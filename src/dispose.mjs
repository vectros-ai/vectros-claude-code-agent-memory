#!/usr/bin/env node
/**
 * dispose.mjs — the AGENT's half of capture.
 *
 * The distiller PROPOSES candidates into the queue; nothing else may write memory. This is the
 * one command that retires them, and it is deliberately a CLI rather than a hook: disposition is
 * a judgment the agent makes with tools and repo access, not something a 30s hook can infer.
 *
 *   node dispose.mjs <sessionId> --list
 *   node dispose.mjs <sessionId> c1=stored:<record-uuid> \
 *                                c2=ignored:covered:docs/gotchas/known-rename-issue.md \
 *                                c3=documented:docs/CONVENTIONS.md#diagnosis-discipline \
 *                                c4=ignored:point-in-time, not durable
 *   node dispose.mjs <sessionId> --reopen c2 the cited doc was stale; the claim is true
 *
 * `<sessionId>` accepts either the full id or an unambiguous prefix of one — the same short form
 * every nudge/report line displays (`ORPHAN-NUDGE(n from 7172bd20)`). A prefix that resolves to
 * zero or more than one local queue file is refused with an error, never silently read as "no
 * pending candidates" (see `resolveSessionId` below for why this matters).
 *
 * WHY EVERY CLAIM IS VERIFIED
 * A disposition is irreversible in the only sense that matters: a disposed candidate is never
 * re-offered (that is the whole point — nothing nags, nothing drops on a clock). So a FALSE claim
 * does not merely mis-file the candidate, it destroys it. `stored:<id>` with a typo'd uuid marks
 * the memory handled and loses it forever, and the agent making the claim cannot detect this:
 * *the write response echoes the request, not stored state* — the same blind spot that let a
 * "stored" belief survive a failed write elsewhere in this repo. So we do not trust the claim, we
 * READ IT BACK from the store. A bogus id 404s; that 404 is the gate.
 *
 * ALL-OR-NOTHING **validation**. Every spec is verified BEFORE any write, so one typo in arg 4
 * cannot leave args 2-3 applied and the rest not. NOTE the precise scope: this covers VALIDATION
 * failures, which is the reachable case. If a WRITE itself fails midway, earlier specs already
 * landed and this returns non-zero — partial application.
 *
 * `cN` ADDRESSES A RECORD, NOT A LINE IN A FILE. The candidate corpus lives
 * in Vectros records; a `cN` is a stable ordinal over ALL of a session's candidates ever
 * (`candidates.mjs`'s `bySession`/`withOrdinals`) — settling one never renumbers another. Settling
 * PATCHES THE RECORD FIRST; the local queue file is then updated as a best-effort durability
 * backup, never the other way around. Records unreachable ⇒ this refuses outright rather than
 * guessing at an address it cannot verify.
 *
 * Exit 0 only if every spec was applied (or was already applied). Non-zero otherwise — the agent
 * must be able to tell "disposed" from "I said the words and nothing happened".
 *
 * NEVER `process.exit()` HERE — set `process.exitCode` and return. MEASURED on Windows/Node: once
 * this process has made a `fetch`, an explicit `process.exit()` trips a libuv assert
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, uv/src/win/async.c:76) and dies with 0xC0000409 instead
 * of the exit code we set. It reproduced on 3/3 hard exits and 0/3 soft exits, and consuming or
 * cancelling the response body made no difference — the exit call itself is the fault. It bit the
 * REFUSAL path specifically, because that is the only path that both calls the network and exits
 * non-zero: the gate's own verdict was the thing being corrupted. Soft exit is also FASTER
 * (~570ms vs ~1050ms), so there is no drain-hang to trade off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cred } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { read as readQueue, append, DISPOSITIONS } from './queue.mjs';
import { bySession, settle as settleRecord, reopen as reopenRecord } from './candidates.mjs';
import { queueDir, slug, SID_DISPLAY_LEN, memoryHome } from './paths.mjs';
import { DISPOSE_TIMEOUT_MS, DISPOSE_STORED_RECENCY_MIN, NUDGE_TITLE_MAX_CHARS, NUDGE_FIELD_MAX_CHARS, QUEUE_BODY_MAX_CHARS } from './config.mjs';

/**
 * PREFIX RESOLUTION — pasting an `ORPHAN-NUDGE` line's 8-char id straight into `dispose.mjs`
 * must not fail silently: `bySession` does an EXACT `sessionId` field match, so a prefix would
 * simply match zero records and render "No pending candidates", identical to a genuinely
 * empty queue. That is a false negative in the same shape this whole file exists to refuse
 * elsewhere: a read that LOOKS like a confirmed empty state but is actually "the query didn't run
 * against the right scope". Silent is the failure mode this file refuses everywhere else
 * (`RECORDS UNREACHABLE`, corrupt-queue backups, ...); an unresolved id deserves the same refusal.
 *
 * Deliberately keyed on LENGTH, not id shape (e.g. "is this a UUID") — a real Claude Code session
 * id always is a UUID, but this file's own tests (and any adopter's own tooling) use plain
 * descriptive ids like `dispose-test-0001`, and nothing here should assume a specific id format
 * beyond "the nudge UI truncates to `SID_DISPLAY_LEN` characters". Anything LONGER than that is
 * the caller's literal, full intended id and is returned completely unchanged — zero behavior
 * change for every existing caller, script, or test.
 *
 * AT OR UNDER that length, the input is ambiguous — it could be a genuine short full id (this
 * file's own tests use them) or a truncated prefix — and there is no way to tell them apart by
 * shape alone. So both interpretations are computed together, structurally, rather than picking
 * one first and only falling back to the other: every local `queue/*.jsonl` filename whose name
 * starts with the (slugged) input is a candidate, and a literal short id's OWN file is always one
 * of those candidates too (any string trivially starts with itself). Filenames are the SLUGGED id
 * (`paths.mjs` `slug`/`queueFor`), not the raw one, so the input is slugged before comparing —
 * `slug` only rewrites disallowed characters in place, so slugging a PREFIX of a string yields
 * exactly the prefix of the slugged string, which is what makes finding the right FILE reliable
 * even for an id containing a slug-affected character (a colon, a space, ...).
 *
 * ONLY WHEN EXACTLY ONE CANDIDATE SURVIVES does resolution proceed. Checking "does a literal file
 * exist?" FIRST and returning it immediately would never check whether that same literal input
 * could ALSO be a truncated prefix of some other, longer session's id sitting in the same
 * directory. Two candidates for one input is exactly as unresolvable as a genuine multi-way prefix
 * collision, and silently preferring the literal interpretation would be the exact silent failure
 * mode this whole function exists to refuse. So a literal match and a prefix match compete in the
 * same set, and a real collision between them surfaces as "ambiguous", never gets silently
 * decided.
 *
 * Finding the file is still not the same as knowing the exact raw id — `slug` is LOSSY (`a:b` and
 * `a_b` slug to the same filename), so a filename cannot in general be reversed back into the one
 * true raw id, only into "some raw id that would produce this file". If the sole surviving
 * candidate is not an EXACT match of the literal input (i.e. resolution depended on slugging the
 * input at all, `slug(input) !== input`), this function refuses rather than guessing which raw id
 * the filename came from. An id built only from characters `slug` never touches (a UUID, or any
 * hyphen/dot/word-character descriptive id — the only shapes this file's own tests, or a real
 * Claude Code session, ever use) is never affected by this: `slug(input) === input` always holds
 * for those, so the refusal branch below never fires for the ordinary case.
 *
 * The other case this cannot recover: a genuine short id, at or under `SID_DISPLAY_LEN`, with NO
 * local queue file at all (a record-only session — see `backupToFile` above for how that
 * happens). Nothing at this point in `main()` has made a records call yet, so there is no way to
 * distinguish that from an unresolvable prefix without one; refusing (never guessing) is the same
 * answer as every other unreachable-address case in this file. Closing this would take trying the
 * literal id against records first, at the cost of an extra round trip on every short-id call; that
 * is not done.
 */
function resolveSessionId(input) {
  if (!input) return { error: 'empty session id' }; // defensive: main() already guards this, but this function should not trust that.
  if (input.length > SID_DISPLAY_LEN) return { id: input };
  let names;
  try {
    names = fs.readdirSync(queueDir());
  } catch {
    /* silence-ok: ENOENT (no queue/ yet — a fresh install, or every session ever swept away) is
     * the normal case and correctly yields zero matches below. Any other read failure degrades to
     * the same outcome, which is still a REFUSAL (the "0 matches" branch below), never a false
     * "resolved" or a false "no pending candidates" — the two failure modes this function exists
     * to prevent. Nothing is lost by treating an unreadable directory as "found nothing here". */
    names = [];
  }
  const slugged = slug(input);
  // A literal short id's own file always starts with its own (slugged) name, so it is always one
  // of these candidates — there is no separate "check the literal first" branch. A literal match
  // and a colliding longer sibling's prefix match compete in the SAME set, so a real collision
  // surfaces as ambiguous instead of the literal silently winning.
  const matches = names.filter((n) => n.endsWith('.jsonl') && n.slice(0, -'.jsonl'.length).startsWith(slugged)).map((n) => n.slice(0, -'.jsonl'.length));
  if (matches.length === 0) {
    return { error: `no session found matching "${input}" (checked local queue filenames under ${queueDir()}). `
      + 'This is NOT the same as "no pending candidates" — pass the FULL session id, not the short prefix an '
      + 'ORPHAN-NUDGE line displays.' };
  }
  if (matches.length > 1) {
    return { error: `"${input}" matches ${matches.length} sessions, ambiguous: ${matches.join(', ')} — pass the full id.` };
  }
  const only = matches[0];
  if (only === input) return { id: input }; // an exact literal filename match — unambiguous, nothing to resolve
  if (slugged !== input) {
    // Found the right FILE, but slug() is lossy, so its name cannot be trusted as the one true
    // raw id — see this function's own header for why guessing here would be worse than refusing.
    return { error: `"${input}" matches a local queue file only after removing characters this package's session-id `
      + `filenames can't carry (spaces, colons, ...) — its exact raw id can't be safely reconstructed from that `
      + `file alone. Pass the FULL literal session id instead of a prefix.` };
  }
  return { id: only, resolvedFrom: input }; // a genuine, unambiguous prefix match
}

/**
 * THE ADDRESS SPACE — records, not the file.
 *
 * `bySession` numbers ALL of a session's candidates ever, settled included, so an ordinal
 * (`c1`, `c2`, ...) is a real, STABLE address: `c2` stays `c2` for the life of the session even
 * after `c1` settles. The local append log gives the same guarantee; here it is sourced from the
 * record store. → candidates.mjs `withOrdinals` header.
 *
 * UNREACHABLE RECORDS ⇒ `state: 'unreachable'`, and every caller refuses rather than guesses —
 * the same "no nudge is safer than a wrong nudge" refusal used for a corrupt queue. Addressing
 * LIVES in the record store; if it cannot be read, nothing here can safely resolve a `cN` to
 * anything, so pretending otherwise is not an option.
 */
async function readRecords(sessionId) {
  const rows = await bySession(sessionId);
  if (rows === null) return { state: 'unreachable' };
  const all = new Map(rows.map((r) => [r.ordinal, r]));
  const pending = rows.filter((r) => r.disposition === 'pending' && !r.supersededBy);
  const disposed = new Set(rows.filter((r) => r.disposition !== 'pending' && !r.supersededBy).map((r) => r.ordinal));
  const superseded = new Set(rows.filter((r) => r.supersededBy).map((r) => r.ordinal));
  return { state: 'ok', all, pending, disposed, superseded };
}

/**
 * BACK UP THE SETTLEMENT TO THE LOCAL FILE — best-effort, loud on failure, never blocking.
 *
 * The RECORD write is the operation that determines whether dispose.mjs succeeds (see Phase 2 in
 * `main()`), and this call is what makes the local file agree with it afterward. (The propose side
 * runs the other way: capture-worker.mjs writes the queue first and the record afterward via the
 * spool.) The file's jobs here are durability if records is unreachable at a future read, and the
 * input `report.mjs --compare` audits against; a failed backup is loud, never silently
 * swallowed.
 *
 * Resolves the file's OWN positional id (`c7`, independent of and unrelated to the record ordinal
 * just used to address this candidate) by matching `externalId` — the one field both stores carry
 * — so the appended event stays in the exact shape `report.mjs`'s existing fold already expects.
 * No matching local entry (a record synced from elsewhere, with nothing proposed on this machine)
 * is not an error: the record write already succeeded, so there is simply nothing to back up.
 */
async function backupToFile(sessionId, label, externalId, ev) {
  const q = readQueue(sessionId);
  if (q.state === 'corrupt') {
    console.log(`  WARN ${label}: local queue unreadable — the record IS settled; there is just no local backup of it. `
      + 'Re-run `report.mjs --compare` once the file is readable again.');
    return;
  }
  let fileId = null;
  for (const [id, c] of q.all) { if (c.externalId === externalId) { fileId = id; break; } }
  if (!fileId) {
    hlog('dispose', `${label}: no local queue entry for externalId ${externalId} — record settled, nothing to back up locally`);
    return;
  }
  if (!append(sessionId, { ...ev, id: fileId })) {
    console.log(`  WARN ${label}: local backup append FAILED — the record IS settled; only the local audit copy is `
      + 'missing. Re-run `report.mjs --compare` once writable to confirm the record still agrees.');
  }
}

/**
 * Same untrusted-field rule as nudge.mjs's `field()` and hit.mjs's `clean()`/`cut()` — a
 * candidate's title/body/kind/dest/sourceRef is model-authored text with no length bound of its
 * own, and this CLI's listing renders it verbatim (as nudge.mjs does). Newline
 * collapse is the load-bearing half — a raw newline in a title/sourceRef would visually splice one
 * candidate's listing into the next. The cap is a safety ceiling against pathological input, not a
 * budget squeeze: unlike nudge.mjs's injected-context line, this is a terminal the OPERATOR reads
 * to decide how to dispose, so `body` gets QUEUE_BODY_MAX_CHARS (the same generous ceiling the
 * queue itself enforces at write time) rather than the tight NUDGE_BODY_MAX_CHARS.
 */
const field = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * THE DISPOSAL AUDIT LINE — a settlement is a decision, and decisions need a timeline.
 *
 * The queue already records WHAT was settled and HOW; what it cannot show is the sequence across
 * sessions, which is what an operator needs when a candidate turns out to have been destroyed by a
 * wrong call. `hooks.log` is the one place every other component leaves its receipt, so a
 * disposition goes there too — cheap (a line per settled candidate, and settling is rare), and it
 * makes "when did we decide this, and on what evidence?" answerable from the same file as
 * everything else rather than by re-folding queues by hand.
 *
 * Failure here is deliberately swallowed by `hlog` itself: an audit line must never be the reason a
 * settlement fails. The queue append is the record of truth; this is the diagnosis trail.
 */
const audit = (sessionId, msg) => hlog('dispose', msg, sessionId);

const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');
/**
 * How recently a `stored` record must have been written. A candidate you settle is one you just
 * created (or deliberately merged into). Generous, because a long disposition pass over a big
 * queue is normal; tight enough that a uuid recall injected hours ago does not pass.
 */

const OK = (s) => `  OK   ${s}`;
const NO = (s) => `  FAIL ${s}`;

/** Read a record back from the store. null = it is not there. This is the anti-lie gate. */
async function recordExists(id, { requireRecent = true } = {}) {
  const key = cred('VECTROS_API_KEY');
  if (!key) return { ok: false, why: 'no VECTROS_API_KEY in the environment/keyring' };
  if (!/^[0-9a-f-]{16,}$/i.test(id)) return { ok: false, why: `"${id}" is not a record id` };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), DISPOSE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/records/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { ok: false, why: `no record ${id} exists — the write did NOT land` };
    if (!res.ok) return { ok: false, why: `read-back got HTTP ${res.status} (cannot confirm the write)` };
    const j = await res.json();
    // NOT fail-open. Everywhere else in this system an unreachable store means "inject nothing and
    // carry on"; here it must mean STOP. Fail-open on a verification gate is not a gate.

    /**
     * EXISTENCE IS NOT CORRESPONDENCE.
     *
     * This fetched `typeName` and threw it away, so ANY 2xx passed. The gate was closed against
     * the improbable failure (a random typo -> 404) and open against the probable one: recall
     * injects REAL record uuids into the agent's context on every hit, so the id most likely to be
     * pasted by mistake is a real one belonging to something else.
     *
     * Without these checks a candidate titled "stored path" could be settled with the uuid of a
     * real, unrelated, already-existing memory record — a pinned memory covering a completely
     * different topic — with exit 0.
     *
     * Checked: the id echoes, and the record IS a memory (a `document`/ADR id is the shape of
     * the mistake this catches). Neither is sufficient — a real, unrelated MEMORY uuid still
     * passes — so `recentlyWritten` below carries the real weight: a candidate you just stored is
     * a record you just wrote.
     */
    if (j?.id && j.id !== id) return { ok: false, why: `read-back returned id ${j.id}, not ${id}` };
    if (j?.typeName && j.typeName !== 'memory') {
      return { ok: false, why: `${id} is a '${j.typeName}', not a memory — a candidate is stored AS a memory record` };
    }
    const written = Date.parse(j?.updatedAt || j?.createdAt || '');
    const ageMin = Number.isFinite(written) ? (Date.now() - written) / 60000 : null;
    // `requireRecent: false` for an `ignored:covered:<uuid>` citation — a record that ALREADY covers
    // the candidate is old by definition, so the recency gate (which exists to catch a uuid pasted
    // from a recall hit) would reject exactly the correct citation. Existence + typeName still hold.
    if (requireRecent && ageMin !== null && ageMin > DISPOSE_STORED_RECENCY_MIN) {
      return {
        ok: false,
        why: `${id} was last written ${Math.round(ageMin)} min ago — a 'stored' candidate must be a record you JUST wrote. `
          + `This is the shape of pasting a uuid recall showed you. If you deliberately merged into an existing record, touch it and re-run.`,
      };
    }
    return { ok: true, typeName: j?.typeName, title: j?.payload?.title ?? j?.title, ageMin };
  } catch (e) {
    return { ok: false, why: `read-back failed (${e.name === 'AbortError' ? 'timeout' : e.message}) — cannot confirm; NOT marking stored` };
  } finally { clearTimeout(to); }
}

/**
 * Verify an `ignored:covered:<ref>` citation — the gate on the ONE-WAY DOOR, which would otherwise
 * be the unlocked one.
 *
 * THE FAILURE MODE THIS CLOSES: disposing a TRUE candidate as `ignored:PREMISE IS FALSE`, citing
 * docs that are themselves STALE. `ignored` is never re-offered, so the candidate is destroyed —
 * and nothing would look at the reason. Note the asymmetry that makes it possible:
 *
 *   stored:<uuid>     REVERSIBLE (delete the record) and MACHINE-VERIFIED — read back, id echoed,
 *                     typeName checked, recency checked. Four gates on the undoable one.
 *   documented:<path> reversible, weakly checked (file exists, anchor warns).
 *   ignored:<text>    IRREVERSIBLE, and checked by NOTHING. Free text. No gate at all.
 *
 * So the disposition that cannot be undone would be the only one nobody had to prove. This adds
 * the citation form — and `--reopen` below removes the irreversibility itself, because a gate that
 * can only refuse in advance is not enough for a door that would otherwise be one-way.
 *
 * THREE CITATION SHAPES, each verified the way that KIND of thing is verified:
 *   covered:<uuid>            → read the record back from the store, exactly as `stored:` does, but
 *                               WITHOUT the recency gate: "already covered" means an OLD record.
 *                               That is the whole point, so requiring recency would be backwards.
 *   covered:§N                → shorthand for a repo that keeps a numbered-section conventions
 *                               doc at `docs/development/CONVENTIONS.md` (`### N. Title` headings)
 *                               — resolves the section number against it, if present.
 *   covered:<path>[#anchor]   → the general form: any real path in the working tree, via docExists.
 *
 * Bare `ignored:<reason>` stays LEGAL and unverified, deliberately: "not durable", "point-in-time",
 * "this was a transient observation" are real dispositions with nothing to cite, and forcing a
 * citation there would only teach the agent to invent one. The citation form is the documented
 * default for *"already covered"* — the claim that has something to be wrong about.
 */
async function coveredExists(ref) {
  const c = String(ref || '').trim();
  if (!c) return { ok: false, why: 'ignored:covered: needs a citation (a record id, a §N, or a path)' };
  if (/^[0-9a-f-]{16,}$/i.test(c)) {
    // `requireRecent: false` — see the header. A covering record is old BY DEFINITION.
    const v = await recordExists(c, { requireRecent: false });
    return v.ok ? { ok: true, note: `covered by record ${c} (${v.typeName || 'record'})` } : v;
  }
  const sec = c.match(/^§\s*(\d+)/);
  if (sec) return sectionExists(sec[1]);
  const v = docExists(c);
  return v.ok ? { ok: true, note: `covered by ${v.note}` } : v;
}

/**
 * The directory that carries the `docs/development/CONVENTIONS.md` landmark, found by walking up
 * from the working directory — or null. The landmark is the `§N` shorthand's own convention (see
 * `sectionExists` below): a project without that file simply has no `§N` shorthand, and callers
 * use the general path-citation form instead.
 */
function conventionsRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'docs', 'development', 'CONVENTIONS.md'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The top level of the git working tree the process is inside — or null when it is not inside
 * one (or git is missing or too slow). A linked worktree answers with its OWN top level, which is
 * what a citation should be bounded by.
 */
function gitTopLevel() {
  // GIT_DIR and friends would make git answer for a repository other than the one the working
  // directory is in (with GIT_DIR set and no work tree, the "top level" is the working directory
  // itself, which is the parent-of-checkouts case this lookup exists to refuse).
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[k];
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    }).trim();
    return out ? path.resolve(out) : null;
  } catch { /* silence-ok: not a repo, no git, or git timed out — all mean "no root from git", and
      the caller's refusal (naming the working directory) is the receipt. */ return null; }
}

/**
 * The PROJECT ROOT a `documented:`/`covered:` path is bounded by — or null when there is none.
 * Two ways to find it, in this order:
 *
 *   1. A directory up to eight levels above the working directory that carries
 *      `docs/development/CONVENTIONS.md` (a project that keeps the numbered-section convention).
 *   2. The git top level, for every other project. Most projects have no such file, and for them
 *      step 1 alone refused every path citation, whatever the working directory.
 *
 * The working directory has to be inside the project: from the runtime directory, or any directory
 * beneath it (not a project, even when a dotfiles repository above it makes it a git working
 * tree), a path citation is refused, and the refusal says to run from the project.
 *
 * USED BY `docExists`: bounding against `process.cwd()` instead breaks both directions:
 *
 *   · FALSE REFUSAL. From a subdirectory a few levels into the repo, a `documented:../../TOP-
 *     LEVEL.md` citation — plainly inside the same repo — would be refused, with a diagnosis
 *     telling the agent it was pointing outside the repo. A confidently wrong diagnosis is the
 *     exact failure `sectionExists` is written to avoid below.
 *   · FALSE ACCEPTANCE. From a directory that happens to be the parent of SEVERAL sibling repo
 *     checkouts, a citation into one sibling's docs would pass — the cross-checkout case the
 *     bound exists to refuse.
 *
 * Neither step falls back to the working directory itself: a parent of several checkouts that is
 * neither carrying the landmark nor inside a git tree finds no root and every citation is refused.
 * A parent that IS inside an enclosing git tree gets that outer tree as its root, and `docExists`
 * then refuses any citation that lies inside a repository nested below it.
 */
function repoRoot() {
  const landmark = conventionsRoot();
  const git = gitTopLevel();
  // A git working tree nested BELOW the landmark directory (a separate clone inside a checkout that keeps
  // the landmark) is its own project: the deeper of the two roots wins.
  if (landmark && git) {
    const rel = path.relative(realOr(landmark), realOr(git));
    if (rel !== '' && !isOutsideRel(rel)) return { dir: git, kind: 'git' };
  }
  if (landmark) return { dir: landmark, kind: 'landmark' };
  return git ? { dir: git, kind: 'git' } : null;
}

/** True when a `path.relative` result leaves its base (or is on another drive). */
function isOutsideRel(rel) {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

/** The on-disk spelling of `p`, or `p` itself when it cannot be resolved. */
function realOr(p) {
  try { return fs.realpathSync.native(p); } catch { /* silence-ok: an unresolvable path keeps the spelling it was given, and the containment check that follows is the receipt. */ return p; }
}

/**
 * Resolve `§N` against a repo-level CONVENTIONS.md, IF one exists at `docs/development/
 * CONVENTIONS.md` with numbered `### N. Title` section headings — an opt-in convention some
 * repos keep, not a requirement this package imposes. Walks UP from cwd to find the repo, so the
 * citation works from any subdirectory without the agent knowing the layout — and REFUSES rather
 * than passing when the doc cannot be found, because "I could not check" must never render as
 * "checked".
 */
function sectionExists(n) {
  const root = conventionsRoot();
  {
    const p = root && path.join(root, 'docs', 'development', 'CONVENTIONS.md');
    if (p) {
      let body = '';
      try { body = fs.readFileSync(p, 'utf8'); }
      catch (e) { return { ok: false, why: `found CONVENTIONS.md but could not read it (${e.code}) — cannot verify §${n}` }; }
      const re = new RegExp(`^#{2,4}\\s*${n}\\.\\s`, 'm');
      if (re.test(body)) return { ok: true, note: `covered by CONVENTIONS §${n}` };
      /**
       * NAME THE CHECKOUT AS A CAUSE. This resolves against the WORKING TREE, so a branch that is
       * behind its upstream legitimately lacks sections that exist. Measured directly: a new
       * section landed upstream while a local checkout was a few commits behind, so a citation to
       * it — correct at HEAD — was refused with "no such section". The refusal is right (the
       * check genuinely cannot verify it from a stale checkout); the DIAGNOSIS was confidently
       * wrong, and a wrong diagnosis is worse than none because it is believed. This gate exists
       * because a stale doc misled someone; it must not become a stale checkout misleading the
       * next person in the same way.
       */
      const highest = [...body.matchAll(/^#{2,4}\s*(\d+)\.\s/gm)].map((m) => +m[1]).reduce((a, b) => Math.max(a, b), 0);
      return {
        ok: false,
        why: `CONVENTIONS.md in THIS WORKTREE has no §${n} (highest here: §${highest}). Either the citation is wrong, `
          + `or this checkout is BEHIND — a section added on main is not here until you rebase. Check with `
          + `\`git fetch && git show origin/main:docs/development/CONVENTIONS.md | grep '^### ${n}\\.'\` before assuming the citation is bad.`,
      };
    }
  }
  return { ok: false, why: `could not locate docs/development/CONVENTIONS.md from ${process.cwd()} — cannot verify §${n}; cite a path or a record id instead` };
}

/** Verify a `documented:<path>[#anchor]` claim against the working tree. */
function docExists(ref) {
  const [rel, anchor] = String(ref).split('#');
  if (!rel) return { ok: false, why: 'documented: needs a file path' };
  /**
   * CONTAIN IT TO THE WORKTREE — bounded against the DISCOVERED ROOT, not `cwd`.
   *
   * `cwd` is wherever the agent happens to be, so bounding against it fails in both directions:
   *   · FALSE REFUSAL — from a subdirectory a few levels into the repo (e.g. `<repo>/some/nested/
   *     dir`), `documented:../../TOP-LEVEL.md` is plainly inside the repo and would be refused,
   *     with a diagnosis telling the agent it pointed outside the repo entirely. A confidently
   *     wrong diagnosis is the exact failure `sectionExists` is written to avoid.
   *   · FALSE ACCEPTANCE — from the parent directory of SEVERAL sibling repo checkouts,
   *     `documented:other-checkout/docs/...` would pass: the cross-checkout case the bound exists
   *     to catch.
   *
   * NO ROOT = REFUSE, rather than falling back to `cwd`. A fallback re-admits the counterexample
   * above — from the parent of several checkouts, a sibling path is "inside cwd". If we cannot
   * find the repo we cannot check the claim, and this file's doctrine is that failing open on a
   * verification gate means there is no gate.
   *
   * ROOT-RELATIVE FIRST, cwd-relative as a FALLBACK. Bounding against the root while still
   * RESOLVING against `cwd` would print a diagnosis instructing the agent to "cite a path relative
   * to the repo root"; obeying that instruction from a nested subdirectory would produce a
   * doubled-up, nonexistent path — a verifier whose own instructions do not verify.
   *
   * So try BOTH bases and accept the one that resolves inside the tree. Root-relative is what the
   * diagnostics ask for and what a `documented:` citation means from an outside reader's
   * perspective; cwd-relative keeps `../TOP-LEVEL.md`-style citations working from a subdirectory.
   * Both candidates are containment-checked — the fallback widens which SPELLINGS are understood,
   * never which files are reachable.
   *
   * WHAT IT DOES NOT DO: the containment check on the
   * two spellings of the CITED path above is lexical; the link and nested-repository checks that follow
   * the choice of file resolve it by real path. Still agent-supplied, locally executed, read-only and
   * existence-only: hygiene against the realistic error, not a containment guarantee.
   */
  const runtime = realOr(memoryHome());
  const runtimeRel = path.relative(runtime, realOr(process.cwd()));
  if (runtimeRel === '' || !isOutsideRel(runtimeRel)) {
    return { ok: false, why: `the working directory is inside this package's runtime directory (${runtime}), which is not a project — a documented: path is resolved against your project, so run dispose.mjs from inside it (its full path works from any directory)` };
  }
  const found = repoRoot();
  if (!found) {
    return { ok: false, why: `cannot locate the project root from ${process.cwd()} (not inside a git working tree or git could not be run, and no docs/development/CONVENTIONS.md within 8 levels up) — a documented: path is resolved against your project, so run dispose.mjs from inside it (its full path works from any directory)` };
  }
  /**
   * A git root is compared by REAL path on both sides. Git reports its own spelling of the top level
   * (a long name where the working directory carries an 8.3 short one, a target where it carries a
   * junction), and a containment check between two spellings of one directory refuses the citation
   * with a confidently wrong "sibling worktree" diagnosis. The landmark root is compared the same way,
   * so the nested-repository and link checks below see one spelling of the project for either kind.
   */
  const root = realOr(found.dir);
  const cwd = realOr(process.cwd());
  const inside = (q) => !isOutsideRel(path.relative(root, q));
  const fromRoot = path.resolve(root, rel);
  const fromCwd = path.resolve(cwd, rel);
  const bases = fromRoot === fromCwd ? [fromRoot] : [fromRoot, fromCwd];
    // A DIRECTORY IS NOT A CITATION. `existsSync` alone accepted `documented:.` and
    // `documented:docs/development` — settling a candidate, permanently, against something that
    // documents nothing. Worse with an anchor: `readFileSync` throws EISDIR, the catch below
    // swallows it, and the anchor check is skipped entirely, so `documented:docs#anything` passed.
  const isFile = (q) => { try { return fs.statSync(q).isFile(); } catch { /* silence-ok: the `false`
      return IS the receipt. A stat that throws (ENOENT, EPERM, a path too long) means we cannot SHOW
      this is a file, and this gate's job is to refuse what it cannot confirm; the caller reports that
      refusal naming every base it tried, so a log here would say the same thing twice. */ return false; } };
  const p = bases.find((q) => inside(q) && isFile(q));
  if (!p) {
    // Distinguish "outside the tree" from "not there" — they call for different corrections, and
    // conflating them tells an agent its correct citation was a sibling worktree. Only claim the
    // wrong-worktree diagnosis when a candidate really does land outside.
    /**
     * THE WRONG-WORKTREE DIAGNOSIS IS ONLY EARNED WHEN NO BASE LANDS INSIDE THE TREE.
     *
     * With two bases, one can escape while the other is inside-and-merely-missing. If the escape
     * won, `documented:../docs/typo.md` from a nested subdirectory would be told it was "probably
     * pointing at a sibling repo" when the real problem was a typo under `<repo>/docs/`. A refusal
     * the reader believes and acts on is worse than a vague one.
     */
    /**
     * PREFER AN ESCAPED BASE THAT ACTUALLY EXISTS. Suppressing the wrong-worktree diagnosis
     * whenever ANY base landed inside the tree would fix the typo case and break the true positive:
     * from a nested subdirectory, `documented:../../sibling-repo/TOP-LEVEL.md` is a real
     * sibling-checkout path, but the cwd-relative base is nominally inside, so the agent would be
     * told "does not exist" while the first path listed under "tried" was sitting on disk.
     *
     * The discriminator is EXISTENCE, not insideness: an escaped candidate that exists is a real
     * wrong-worktree citation and deserves the specific diagnosis; an escaped candidate that does
     * not exist is just a typo, and "does not exist" is the honest answer.
     */
    const escaped = bases.find((q) => !inside(q) && fs.existsSync(q))
      || (bases.some(inside) ? null : bases.find((q) => !inside(q)));
    if (escaped) {
      return { ok: false, why: `${rel} resolves to ${escaped}, which is OUTSIDE this worktree (${root}) — cite a path relative to the repo root; if that file exists, you are probably pointing at a sibling worktree` };
    }
    return { ok: false, why: `${rel} does not exist — tried ${bases.join(' and ')} (repo root ${root}, cwd ${process.cwd()})` };
  }
  /**
   * RECORD THE RESOLVED, ROOT-RELATIVE PATH — not the spelling the agent typed.
   *
   * A repo can plausibly have two files with the same base name at different depths (a root-level
   * doc and a same-named one in a subdirectory). From a nested subdirectory, `documented:TOP-
   * LEVEL.md` resolves root-first to the ROOT file. Either is defensible; recording the bare
   * string `TOP-LEVEL.md` is not, because the disposition is PERMANENT and a reader cannot tell
   * which file was actually verified. `note` is carried into the queue append as a separate
   * `resolved` field (see the append).
   */
  // No `|| '.'` fallback: the only input that produces an empty relative path is `documented:.`,
  // i.e. the repo root itself, which the isFile() gate above refuses. Codifying a degenerate input
  // to make it render is the wrong direction; refuse it instead.
  /**
   * A GIT root is only the project when no other repository sits between the cited file and it. With
   * an enclosing repository (a dotfiles repository at the home directory, a checkout that holds
   * nested clones, submodules or linked worktrees under it) the top level is the OUTER tree, and a
   * citation into a sibling or nested checkout would otherwise be accepted from a directory that is
   * merely inside the outer one: the cross-checkout acceptance the rest of this function refuses.
   */
  {
    // The cited file is followed through links first: a link inside the tree that leads into another
    // checkout is that checkout's file, not this project's.
    const real = realOr(p);
    if (!inside(real)) {
      return { ok: false, why: `${rel} resolves through a link to ${real}, which is outside the project root ${root} — cite a file that lives in the project` };
    }
    for (let d = path.dirname(real); path.relative(root, d) !== '' && inside(d); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) {
        return { ok: false, why: `${rel} lies inside a different git repository (${d}) than the project root ${root} — a nested checkout or submodule is not part of this project; cite a file in the project itself` };
      }
    }
  }
  const noted = path.relative(root, p).split(path.sep).join('/');
  if (!anchor) return { ok: true, note: noted };
  // Lenient on the anchor: heading->slug rules vary and a near-miss should not block a real edit.
  let body = '';
  try { body = fs.readFileSync(p, 'utf8'); } catch { return { ok: true, note: noted }; }
  const slugs = (body.match(/^#{1,6}\s+.+$/gm) || []).map((h) =>
    h.replace(/^#+\s+/, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
  /**
   * ALSO honour the `**Slug:**` declaration GOTCHAS.md uses to identify each entry.
   *
   * The heading check alone warned on every CORRECT GOTCHAS pointer, because a gotcha is
   * identified by its declared slug, not by its prose heading. A warning that fires on the right
   * answer is worse than no warning: it teaches the reader to skip it, and then it cannot be heard
   * when it is right. (Found by disposing this session's own candidates: 4 of 5 anchors were
   * genuinely wrong prose and the warning was correct; the 5th was this gap.)
   *
   * TWO spellings here are deliberate, and each cost a run:
   *   - NOT ^-anchored. The real line is "**Area:** docs " + separator + " **Slug:** <slug>", so the
   *     slug is mid-line; an anchored regex finds ZERO of the 81 declarations and silently does
   *     nothing. The count is the discriminator, not the pass/fail.
   *   - ` IS a backtick, escaped on purpose. Spelled literally, the static scanners read it as a
   *     template delimiter (tests/lintlib.mjs does not parse regex literals), the file unbalances,
   *     and receipt-lint REFUSES it — which its self-check did, correctly, on this very edit.
   */
  for (const m of body.matchAll(/\*\*Slug:\*\*\s*\x60([^\x60]+)\x60/g)) slugs.push(m[1].toLowerCase());
  const hit = slugs.some((s) => s === anchor.toLowerCase() || s.includes(anchor.toLowerCase()));
  return { ok: true, note: noted + (hit ? `#${anchor}` : `#${anchor} (WARN: no heading/slug matches this anchor)`) };
}

function parseSpec(arg) {
  const eq = arg.indexOf('=');
  if (eq < 1) return { error: `"${arg}" is not <id>=<disposition>[:<ref>]` };
  const id = arg.slice(0, eq);
  const rest = arg.slice(eq + 1);
  const colon = rest.indexOf(':');
  const disposition = colon < 0 ? rest : rest.slice(0, colon);
  const ref = colon < 0 ? '' : rest.slice(colon + 1);
  if (!DISPOSITIONS.has(disposition)) {
    return { error: `"${disposition}" is not a disposition (${[...DISPOSITIONS].join(' | ')})` };
  }
  return { id, disposition, ref };
}

function renderList(rq, sessionId) {
  // Records UNREACHABLE reports the same shape "nothing to settle" would — the same refusal as a
  // "corrupt" queue. Printing "No pending candidates" here would be a CONFIDENT FALSE STATEMENT to
  // the one actor that can settle them; say "can't tell" instead.
  if (rq.state === 'unreachable') {
    console.error(`RECORDS UNREACHABLE for ${sessionId} — cannot list candidates.`);
    console.error(`  This is NOT "no pending candidates". Addressing lives in the record store; `);
    console.error(`  it could not be reached — check VECTROS_API_KEY / connectivity.`);
    process.exitCode = 1;
    return;
  }
  if (!rq.pending.length) {
    console.log(`No pending candidates for ${sessionId}.`);
    return;
  }
  console.log(`${rq.pending.length} pending candidate(s) for ${sessionId}:\n`);
  for (const c of rq.pending) {
    console.log(`${c.ordinal}  [${field(c.kind, NUDGE_FIELD_MAX_CHARS) || '?'} -> ${field(c.dest, NUDGE_FIELD_MAX_CHARS) || '?'}]  ${field(c.title, NUDGE_TITLE_MAX_CHARS)}`);
    console.log(`    ${field(c.body, QUEUE_BODY_MAX_CHARS)}`);
    if (c.sourceRef) console.log(`    sourceRef: ${field(c.sourceRef, NUDGE_FIELD_MAX_CHARS)}`);
    if (c.revises) console.log(`    (revises ${field(c.revises, NUDGE_FIELD_MAX_CHARS)})`);
    console.log('');
  }
  const self = `node "${process.argv[1]}"`;
  console.log('Dispose:  ' + self + ' ' + sessionId + ' c1=stored:<uuid> c2=documented:<path#anchor> c3=ignored:covered:<path|§N|uuid>');
  console.log('  `ignored:covered:<ref>` is CHECKED — the citation must resolve. Bare `ignored:<reason>` is NOT');
  console.log('  checked; use it only when there is genuinely nothing to cite (not durable, point-in-time).');
  console.log('Undo:     ' + self + ' ' + sessionId + ' --reopen <cN> [why]   # a wrong `ignored` is recoverable');
}

async function main() {
  const [rawSessionId, ...args] = process.argv.slice(2);
  if (!rawSessionId) {
    console.error('usage: node dispose.mjs <sessionId> [--list'
      + ' | --reopen <cN> [why]'
      + ' | <id>=<stored:uuid|documented:path|ignored:covered:ref|ignored:reason> ...]');
    process.exitCode = 2;
    return;
  }
  const resolved = resolveSessionId(rawSessionId);
  if (resolved.error) {
    console.error(resolved.error);
    process.exitCode = 2;
    return;
  }
  const sessionId = resolved.id;
  if (resolved.resolvedFrom) console.error(`(resolved prefix "${resolved.resolvedFrom}" -> ${sessionId})`);
  const rq = await readRecords(sessionId);
  if (!args.length || args[0] === '--list') return renderList(rq, sessionId);

  /**
   * `--reopen <cN> [why]` — THE DOOR SWINGS BOTH WAYS.
   *
   * Every gate in this file refuses a bad claim BEFORE it lands. That is necessary and it is not
   * sufficient, because a claim can PASS every gate and still be wrong on the merits: a true
   * candidate disposed as `PREMISE IS FALSE`, citing docs that are stale. No pre-flight check
   * catches that — the error is only visible LATER, when someone reads the reason and knows better.
   *
   * So the remedy is not another gate, it is reversibility. `reopen` appends an event that undoes a
   * dispose; the fold makes the candidate pending again and the ordinary nudge re-offers it. The
   * queue keeps BOTH events, so the record of what was settled — and un-settled — stays complete.
   * Nothing is rewritten, which is the property the append-only log exists to give.
   *
   * It refuses to "reopen" what was never disposed, and refuses a SUPERSEDED candidate: a `revise`
   * already replaced that claim with a corrected one, and resurrecting the old version would
   * re-offer the wrong text while its fix sits pending in the same queue.
   */
  if (args[0] === '--reopen') {
    /**
     * THE FIRST NON-`cN` ARG TERMINATES THE ID LIST. Filtering instead (every `cN`-shaped token
     * anywhere in the line is an id, everything else is joined into `why`) would make
     *
     *     --reopen c7 duplicate of c3
     *
     * reopen **c7 AND c3**. If c3 had been correctly disposed as `stored`, it would come back to
     * pending, the nudge would re-offer it, and the agent would store a duplicate record — while
     * the summary line said "2 reopened" and nothing flagged it. A prose `why` that mentions
     * another candidate is the NORMAL way to explain a reopen, so the footgun would sit directly on
     * the common path.
     *
     * Positional parsing avoids it: ids first, then the reason, and a `cN` inside the reason is
     * just words.
     */
    const rest = args.slice(1);
    let cut = rest.findIndex((a) => !/^c\d+$/.test(a));
    if (cut < 0) cut = rest.length;
    const ids = rest.slice(0, cut);
    const why = rest.slice(cut).join(' ');
    if (rq.state === 'unreachable') {
      console.error(`RECORDS UNREACHABLE for ${sessionId} — refusing to reopen anything. Nothing was written.`);
      process.exitCode = 1;
      return;
    }
    if (!ids.length) {
      console.error('usage: node dispose.mjs <sessionId> --reopen c3 [why it was wrong]');
      process.exitCode = 2;
      return;
    }
    let n = 0;
    for (const id of ids) {
      const cand = rq.all.get(id);
      if (!cand) { console.error(NO(`${id}: no such candidate in this session's queue`)); process.exitCode = 1; continue; }
      if (rq.superseded.has(id)) {
        // NOT "not disposed" — a candidate can be BOTH settled (stored/documented/ignored) AND
        // later superseded by a revise; the two sets are independent, so "not disposed" would be
        // false whenever both are true. The refusal itself is correct either way — reopening a
        // superseded candidate is never right.
        console.error(NO(`${id}: was SUPERSEDED by a revise — a later run already corrected this claim, `
          + 'whether or not it was also settled first. Reopening it would re-offer the version that '
          + 'was found wrong; settle the revision instead.'));
        process.exitCode = 1;
        continue;
      }
      if (!rq.disposed.has(id)) { console.log(`  SKIP ${id}: not disposed — nothing to reopen`); continue; }
      /**
       * REOPENING A `stored`/`documented` DISPOSAL IS A DIFFERENT ACT, and every doc string
       * (nudge.mjs, this file's own header) presents `--reopen` as the undo for a wrong
       * `ignored`. Undoing a `stored` one puts a candidate back in the queue whose content is
       * ALREADY IN THE STORE — the nudge re-offers it and the obvious next move creates a duplicate
       * record. It is still allowed (the disposal may genuinely have been wrong), but it must not be
       * indistinguishable from the case the feature was built for.
       *
       * `prior` comes straight off the record `readRecords` already fetched — no second read
       * needed: the record's own `disposition` field IS the last disposition, always, since a
       * `reopen` here is what would change it.
       */
      const prior = cand.disposition;
      if (prior && prior !== 'ignored') {
        console.log(`  WARN ${id}: was disposed as '${prior}', not 'ignored'. Reopening it re-offers a candidate whose`);
        console.log(`       content is already ${prior === 'stored' ? 'IN THE STORE — settling it again is how you get a DUPLICATE record' : 'IN A DOC — settle it as documented again, not as a new write'}.`);
      }
      // RECORD FIRST — this is the write that determines success. A failure here means
      // NOTHING happened (the candidate is still settled exactly as it was); the file backup
      // below only ever runs after this succeeds.
      const reopened = await reopenRecord(cand.id, why || '');
      if (!reopened) {
        console.error(NO(`${id}: RECORD REOPEN FAILED — nothing was written (records unreachable or refused it). `
          + 'Still disposed exactly as before; re-run once reachable.'));
        process.exitCode = 1;
        return;
      }
      audit(sessionId, `REOPEN ${id}${why ? ' — ' + why : ''}`);
      console.log(OK(`${id} reopened — it is pending again and the nudge will re-offer it`));
      await backupToFile(sessionId, id, cand.externalId, { op: 'reopen', why: why || null });
      n++;
    }
    console.log(`\n${n} reopened.`);
    return;
  }

  /**
   * FAIL CLOSED when records is unreachable — before parsing a single spec.
   *
   * Without this, `rq.all` is an empty Map and every candidate falls through to *"no such candidate
   * in this session's queue"*: a precise, confident, WRONG diagnosis. It names the candidate as the
   * problem when the problem is the reader, and it points the agent at the one conclusion that
   * guarantees data loss — "that candidate never existed, drop it" — when the truth is the opposite:
   * every candidate is still there and still pending.
   *
   * Refusing outright (rather than best-effort-ing on an empty map) is worth it for the same reason
   * it was worth it against a corrupt file: we cannot check that the id exists or is still pending,
   * so we would be writing unverifiable settlements against the one store that is supposed to be
   * the record of what was settled. Refuse, and say exactly why.
   */
  if (rq.state === 'unreachable') {
    console.error(`RECORDS UNREACHABLE for ${sessionId} — refusing to dispose anything.`);
    console.error(`  Nothing was written. Your candidates are NOT gone; addressing lives in the record `);
    console.error(`  store and it could not be reached.`);
    process.exitCode = 1;
    return;
  }

  // ── Phase 1: parse + verify EVERYTHING. No writes yet.
  const specs = [];
  const errors = [];
  const skips = [];
  for (const a of args) {
    const s = parseSpec(a);
    if (s.error) { errors.push(NO(s.error)); continue; }
    const cand = rq.all.get(s.id);
    if (!cand) { errors.push(NO(`${s.id}: no such candidate in this session's queue`)); continue; }
    if (!rq.pending.some((c) => c.ordinal === s.id)) {
      // Idempotent: already disposed (or superseded by a REVISE) is a no-op, not an error.
      skips.push(`  SKIP ${s.id}: already settled (disposed or superseded) — no re-append`);
      continue;
    }
    if (s.disposition === 'stored') {
      const v = await recordExists(s.ref);
      if (!v.ok) { errors.push(NO(`${s.id}: ${v.why}`)); continue; }
      specs.push({ ...s, note: `record ${s.ref} verified (${v.typeName || 'record'})`, externalId: cand.externalId, recordId: cand.id });
    } else if (s.disposition === 'documented') {
      const v = docExists(s.ref);
      if (!v.ok) { errors.push(NO(`${s.id}: ${v.why}`)); continue; }
      specs.push({ ...s, note: v.note, externalId: cand.externalId, recordId: cand.id });
    } else if (/^covered:/i.test(s.ref || '')) {
      /**
       * CASE-INSENSITIVE, because the failure mode of a near-miss is SILENT DOWNGRADE. `Covered:`
       * would have fallen through to the bare arm: exit 0, candidate settled, no verification, and
       * a NOTE the agent had no reason to read closely — the citation it wrote was simply never
       * checked. A gate that quietly stops being a gate on a capitalisation is not a gate.
       */
      const v = await coveredExists(s.ref.replace(/^covered:/i, ''));
      if (!v.ok) { errors.push(NO(`${s.id}: ${v.why}`)); continue; }
      specs.push({ ...s, note: v.note, externalId: cand.externalId, recordId: cand.id });
    } else {
      /**
       * BARE `ignored:<reason>` — legal, unverified, and LOUD about which of those it is.
       *
       * It stays legal because "not durable" and "point-in-time" are real dispositions with nothing
       * to cite, and demanding a citation there teaches the agent to invent one. But the agent must
       * see, at the moment it settles, that this particular claim was taken on trust — and that the
       * cited form exists. A bare `ignored:PREMISE IS FALSE` whose premise was in fact true is the
       * case to interrupt; a line saying "nothing checked this" is the cheapest thing that can.
       */
      if (!s.ref) skips.push(`  NOTE ${s.id}: ignored with no reason — a reason is how the next session knows this was judged, not missed`);
      else skips.push(`  NOTE ${s.id}: ignored — reason recorded but NOT verified. If this is "already covered", `
        + `cite it (ignored:covered:<path|§N|record-id>) and it gets checked. Reopen with --reopen ${s.id} if wrong.`);
      specs.push({ ...s, note: s.ref || '(no reason given)', externalId: cand.externalId, recordId: cand.id });
    }
  }

  for (const l of skips) console.log(l);

  if (errors.length) {
    console.error('\nNOTHING was disposed — every spec must verify first (a false claim destroys the candidate):\n');
    for (const e of errors) console.error(e);
    console.error('\nFix the failing spec(s) and re-run. Candidates remain pending; nothing was lost.');
    process.exitCode = 1;
    return;
  }

  // ── Phase 2: settle. The RECORD write is the operation that determines success — records is
  // the address space and the source of truth; the file is a backup.
  let n = 0;
  for (const s of specs) {
    /**
     * BOTH THE CLAIM AND WHAT IT RESOLVED TO. `ref` is what the agent typed; `resolved` is the file
     * or record the gate actually verified. Keeping only `ref` would let the root-relative
     * normalisation reach the terminal line and nothing else, so a `documented:
     * ../../TOP-LEVEL.md` citation from a nested subdirectory would leave a permanent record that
     * could not say which of two same-named files was checked.
     *
     * RECORD FIRST, by the real id `readRecords` already resolved — no externalId round-trip
     * needed here (that lookup shape stays in candidates.mjs for callers that only hold an
     * externalId; this one holds the id directly). A failure here means NOTHING happened for this
     * spec: still pending, exactly as before. `return`, not `continue` — matching this file's own
     * documented scope for Phase 2 failures (VALIDATION is all-or-nothing in Phase 1; a write
     * failure here is the one place partial application is possible, and it is always disclosed,
     * never silent).
     */
    const settled = await settleRecord(s.recordId, s.disposition,
      { ref: s.ref || null, resolved: s.note && s.note !== s.ref ? s.note : null });
    if (!settled) {
      console.error(NO(`${s.id}: RECORD SETTLE FAILED — nothing was written (records unreachable or refused it). `
        + `Still pending, exactly as before. ${n} disposed before this failure.`));
      process.exitCode = 1;
      return;
    }
    // The audit trail — including whether this claim was VERIFIED or taken on trust, which is the
    // distinction that matters most for an irreversible disposition.
    const checked = s.disposition === 'ignored' && !/^covered:/i.test(s.ref || '') ? 'UNVERIFIED' : 'verified';
    audit(sessionId, `${s.id} -> ${s.disposition} (${checked}) ${s.ref || '(no ref)'}`
      + (s.note && s.note !== s.ref ? ` [resolved: ${s.note}]` : ''));
    console.log(OK(`${s.id} -> ${s.disposition}  ${s.note}`));
    await backupToFile(sessionId, s.id, s.externalId, {
      op: 'dispose', disposition: s.disposition,
      ref: s.ref || null,
      resolved: s.note && s.note !== s.ref ? s.note : null,
    });
    n++;
  }
  console.log(`\n${n} disposed.`);
}

// NOT fail-open, and NOT `process.exit` (see the header): an unexpected throw must surface as a
// non-zero code, because a silent success here means a candidate the agent believes it settled.
main().catch((e) => { console.error('dispose failed: ' + (e?.stack || e)); process.exitCode = 1; });
