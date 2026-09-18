#!/usr/bin/env node
/**
 * Stop / PreCompact hook — capture trigger.
 *
 * Capture is INVOLUNTARY (delegated to local inference, not the agent's discipline).
 * This thin hook fires at a turn/session boundary and
 * fire-and-forgets a DETACHED worker (`capture-worker.mjs`) that distills the session
 * into candidate PRIVATE `memory` records. Off the reply path; debounced to a few calls
 * per session (token-thrift).
 *
 * The worker PROPOSES into a per-session queue and writes NOTHING to the store (and loads
 * no MCP → orphan-safe). The AGENT commits, via dispose.mjs, which verifies every claim.
 * The old "soak the dry-run, then flip to live writes (MCP-backed reconcile)" follow-on is
 * DEAD — the soak killed it. See capture-worker.mjs for why.
 *
 * RE-ENTRANCE GUARD: no-op inside the mid-run evaluator's own nested `claude -p`.
 * Emits nothing; never blocks. Self-contained. Fail-open.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cred, workersDisabled } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { readState, writeState } from './state.mjs';
import { read as readQueue } from './queue.mjs';
import { isHeld, claim, release } from './lock.mjs';
import { transcriptLength } from './transcript.mjs';
import { runSweep } from './sweep.mjs';
import { runReap } from './reap.mjs';
import {
  orphanCapDisabled, orphanCapDue, markOrphanCapChecked, collectOrphanCandidates, planOrphanCap,
} from './orphan-cap.mjs';
import { lockFor } from './paths.mjs';
import { DELTA_GATE_CHARS, PROJECT_DEBOUNCE_MS } from './config.mjs';

if (process.env.VECTROS_RECALL_EVAL === '1') process.exit(0); // re-entrance guard

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'capture-worker.mjs');
const PROJECTOR = path.join(HERE, 'project.mjs'); // run DETACHED, never inline — see below
const ORPHAN_CAP_WORKER = path.join(HERE, 'orphan-cap-worker.mjs'); // same reason — see below
const API_KEY = cred('VECTROS_API_KEY');

/**
 * THE GATE IS CONTENT, NOT TIME.
 *
 * It was `DEBOUNCE_MS = 90_000`. A time debounce is uncorrelated with what the session actually
 * produced, so it was wrong in BOTH directions at once. Measured on one real session:
 *
 *   - median delta between runs: 5.5K chars, against a 12K window. 89% of calls re-read text
 *     they had already seen and proposed variations on it. THAT is the near-duplicate engine —
 *     not model quality. We kept asking the same question and got new answers.
 *   - one run had a 598K-char delta and read 12K of it.
 *
 * DELTA_GATE_CHARS ~100K yields ~7 calls/session, which is what the design always meant by
 * "a few calls per session". It is also what kills the ~1/min phantom Desktop sessions: they
 * produce no text, so no delta, so no call. No lifecycle event needed, no promptCount guard
 * needed — content is the whole discriminator.
 *
 * (There was a `MIN_SESSION_CHARS = 20_000` second condition, credited in this comment with
 * killing trivial sessions. It was DEAD CODE: `delta >= 100_000` implies `total >= 100_000`, so it
 * could never bind, and the delta gate was doing the work it was thanked for. Removed rather than
 * left as a knob a future engineer would tune and observe no effect from.)
 *
 * THE TAIL GAP IS CLOSED BY THE SWEEP, NOT BY THIS GATE — and the division of
 * labour is the design. This gate still ignores the tail on purpose: anything under 100K when a
 * session ends is not captured HERE, because "the session ended" is exactly what a single Stop
 * cannot tell us, and a low-water mark small enough to catch the tail fires constantly mid-session.
 * So the tail is left to `sweep.mjs`, which flushes a session's residual once it has been QUIET for
 * a day — done detected by absence of growth rather than by a lifecycle event.
 *
 * The invariant this gate proves is "the watermark never passes unread text" (true). The invariant
 * the system needs is "all text is eventually read", and the sweep is what supplies it. Do not
 * mistake the first for the second, and do not "fix" the tail by lowering this number — that is
 * Option A, and it re-explodes the call count the gate exists to bound.
 */
// (The lock's staleness window lives with the lock: `lock.mjs` § STALE_MS. It was duplicated here
// as `LOCK_STALE_MS` after the extraction and bound to nothing — precisely the knob-that-does-
// nothing this file removed `MIN_SESSION_CHARS` for.)
// The MEMORY.md projection runs on its own, slower clock: it is a CACHE REFRESH, not capture.
// Stop is the right moment (off the reply path, and it lands before the next session's
// auto-load), but the pinned set changes rarely, so ~10 min is plenty. One REST lookup + one
// atomic file write; no inference.

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  let input;
  // An unparseable payload means this hook does NOTHING, in every session, until someone notices —
  // the founding story behind this discipline, exactly (recall.mjs read the wrong field name and no-op'd for a week).
  // recall.mjs logs this; the other four entry points did not. Same shape, receipt only where the
  // bug had already been found — the same census discipline failure mode.
  try { input = JSON.parse(await readStdin()); } catch { hlog('capture', 'skip: unparseable stdin'); return; }
  const sessionId = input.session_id || 'nosession';
  const transcriptPath = input.transcript_path || '';
  const now = Date.now();
  const isPreCompact = (input.hook_event_name || '') === 'PreCompact';

  /**
   * The PreCompact boundary is marked BEFORE the API-key check, and state is read as LATE as
   * possible. Two defects, closed here:
   *
   * (1) `if (!API_KEY) return` used to sit above this, so with no Vectros credential a compacted
   *     session silently never oriented — even though marking the boundary needs no credential at
   *     all. It is the ONLY signal for a post-compact kickoff (`SessionStart` does not re-fire),
   *     and it was gated on something unrelated to it.
   *
   * (2) The read-modify-write window used to SPAN the transcript parse: readState -> parse a
   *     ~35MB JSONL (~1-3s) -> writeState(the pre-parse snapshot). `Stop` is wired to BOTH
   *     stop.mjs and capture.mjs, so they race by configuration — and because the parse sits
   *     inside capture's window, capture almost always wrote LAST and deterministically won,
   *     reverting `lastAssistant` to the previous turn's tail every ~10 minutes. That field is
   *     stop.mjs's entire output and the rolling-window query depends on it; the failure is
   *     invisible because a stale-but-plausible tail looks healthy. atomic.mjs called the residue
   *     "an off-by-one on a counter" — but the lost updates land on `lastAssistant`,
   *     `injectedIds` and `orientPending`, each the whole purpose of the hook that writes it.
   *
   * Reading immediately before each write keeps the window at microseconds instead of seconds.
   * It does not make the write atomic — that needs a lock — but it stops capture
   * from reliably clobbering a hook that had no chance.
   */
  if (isPreCompact) {
    const { value: s, state: stState } = readState(sessionId, { injectedIds: [], lastAssistant: '', promptCount: 0 });
    // Refuse only on UNREADABLE. A torn read hands back DEFAULTS; writing them would erase promptCount,
    // injectedIds and lastAssistant to mark one flag — trading the whole file for one field, at
    // the one boundary SessionStart cannot re-fire. Skipping costs the post-compact orient; the
    // write costs everything. Neither is free, and this is the cheaper loss. → state.mjs.
    if (stState === 'unreadable') {
      hlog('capture', 'PreCompact: state read UNREADABLE — orientPending NOT marked (the bytes are unknown and may be fine); the post-compact kickoff will not orient', sessionId);
    } else {
      s.orientPending = true;
      writeState(sessionId, s);
      hlog('capture', 'PreCompact — marked orientPending for the post-compact kickoff', sessionId);
    }
  }

  /**
   * ── THE REAPER. Position and gating are both deliberate; both were wrong at first.
   *
   * ABOVE the `if (!API_KEY) return` below, because it needs no credential. Underneath it, an
   * operator running without a Vectros key got unbounded growth FOREVER — and this file already
   * documents fixing exactly that defect for the PreCompact marker ~140 lines up ("`if (!API_KEY)
   * return` used to sit above this, so with no Vectros credential a compacted session silently never
   * oriented — even though marking the boundary needs no credential at all"). Same shape, same file,
   * caught only afterward.
   *
   * OUTSIDE the `WORKERS_OFF` branch, because that switch is documented as the kill switch for the
   * nested-INFERENCE workers and the reaper bills nothing — so stopping spend must not silently stop
   * pruning.
   *
   * IT HAS ITS OWN SWITCH, and it did not when this comment was first written. The original text
   * said "if the reaper ever needs disabling, that is what REAP_MAX_DELETES_PER_RUN and the windows
   * are for" — which was FALSE: that knob floors at 1, not 0, and the windows cap at 365 days. The
   * only irreversible component in the tree had no off switch while a comment asserted otherwise,
   * which is the one place a false claim gets ACTED ON (an operator reads it at 2am). Now:
   * `touch ~/.claude/vectros-memory/REAP_OFF`, or `VECTROS_MEM_REAP_OFF=1` for a child that must
   * not delete. → `reap.mjs` § reapDisabled.
   *
   * Its own try/catch, not folded into the sweep's: a shared handler would report a reaper failure as
   * `tail sweep FAILED`, a receipt naming the wrong subject — the defect `lock.mjs`'s `release` was
   * already fixed for once.
   *
   * ONE receipt, logged HERE where the sid is known. `runReap` used to hlog it too, so every reap
   * produced two lines on the one component that deletes — this discipline asks for a believable receipt, and
   * two of them per event is a reading hazard on exactly the wrong function.
   */
  try {
    const r = runReap({ now });
    if (r.receipt) hlog('reap', r.receipt, sessionId);
  } catch (e) {
    hlog('reap', `reap FAILED (${e?.code || e?.name || 'error'}) — state/ and queue/ were NOT pruned this tick; they grow ~368 files/day: ${e?.message || e}`, sessionId);
  }

  // this discipline's first half (existence — ran vs. never fired): a component that fires and no-op's must still be countable. Per-Stop cadence
  // makes a line per invocation affordable, so just say it — recall.mjs already does exactly this,
  // and the inconsistency (one rule, a receipt only where someone happened to write one) is the census discipline's own failure mode.
  if (!API_KEY) { hlog('capture', 'skip: no VECTROS_API_KEY', sessionId); return; }

  /**
   * ── THE ORPHAN CAP. Auto-ignore a genuinely record-backed orphan candidate that has been offered
   * on too many distinct calendar days with nobody settling it. → orphan-cap.mjs's own header for
   * the full design + tradeoff defense; this comment states placement, not the argument.
   *
   * BELOW THE API-KEY GATE, unlike the reaper above — the reaper prunes local files and needs no
   * credential; this component's whole job is a RECORDS write, so without a credential there is
   * nothing it could do. Placing it above would just be a no-op check on every keyless invocation.
   *
   * NOT GATED ON `WORKERS_OFF` (checked later, only around the distiller spawn below) — same
   * reasoning as the reaper's own placement: that switch is documented as the kill switch for
   * BILLED INFERENCE spend, and this component calls no Claude API at all, only a Vectros records
   * PATCH. Gating it there would silently stop a free, correctness-only backstop every time an
   * operator turns off spend, for a reason that has nothing to do with this component.
   *
   * THE CHECK IS INLINE AND CHEAP (local file reads only, no network) — `collectOrphanCandidates`/
   * `planOrphanCap` are the same pure functions `orphan-cap-worker.mjs` re-derives its own plan
   * from. The ACTUAL WRITE never happens here: it needs network, and this hook must stay fast and
   * fail-open, the same reason `capture-worker.mjs`/`project.mjs` are spawned detached rather than
   * awaited. Spawning a worker only when the cheap check finds real breaching work (rather than
   * spawning unconditionally on every debounce tick) is what keeps an idle corpus from paying a
   * process-spawn cost for nothing.
   *
   * MARKED DUE ON SPAWN, NOT ON THE WORKER'S SUCCESS — same asymmetric-cost reasoning as
   * `markSwept`'s own header: nothing observes a detached worker's exit, so "mark on spawn" is the
   * only option that does not respawn a worker every Stop for the rest of the session if this one
   * dies. A failed run still shows up: the worker's own crash receipt logs to hooks.log, and an
   * un-cleared breach simply gets caught again once ORPHAN_CAP_DEBOUNCE_MS has passed again.
   *
   * Its own try/catch, not folded into the reaper's or the sweep's, for the same reason `lock.mjs`'s
   * `release` was already fixed for once: a shared handler reports the wrong subject's failure.
   */
  try {
    const off = orphanCapDisabled();
    if (!off && orphanCapDue(now)) {
      const plan = planOrphanCap({ queues: collectOrphanCandidates() });
      if (plan.breach.length) {
        // `--apply` IS REQUIRED — the worker itself defaults to dry-run (its own header explains
        // why: an operator typing its name to inspect must never be the invocation that writes).
        // This is the one real spawn site that means it.
        const child = spawn(process.execPath, [ORPHAN_CAP_WORKER, sessionId, '--apply'], {
          detached: true, stdio: 'ignore', env: process.env, windowsHide: true,
        });
        child.unref();
        hlog('orphan-cap', `spawned worker: ${plan.stats.candidatesToSettle} candidate(s) across `
          + `${plan.breach.length} queue(s) to auto-ignore${plan.stats.candidatesDeferred ? `, ${plan.stats.candidatesDeferred} deferred past the per-run cap` : ''}`, sessionId);
      }
      markOrphanCapChecked(now);
    } else if (off) {
      hlog('orphan-cap', `skip: disabled (${off})`, sessionId);
    }
  } catch (e) {
    hlog('orphan-cap', `check FAILED (${e?.code || e?.name || 'error'}) — no worker spawned this tick, retried once due again: ${e?.message || e}`, sessionId);
  }

  /**
   * The gate. Note what is NOT here any more: PreCompact no longer forces a capture.
   * Capture reads `transcript_path` — the FILE, not the context window — so a compact takes
   * nothing from it and there is nothing to flush before one. PreCompact stays wired only to
   * mark the orient boundary (below); do not re-add a capture trigger to it.
   *
   * The watermark comes from the QUEUE (append-only, monotonic), never from `state` — a state
   * file torn read would rewind the offset and re-read the whole arc, which is the exact
   * failure the gate exists to prevent. → queue.mjs, atomic.mjs.
   */
  const q = readQueue(sessionId);
  const total = transcriptPath ? transcriptLength(transcriptPath) : 0;
  const delta = total - q.offset;

  /**
   * IN-FLIGHT LOCK + fail-closed queue read. Two defects, one guard.
   *
   * (1) A corrupt queue read reports `offset: 0`, so `delta` would be the WHOLE arc and the gate
   *     would open on a lie. Refuse.
   * (2) There was NO in-flight guard at all. The watermark only advances when a WORKER finishes a
   *     window — up to 8 x 180s ~= 24 min for a full drain — so every Stop in that window saw the
   *     same delta and spawned ANOTHER full worker. That is not just duplicate spend: `nextId(all)`
   *     is a read-modify-write over the fold, so two workers reading the same snapshot both mint
   *     `c1`, and `all.set(id, ev)` is last-write-wins => the first worker's candidates are
   *     silently destroyed. queue.mjs's headline claim ("an append log, never a read-modify-write
   *     ... no lost update") is true of the EVENTS and false of the ID ALLOCATION.
   *
   *     The old `DEBOUNCE_MS = 90_000` was incidentally serializing this; the content-gate rewrite
   *     removed it and put nothing in its place. A watermark must be worker-driven (correct, kept)
   *     and a SPAWN GUARD must prevent duplicate workers — two different jobs that got conflated.
   *
   * The lock is a file with the worker's pid + mtime, stale after LOCK_STALE_MS so a killed worker
   * cannot wedge capture forever. Fail-open on any lock error: no lock is the status quo ante.
   */
  const lock = lockFor(sessionId);
  const lockHeld = () => isHeld(lock, sessionId);

  // `let`, not `const`: the WORKERS_OFF kill switch below clears it. (Left as `const` this
  // reassignment is a runtime TypeError that `node --check` happily calls "syntax OK" — the same
  // way it blessed the `doSpawn` ReferenceError. Parse-checking a hook proves nothing; run it.)
  // NOTE: `total >= MIN_SESSION_CHARS` was dead code — delta >= 100K implies total >= 100K > 20K,
  // so it could never bind, while its comment credited it with killing the phantom sessions (the
  // delta gate does that). Removed rather than left as a knob that does nothing.
  let doCapture = Boolean(transcriptPath)
    && q.state !== 'corrupt'          // fail closed: an unreadable queue reports offset 0
    && delta >= DELTA_GATE_CHARS
    && !lockHeld();                   // a worker is already draining this session
  // The projection runs on its OWN, slower clock — it must not be starved by capture's
  // debounce (they answer different questions: "distill this turn?" vs "is the cache stale?").
  // Read state HERE, after the transcript parse above, not before it. → the header on the
  // PreCompact block: a snapshot held across that parse is what let capture revert stop.mjs.
  const { value: projState, state: projStState } = readState(sessionId, { injectedIds: [], lastAssistant: '', promptCount: 0 });
  const doProject = now - (projState.lastProjectAt || 0) >= PROJECT_DEBOUNCE_MS;

  // (The PreCompact orientation boundary is marked at the TOP of main() — it must not sit behind
  // the API-key check or the gate, because it is the only post-compact orient signal there is and
  // it needs neither a credential nor a transcript.)
  /**
   * SAY WHAT YOU DID, INCLUDING NOTHING (this discipline, wired here).
   *
   * This returned silently — and it is the COMMON path: most Stops are under the gate. So the
   * busiest decision in the system left no trace, and "the gate is working" was indistinguishable
   * from "capture.mjs is dead", which is the precise ambiguity hooklog.mjs exists to remove. This
   * discipline was censused at 1 of 6 sites; the smoke test's new "did the hook write a log line?" check
   * then caught this one independently on its first run.
   *
   * One line per Stop is affordable now that the log ROLLS instead of trimming, and it is the line
   * that answers the first question anyone asks: how much new text was there, and why no call?
   */
  /**
   * THE SWEEP RUNS HERE — ABOVE the no-op return, and that placement is load-bearing.
   *
   * Almost every Stop is under the gate, so the no-op path below is the COMMON path. Putting the
   * sweep after it would mean the tail flush fires only on the ~7 Stops per session that already
   * opened the gate — i.e. on active sessions, which are the ones with nothing to sweep. It would
   * have been the exact shape this file has already paid for twice: `if (!claimed) return` starving
   * the projector, and the "nothing to inject" guard in recall.mjs doubling as a state commit. A
   * guard that reads as "we have nothing to capture" must not also decide "and nothing else runs".
   *
   * The sweep is about OTHER sessions and is independent of this session's delta, so it is gated
   * only on its own debounce (a single `statSync` at rest — see sweep.mjs's cost order).
   *
   * WORKERS_OFF covers it, for the kill switch's whole reason for existing: flipping it must
   * silence EVERY nested inference call at once, or "are the workers responsible?" stops being a
   * one-step question. A sweep spawns the same billed distiller, so it is a worker.
   */
  let swept = null;
  if (workersDisabled()) {
    // DELIBERATELY SILENT. This used to log a line per Stop (~2/min, indefinitely) that said only
    // what the operator already knows — they created the kill-switch file. The `doCapture` branch
    // below still reports WORKERS_OFF when a capture would actually have fired, which is the case
    // worth a receipt: something was suppressed. Nothing was suppressed here unless a sweep was
    // also due, and the sweep's own debounce is what decides that.
    // silence-ok: the kill switch is operator-created and self-evident; a per-Stop line about a
    // deliberate configuration is noise, and a healthy path should stay quiet.
  } else {
    try {
      swept = runSweep(sessionId, now);
    } catch (e) {
      // The sweep is somebody else's tail; the live session's own capture is what this hook is FOR.
      // A sweep failure must never cost it, so this is caught here rather than at the outer handler
      // — and reported, because a silently dead sweep would return with no way to notice.
      hlog('capture', `tail sweep FAILED (${e?.code || e?.name || 'error'}) — no orphaned tail flushed this tick: ${e?.message || e}`, sessionId);
    }
    /**
     * THE REAPER, on the same Stop, behind its own much slower debounce (daily vs the
     * sweep's ten minutes). Rides here rather than getting its own trigger because this is already
     * the "do the housekeeping nobody asked for" moment, and it is off the reply path.
     *
     * SEPARATE try/catch, not folded into the sweep's. The two do genuinely different things and a
     * shared handler would report a reaper failure as `tail sweep FAILED` — a receipt naming the
     * wrong subject, which `lock.mjs`'s `release` was already fixed for once. The reaper is the
     * LEAST important thing this hook does and the only one that deletes, so its failure must cost
     * nothing else and must say what it actually was.
     *
     * Growth is ~368 files/day against windows of 7-90 days, so a daily run is already far more
     * often than the shortest window needs; there is nothing a per-Stop reap could catch.
     */
  }

  const sweptNote = swept && swept.flushed ? `, SWEPT ${swept.flushed} stale session(s)` : '';

  if (!doCapture && !doProject) {
    hlog('capture',
      `no-op — delta=${Math.round(delta / 1000)}K of ${DELTA_GATE_CHARS / 1000}K gate`
      + `${q.state === 'corrupt' ? ', queue UNREADABLE (refused)' : ''}`
      + `${lockHeld() ? ', worker already draining' : ''}${sweptNote}`,
      sessionId);
    return;
  }

  // NOT `state.lastCaptureAt` any more — the watermark is the queue's, and it is written by the
  // WORKER only after a run actually produces something. Marking it here would advance the
  // watermark on a distiller that crashed, silently skipping that stretch of transcript forever.
  // Refuse only on UNREADABLE: publishing defaults here erases promptCount/orientPending/
  // injectedIds to record a projection clock. The clock re-fires in 10 minutes; the state does not
  // come back. → state.mjs.
  if (doProject && projStState !== 'unreadable') {
    projState.lastProjectAt = now;
    writeState(sessionId, projState);
  } else if (doProject) {
    hlog('capture', 'projection clock NOT advanced — state UNREADABLE (the bytes are unknown and may be fine)', sessionId);
  }

  // The distiller is the other nested `claude -p`, so the kill switch must cover it too — the
  // switch's whole value is that flipping it silences EVERY nested inference call at once,
  // making "are the workers responsible?" a one-step question. (It answered no; see
  // creds.mjs § KILL SWITCH.) The PROJECTION below is deliberately NOT gated: it is a Vectros
  // REST call touching no Anthropic credential, so the MEMORY.md cache stays fresh even with
  // the inference half off.
  if (doCapture && workersDisabled()) {
    doCapture = false;
    hlog('capture', 'workers OFF (WORKERS_OFF present) — distiller not spawned', sessionId);
  }
  if (doCapture) {
    // Claim the lock BEFORE spawning. Taken here rather than in the worker because the race is
    // between GATE evaluations: the worker starts ~100ms later, and the next Stop can land first.
    // `wx` = create-exclusive: fails if it already exists, so the claim is ATOMIC. The previous
    // `lockHeld()` then `writeFileSync` was check-then-act — two Stops landing in the same
    // millisecond both saw no lock and both spawned, which is precisely the race the lock exists
    // to stop. The worker releases it in a `finally`; capture.mjs only clears it when STALE.
    /**
     * TWO FACTS, because "I may spawn" and "I hold the lock" are different questions — and one
     * boolean answering both hands this process the right to delete another's lock. The claim now
     * lives in `lock.mjs`, where it has a test for each of its three outcomes; the reasoning is
     * there. `doCapture` goes false only on a lost race.
     */
    const { proceed, owned } = claim(lock, sessionId);
    const claimed = proceed;
    if (!proceed) doCapture = false;
    /**
     * `if (!claimed) return` USED TO LIVE HERE, and it did two jobs while meaning one.
     *
     * It reads as "don't spawn the distiller" and it EXECUTES "abandon the hook" — so losing the
     * lock race skipped the projector below. And the projection clock was already committed at the
     * `lastProjectAt = now` write further up, so the system then believed it had refreshed
     * MEMORY.md for the next 10 minutes. It had not, and nothing said so. Three lines above, this
     * file insists the projection "must not be starved by capture's debounce" — and capture's LOCK
     * was starving it instead, which is the same bug through a different door.
     *
     * `doCapture` already went false on EEXIST, so falling through spawns nothing and reaches the
     * projector, which is what both clocks were promised.
     */
    if (claimed) {
      try {
        const child = spawn(process.execPath, [WORKER, sessionId, transcriptPath, String(q.offset)], {
          // windowsHide is NOT optional here: on Windows `detached: true` gives the child its OWN
          // CONSOLE by default, which flashes a visible CLI window across the user's screen every
          // time a hook fires. These hooks must be invisible — the user never asked to watch them.
          detached: true, stdio: 'ignore', env: process.env, windowsHide: true,
        });
        child.unref();
        // Logged HERE, after the claim succeeded and the spawn didn't throw — not before either,
        // which is what this line used to do. On a lost lock race (`!proceed`, above) or a spawn
        // failure (the catch below), nothing was actually distilled this tick; a log line asserting
        // "spawned" before either of those was checked lied on exactly the ticks worth knowing
        // about. Still logs the GATE's arithmetic, not just "spawned" — when the near-duplicate
        // rate or the cost moves, the first question is "how much new text did each run actually
        // see?" and the log has to answer it without a re-derivation from the transcript.
        hlog('capture',
          `spawned distiller — delta=${Math.round(delta / 1000)}K since offset ${Math.round(q.offset / 1000)}K `
          + `(total ${Math.round(total / 1000)}K, gate ${DELTA_GATE_CHARS / 1000}K, ${q.pending.length} pending)`,
          sessionId);
      } catch (e) {
        /**
         * RELEASE THE LOCK. The worker frees it in a `finally` — but the worker never STARTED, so
         * that finally never runs and the lock sits for the full LOCK_STALE_MS (30 min). Capture
         * would then be wedged for half an hour by an EMFILE/ENOMEM blip: the content gate
         * degraded back into a timer, through the one path the lock fix didn't cover.
         *
         * And the message: this was `projector spawn FAILED — MEMORY.md pinned block not
         * refreshed`, copy-pasted from the projector block below onto the DISTILLER spawn. An
         * operator debugging a wedged capture was told the wrong component had failed — a receipt
         * that names the wrong subject is worse than no receipt, because it is believed.
         *
         * `owned`, not `claimed`: release ONLY a lock this process actually created. See lock.mjs —
         * the fail-open path proceeds without owning one, and unlinking there would delete a live
         * worker's lock. `release` returns what it actually DID, so the line below reports it
         * rather than asserting it.
         */
        const freed = release(lock, owned, sessionId);
        const said = { released: 'lock released', 'not-ours': 'lock left alone (not ours)', failed: 'LOCK STUCK — see the release line above' }[freed];
        hlog('capture', `distiller spawn FAILED (${e?.code || e?.message || 'error'}) — ${said}, nothing distilled this tick`, sessionId);
      }
    }
  }

  // DETACHED, never inline. This was an inline `await refreshPinnedBlock()` on the reasoning
  // that "Stop has a 600s budget so inline is fine" — wrong thinking. The projection costs ~1.8s,
  // dominated by a COLD TLS handshake (~1.3s first call vs ~220ms warm)
  // because every hook is a fresh process that never reuses a connection. That made this hook
  // take ~4s to exit, on EVERY PreCompact (the user's compaction path) and on every 10-minute
  // Stop. A generous budget is not a licence to block the user: the projection is a CACHE
  // REFRESH and nothing waits on it, so it has no business on any synchronous path.
  if (doProject) {
    try {
      const p = spawn(process.execPath, [PROJECTOR], {
        detached: true, stdio: 'ignore', env: process.env, windowsHide: true, // see above
      });
      p.unref();
      // this discipline — say what you did. This spawn was silent, so a Stop that projected and did not
      // capture left NO trace at all: capture.mjs looked dead on one of its two normal paths.
      // Found by smoke.mjs's "did the hook write a log line?" check, which caught the no-op path
      // first and then this one — the same gap, twice, in the same hook. (project.mjs logs its own
      // outcome; this line records that the SPAWN happened, which is the part that can fail here.)
      hlog('capture', 'spawned the MEMORY.md projector (cache refresh; ~10 min clock)', sessionId);
    } catch (e) {
      hlog('capture', `projector spawn FAILED (${e.code || e.message}) — MEMORY.md not refreshed this tick`, sessionId);
    }
  }
}

/**
 * THE WIDEST FAIL-OPEN SURFACE IN THIS HOOK — and it was the silent one.
 *
 * This was `main().catch(() => {})`. ANY throw anywhere in main() lands here, so a hook that dies
 * on line one and a hook that ran perfectly and had nothing to say produced the SAME observable:
 * nothing. That is the founding story behind this discipline (a recall hook read the wrong field name and no-op'd for a
 * week) sitting on the outermost line of six different hooks — including, pointedly,
 * `recall-eval-worker.mjs`, whose own comment names a bug this construct swallowed.
 *
 * It was also invisible to this discipline's own ENFORCER: `receipt-lint-test.mjs` matched only `catch (e) {` and
 * consumed `(() => {})` as the optional binding, landing on `;` where it wanted `{`, and skipping
 * the block entirely. Six swallows, zero findings, green build. The lint reads arrow handlers now.
 *
 * Exit stays 0 and nothing rethrows: a hook must never break the user's turn. The log is the whole
 * remedy — it makes "dead" distinguishable from "quiet", which is all this discipline ever asks.
 */
main().catch((e) => {
  try { hlog('capture', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
