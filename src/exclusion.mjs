/**
 * THE OPT-OUT RULES — which sessions are excluded from recall and capture.
 *
 * Three things exclude a session: the `VECTROS_MEMORY_OFF` environment variable, a session directory
 * at or under an entry of `config.json`'s `EXCLUDED_DIRECTORIES`, and — only when
 * `INCLUDED_DIRECTORIES` is non-empty — a session directory that is NOT under one of its entries.
 * An exclusion always beats an inclusion. This module holds the rules; `optout.mjs` is the guard
 * that applies them at the top of every hook.
 *
 * NO IMPORT-TIME EFFECTS OF ITS OWN (it imports the config loader, which reads the config file once).
 * `optout.mjs` reads stdin and may exit the process, which is right for a
 * hook and wrong for anything else that wants to ask "is this session excluded?" — the tail sweep,
 * the orphan cap, the cross-session nudge and the spool drain all do, from processes that must keep
 * running. So the questions live here, side-effect free, and the guard lives next door.
 *
 * WHY SESSIONS THAT ARE NOT RUNNING NEED THE SAME RULES. A hook only ever sees the session in front
 * of it. But three background paths act on OTHER sessions' leftovers — the sweep distills a finished
 * session's unread tail, the nudge offers its pending candidates to a live agent, the orphan cap
 * settles them, and the spool drain turns its proposals into records. If any of those ignored the
 * list, a directory excluded AFTER a session ran would leak through the one session still alive.
 * They therefore ask `excludedSessionCheck()` about the session's recorded origin (the queue's
 * `cwd` event, `state.cwd`), evaluated against the list as it stands NOW, not as it stood at capture.
 *
 * FAIL DIRECTIONS DIFFER BY WHAT IS BEING PROTECTED, and each is deliberate:
 *   · A live hook with an unusable list fails CLOSED (does nothing): the alternative is capturing
 *     the very session the list exists to protect.
 *   · A background check that cannot READ a session's files fails closed too (skips it this tick).
 *   · A session with NO recorded origin at all predates this feature. With only an exclusion list
 *     it is treated as not excluded: there is no evidence it was ever inside an excluded
 *     directory, and the opt-out applies from the moment it is configured, not retroactively.
 *     With an inclusion list the same session is treated as excluded, because an allow-list admits
 *     only what it can show to be inside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { optOutConfig } from './config.mjs';
import { readJsonSafe } from './atomic.mjs';
import { read as readQueue } from './queue.mjs';
import { stateFor } from './paths.mjs';

/**
 * `VECTROS_MEMORY_OFF` — on for anything but unset, empty, `0`, `false` or `no`. Documented as
 * `=1`; the wider reading exists so that a value someone plausibly typed to mean "on" cannot
 * silently mean "off", which for an exclusion switch is the wrong direction to be wrong in.
 */
export function optOutEnvOn(env = process.env) {
  const v = String(env.VECTROS_MEMORY_OFF ?? '').trim().toLowerCase();
  return v !== '' && !['0', 'false', 'no'].includes(v);
}

/** Case-insensitive filesystems by default: Windows (the issue's requirement) and macOS. */
const foldsCase = (platform) => platform === 'win32' || platform === 'darwin';

/**
 * One spelling per directory: separators unified, `.`/`..` resolved, trailing separators dropped
 * (the root keeps its own), and lower-cased where the filesystem folds case. Empty in, empty out.
 * `platform` is a parameter so the Windows rules can be asserted from any host.
 */
export function normalizeDir(p, platform = process.platform) {
  let s = String(p ?? '').trim();
  if (!s) return '';
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    // `\\?\C:\x` and `\\?\UNC\srv\share` are the same places as `C:\x` and `\\srv\share`.
    s = s.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}[?.][\\/]/, '');
  }
  let n = api.normalize(s); // win32.normalize also turns `/` into `\`
  if (platform === 'win32') {
    // Windows ignores trailing dots and spaces in a path component (`clientA.` is `clientA`).
    n = api.normalize(n.split('\\').map((c) => (c === '.' || c === '..' ? c : c.replace(/[. ]+$/, ''))).join('\\'));
  }
  const root = api.parse(n).root;
  while (n.length > root.length && /[\\/]$/.test(n) && (platform === 'win32' || n.endsWith('/'))) n = n.slice(0, -1);
  return foldsCase(platform) ? n.toLowerCase() : n;
}

/**
 * `dir` is `excluded` itself or lives beneath it. The boundary is a SEPARATOR, never a character:
 * `c:\a\client` contains `c:\a\client\x` but not `c:\a\clientx`, which a bare `startsWith` would
 * have swallowed.
 */
function isWithin(dir, excluded, platform) {
  if (!dir || !excluded) return false;
  if (dir === excluded) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return dir.startsWith(excluded.endsWith(sep) ? excluded : excluded + sep);
}

/**
 * The on-disk spelling of a path (symlinks and junctions resolved), or '' if it does not exist.
 * Memoized for the life of the process: a hook is short-lived, and the background checks ask about
 * the same few list entries once per session, which would otherwise be sessions x entries
 * filesystem calls (and one slow call per entry if a listed share is unreachable).
 */
const realDirCache = new Map();
function realDir(p, platform) {
  const key = `${platform}\u0000${p}`;
  if (realDirCache.has(key)) return realDirCache.get(key);
  let r = '';
  try { r = normalizeDir(fs.realpathSync.native(p), platform); }
  catch { /* silence-ok: a directory that does not exist has no real path to compare; the textual comparison has already covered the spelling that was given. */ }
  realDirCache.set(key, r);
  return r;
}

/**
 * Is `dir` at or under any of `dirs`? Compared by spelling AND by real path, so a session started
 * through a symlink or junction into an excluded directory is caught, as is one that lists the link
 * while the session reports the target.
 */
export function dirUnder(dir, dirs, { platform = process.platform, realpath = true } = {}) {
  if (!dir || !dirs?.length) return false;
  const candidates = [normalizeDir(dir, platform)];
  const entries = dirs.map((d) => normalizeDir(d, platform));
  if (realpath) {
    candidates.push(realDir(dir, platform));
    for (const d of dirs) entries.push(realDir(d, platform));
  }
  return candidates.some((c) => c && entries.some((e) => isWithin(c, e, platform)));
}

/**
 * Is `dir` INSIDE the allow-list `dirs`? Stricter than `dirUnder`, because the two lists fail in
 * opposite directions: an exclusion matched by EITHER spelling errs towards excluding, but an
 * allow-list matched by either spelling would admit a junction that sits inside an included root and
 * points outside it. Here every spelling of `dir` that can be resolved (as written, and its real path)
 * must be under some entry (as written, or its real path).
 */
export function dirWithin(dir, dirs, { platform = process.platform, realpath = true } = {}) {
  if (!dir || !dirs?.length) return false;
  const entries = dirs.map((d) => normalizeDir(d, platform));
  if (realpath) for (const d of dirs) entries.push(realDir(d, platform));
  const candidates = [normalizeDir(dir, platform)];
  if (realpath) candidates.push(realDir(dir, platform));
  const live = candidates.filter(Boolean);
  return live.length > 0 && live.every((c) => entries.some((e) => isWithin(c, e, platform)));
}

/**
 * Every directory this hook invocation can be said to be in: the payload's `cwd`, and
 * `CLAUDE_PROJECT_DIR` (the directory Claude Code was started in, which does not move when a
 * command `cd`s). Either one being excluded excludes the session. Only when neither is present does
 * the hook process's own working directory stand in.
 */
export function sessionLocations(input, env = process.env, cwd = () => process.cwd(), platform = process.platform) {
  const abs = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  for (const v of [input?.cwd, env.CLAUDE_PROJECT_DIR]) {
    if (typeof v !== 'string' || !v.trim()) continue;
    // A relative value has no meaning on its own; it is relative to this process's directory.
    const here = abs.isAbsolute(v.trim()) ? v.trim() : abs.resolve(cwd(), v.trim());
    if (!out.includes(here)) out.push(here);
  }
  return out.length ? out : [cwd()];
}

/**
 * What to RECORD as where a session originated: BOTH the payload's working directory and the
 * directory Claude Code was started in ('' when unknown). They are kept separately because either
 * can be the one a later exclusion names: a project directory that is the PARENT of a directory
 * excluded afterwards says nothing about the work done inside it, and the working directory says
 * nothing about where the session was rooted.
 */
export function originDirs(input, env = process.env) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  return { cwd: clean(input?.cwd), projectDir: clean(env.CLAUDE_PROJECT_DIR) };
}

/**
 * The live-hook decision: `null` to run normally, or `{ trigger, label }` to do nothing.
 *   trigger 'env'          — VECTROS_MEMORY_OFF
 *   trigger 'config'       — the directory lists cannot be trusted (fail closed)
 *   trigger 'directory'    — the session is in an excluded directory
 *   trigger 'not-included' — an inclusion list exists and the session is not under it
 * With an inclusion list, EVERY location of the session must be under it: a session started inside
 * an included root that has since moved out is outside the allow-list, not half-inside it.
 * `label` is for the single per-session log line and carries no path.
 */
export function optOutDecision({ input = null, env = process.env, config = optOutConfig(), platform = process.platform, cwd } = {}) {
  if (optOutEnvOn(env)) return { trigger: 'env', label: 'VECTROS_MEMORY_OFF is set' };
  if (config.problem) return { trigger: 'config', label: `${config.problem}; failing closed` };
  const here = sessionLocations(input, env, cwd, platform);
  if (config.dirs.length && here.some((l) => dirUnder(l, config.dirs, { platform }))) {
    return { trigger: 'directory', label: 'the session directory is under an excluded directory' };
  }
  if (config.included?.length && !here.every((l) => dirWithin(l, config.included, { platform }))) {
    return { trigger: 'not-included', label: 'the session directory is not under an included directory' };
  }
  return null;
}

/**
 * The name Claude Code gives a project's folder under `<config>/projects/`: the project's path with EVERY
 * non-alphanumeric character turned into `-` (`C:\Users\me\tmp_check.v1 x` is `C--Users-me-tmp-check-v1-x`).
 * One definition, used by the transcript match below and by the pinned-set refresh, so the two cannot drift.
 */
export const encodeProjectDir = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

/**
 * Claude Code stores a session's transcript at `<config>/projects/<project dir>/<session>.jsonl`,
 * where `<project dir>` is the project's path with every non-alphanumeric character turned into
 * `-`. For a session that recorded no origin of its own (one that ran before the origin was
 * recorded), that name is the only evidence of where it ran.
 *
 * THIS IS A LOSSY ENCODING, and the loss is taken in the safe direction: `C:\a\Client-X` and
 * `C:\a\Client\X` encode alike, so a sibling whose name continues past an excluded directory's
 * with a `-` can be excluded too. That over-exclusion only ever means a leftover session is not
 * swept (or, for an inclusion list, wrongly cleared); it is accepted for legacy sessions only, because the exact match (a separator boundary)
 * is available for everything that has a recorded origin.
 */
export function transcriptDirUnder(transcriptPath, dirs, platform = process.platform) {
  if (!transcriptPath || !dirs?.length) return false;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const projectDir = api.dirname(String(transcriptPath));
  if (api.basename(api.dirname(projectDir)) !== 'projects') return false; // not Claude Code's layout: infer nothing
  const fold = (s) => (foldsCase(platform) ? s.toLowerCase() : s);
  const project = fold(api.basename(projectDir));
  return dirs.some((d) => {
    const e = fold(encodeProjectDir(normalizeDir(d, platform)));
    return !!e && (project === e || project.startsWith(e.endsWith('-') ? e : `${e}-`));
  });
}

/** What the session's own files say about where it ran. `unreadable`: could not tell, so cannot clear it. */
function originsOf(sid, known) {
  const dirs = [];
  let transcriptPath = known.transcriptPath ?? null;
  let unreadable = false;
  if (known.queueDirs !== undefined) {
    dirs.push(...known.queueDirs);
  } else {
    const q = readQueue(sid);
    if (q.state === 'corrupt') unreadable = true;
    else dirs.push(...[q.cwd, q.projectDir].filter(Boolean));
  }
  if (known.stateDirs !== undefined) {
    dirs.push(...known.stateDirs);
  } else {
    const s = readJsonSafe(stateFor(sid), {});
    // `damaged` is a file that EXISTS and parsed as garbage: the session ran, and where it ran is gone.
    // That is not "no recorded origin" (a session from before the origin was recorded), so it is not cleared.
    if (s.state === 'unreadable' || s.state === 'damaged') unreadable = true;
    else {
      for (const k of ['cwd', 'projectDir']) if (typeof s.value[k] === 'string' && s.value[k]) dirs.push(s.value[k]);
      transcriptPath ??= s.value.transcriptPath ?? null;
    }
  }
  return { dirs, transcriptPath, unreadable };
}

/**
 * A predicate `(sid, known?) => boolean` for the background paths: is this session's leftover work
 * off limits? `known` lets a caller that has already folded the queue or parsed the state pass what
 * it holds (`{ queueDirs, stateDirs, transcriptPath }`, arrays, empty meaning "looked, none") instead
 * of paying for a second read; anything not supplied is read here. A session can have several
 * recorded origins (the working directory and the project directory, in the queue and in state):
 * it is excluded if ANY of them is under the exclusion list, and admitted by an allow-list only if
 * ALL of them are inside it.
 *
 * With nothing to protect this costs nothing — no file is touched — which is the common case and the
 * reason the sweep and nudge can call it on every pass.
 */
export function excludedSessionCheck({ config = optOutConfig(), platform = process.platform, readOrigins = originsOf } = {}) {
  if (config.problem) return () => true; // the lists cannot be honoured, so no session can be cleared
  const dirs = config.dirs;
  const included = config.included ?? [];
  if (!dirs.length && !included.length) return () => false;
  return (sid, known = {}) => {
    const o = readOrigins(sid, known);
    if (o.unreadable) return true;
    if (o.dirs.some((d) => dirUnder(d, dirs, { platform }))) return true;
    // The transcript's folder name is a LOSSY encoding, so it is consulted only for a session with no
    // recorded origin; a recorded one has already been compared exactly, and a sibling that merely
    // continues an excluded name must not be swept up by the approximation.
    if (dirs.length && !o.dirs.length && transcriptDirUnder(o.transcriptPath, dirs, platform)) return true;
    if (!included.length) return false;
    // An allow-list admits only what it can SHOW to be inside it: every recorded origin. A session with
    // none is not admitted — the transcript's folder name is a lossy encoding that would clear a sibling
    // (`mine-secret` under `mine`), and an approximation is the wrong tool for an allow-list.
    return !(o.dirs.length > 0 && o.dirs.every((d) => dirWithin(d, included, { platform })));
  };
}
