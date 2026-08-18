/**
 * WHERE THE RUNTIME LIVES — the one derivation of every path these hooks touch.
 *
 * WHY THIS EXISTS. `path.join(os.homedir(), '.claude', 'vectros-memory', …)` was spelled out in 17
 * runtime files and 22 test files — one convention, thirty-nine hand-rolls, no seam — and that
 * costs three separate things:
 *
 *   1. AN ADOPTER CANNOT RELOCATE THE RUNTIME. `~/.claude/vectros-memory` is not a preference here,
 *      it is a fact repeated until it became one. After the build bundles the source, it is a fact
 *      an adopter cannot reach at all — the same argument that makes the config seam a
 *      prerequisite rather than a nicety.
 *   2. THE SUITE IS NOT HERMETIC, and this is not theoretical. `tests/orient-boundary-test.mjs`
 *      case 2c asserts "an empty store injects NOTHING"; it fails on this machine because
 *      `nudge.mjs`'s cross-session orphan block finds a REAL orphaned queue belonging to a REAL
 *      other session, sitting in the one shared directory no test can point away from. Its
 *      precondition catches it and says so honestly — `ctx was 3689c` — so the failure is loud
 *      rather than silent, but the test cannot be fixed without a seam to isolate.
 *   3. A REAPER CANNOT BE TESTED. The thing under test walks `state/` and deletes from it.
 *      With one hardcoded root, exercising it means pointing it at the developer's own 5,779 live
 *      state files and hoping the retention window is right.
 *
 * FUNCTIONS, NOT CONSTANTS, AND THAT IS THE WHOLE POINT OF THE SHAPE. `hooklog.mjs`'s `logPath()`
 * already paid for this lesson and wrote it down: a memoized module constant honours an env var
 * only when it happened to be set before the module was first imported, which under ESM's hoisted,
 * evaluate-once import graph is a property of file order rather than of intent. A `path.join` per
 * call is free next to the IO it is about to address.
 *
 * A LEAF, DELIBERATELY. This module imports `node:path` and `node:os` and NOTHING else — no
 * `hooklog`, no `atomic`, no `config`. That is what lets the three bootstrap modules
 * (`config.mjs`, `atomic.mjs`, `hooklog.mjs`) all depend on it without an import cycle, and it is
 * why it cannot log: a path helper that could `hlog` would import the logger that imports the
 * writer that imports the config that needs the path. Nothing here can fail in a way worth
 * reporting anyway — `path.join` on a string does not throw.
 *
 * WHAT IS NOT HERE. Paths that are already derived from a session payload or a hook's own module
 * URL (`fileURLToPath(import.meta.url)`, the worker/prompt file locations) stay where they are:
 * they resolve against the INSTALLED code, not the runtime state, and the two move independently.
 */
import path from 'node:path';
import os from 'node:os';

/**
 * An env var set to empty or whitespace means "not set".
 *
 * The same rule `config.mjs`'s `resolveConfig` applies to `VECTROS_MEM_*`, and for the same reason:
 * `VECTROS_MEMORY_HOME=` in a shell profile or a CI job is how an operator spells "leave it alone",
 * and reading it as a literal empty path would silently relocate the entire runtime to the process
 * cwd. A footgun, not a configuration.
 */
const env = (name) => {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

/**
 * Claude Code's own config directory — the parent of `projects/`, where it writes session
 * transcripts. `CLAUDE_CONFIG_DIR` is Claude Code's documented relocation switch, so honouring it
 * means a relocated install still finds its own transcripts; unset (the overwhelmingly common case)
 * changes nothing. This module asserts only what it does — read the var if present, default if not
 * — and makes no claim about what sets it.
 */
export const claudeHome = () => env('CLAUDE_CONFIG_DIR') || path.join(os.homedir(), '.claude');

/**
 * Where THIS runtime keeps its state. `VECTROS_MEMORY_HOME` is the adopter-facing and test-facing
 * override; everything below is derived from it, so one variable relocates the whole runtime and
 * there is no second place to remember.
 */
export const memoryHome = () => env('VECTROS_MEMORY_HOME') || path.join(claudeHome(), 'vectros-memory');

/** Join under the runtime root. The one place the layout below is spelled. */
export const inMemoryHome = (...seg) => path.join(memoryHome(), ...seg);

// ── Directories.
export const stateDir = () => inMemoryHome('state');
export const queueDir = () => inMemoryHome('queue');
export const locksDir = () => inMemoryHome('locks');
export const stagedDir = () => inMemoryHome('staged');
/**
 * The candidate WRITE-AHEAD SPOOL — proposals recorded locally before they reach the store, so an
 * outage costs a delayed nudge rather than a lost lesson. Append-only, per session, folded like
 * the queue. → spool.mjs.
 */
export const spoolDir = () => inMemoryHome('spool');
export const captureLogDir = () => inMemoryHome('capture-log');
export const orphanedEditsDir = () => inMemoryHome('orphaned-edits');
/** Claude Code's transcript store — NOT ours; it is read, never written. */
export const projectsDir = () => path.join(claudeHome(), 'projects');

// ── Files. The two that already had their own override keep it: an existing escape hatch that
//    stops working is a regression for whoever set it, and both are wired into the suite today.
export const defaultHooksLog = () => inMemoryHome('hooks.log');
export const configFile = () => env('VECTROS_MEMORY_CONFIG') || inMemoryHome('config.json');
export const credentialsFile = () => env('VECTROS_HOOK_CREDENTIALS') || inMemoryHome('credentials.json');
export const workersOffFile = () => inMemoryHome('WORKERS_OFF');
/**
 * The REAPER's own kill switch, separate from `WORKERS_OFF` on purpose. `WORKERS_OFF` is documented
 * as the switch for the nested-INFERENCE workers — an operator reaches for it to stop billed spend —
 * and the reaper bills nothing, so the two were deliberately decoupled. But that left the ONE
 * irreversible component in the tree with no off switch at all, while a comment claimed the windows
 * were one. A file, not just an env var, for `creds.mjs`'s reason: hooks are fresh processes that
 * read from disk every invocation, so `touch REAP_OFF` takes effect on the very next hook with no
 * restart — which is exactly what you want from a switch you reach for while something is deleting.
 */
export const reapOffFile = () => inMemoryHome('REAP_OFF');
/** Same shape, same reason, for orphan-cap.mjs's own irreversible-ish component: a
 * `touch ORPHAN_CAP_OFF` an operator reaches for while it is auto-`ignored`-ing candidates. */
export const orphanCapOffFile = () => inMemoryHome('ORPHAN_CAP_OFF');
/**
 * "Do not promote spooled proposals to records here." A FILE, matching `REAP_OFF`/`WORKERS_OFF`,
 * because a hook is a fresh process and a new write path on the owner's live loop needs an
 * off-switch that does not require a redeploy to reach.
 *
 * It also closes a live hazard in the TEST HARNESS. `capture-worker` now ends every run with an
 * unconditional `drainAll`, and `isolate.mjs` deliberately does NOT isolate credentials (the
 * `*-real-test.mjs` files need the real ones). So any suite run that left an owed spool entry
 * behind and then spawned the worker would POST candidate records to the REAL store with the
 * owner's real key. `isolate.mjs` writes this marker, so the whole suite is structurally incapable
 * of it — rather than relying on every test remembering to clean up after itself.
 */
export const spoolOffFile = () => inMemoryHome('SPOOL_OFF');
/**
 * "Do not settle, reopen, or supersede a candidate here." `SPOOL_OFF`'s sibling for the OTHER path
 * that reaches the live store with the owner's real key — `candidates.mjs`'s `settle`/`reopen`/
 * `markSuperseded` had no equivalent gate (a real review finding, closed here):
 * they call the store directly and relied entirely on every test remembering to inject its own
 * transport, the exact "incidentally safe, not structurally safe" shape `SPOOL_OFF` exists to
 * replace. `isolate.mjs` writes this marker for the same reason it writes that one.
 */
export const verdictMutationsOffFile = () => inMemoryHome('VERDICT_MUTATIONS_OFF');
export const projectionLog = () => inMemoryHome('projection.log');
export const sweepMarker = () => inMemoryHome('last-swept');
/**
 * "The store says the `candidate` type does not exist here." A FILE, because a hook is a fresh
 * process on every invocation — an in-memory latch would be re-learned (and re-paid) every Stop.
 * Its MTIME is the whole payload: fresher than `CANDIDATE_SCHEMA_RECHECK_MS` means don't try.
 * Deleting it forces an immediate retry, which is the manual override. → candidates.mjs.
 */
export const candidateSchemaGapFile = () => inMemoryHome('candidate-schema-absent');

/**
 * Per-session paths. `slug` is shared rather than re-spelled: `queue.mjs`, `capture.mjs`,
 * `capture-worker.mjs` and `sweep.mjs` each carried their own copy of this regex, and a lock path
 * that slugs differently from the queue path that names it is a bug nobody would find by reading
 * either file alone.
 */
export const slug = (s) => String(s).replace(/[^\w.-]/g, '_');

/**
 * The one truncation length used everywhere a session id is shown for a human to read (and
 * potentially copy) rather than a machine to key on: `hooklog.mjs`'s `[abc12345]` bracket on
 * every log line, `nudge.mjs`/`recall.mjs`'s `ORPHAN-NUDGE(...)`/`ORPHANED MEMORY CANDIDATES(...)`
 * text, `report.mjs`'s tables, `sweep.mjs`'s diagnostic lines. `dispose.mjs`'s prefix-resolution
 * (`resolveSessionId`) depends on this number matching every DISPLAY site exactly — if any one of
 * them drifted to a different length independently, an id copied from it would silently stop
 * resolving (or start colliding) in dispose.mjs, the same class of bug `slug` above was extracted
 * to prevent one line up. Shared for that reason, not because it is meant to be tunable — see
 * `tunable-census-test.mjs`'s `NOT_A_TUNABLE` entry for why this is a protocol constant, not a
 * `VECTROS_MEM_*` knob.
 */
export const SID_DISPLAY_LEN = 8;

export const stateFor = (sessionId) => path.join(stateDir(), `${slug(sessionId)}.json`);
export const queueFor = (sessionId) => path.join(queueDir(), `${slug(sessionId)}.jsonl`);
export const spoolFor = (sessionId) => path.join(spoolDir(), `${slug(sessionId)}.jsonl`);
export const lockFor = (sessionId) => path.join(locksDir(), `${slug(sessionId)}.lock`);
