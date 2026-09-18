/**
 * Hook observability — one line per invocation, to `~/.claude/vectros-memory/hooks.log`.
 *
 * WHY THIS EXISTS: every hook here is deliberately
 * FAIL-OPEN — any error, timeout, or missing config degrades to "inject nothing" so a broken
 * hook can never break a turn. That is the right behavior and it has a brutal corollary:
 *
 *     "never fired", "fired and no-op'd", and "fired and errored" are INDISTINGUISHABLE.
 *
 * `recall.mjs` read `input.user_prompt` when the payload field is `prompt`, so it returned at
 * line 1 of every real invocation. It was wired, deployed, and silently dead — noticed only by
 * reading the log, because there WAS no instrumentation to catch it. Every test fed
 * it synthetic stdin carrying `user_prompt`, so the tests confirmed the assumption rather than
 * the contract.
 *
 * A fail-open component MUST say what it did. The log is the receipt. Keep it to ONE line:
 * cheap enough to always be on, and greppable when a hook "does nothing".
 *
 * Never throws (an observability failure must not break the thing it observes).
 *
 * TEST-MODE REDIRECT. Every hook here calls `hlog` on every failure path it exercises, so
 * running the SUITE against the real hooks in-process (spawning `recall.mjs`, `sweep.mjs`'s
 * `runSweep`, etc. — which is how these tests deliberately force 400s/spawn-failures/corrupt
 * reads to prove the fail-open receipt fires) lands every one of those simulated-failure lines in
 * the PRODUCTION log: `grep FAILED hooks.log` then returns fixture noise indistinguishable from a
 * real incident. `VECTROS_HOOKLOG_PATH` overrides the target; unset (the default, every real
 * session) is unaffected. Read FRESH on every call, not memoized at import time — a memoized
 * constant would only honor the env var when it happened to be set before this module was first
 * imported, which is exactly the ESM import-hoisting trap `config.mjs`'s pure-function seam
 * exists to dodge. A re-`stat`/`join` per call is cheap next to the write it guards.
 */
import fs from 'node:fs';
import { rollAtomic } from './atomic.mjs';
import { defaultHooksLog, SID_DISPLAY_LEN } from './paths.mjs';
import { tunables } from './config.mjs';

/** Where hlog() writes THIS call. Exported so tests/tools assert against the same path in use. */
export function logPath() {
  const raw = process.env.VECTROS_HOOKLOG_PATH;
  return raw && raw.trim() ? raw : defaultHooksLog();
}
/**
 * The roll threshold, read at USE time from the config seam — NOT imported as a name.
 *
 * Same structural constraint as `atomic.mjs`: `config.mjs` imports `hlog` from this file (to emit
 * its own receipt), so a named import here would be a temporal-dead-zone read. `tunables()` is
 * re-entrancy-safe by construction. → config.mjs § tunables.
 *
 * ROLL ASIDE, DO NOT TRIM. This was `rotateAtomic(LOG, KEEP_LINES = 2000)` — keep the last 2000
 * lines, discard the rest. The discard is a real defect on the one instrument that tells us whether
 * any hook works, and it would fire the moment the log crossed the threshold.
 *
 * It had NOT fired yet (the log sits under it), and the change's original justification — that the
 * discard explained a ~21h log span — was FALSE: the log spans its own lifetime, and the state
 * files are older only because `orient.mjs` was wired earlier. → atomic.mjs § rollAtomic for the
 * full correction. Fixing a latent landmine is right; the reason given for it was not.
 *
 * Now the whole file is renamed aside and GENERATIONS are kept, and `logGenerations()` lets a
 * reader span the lot.
 */
// A hoisted DECLARATION, not a `const` arrow — same TDZ rule as atomic.mjs's `_ia`. `config.mjs`
// imports `hlog` from this file, so during the cycle's bootstrap `reportConfig` calls `hlog`, which
// calls this. A module-scope `const` would be in the dead zone: the throw lands in hlog's own inner
// catch, the roll check is silently skipped, and the comment there claims the only case is "no log
// yet".
function maxBytes() { return tunables().HOOKLOG_MAX_BYTES; }

/**
 * hlog('recall', 'injected 12 hits (orient)') -> one timestamped line.
 *
 * The APPEND is safe: a sub-4KB write to a file opened O_APPEND is atomic, which matters
 * because this log is shared by every hook in every session (~2/min of session churn alone).
 *
 * The ROTATION was NOT. It was read -> `writeFileSync` — truncate-in-place
 * on the most contended file we have, so concurrent rotations would interleave and shred the
 * log. It had never fired only because the log sits under the roll threshold; it was a landmine with a
 * size fuse, on the one instrument that tells us whether any hook works at all. → `atomic.mjs`.
 * It also *discarded* everything past the last 2000 lines; it now rolls generations instead.
 */
export function hlog(hook, msg, sessionId) {
  try {
    const log = logPath();
    try {
      // keepGenerations is left to rollAtomic's default, which reads the same seam — one
      // source, not a value threaded through a caller that has no opinion about it.
      if (fs.statSync(log).size > maxBytes()) rollAtomic(log);
    } catch { /* silence-ok: no log yet — statSync ENOENT is the normal first-write case, and appendFileSync below creates it. Nothing is lost. */ }
    const sid = sessionId ? ` [${String(sessionId).slice(0, SID_DISPLAY_LEN)}]` : '';
    fs.appendFileSync(log, `${new Date().toISOString()} ${hook.padEnd(9)}${sid} ${msg}\n`);
  } catch { /* silence-ok: THE one catch that cannot obey this discipline — this IS the logger, so its only receipt channel is itself. Observability must never break the hook it observes; a lost line is the accepted floor of the whole scheme. */ }
}
