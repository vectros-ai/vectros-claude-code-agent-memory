/**
 * Atomic file primitives — the one safe way to write shared state from a hook.
 *
 * WHY THIS EXISTS (measured 2026-07-16, not theorised):
 *
 * Six hook processes read-modify-write ONE state file per session, and `Stop` is wired to two
 * of them (`stop.mjs` + `capture.mjs`), so every Stop races by configuration. `writeFileSync`
 * TRUNCATES then writes — a reader landing in that window gets a partial file, `JSON.parse`
 * throws, and the caller's `catch` silently hands back a fresh object.
 *
 *   Reproduced, 4 procs x 4000 cycles on one file:  5399/16000 reads torn = 33.7%.
 *
 * That is how `promptCount` went 37 -> 9 on a live session: nothing decrements it; the state was
 * reset to {} and counted back up. Every torn read ALSO silently drops `injectedIds` (recall
 * re-injects what it already showed), `orientPending` (the boundary flag), and the capture
 * offset (the delta gate re-reads the whole arc).
 *
 * THE WINDOWS TRAP — why the textbook fix is worse than the bug:
 *
 * "Write to a temp file and rename" is atomic on POSIX. On Windows, `MoveFileEx` REFUSES to
 * replace a file another process currently holds open, and a swallowed error means the write is
 * simply lost. Measured on the same harness:
 *
 *   plain temp+rename        ->  0 torn reads,  9055/16000 writes LOST (EPERM)  <- 56%!
 *   temp+rename + retry      ->  0 torn reads,     5/16000 writes lost (0.03%)
 *
 * So the naive fix stops the corruption and silently throws away half the data instead — it
 * would have looked healthier while losing more. The retry is not a nicety; it is the fix.
 * (This ships in the OSS package, where every Windows user would hit it.)
 *
 * ALSO: the temp name carries the pid. A shared temp path (`file + '.tmp'`) lets two concurrent
 * writers interleave into the SAME scratch file and rename the wreckage over the target —
 * exactly the bug in `project.mjs`, whose target is the auto-loaded MEMORY.md.
 *
 * WHAT THIS DOES NOT FIX: lost updates. A reads, B reads, A writes, B writes -> A's change is
 * gone. Rename makes each write whole, not serialised. For a counter that is an off-by-one; for
 * an offset that must never rewind (the capture delta gate), use an append-only log instead.
 */
import fs from 'node:fs';
import path from 'node:path'; // rollAtomic/pruneGenerations resolve the archive dir
import { tunables } from './config.mjs';

/**
 * THE RETRY BUDGET comes from the config seam via `tunables()` rather than a named import, because
 * `config.mjs` imports `readJsonSafe` from THIS file (to keep one corrupt-detector, not two) and a
 * named import would be read inside config's dead zone. That much was right.
 *
 * What the original version of this comment got WRONG, and it shipped a crash: it claimed the
 * accessor also buys late resolution ("resolves at the time it is consulted"). It does not.
 * `tunables()` memoizes on its first call, and that first call is `const V = tunables()` during
 * config's own import — so the value is fixed at import time exactly like a named export would be.
 * The accessor buys CYCLE-SAFETY and nothing else. Anyone who acts on the old sentence — adding a
 * config-reload path, say — will find `tunables()` never re-reads.
 *
 * The real hazard is below, and it is the opposite direction from the one that comment described.
 */
/**
 * ⚠ EVERY BINDING BELOW IS A HOISTED `function`, NOT A `const`, AND THAT IS LOAD-BEARING.
 *
 * THE BUG THIS FIXES, reproduced against the real modules (2026-07-29, cold review):
 *
 *     $ VECTROS_MEMORY_CONFIG=<a directory> node recall.mjs
 *     ReferenceError: Cannot access 'CONTENDED' before initialization
 *         at readJsonSafe (atomic.mjs:162)  at resolveConfig (config.mjs)  at tunables (config.mjs)
 *
 * `readJsonSafe` RUNS WHILE THIS MODULE'S OWN BODY HAS NOT YET EXECUTED. That sounds impossible
 * and is the ordinary case: every one of the nine hook entry points reaches `atomic.mjs` BEFORE
 * `config.mjs` (via `creds.mjs` or `hooklog.mjs`), so this module starts evaluating, hits
 * `import … from './config.mjs'`, and hands control to config — whose own body immediately calls
 * `readJsonSafe` to read `config.json`. Function DECLARATIONS are hoisted and initialized before
 * any module body runs, so `readJsonSafe` itself is callable; `const` bindings are in the temporal
 * dead zone until this body resumes.
 *
 * So the hazard is NOT "config's exports are in TDZ" (the direction the re-entrancy guard in
 * `config.mjs` addresses, and the direction the first version of the bootstrap test modelled). It
 * is the mirror image: THIS module's constants are in TDZ while config calls into it.
 *
 * AND IT FAILED CLOSED, SILENTLY. `readJsonSafe` returns before touching any of these on ENOENT
 * (no config file — the common case) and on a clean read, so every ordinary startup worked. It
 * threw only when `config.json` EXISTS AND CANNOT BE READ: EISDIR, EACCES/EPERM (an
 * admin-provisioned or wrong-ACL config, realistic for an adopter), EBUSY from a Windows AV or
 * indexer holding it, EMFILE under load. The hook then dies during module evaluation — before
 * `main().catch()` is installed, before anything can `hlog` — which is exactly the
 * "dead and quiet are indistinguishable" failure `hooklog.mjs` exists to prevent, arriving in the
 * module that prevents it. ESM also caches a failed evaluation, so every later import in that
 * process re-throws: the hook is wedged, not degraded.
 *
 * The rule, stated so it survives a refactor: ANY binding reachable from a function this module
 * exports must be hoisted, because this module participates in a cycle and its exports are called
 * during its own dead zone. `tests/config-bootstrap-test.mjs` reproduces the real entry order
 * (leaf first) and goes RED if any of these becomes a `const` again.
 */
function retries() { return tunables().RENAME_RETRIES; }
function retryMs() { return tunables().RENAME_RETRY_MS; }

/** Errors that mean "someone has the target open right now" — retryable on Windows. */
function isContended(code) { return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'; }

/**
 * A real synchronous sleep (not a busy spin) — the reader's open window is sub-millisecond.
 *
 * ⚠ `var`, NOT `let`, AND THAT IS THE ACTUAL FIX. The first attempt moved the `SharedArrayBuffer`
 * construction into this function and left `let _ia = null` at module scope — which changed nothing,
 * because the BINDING is what sits in the temporal dead zone, not the allocation. Verified with a
 * fixture reproducing the real leaf-first entry order: reading a module-scope `let` during the
 * cycle's bootstrap throws `ReferenceError`.
 *
 * And the consequence was invisible. The throw lands in this function's OWN `catch`, so there is no
 * crash and no log line — the retry loop simply stops sleeping. The 12 x 3ms contention budget this
 * whole module is built on (56% write loss -> 0.03%) silently became 12 back-to-back attempts with
 * ZERO delay for the duration of the bootstrap read. A degraded guarantee that reports success is
 * exactly what this discipline exists to prevent, and it was introduced by the commit fixing a
 * violation of that same discipline.
 *
 * `var` is hoisted AND initialized to `undefined`, so it has no dead zone at all. That is the whole
 * reason to reach for it here, in the one module whose exports run before its own body.
 * (PM cold pass, 2026-07-30.)
 */
var _ia; // eslint-disable-line no-var -- hoisted-and-initialized: see above, this must not be TDZ
function sleepSync(ms) {
  try {
    if (!_ia) _ia = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(_ia, 0, 0, ms);
  } catch { /* silence-ok: Atomics.wait is refused where blocking is disallowed; the retry loop then spins instead of sleeping. Slower, never wrong — no data rides on this. */ }
}

/**
 * Publish `data` at `file` atomically. Readers see the whole old file or the whole new one.
 * Returns true on success. On failure the caller MUST log — a silent lost write is the bug
 * this module exists to kill.
 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
  } catch {
    // silence-ok: the `false` return IS the receipt. This function's contract puts the log on the
    // caller ("On failure the caller MUST log"), and state.mjs:41 honours it with WRITE LOST.
    return false;
  }
  const n = retries();
  for (let i = 0; i < n; i++) {
    try {
      fs.renameSync(tmp, file); // the atomic step: swaps which content the NAME resolves to
      return true;
    } catch (e) {
      if (!isContended(e.code)) break; // a real error (ENOSPC, EROFS...) — don't spin on it
      sleepSync(retryMs());
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* silence-ok: best-effort scratch cleanup on a path that already returns false; a stranded .tmp costs bytes, and the caller is about to report the lost write. */ }
  return false;
}

/**
 * Read JSON, distinguishing the three outcomes the old `catch {}` collapsed into one:
 *   { value, state: 'fresh'   } — no file yet. Defaults are CORRECT here.
 *   { value, state: 'ok'      } — parsed.
 *   { value, state: 'unreadable' } — the read FAILED; the bytes are unknown and may be fine.
 *   { value, state: 'damaged' }    — the bytes were read and do not parse; the content is lost.
 *                                    Defaults are
 *                                 WRONG here: this is data loss, and the caller must say so.
 * Conflating 'fresh' with a read failure is precisely how a torn read became a silent reset — and
 * conflating the two FAILURES with each other is how the fix for that wedged a session forever.
 * See the `unreadable` vs `damaged` note in readJsonSafe: they need opposite responses.
 */
export function readJsonSafe(file, defaults = {}) {
  let raw;
  /**
   * RETRY ON CONTENTION — the read path had none (fixed 2026-07-16, cold panel).
   *
   * `CONTENDED` was consulted at both WRITE sites and nowhere else, so `EPERM`/`EACCES`/`EBUSY` on
   * a read — which mean "someone has this open right now", not "this file is damaged" — returned
   * a read failure, i.e. the state this function defines as *"data loss, and the caller must
   * say so"*. Callers then write the defaults back. That is the 33.7% torn-read cascade re-entering
   * through the door the fix left open, now published durably instead of transiently.
   *
   * WORSE: the atomic-write fix probably WIDENED it. Writers used to `writeFileSync`; they now
   * `renameSync` — which is exactly the Windows `MoveFileEx` contention measured at 56% on this
   * machine. The reader that most needs the retry is `evaluate.mjs` (`PostToolUse`, the most
   * frequent reader), racing `writeState` on every Stop.
   *
   * This is the fourth of four mechanisms this branch wired only at the site where its bug was
   * diagnosed — the panel's systemic finding, and the one my own accounting already named while the
   * MR claimed it fixed.
   *
   * ── `unreadable` vs `damaged`: THE DISTINCTION IS THE WHOLE CONTRACT ──
   *
   * Both used to return `state: 'corrupt'` with the difference stated only in a PROSE `why`, which
   * no caller could branch on — 2 consumers, both using it as an `hlog` format string. A receipt
   * nobody reads is not a receipt, and this one was hiding the single most consequential bit in the
   * module: **did we SEE the content?**
   *
   *   unreadable — the read itself failed. The bytes are UNKNOWN. They may be perfectly good.
   *                Writing defaults would destroy content we never looked at. -> REFUSE TO WRITE.
   *   damaged    — we read the bytes and they do not parse. Every writer renames (there is no
   *                truncating writer any more), so this is not a torn read: it is real damage, and
   *                the content is ALREADY LOST. Refusing to write leaves it damaged FOREVER —
   *                nothing else creates or repairs this file. -> WRITING DEFAULTS IS THE REPAIR.
   *
   * That asymmetry is not academic; collapsing it cost both directions on this branch. Treating
   * `damaged` as transient (refuse forever) wedges a session permanently stateless: `isFirstPrompt`
   * latches TRUE, so every prompt pays a full multi-facet orient; and `evaluate.mjs`'s `lastEvalAt`
   * defaults to 0, so its debounce always opens and never persists — a detached billed `claude -p`
   * per tool call, unbounded. Treating `unreadable` as permanent (write defaults) is the 33.7%
   * torn-read cascade, published durably.
   *
   * So the states are what callers branch on, and the prose is only for humans. `corrupt` is gone
   * as a value: it conflated "a retry fixes this" with "a retry never will", which is the same
   * founding `null`-vs-`[]` story one layer beneath where anyone was looking for it.
   */
  for (let i = 0; ; i++) {
    try { raw = fs.readFileSync(file, 'utf8'); break; }
    catch (e) {
      if (e.code === 'ENOENT') return { value: { ...defaults }, state: 'fresh' };
      // Contention is transient: spin the same 12x3ms the write path uses. Only after exhausting
      // it is "can't read" genuinely can't-tell — and THAT is worth calling corrupt.
      if (!isContended(e.code) || i >= retries()) {
        return { value: { ...defaults }, state: 'unreadable', why: `read ${e.code}${isContended(e.code) ? ` after ${retries()} retries` : ''}` };
      }
      sleepSync(retryMs());
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: { ...defaults }, state: 'damaged', why: `unparseable (${raw.length}b)` };
  }
  /**
   * A NON-OBJECT ROOT IS DAMAGED, and it has to be caught HERE because the spread destroys the
   * evidence: `{...defaults, ...null}` and `{...defaults, ...42}` are both `{...defaults}`, and
   * `{...[{CONTEXT_CAP:8000}]}` is `{"0":{…}}` — which looks like a populated object to any caller
   * downstream. So a caller cannot tell "empty config" from "the operator wrote an array".
   *
   * Every consumer of this function merges the result over a defaults OBJECT (state.mjs,
   * creds.mjs, config.mjs), so a root that is not a plain object is never usable to any of them.
   * `[{"CONTEXT_CAP": 8000}]` in a config file, or an array root in a hand-authored
   * `credentials.json`, previously read as a perfectly clean parse with nothing applied and nothing
   * said. `damaged` is the honest state: the bytes were read, and their content is not usable.
   */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      value: { ...defaults },
      state: 'damaged',
      why: `root is ${Array.isArray(parsed) ? 'an array' : typeof parsed === 'object' ? 'null' : typeof parsed}, expected an object`,
    };
  }
  return { value: { ...defaults, ...parsed }, state: 'ok' };
}

/**
 * ROLL a log aside instead of trimming it. One rename; the history survives.
 *
 * This replaces `rotateAtomic(file, keepLines)`, which read the file and rewrote the last N
 * lines — TWO latent defects in one call. (1) read -> `writeFileSync` is the truncate-in-place
 * race, on a file contended by EVERY hook in EVERY session. (2) **it destroyed the head:**
 * everything past `keepLines` was discarded, so the log could never answer "is recall firing?"
 * beyond its last 2000 lines. The instrument that exists because fail-open hooks are silent was
 * built to become amnesiac.
 *
 * CORRECTION (review, 2026-07-16) — BOTH defects were LATENT; neither had ever fired. The log sits
 * under `MAX_BYTES`, so `rotateAtomic` had never run. The original justification for this change
 * said the discard "is why the log answered for only ~21 hours while the state files went back
 * days" — **that was false, and self-contradictory with the very next clause** ("dormant only
 * because the log sat under its size threshold"): a rotation that never ran cannot have trimmed
 * anything. The real reason for the ~21h span is mundane — the log simply started then; the state
 * files are older because `orient.mjs` was wired earlier. There was no amnesia to explain.
 *
 * The fix stands on its own: the discard is real and would fire the moment the log crossed 512K,
 * on the one file that tells us whether any hook works. But the reasoning that reached for it was
 * the discipline that says "suspecting your own change? timing is not evidence" failing inside the
 * very branch that introduced that discipline — a coincidence in time was read as a cause, and the
 * number was then repeated as measured. Kept here, wrong-and-corrected, because the mistake is the
 * more useful artifact.
 *
 * A rename is a single atomic step: no read, no rewrite, nothing to interleave, and the bytes are
 * preserved rather than summarized. Appenders resolve the path per call (`appendFileSync` opens
 * and closes), so the next write simply recreates an empty log — no lost lines, no shared handle.
 *
 * Fail-open: if the rename loses the Windows EPERM race (a reader holds the file open) we simply
 * do not roll this time and try again on the next call. A missed roll costs disk, not data.
 *
 * `stamp` is injected rather than read from the clock so the caller stays testable.
 */
export function rollAtomic(file, { keepGenerations = tunables().HOOKLOG_KEEP_GENERATIONS, stamp } = {}) {
  const tag = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.${tag}`;
  const n = retries();
  for (let i = 0; i < n; i++) {
    try {
      fs.renameSync(file, dest);
      pruneGenerations(file, keepGenerations);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;       // nothing to roll
      if (!isContended(e.code)) return false;    // a real error — don't spin
      sleepSync(retryMs());
    }
  }
  return false;
}

/** Keep the newest `keep` archives of `<file>.<tag>`; delete the rest. Never throws. */
function pruneGenerations(file, keep) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file) + '.';
    const archives = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base) && !f.endsWith('.tmp'))
      .sort();                       // ISO-ish tags sort chronologically
    for (const f of archives.slice(0, Math.max(0, archives.length - keep))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* silence-ok: an archive we cannot delete costs disk, never data — and the log it belongs to is already safely rolled. */ }
    }
  } catch { /* silence-ok: pruning is hygiene, not correctness; skipping it keeps MORE history than intended, which is the safe direction to fail. */ }
}

/** Every generation of a rolled log, oldest first, including the live file. For readers. */
export function logGenerations(file) {
  const out = [];
  try {
    const dir = path.dirname(file);
    const base = path.basename(file) + '.';
    out.push(...fs.readdirSync(dir)
      .filter((f) => f.startsWith(base) && !f.endsWith('.tmp'))
      .sort()
      .map((f) => path.join(dir, f)));
  } catch { /* silence-ok: archives unreadable — the live log below is still returned, so a reader sees LESS history than exists but never fabricates any. This module cannot hlog: hooklog.mjs imports IT, so the dependency only runs one way. */ }
  try { fs.statSync(file); out.push(file); } catch { /* silence-ok: no live log yet (ENOENT is the normal case before the first hook fires) — the archives above stand on their own. */ }
  return out;
}
