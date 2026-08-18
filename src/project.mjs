/**
 * MEMORY.md projection — materialize the pinned set into the harness's auto-loaded index.
 *
 * WHY (the refinement that fell out of dogfooding):
 * File memory and Vectros memory have OPPOSITE cost asymmetries.
 *   - MEMORY.md: read is FREE + instant (the harness auto-loads it every session), but the
 *     write is expensive, manual, and unreliable — it needs housekeeping discipline, which is
 *     exactly the failure this whole loop exists to remove.
 *   - Vectros: the write is cheap + INVOLUNTARY (Haiku capture), structured and governed, but
 *     the read costs a lookup and has a failure mode.
 * Choosing one re-imports the other's flaw. So we don't choose: **Vectros is the source of
 * truth; MEMORY.md becomes a GENERATED VIEW of it.** Writes stay involuntary; reads stay free.
 *
 * This also bounds the file BY CONSTRUCTION — top-N by priority, regenerated, never accreting.
 * (The un-projected MEMORY.md hit its 24KB read limit mid-dogfood. A cache can't rot that way.)
 *
 * PRIORITY's real jobs, now separated: (1) rank within recall, (2) order enumeration, and
 * (3) decide what materializes here. Only (3) is about "always-load" — and the harness, not a
 * hook, does the loading.
 *
 * SAFETY — this WRITES to a file the agent is also told to maintain, so:
 *   - Only the region between the markers is ever touched. Hand-authored content outside them
 *     (the memory operating principles, which stay hand-authored by design) is never read, never
 *     moved, never rewritten. No markers => append, never destroy.
 *   - The block carries a hash of its own generated content. If the block was hand-edited since
 *     the last refresh, we DO NOT silently clobber: the divergent text is quarantined to a file
 *     first, and the event is logged. Nothing is ever lost without a copy.
 *   - Atomic write (tmp + rename), so an interrupted refresh can't truncate the index.
 * Fail-open throughout: any error leaves MEMORY.md exactly as it was.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cred } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { orphanedEditsDir, projectionLog, projectsDir } from './paths.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { PINNED_LIMIT, PINNED_MIN_PRIORITY, PROJECT_HOOK_MAX_CHARS, PROJECT_TIMEOUT_MS } from './config.mjs';


/**
 * Locate the harness's auto-memory index. NEVER hardcode it (an earlier cut pinned one
 * machine's literal path — benign here, but it would silently write to a file nobody loads if
 * the harness ever resolved elsewhere, and it is meaningless to any other user of this code).
 *
 * The harness slugs a project path by replacing `:` `\` `/` with `-`
 * (`C:\Users\me\IdeaProjects\monorepo` -> `C--Users-me-IdeaProjects-monorepo`) and stores
 * `<slug>/memory/`. Memory is keyed to the GIT ROOT, not the cwd, which is why every sibling
 * WORKTREE shares one store: worktrees share a git common dir, so they all resolve to the main
 * worktree. (Verified: 176 project dirs on this machine, 175 transcripts-only, exactly ONE
 * `memory/`.)
 *
 * Resolution order, and we only ever return a path that ALREADY EXISTS — so a wrong guess
 * degrades to "do nothing" instead of conjuring a phantom memory dir the harness never reads.
 */
function resolveMemoryIndex() {
  if (process.env.VECTROS_MEMORY_INDEX) return process.env.VECTROS_MEMORY_INDEX; // tests/escape hatch

  // 1. Derive from the git root (the main worktree, shared by every sibling worktree).
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, // no flashed console window (see capture.mjs)
      timeout: 5000,     // never let a wedged git hang a hook — fall through to discovery instead
    }).trim();
    const root = path.dirname(path.resolve(common));       // .../monorepo/.git -> .../monorepo
    const slug = root.replace(/[:\\/]/g, '-');
    const p = path.join(projectsDir(), slug, 'memory', 'MEMORY.md');
    if (fs.existsSync(p)) return p;
  } catch { /* silence-ok: not a repo / no git / git timed out — all mean "this derivation does not apply", and step 2's discovery below is the designed next attempt. A failure to resolve ends at the `skip: memory index not resolved` receipt, which main() hlogs. */ }

  // 2. Fall back to discovery: if exactly ONE project has a memory index, it is unambiguous.
  try {
    const found = fs.readdirSync(projectsDir())
      .map((d) => path.join(projectsDir(), d, 'memory', 'MEMORY.md'))
      .filter((p) => fs.existsSync(p));
    if (found.length === 1) return found[0];
  } catch { /* silence-ok: the projects dir is unreadable or absent — indistinguishable here from "no index found", and BOTH correctly fall to the `return ''` below, whose `skip: memory index not resolved` receipt main() hlogs. The refusal is reported; only its reason is coarse. */ }

  return ''; // ambiguous or absent -> skip; never guess, never create
}

const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');

const BEGIN = '<!-- VECTROS-PINNED:BEGIN';
const END = '<!-- VECTROS-PINNED:END -->';

function log(msg) {
  try { fs.appendFileSync(projectionLog(), `${new Date().toISOString()} ${msg}\n`); } catch { /* silence-ok: this IS a logger, so it has no channel to report its own failure — the same bind as hooklog.mjs:62. Every caller of log() also returns a receipt string that main() hlogs, so the event still surfaces on the other channel. */ }
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function field(rec, name) {
  return rec?.[name] ?? rec?.payload?.[name] ?? rec?.data?.[name] ?? rec?.fields?.[name] ?? undefined;
}

async function fetchPinned() {
  const key = cred('VECTROS_API_KEY');
  if (!key) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), PROJECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/records/lookup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'memory', field: 'priority', from: String(PINNED_MIN_PRIORITY), to: '999999', order: 'desc', limit: PINNED_LIMIT }),
      signal: ctrl.signal,
    });
    if (!res.ok) { log(`lookup HTTP ${res.status} — returning null so the file is left alone`); return null; }
    const j = await res.json();
    return Array.isArray(j.data) ? j.data : null;
  } catch (e) {
    // silence-ok-adjacent but worth the line: `null` (not `[]`) is the deliberate signal — the caller
    // turns it into `skip: lookup failed (file untouched)`, which main() hlogs. Projecting a failed
    // read as "empty" would WIPE the pinned block out of the auto-loaded MEMORY.md, so the type
    // distinction here is load-bearing. Logging the reason is what tells the two apart afterwards.
    log(`lookup FAILED (${e?.name === 'AbortError' ? `timeout after ${PROJECT_TIMEOUT_MS}ms` : (e?.code || e?.message)}) — returning null so the file is left alone`);
    return null;
  } finally { clearTimeout(to); }
}

/** One line per entry — a POINTER index, matching the file's existing convention. */
function renderEntries(records) {
  return records.map((r) => {
    const pri = field(r, 'priority') ?? 0;
    const title = field(r, 'title') || '(untitled)';
    const kind = field(r, 'kind') || '';
    const id = r?.id || r?.recordId || field(r, 'externalId') || '';
    let hook = String(field(r, 'body') ?? '').replace(/\s+/g, ' ').trim();
    if (hook.length > PROJECT_HOOK_MAX_CHARS) hook = hook.slice(0, PROJECT_HOOK_MAX_CHARS) + '…';
    return `- **[p${pri}]${kind ? ` (${kind})` : ''} ${title}** — ${hook}${id ? ` \`${id}\`` : ''}`;
  });
}

/**
 * Returns the EXACT region that will sit between `-->` and the END marker, and its hash.
 * These must correspond byte-for-byte: the divergence check slices this region back out and
 * re-hashes it. (An earlier cut hashed the body but wrote `-->\n${body}`, so the slice carried
 * one extra newline -> every refresh "diverged", quarantining a file each tick and drowning the
 * real signal. Keep the hashed text and the written text literally the same string.)
 */
function renderBlock(records) {
  const region = [
    '',
    '> **Pinned memories — projected from Vectros (`priority >= 10`). This block is GENERATED.**',
    '> **Do NOT hand-edit it: your edits are quarantined and overwritten on the next refresh.**',
    '> To change an entry, update the memory record itself (or let capture do it); the next',
    '> refresh projects it here. Full memory is recalled semantically on demand — this is only',
    '> the always-load tier.',
    '',
    ...(records.length ? renderEntries(records) : ['- _(no pinned memories — nothing at `priority >= 10`)_']),
    '',
  ].join('\n'); // leading '' => region starts with the newline that follows `-->`
  return { region, h: hash(region) };
}

/**
 * Refresh the generated block in MEMORY.md. Returns a short status string.
 * Never throws; never touches anything outside the markers.
 */
export async function refreshPinnedBlock() {
  const MEMORY_INDEX = resolveMemoryIndex();
  if (!MEMORY_INDEX) return 'skip: memory index not resolved (never guess, never create)';

  const records = await fetchPinned();
  if (records === null) return 'skip: lookup failed (file untouched)';

  const { region, h } = renderBlock(records);
  // NOTE: no '\n' here — `region` already begins with it. It must match the slice byte-for-byte.
  const block = `${BEGIN} hash=${h} refreshed=${new Date().toISOString()} -->${region}${END}`;

  let file;
  try { file = fs.readFileSync(MEMORY_INDEX, 'utf8'); }
  catch (e) { return `skip: MEMORY.md unreadable (${e.code}) — file untouched`; } // the returned string IS the receipt: main() hlogs it. Carrying e.code distinguishes absent from unreadable.

  const bIdx = file.indexOf(BEGIN);
  const eIdx = file.indexOf(END);

  let next;
  if (bIdx === -1 || eIdx === -1 || eIdx < bIdx) {
    // No markers yet: APPEND. Never restructure or overwrite hand-authored content.
    next = file.trimEnd() + '\n\n' + block + '\n';
    log(`init: appended pinned block (${records.length} entries)`);
  } else {
    // Markers present — check whether the existing block was hand-edited since we wrote it.
    const existing = file.slice(bIdx, eIdx + END.length);
    const declared = existing.match(/hash=([0-9a-f]+)/)?.[1];
    const currentBody = existing.slice(existing.indexOf('-->') + 3, existing.length - END.length);
    const diverged = declared && hash(currentBody) !== declared;
    // Nothing changed and nobody edited it: do NOT rewrite. The `refreshed=` stamp alone would
    // otherwise churn the file (and its mtime) every tick for no reason.
    if (!diverged && declared === h) return 'noop: already current';
    if (diverged) {
      // Diverged: someone edited the generated block. Quarantine BEFORE overwriting — a cache
      // may be rebuilt, but we never destroy text a human/agent actually wrote.
      try {
        fs.mkdirSync(orphanedEditsDir(), { recursive: true });
        const q = path.join(orphanedEditsDir(), `memory-md-${Date.now()}.md`);
        fs.writeFileSync(q, currentBody);
        log(`DIVERGED: generated block was hand-edited; quarantined to ${q} before refresh`);
      } catch (e) { return `skip: diverged but quarantine FAILED (${e.code}) — file untouched, hand-edits preserved in place`; } // the returned string IS the receipt (main() hlogs it), and refusing to overwrite is the point: we never destroy text a human wrote.
    }
    next = file.slice(0, bIdx) + block + file.slice(eIdx + END.length);
  }

  if (next === file) return 'noop: already current';
  // tmp+rename was right in principle and wrong twice in practice (fixed 2026-07-16):
  //   1. the temp name was SHARED (`MEMORY_INDEX + '.tmp'`), not pid-scoped. MEMORY.md is a
  //      cross-session file and each session's projection runs on its own debounce clock, so two
  //      sessions could interleave into the same scratch file and rename the wreckage over the
  //      index that every session auto-loads.
  //   2. no retry. On Windows `MoveFileEx` refuses to replace a file a reader holds open; the
  //      catch swallowed the EPERM and the projection was silently dropped. Measured: plain
  //      tmp+rename lost 56% of writes under contention. → `atomic.mjs`.
  if (!writeFileAtomic(MEMORY_INDEX, next)) {
    log('ERROR: write LOST (rename stayed contended) — MEMORY.md not refreshed this cycle');
    return 'skip: write lost';
  }

  log(`refreshed: ${records.length} pinned entries`);
  return `refreshed ${records.length} entries`;
}

// Standalone entry point. capture.mjs spawns this DETACHED (never inline — it costs ~1.8s,
// dominated by a cold TLS handshake, and must not sit on the user's compaction path).
//
// It therefore has NO stdout anyone reads (`stdio: 'ignore'`), so it must report to the shared
// hook log or it becomes unobservable — the exact failure that let recall.mjs sit silently dead.
// `projection.log` alone is not enough: it only records CHANGES, so a healthy "noop" and a run
// that never happened look identical. Detaching a component means it needs its receipt MORE, not
// less.
//
// FOUND (PM cold pass, this MR): a THIRD, different entry-point idiom lived here —
// `process.argv[1].endsWith('project.mjs')` — safe today only because nothing imports this file's
// top-level scope, so it never got a chance to fire spuriously the way reap.mjs's/report.mjs's
// `import.meta.url` checks did. `.endsWith()` also has its own narrow false-positive risk a bare
// substring match carries (a hypothetical `subproject.mjs` would match too). Standardized to the
// same `path.basename(...) === '<own-filename>'` shape every dual-mode file in this tree now uses
// — one idiom, not three, so a future reader (or reviewer) has exactly one pattern to check for.
if (process.argv[1] && path.basename(process.argv[1]) === 'project.mjs') {
  refreshPinnedBlock()
    .then((s) => { hlog('project', s); console.log(s); })
    .catch((e) => hlog('project', `ERROR: ${e?.message || e}`));
}
