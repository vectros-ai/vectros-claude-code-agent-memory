/**
 * THE STALE-QUEUE SWEEP.
 *
 * THE GAP. `capture.mjs` spawns the distiller only when `delta >= DELTA_GATE_CHARS` (100K). Below
 * the gate nothing fires, the queue is per-session and never revisited, and no lifecycle event is
 * usable (`SessionEnd` fires ~2/min with `reason=other`; `PreCompact` reads the FILE, so a compact
 * takes nothing from it). So the final residual of EVERY session — up to ~100K of its newest text —
 * was distilled by nothing, ever. That is the END of the arc: the conclusions, the retractions, and
 * the wrap-up where learnings are articulated. MEASURED 2026-07-20: 617K orphaned across 9 done
 * sessions.
 *
 * WHAT THIS IS. A sweep over OTHER sessions' queues, run on a Stop we were going to get anyway.
 * A session whose transcript has not grown for `STALE_SESSION_MS` (24h) is done; if it still owes
 * more than `RESIDUAL_FLOOR_CHARS`, spawn the ORDINARY distiller to drain it. The flush IS the
 * existing drain — only the trigger and its gate are new.
 *
 * WHAT IT IS NOT, and these are the load-bearing constraints:
 *
 *   • NOT a lower gate on the live session. That was Option A, and it is rejected: a low-water mark
 *     small enough to catch the tail is small enough to fire constantly mid-session, re-reading the
 *     same text every turn — the exact near-duplicate engine the content-gate rewrite removed.
 *   • NOT a new watermark. The worker is spawned with `(sessionId, transcriptPath, offset)`,
 *     identical to the normal path, and marks only what it actually read. NO NEW WATERMARK PATH
 *     MEANS THE 72%-DROP BUG CANNOT REOPEN THROUGH THIS CHANGE. We add a trigger, not a marker.
 *   • NOT a solution to paused-vs-done, because it does not need one. The watermark is honest, so an
 *     early flush of a merely-paused session costs at most one extra Haiku call; when it resumes,
 *     the next gate drains the new delta from the advanced watermark.
 *   • NOT a phantom-spend regression. Desktop spawns ~1-2 phantom Stops per minute and the current
 *     gate ignores them for free because they produce no text -> no delta -> no call. The sweep
 *     preserves that property exactly: it spawns inference ONLY for a stale session with real
 *     residual (the scan itself reads transcripts — see `runSweep` for what that costs). Phantoms have ~0 residual and are never distilled. This is the
 *     safety property the whole capture design rests on — do not add a trigger here that fires on
 *     anything other than CONTENT.
 *
 * The selection is a PURE function of rows + clock + thresholds (`selectFlushable`), so every rule
 * below is RED-provable without a transcript, a spawn, or a real `~/.claude`. → tests/sweep-test.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hlog } from './hooklog.mjs';
import { lockFor, queueDir, stateDir, sweepMarker, slug, SID_DISPLAY_LEN } from './paths.mjs';
import { read as readQueue, markSwept } from './queue.mjs';
import { isHeld, claim, release } from './lock.mjs';
// NOT `noteSkip`: this module deliberately routes its receipts to `hlog` instead — the blind-spot
// ledger is printed only by report.mjs, and the orphan scan runs inside a per-prompt process that
// exits without reading it. → `orphanedPending`.
import { isStale, residualBySession, isReal, ageOf, blindSpots } from './residual.mjs';
import { STALE_SESSION_MS, RESIDUAL_FLOOR_CHARS, SWEEP_DEBOUNCE_MS, HANDED_TTL_MS,
  MAX_FLUSH_PER_SWEEP } from './config.mjs';

/**
 * RE-EXPORTED under the name this module has always published. It was
 * `export const MAX_FLUSH_PER_SWEEP = 1` here; the value moved to the config seam, but two tests
 * and any future caller import it FROM SWEEP, so dropping the export would be a breaking change
 * dressed as a refactor — which is exactly what the suite reported when this first landed
 * (`residual-test.mjs` crashed with "does not provide an export named MAX_FLUSH_PER_SWEEP").
 * Same shape as `lock.mjs`'s `STALE_MS`.
 */
export { MAX_FLUSH_PER_SWEEP };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'capture-worker.mjs');

/** The debounce marker. Its MTIME is the clock; the file's contents are irrelevant. */
/**
 * A FUNCTION, matching `reap.mjs`'s `REAP_MARKER` and `paths.mjs`'s own stated rule. It was an
 * import-time snapshot, which honours `VECTROS_MEMORY_HOME` only if the variable happened to be set
 * before this module was first imported — a property of file order rather than intent, and exactly
 * what `paths.mjs`'s header condemns. (PM cold pass, 2026-07-30: the rule was violated in six
 * modules; the census could not see it because it hunts the literal `homedir()` pattern, not a
 * snapshot of the accessor.)
 */
export const SWEEP_MARKER = () => sweepMarker();

/**
 * How many sessions one sweep may flush. MOVED to config.mjs's SPEC — this comment predates that and is kept only for the reasoning below — it is a concurrency rail, not an
 * operating parameter, and `config.mjs` earns its keep by holding the numbers an operator would
 * actually tune.
 *
 * ONE, deliberately. Each flush is a detached drain of up to `MAX_WINDOWS_PER_RUN` (8) Haiku calls
 * at 180s each. The measured backlog was 9 orphaned sessions; flushing them all on one Stop would
 * put ~9 concurrent drains on the machine and bill the entire backlog in a single tick. At one per
 * sweep with a 10-minute debounce the same backlog drains over ~90 minutes of active work, which
 * is invisible and unhurried — the backlog is by definition not urgent, since every session in it
 * has been idle for a day.
 *
 * The cost is that the remainder waits. That is FINE, but it must never be SILENT: the receipt
 * below always reports how many were eligible and how many were deferred, because a cap that
 * quietly truncates coverage reads as "everything was handled" when it was not.
 */

/**
 * Is a sweep due? The marker's mtime against `debounceMs`.
 *
 * FAIL-OPEN TOWARD SWEEPING, and be honest about what that costs: an unreadable marker costing NO
 * sweeps is the tail loss returning silently, which is worse than an extra scan — but the scan is
 * NOT free. It parses every stale session's transcript that is not already swept (MEASURED: 1695 ms
 * / 155 MB against a 10-session backlog; ~10 ms once those are swept, via `skipSwept`). This comment
 * used to say "a readdir plus a stat per session", which was never true and was one of three places
 * asserting it. ENOENT is the normal first-run case and stays quiet; anything else leaves a receipt.
 *
 * THE `stat` SEAM IS THERE SO THE FAIL-OPEN BRANCH CAN BE TESTED AT ALL, and the reason is worth
 * recording because the first draft got it wrong. The test tried to produce an unreadable marker by
 * pointing at a DIRECTORY — but `statSync` on a directory SUCCEEDS and returns a usable mtime, so
 * the check was asserting a premise that does not hold. MEASURED on this machine (Windows 11, Node
 * via node:fs): a directory stats fine; a file used as a path component gives ENOENT (the quiet
 * branch); the only non-ENOENT throw reachable from `node:fs` is a NUL-byte path, which is a
 * synthetic `TypeError`, not an operator's failure.
 *
 * Rather than assert a platform behaviour nobody has measured — the mistake `lock.mjs`'s header
 * documents at length, where a "refutation" cited a test that contained no such measurement — the
 * reader is injectable and the test drives the branch directly. This tests the LOGIC, which is
 * ours; it does not claim to know which real-world conditions reach it.
 */
export function sweepDue(marker, nowMs, debounceMs, stat = fs.statSync) {
  try {
    const ageMs = nowMs - stat(marker).mtimeMs;
    return { due: ageMs >= debounceMs, ageMs };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      hlog('sweep', `debounce marker UNREADABLE (${e.code}) at ${marker} — sweeping anyway; the debounce is NOT being honoured this tick, so the scan (up to ~1.7s of transcript parsing while a backlog exists) may run on every Stop until this is fixed`);
    }
    return { due: true, ageMs: null };
  }
}

/**
 * Advance the debounce clock. Called BEFORE the scan, not after, and that ordering is the point: if
 * the scan or a spawn throws, the marker has already moved, so the failure costs one skipped sweep
 * instead of a hot loop retrying a broken scan on every Stop. Returns whether it landed, so the
 * caller can say so rather than assume it.
 */
export function markSweepRun(marker, nowMs) {
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(nowMs));
    return true;
  } catch (e) {
    // Fail-open: a sweep with no working debounce still does the right work, just far more often
    // than intended. But SAY SO, and do not undersell it: a
    // permanently unwritable marker means every Stop rescans — and a rescan is up to ~1.7s of
    // transcript parsing while a backlog exists, at ~2 Stops/min. An operator should be able to find
    // that in the log rather than in a CPU graph. (This used to say the work was "stats-only until
    // something is genuinely eligible"; it named the right symptom and the wrong magnitude.)
    hlog('sweep', `could NOT write the debounce marker (${e.code || e.message}) at ${marker} — the sweep will rescan on every Stop until this is fixed`);
    return false;
  }
}

/**
 * THE SELECTION RULE. Pure: rows in, a decision and a REASON per row out.
 *
 * Every skip carries its reason because "the sweep flushed nothing" has five very different
 * meanings — nothing is done yet, everything is already flushed, everything is under the floor,
 * the sessions are all live, or the enumerator refused them all — and a receipt that cannot tell
 * them apart is the ambiguity this whole subsystem exists to remove.
 *
 * THE FOUR GATES, in order, and each one is a test:
 *
 *   1. SELF. The current session is live by definition; its own tail is the normal gate's job.
 *   2. STALE. Not idle for `staleMs` -> somebody's live (or merely paused) session. Leave it. This
 *      is the "done" signal, and it is detected by ABSENCE OF GROWTH rather than by a lifecycle
 *      event, because no usable lifecycle event exists.
 *   3. FLOOR. Below `floorChars` there is not enough new text to be worth a billed call. This is
 *      what keeps phantom sessions free, so it is a safety gate, not thrift.
 *   4. ALREADY FLUSHED THIS EPISODE — `sweptAt >= lastStopAt`. Not "swept ever": a session that
 *      RESUMES gets a fresh `lastStopAt` from stop.mjs, which puts it back ahead of `sweptAt` and
 *      makes the session eligible again once it goes stale again. So the rule is exactly "one flush
 *      attempt per idle episode", which is what bounds a failing session's retries (→ queue.mjs
 *      markSwept) without permanently blacklisting a session that came back to life.
 *
 * `lastStopAt` missing with `sweptAt` present cannot pass gate 2 (unknown age is never stale, →
 * residual.mjs isStale), so gate 4 never sees a null `lastStopAt` in practice; it is written to
 * compare defensively anyway rather than relying on a neighbouring gate to protect it.
 *
 * The eligible list is ordered by residual DESC — the biggest orphaned tail is the most learning at
 * risk, and with `MAX_FLUSH_PER_SWEEP` small the order decides what actually gets flushed today.
 */
// `nowMs: _nowMs` — accepted (the real caller passes it) but not currently read by any gate below;
// `isStale(r.ageMs, staleMs)` already works off a precomputed age rather than re-deriving it from
// `nowMs` here. Kept in the signature (aliased, not dropped) so the call contract stays documented
// rather than silently narrower than what sweep.mjs actually passes.
export function selectFlushable(rows, { nowMs: _nowMs, staleMs, floorChars, currentSid, max = MAX_FLUSH_PER_SWEEP }) {
  const skipped = [];
  const eligible = [];
  for (const r of rows) {
    if (r.sid === currentSid) { skipped.push({ sid: r.sid, why: 'self (live)' }); continue; }
    if (!isStale(r.ageMs, staleMs)) { skipped.push({ sid: r.sid, why: 'not stale' }); continue; }
    /**
     * NEGATED, NOT `<`. `undefined < 2000` and `NaN < 2000` are both FALSE, so a row with a missing
     * or unmeasured residual would have PASSED the gate documented as "a safety gate, not thrift"
     * and gone on to a billed spawn. `!(x >= floor)` fails the other way: anything that is not
     * demonstrably at or above the floor is refused.
     *
     * `residualBySession` always populates the field, so this is not reachable from the shipped
     * producer today — and the justification originally written here (that a `withResidual: false`
     * flag made `residual: null` a real produced value) is GONE, because that flag was deleted when
     * its only consumer moved to a different index. The negation stays on its own merits: this
     * function is exported, tested standalone, and is THE spend gate, so it must refuse anything not
     * demonstrably above the floor rather than rely on one caller always populating a field. Gate 2
     * already null-checks explicitly (`isStale`); this is the same care, applied here too.
     */
    if (!(r.residual >= floorChars)) { skipped.push({ sid: r.sid, why: `residual ${r.residual} < floor ${floorChars}` }); continue; }
    if (r.sweptAt !== null && r.sweptAt !== undefined
        && (r.lastStopAt === null || r.lastStopAt === undefined || r.sweptAt >= r.lastStopAt)) {
      skipped.push({ sid: r.sid, why: 'already flushed this idle episode' });
      continue;
    }
    if (!r.transcriptPath) { skipped.push({ sid: r.sid, why: 'no transcriptPath (cannot locate the transcript)' }); continue; }
    eligible.push(r);
  }
  eligible.sort((a, b) => b.residual - a.residual);
  /**
   * `eligible` IS RETURNED WHOLE, and that is what fixes head-of-line blocking.
   *
   * `flush`/`deferred` describe the CAP; they are the reported shape and stay. But `runSweep` must
   * iterate the full ordered list, because an eligible session can turn out to be unspawnable at
   * claim time (a lock held by a live worker, or a STALE lock nothing has cleared). With only
   * `flush` to work from, a single wedged session at the head — and it sorts to the head precisely
   * because it has the largest residual — meant `flushed: 0` on every sweep, forever, while the
   * receipt blamed the cap. The cap must bound SPAWNS, not attempts.
   */
  return { eligible, flush: eligible.slice(0, max), deferred: eligible.slice(max), skipped };
}

/**
 * Re-exported from `config.mjs`'s SPEC, where it lives with its three sweep siblings.
 *
 * It was briefly a bare source `const` here — a fourth sweep tunable bypassing the seam, against
 * that file's own "PROVENANCE TRAVELS WITH THE DEFAULT" contract, and it is precisely the number an
 * operator reaches for when an abandoned claim strands a queue. Re-exported rather than merely
 * imported so `tests/sweep-test.mjs` and any reader of this module still find it here.
 *
 * ON PLACEMENT: this re-export must never sit between a doc block and the function it documents.
 * It first landed in exactly that gap, silently re-attributing `orphanedPending`'s documentation to
 * a re-export; `planClaimRenewals` then landed in the same gap and had to be moved out. The rule is
 * positional and absolute — a JSDoc block documents whatever is DIRECTLY below it — and since this
 * comment has now been wrong about its own neighbours twice, it states the RULE rather than a
 * snapshot of who happens to sit next to it.
 */
export { HANDED_TTL_MS };

/**
 * WHICH ORPHAN QUEUES SHOULD THIS TURN STAMP A CLAIM ON — the decision only, no I/O.
 *
 * EXTRACTED SO IT CAN BE TESTED. It lived inline in `recall.mjs`'s `main()`, which returns before
 * any of this without a live `VECTROS_API_KEY`, so the logic was structurally unreachable from a
 * test — and it shipped two regressions that a table-driven test would have caught in one pass:
 * renewal covered only `orphans[0]`, and only when the session had nothing of its own pending.
 * Both holes were in the SELECTION, which is exactly the part that need not touch the filesystem.
 *
 * The rule, in one sentence: claim what we just delivered, renew everything we already hold, and
 * write nothing we wrote recently.
 *
 *   · `delivered` gates the FIRST claim, never the renewals. A block computed and dropped for
 *     budget was never seen, so claiming it would take a queue out of circulation unread.
 *   · Renewal covers EVERY held queue, because holding is a fact about this session, not about
 *     what it happens to be rendering. Anything narrower stops renewing the moment attention
 *     moves — which is precisely when the holder is still working.
 *   · The throttle keeps this off the prompt path's write budget: renewal fires per PROMPT, and
 *     unthrottled it appends a line per prompt to a foreign queue that is fully re-parsed per
 *     prompt, for as long as the hold lasts. A quarter-TTL fires 3 renewals before expiry (30/60/90
 *     min against a 120 min TTL — the first draft said ~4, counting the expiry tick itself) before
 *     expiry while cutting the write rate to ~1 per 30 min per HELD queue instead of one per
 *     prompt. BOUNDED, not zero — an 8h hold at the 2h default still writes ~16 `handed`
 *     events. The first draft said "zero", which is the kind of round number that stops
 *     anyone checking it.
 *
 * Returns `[{ sid, why }]`; the caller does the appending and the receipts.
 */
export function planClaimRenewals({ orphans = [], pick = null, delivered = false, sessionId = null, nowMs, renewEveryMs }) {
  // No identity, no cross-session claim. `'nosession'` is the same string in every process that
  // falls back to it, so a claim keyed on it is held by everyone and released by no one.
  if (typeof sessionId !== 'string' || !sessionId.trim()) return [];
  const plan = new Map();
  if (pick && delivered) plan.set(pick.sid, 'claimed on delivery');
  for (const o of orphans) {
    if (o.handedTo !== sessionId) continue;      // not ours to renew
    if (plan.has(o.sid)) continue;               // already claiming it this turn
    // An unknown/garbled `handedAt` re-stamps rather than skipping: one append, versus a claim we
    // believe we hold silently ageing out from under us.
    if (typeof o.handedAt === 'number' && (nowMs - o.handedAt) < renewEveryMs) continue;
    plan.set(o.sid, 'renewed');
  }
  return [...plan].map(([sid, why]) => ({ sid, why }));
}

/**
 * THE CROSS-SESSION NUDGE'S SOURCE — the loop this sweep has to close.
 *
 * The sweep changes the TRIGGER, not the destination: the worker appends proposals to the swept
 * session's own queue and writes nothing to the store, so the agent still commits every candidate
 * through `dispose.mjs`, which verifies each claim. Swept candidates never bypass agent validation.
 *
 * But the nudge that surfaces pending candidates is CURRENT-SESSION ONLY (recall.mjs reads
 * `readQueue(sessionId)`). A swept session is DONE — its agent is gone — so it would never see its
 * own nudge and its candidates would sit unsettled forever. Hence: surface, cross-session, the
 * pending of FLUSHED STALE sessions ONLY.
 *
 * BOTH CONDITIONS, and the second is what keeps this scoped:
 *   • STALE — past `staleMs`, so the session is genuinely done and its residue is orphaned.
 *   • FLUSHED — carries a `swept` marker, so what is pending is the tail WE took responsibility for.
 *
 * A LIVE session's pending is NEVER surfaced to another session. Its own agent owns its own nudge,
 * and two agents settling one queue is how a candidate gets disposed twice on two different
 * judgements. This is a scoped widening of the candidate-pressure trigger, not a global one.
 */
export function orphanedPending(nowMs, { staleMs, stateDir, queueDir, forSid = null, readQueue: readQ = readQueue, listQueues = defaultListQueues, readLastStopAt = defaultReadLastStopAt, handedTtlMs = HANDED_TTL_MS } = {}) {
  // (`HANDED_TTL_MS` lives in config.mjs's SPEC with its three sweep siblings — it is an n=0 guess
  //  and the one an operator turns when a stranded claim blocks a queue, which is exactly what that
  //  seam is for. It was briefly a bare source `const` here, bypassing the file's own
  //  "provenance travels with the default" contract.)
  /**
   * ENUMERATES THE QUEUE DIR, NOT THE STATE DIR — and that is a correctness-shaped cost fix.
   *
   * THE HISTORY, because it is three lessons in one function. This began by calling the full
   * residual enumeration and filtering afterwards: MEASURED at **1818 ms per prompt**, parsing
   * **218 MB** of transcript JSONL to compute a `residual` this function never reads. Pushing the
   * staleness and no-residual filters DOWN into the enumerator took it to ~100 ms — but that
   * remainder was 2,337 state files read and `JSON.parse`d to find the handful that matter.
   *
   * The right fix is not a faster scan, it is the right INDEX. This function's question is "who has
   * UNSETTLED CANDIDATES?", and a candidate lives in a queue file. A session with no queue file
   * cannot have one — no filtering required, it simply is not in the population. MEASURED on this
   * machine: **9 queue files against 2,337 state files** (measured 2026-07-19; the state dir GROWS
   * — 2,548 on 2026-07-20, 2,816 on 2026-07-21, and unreaped until reap.mjs landed. Two different
   * counts in this tree are two different days, not a contradiction. The RATIO is the durable fact
   * and it only widens). The state read then happens only for
   * those 9, to get `lastStopAt`.
   *
   * So: enumerate queues, fold each, and read state only for the survivors. The transcript is never
   * touched at all — this consumer has no use for residual, which is the fact the first version
   * spent 218 MB failing to notice.
   *
   * The two gates below are this function's CONTRACT and stay explicit rather than being implied by
   * the enumeration: a live session's pending is never handed to another agent, and only a session
   * we actually flushed is ours to hand on.
   */
  const out = [];
  for (const sid of listQueues(queueDir)) {
    const q = readQ(sid);
    // An unreadable queue cannot be nudged about, and rendering `pending: []` for it would be
    // exactly the "no nudge looks like no candidates" conflation the queue receipts exist to stop.
    // `hlog`, NOT the blind-spot ledger. `blindSpots` lives in residual.mjs and its ONLY printer is
    // report.mjs; this runs inside recall.mjs, a per-prompt process that never prints it and then
    // exits. A receipt written where nobody reads it is silence with extra steps — and the comment
    // here used to claim the opposite.
    if (q.state === 'corrupt') { hlog('sweep', `orphan scan: queue ${String(sid).slice(0, SID_DISPLAY_LEN)} UNREADABLE — cannot tell whether it has pending candidates; not surfacing it`); continue; }
    if (!q.pending.length) continue;
    if (q.sweptAt === null || q.sweptAt === undefined) continue; // never flushed — not ours to hand on
    /**
     * THE CROSS-SESSION CLAIM. Someone else is already holding this queue, so we do not also offer
     * it — one dead session's candidates must reach ONE live agent, not every idle one. Our OWN
     * claim never blocks us (a session re-nudged about a queue it already holds is correct), and
     * the claim expires so an abandoned hand-off costs a delay rather than the candidates.
     */
    /**
     * A `handed` WITH NO HOLDER STILL BLOCKS. This read `q.handedTo && …`, which silently treated a
     * claim with a falsy `toSid` as no claim at all — the gate is the enforcement point, so a
     * malformed claim must fail CLOSED (claimed-by-unknown) rather than open.
     *
     * "MINE" IS AN EXPLICIT PREDICATE, not `handedTo !== forSid`. That expression was the fix's own
     * comment claiming it "does the right thing for `null`" — and it does not: `forSid` DEFAULTS to
     * `null` two dozen lines up, so an unknown holder and an unknown asker compare EQUAL and the
     * claimed queue is offered. Exactly the fail-open the block says it closes, asserted about the
     * code rather than about today's single caller. A claim is ours only when both sides are real
     * and identical; every other combination is somebody else's.
     */
    const heldByUs = typeof forSid === 'string' && forSid !== '' && q.handedTo === forSid;
    if (q.handedAt !== null && q.handedAt !== undefined
        && (nowMs - q.handedAt) < handedTtlMs
        && !heldByUs) {
      continue;
    }
    const ageMs = ageOf(readLastStopAt(sid, stateDir), nowMs);
    if (!isStale(ageMs, staleMs)) continue;        // live or merely paused — its agent owns its queue
    // `handedTo` rides along so recall can tell "I already hold this" from "this is new to me" —
    // the difference between RENEWING a claim and making one. → recall.mjs's renewal block.
    out.push({ sid, ageMs, pending: q.pending, handedTo: q.handedTo ?? null, handedAt: q.handedAt ?? null });
  }
  // Most-pending first: with one orphan surfaced per turn, that is the largest block of unsettled
  // learning, and it drains the backlog fastest.
  out.sort((a, b) => b.pending.length - a.pending.length);
  return out;
}

/**
 * The queue-dir index the orphan scan walks. `isReal` filters to UUID-SHAPED sids — and note what
 * that is and is not: it is a SHAPE test, not a provenance test. It excludes word-shaped test sids
 * (`nudge-test-0001`), and it does NOT exclude a UUID-shaped one — this suite writes exactly such a
 * queue into the real runtime dir (see tests/sweep-test.mjs § end-to-end). What actually keeps that
 * fixture out of a live agent's nudge is the `pending.length` gate below, not this line. Any future
 * test seeding a UUID-shaped sid WITH pending candidates, that dies before its cleanup, would be
 * offered to a live agent as somebody's orphan. (PM cold, L1.)
 * Fail-open to an empty list WITH a receipt on `hlog` — the channel this process actually writes.
 */
function defaultListQueues(dir = queueDir()) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, '')).filter(isReal);
  } catch (e) {
    if (e.code !== 'ENOENT') hlog('sweep', `orphan scan: the ENTIRE queue dir is unreadable (${e.code}) — NO swept candidates can be surfaced this turn`);
    return [];
  }
}

/**
 * `lastStopAt` for one session — the staleness clock. Read per SURVIVING queue (a handful), never
 * across the whole state dir: that directory holds thousands of phantom-session files and walking
 * it was the second cost defect here.
 */
function defaultReadLastStopAt(sid, dir = stateDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, slug(sid) + '.json'), 'utf8')).lastStopAt ?? null;
  } catch (e) {
    // No state file, or unreadable → unknown age → NOT stale (isStale fails safe on null). A
    // session we cannot date is never handed to another agent. ENOENT is ordinary; the rest is not.
    if (e.code !== 'ENOENT') hlog('sweep', `orphan scan: state for ${String(sid).slice(0, SID_DISPLAY_LEN)} unreadable (${e.code}) — age unknown, so it is treated as LIVE and not surfaced`);
    return null;
  }
}

/** Exported for the sweep's own enumeration; the sid allow-list is shared with the report. */
export { isReal };


/**
 * RUN THE SWEEP. Called from capture.mjs on a Stop, after the normal gate logic.
 *
 * Everything expensive is behind a gate, in cost order: the debounce (a stat) gates the scan,
 * which gates the spawn (the only billed thing here). At rest — the overwhelmingly common case,
 * including every phantom Stop — this costs ONE `statSync` and returns.
 *
 * THE SCAN IS NOT "STATS-ONLY", and three comments in this file used to say it was. It reads and
 * JSON-parses the transcript of every stale session that is not already swept, to compute the
 * residual the floor gate needs. MEASURED: 1695 ms / 155 MB against a 10-session backlog; ~10 ms
 * once those sessions carry a `swept` marker (`skipSwept` skips them before the parse). It runs at
 * most once per `SWEEP_DEBOUNCE_MS`, on Stop — off the reply path — so the transient is
 * acceptable; it is written down here so the next person does not have to re-measure it.
 *
 * THE LOCK IS THE EXISTING ONE, per session, keyed exactly as capture.mjs keys it. That is what
 * serializes a swept session's own late Stop against another session's sweep of it, and it is why
 * this adds no new concurrency surface. Claim BEFORE spawning, for the same reason capture.mjs
 * does: the race is between gate evaluations, not between workers.
 *
 * `markSwept` fires on a successful CLAIM+SPAWN, and on nothing else. Not on a lost lock race (a
 * live worker is already draining that session — marking it would suppress the flush that its own
 * drain may not complete), and not on a spawn failure (nothing ran; the episode is still owed).
 *
 * Never throws: capture.mjs calls this on the user's Stop path, and a sweep failure must not cost
 * the live session its own capture. The catch reports rather than swallows.
 *
 * @returns {{scanned:number, flushed:number, deferred:number, blocked:number}} — the SAME shape on
 *          EVERY path, including the not-due and no-flush early returns, so a caller never has to
 *          guard on which branch produced it.
 */
export function runSweep(currentSid, nowMs, opts = {}) {
  const marker = opts.marker || SWEEP_MARKER();
  const staleMs = opts.staleMs ?? STALE_SESSION_MS;
  const floorChars = opts.floorChars ?? RESIDUAL_FLOOR_CHARS;
  const debounceMs = opts.debounceMs ?? SWEEP_DEBOUNCE_MS;
  const max = opts.max ?? MAX_FLUSH_PER_SWEEP;
  /**
   * INJECTABLE SEAMS — every impure thing this function does. Not decoration: `runSweep` is the
   * ONLY function in this module that spends money, and it shipped with no test because `spawn`,
   * `claim`, `release` and `markSwept` were module-scope imports with nothing to grab. Three of the
   * defects found in review (head-of-line blocking, the unchecked `markSwept`, the fail-open floor)
   * all lived in exactly the half that had no seam, while the pure selection function had 44
   * checks. A test that cannot reach the spending path is not a test of the spending path.
   */
  const d = opts.deps || {};
  const _spawn = d.spawn || spawn;
  const _claim = d.claim || claim;
  const _release = d.release || release;
  const _isHeld = d.isHeld || isHeld;
  const _markSwept = d.markSwept || markSwept;
  const _enumerate = d.residualBySession || residualBySession;
  const nil = { scanned: 0, flushed: 0, deferred: 0, blocked: 0 };

  const { due, ageMs } = sweepDue(marker, nowMs, debounceMs);
  if (!due) return nil;
  // BEFORE the scan — see markSweepRun. A throw below then costs one skipped sweep, not a hot loop.
  // The return is checked because that function's doc promises a caller that says so; it logs its
  // own failure, so this adds the CONSEQUENCE (an unhonoured debounce means the scan may run on
  // every Stop) rather than repeating the cause.
  if (!markSweepRun(marker, nowMs)) {
    hlog('sweep', 'debounce clock NOT advanced — this scan runs again on the next Stop, and every Stop after it, until the marker is writable', currentSid);
  }

  // `minAgeMs: staleMs` — a session younger than the staleness threshold can NEVER pass gate 2, so
  // reading its transcript to compute a residual nobody will use is pure waste. This is the same
  // cost gate the orphan nudge needs, and it belongs here too: the sweep runs on every Stop.
  // `stats` collects what the enumerator DROPPED, so the receipt below can name the real cause
  // rather than the only cause `skipped` can still see. → residual.mjs skipSwept.
  const stats = {};
  const rows = _enumerate(nowMs, { ...(d.enumDeps || {}), minAgeMs: staleMs, skipSwept: true, stats });
  // `deferred` is deliberately NOT taken from here — see `reallyDeferred` below. The cap-shaped
  // slice is right only if the loop consumes the head in order, and it no longer does.
  const { eligible, skipped } = selectFlushable(rows, { nowMs, staleMs, floorChars, currentSid, max });

  /**
   * HOISTED ABOVE THE BRANCH so both receipts can carry it. It was computed inside the
   * `!eligible.length` arm only, so a scan that flushed one session and dropped three as unreadable
   * reported the drops NOWHERE — the exact silence the counter was added to break, surviving in the
   * busier half of the function.
   */
  const unseen = blindSpots.length;

  if (!eligible.length) {
    /**
     * SAY WHAT YOU DID, INCLUDING NOTHING, and say WHICH nothing.
     *
     * THE WORDING IS NARROWER THAN IT WAS, ON PURPOSE. It used to promise it could distinguish five
     * cases by tallying `skipped` reasons — and then `minAgeMs` was pushed into the enumerator, so
     * rows for live sessions stopped EXISTING and gates 1 and 2 had nothing left to skip. The tally
     * kept its confident shape while two of its five categories quietly became unreachable, and an
     * empty `skipped` collapsed to the literal "no sessions enumerated" — which then meant four
     * different things at once. A receipt that cannot distinguish its cases is the ambiguity the log
     * exists to remove; one that CLAIMS to and cannot is worse, because it is believed.
     *
     * So it now says exactly what it knows: how many STALE sessions were enumerated (live ones are
     * filtered before enumeration and are deliberately invisible here), and the gate tally among
     * those, plus a count of what could not be READ at all — see the `unseen` receipt below, which
     * is computed here rather than deferred to `report.mjs`. (This sentence used to say unreadable
     * inputs "surface in report.mjs's blind-spot ledger". They do not: `blindSpots` is a per-process
     * array and this process exits. The correction was added 26 lines below while the claim itself
     * survived up here — a fix landing next to its own refuted premise.)
     * Quiet but not silent: at most one line per `SWEEP_DEBOUNCE_MS`.
     */
    const by = {};
    for (const s of skipped) by[s.why.replace(/\d+/g, 'N')] = (by[s.why.replace(/\d+/g, 'N')] || 0) + 1;
    /**
     * THE STEADY-STATE CAUSE IS `skippedSwept`, NOT AN EMPTY GATE TALLY. Once the backlog drains,
     * every stale session is dropped by `skipSwept` before `selectFlushable` sees it, so `skipped`
     * is empty — and the fallback string used to assert "no session has been idle long enough",
     * which is false for every one of them. Report the drop count first; it is the answer nearly
     * every time this line fires in a healthy system.
     */
    const parts = [];
    if (stats.skippedSwept) parts.push(`${stats.skippedSwept} already flushed this idle episode`);
    const gateTally = Object.entries(by).map(([w, n]) => `${n} ${w}`).join(', ');
    if (gateTally) parts.push(gateTally);
    /**
     * AND SAY WHEN WE COULD NOT SEE — HERE, because nowhere else will.
     *
     * Two corrections to what this comment used to claim, both found by checking it against the
     * enumerator instead of against itself:
     *
     *   · NOT "the other three drops". `corrupt queue` and `total < offset` DO call `noteSkip`;
     *     `if (!s.transcriptPath) continue` (residual.mjs) does not, deliberately — it is the
     *     phantom exclusion, ~2,500 rows when measured 2026-07-20 (it GROWS — see residual.mjs), and a receipt per phantom is noise, not
     *     signal. It is not a blind spot: those sessions have nothing to measure BY CONSTRUCTION.
     *   · "they surface in report.mjs's blind-spot ledger" was FALSE HERE. `blindSpots` is a
     *     per-process in-memory array; the sweep runs inside the Stop hook, which exits. Nothing it
     *     records ever reaches `report.mjs`, so pointing the operator there pointed at silence.
     *
     * So print the count in the receipt that is actually emitted. Count, not contents — the ledger
     * carries session ids and paths, and this line lands in a shared log.
     */
    if (unseen) parts.push(`${unseen} blind-spot entr${unseen === 1 ? 'y' : 'ies'} THIS PROCESS (unreadable state/queue/transcript; one entry can be a whole-dir failure, so this is NOT a session count)`);
    const detail = parts.join(', ')
      || 'nothing stale at all — no session has been idle long enough to enumerate yet '
         + '(and nothing was dropped as unreadable — sessions with no transcriptPath are excluded '
         + 'before this point by construction, not for a fault)';
    hlog('sweep', `no flush — ${rows.length} STALE session(s) enumerated (live ones are filtered BEFORE this point, so they are deliberately not counted here): ${detail}`
      + `${ageMs === null ? '' : `; ${Math.round(ageMs / 60_000)}m since the last sweep`}`, currentSid);
    return { scanned: rows.length, flushed: 0, deferred: 0, blocked: 0 };
  }

  let flushed = 0;
  let blocked = 0;
  // Which sessions the loop actually TOUCHED — the receipt below derives `deferred` from these
  // rather than from a slice computed before the loop ran. See its comment.
  const flushedSids = new Set();
  const blockedSids = new Set();
  /**
   * ITERATE `eligible`, CAP ON SPAWNS — not on attempts. → selectFlushable's return comment.
   *
   * A session whose claim fails does not consume the budget; we move to the next one. Otherwise a
   * single unspawnable session at the head of the list (and it is at the head precisely because it
   * has the largest residual) starves the entire backlog behind it, on every sweep, forever.
   */
  for (const r of eligible) {
    if (flushed >= max) break;
    const lock = lockFor(r.sid);
    /**
     * `isHeld` FIRST, and it is not redundant with `claim` — it is the ONLY thing that clears a
     * STALE lock. `capture.mjs` calls it for the CURRENT session, which is how live sessions
     * self-heal; a done session's capture hook never runs again, so nothing would ever clear its
     * lock. A worker killed mid-drain (reboot, OOM, EMFILE) would leave a lock file that outlives
     * the session, and `claim` would return EEXIST against it until the disk was wiped.
     */
    /**
     * ONE staleness threshold for both callers — `lock.mjs`'s `STALE_MS`, now 60 min.
     *
     * This briefly passed `2 * STALE_MS` here, on the reasoning that a FOREIGN lock deserves more
     * tolerance than a session's own. It does — but hardening only this side just moved the race:
     * a sweep-spawned adoption drain runs against a session whose own `capture.mjs` may come back
     * to life mid-drain, and IT was still on 30 min, so it would unlink the live worker's lock and
     * spawn a duplicate. The threshold belongs to the resource, not to the caller. → lock.mjs.
     *
     * `tag` stays: a line about a foreign session's lock must not be filed under `capture` for a
     * session that is not capturing.
     */
    if (_isHeld(lock, r.sid, { tag: 'sweep' })) {
      blocked++; blockedSids.add(r.sid);
      hlog('sweep', `${r.sid.slice(0, SID_DISPLAY_LEN)} is already being drained (a LIVE worker holds its lock) — skipping to the next eligible session`, currentSid);
      continue;
    }
    const { proceed, owned } = _claim(lock, r.sid, { tag: 'sweep' });
    if (!proceed) {
      // Lost the claim race to a concurrent sweep or a late Stop in that session — its worker is
      // the flush, so this tick has nothing to add. Deliberately NOT marked swept: see the header.
      blocked++; blockedSids.add(r.sid);
      hlog('sweep', `${r.sid.slice(0, SID_DISPLAY_LEN)}: lost the lock race — not flushing it this tick`, currentSid);
      continue;
    }
    try {
      // `--recovered`: this session ENDED without settling, so anything distilled here is recovered
      // rather than proposed by a live session. The schema has always modelled the distinction;
      // this is the only place that can know it, and until now nothing passed it on.
      const child = _spawn(process.execPath, [WORKER, r.sid, r.transcriptPath, String(r.offset), '--recovered'], {
        // windowsHide, like every other detached spawn here: on Windows `detached` gives the child
        // its own CONSOLE, which flashes a CLI window across the user's screen. These hooks must be
        // invisible — the user never asked to watch them.
        detached: true, stdio: 'ignore', env: process.env, windowsHide: true,
      });
      child.unref();
      flushed++; flushedSids.add(r.sid);
      /**
       * CHECK THE APPEND. `append` returns false on a lost write and `queue.mjs` says outright that
       * "the `false` return IS the receipt, and it is now CHECKED" — this call site was the
       * counterexample, discarding it.
       *
       * It matters because the marker is what bounds retries: spawn succeeded, so the money is
       * already committed, but with no `swept` event gate 4 never fires. If the worker then fails
       * to advance the watermark, EVERY subsequent sweep re-spawns a billed distiller against this
       * session for the rest of its life — the exact unbounded loop `markSwept`'s header says
       * mark-on-spawn exists to prevent, arriving through the unchecked return instead.
       *
       * There is nothing to do about it here (the worker is already away), so the remedy is the
       * receipt: name the session, and name the consequence, loudly enough to be found in the log
       * before it is found in the bill.
       */
      if (!_markSwept(r.sid, r.residual)) {
        hlog('sweep',
          `${r.sid.slice(0, SID_DISPLAY_LEN)}: FLUSHED but the 'swept' marker append FAILED — the distiller IS running, `
          + 'but nothing records that. If it does not advance the watermark, every future sweep will '
          + 're-spawn a billed distiller for this session. Check the queue file is writable.', currentSid);
      }
      hlog('sweep',
        `FLUSHED ${r.sid.slice(0, SID_DISPLAY_LEN)} — ${Math.round(r.residual / 1000)}K of orphaned tail from offset `
        + `${Math.round(r.offset / 1000)}K, idle ${(r.ageMs / 3600_000).toFixed(1)}h `
        + `(stale >= ${Math.round(staleMs / 3600_000)}h, floor ${floorChars}c)`, currentSid);
    } catch (e) {
      // Release, for exactly capture.mjs's reason: the worker frees the lock in a `finally`, but it
      // never STARTED, so that finally never runs and the lock would sit for the full stale window —
      // wedging BOTH this sweep and that session's own capture for 30 minutes over an EMFILE blip.
      // The loop REACHED this session — it is neither deferred (never looked at) nor blocked by
      // another worker. Recording it here keeps it out of `reallyDeferred`, which would otherwise
      // report a spawn failure as "deferred by the cap": the mis-attribution the comment below the
      // loop forbids, reintroduced by the fix written for that comment. The receipt on this path
      // already names the real cause.
      blockedSids.add(r.sid);
      const freed = _release(lock, owned, r.sid, { tag: 'sweep' });
      const said = { released: 'lock released', 'not-ours': 'lock left alone (not ours)', failed: 'LOCK STUCK — see the release line above' }[freed];
      hlog('sweep', `flush spawn FAILED for ${r.sid.slice(0, SID_DISPLAY_LEN)} (${e?.code || e?.message || 'error'}) — ${said}; NOT marked swept, so the next sweep retries it`, currentSid);
    }
  }

  /**
   * DEFERRED IS WHAT THE LOOP NEVER REACHED — not `eligible.slice(max)`.
   *
   * The precomputed slice was correct only while the loop consumed the head in order. Once blocked
   * sessions are skipped rather than counted against the cap, the two disagree: with
   * `eligible = [a(blocked), b]` and `max = 1`, the loop flushes `b` — and the precomputed
   * `deferred` was `[b]`, so the receipt named the SAME session as both flushed and deferred, and
   * `runSweep` returned `deferred: 1` for a session it had just drained.
   *
   * That is precisely the mis-attribution the receipt three lines down exists to prevent ("a
   * receipt that names the wrong cause is worse than none, because it is believed"), introduced by
   * the fix that added the skipping. Derive it from what actually happened instead.
   */
  const touched = new Set([...flushedSids, ...blockedSids]);
  const reallyDeferred = eligible.filter((r) => !touched.has(r.sid));
  if (reallyDeferred.length || blocked || unseen) {
    /**
     * NO SILENT CAPS — and now no MIS-ATTRIBUTED ones either. The first version printed only
     * "deferred by MAX_FLUSH_PER_SWEEP" and printed it even when the real cause was a lock nothing
     * could take, so a permanently wedged sweep read as an ordinary paced one. A receipt that names
     * the wrong cause is worse than none, because it is believed (this codebase's own rule, learned
     * on a lock-release message that named the wrong component).
     */
    const parts = [];
    if (reallyDeferred.length) {
      parts.push(`${reallyDeferred.length} deferred by the cap (max=${max}): `
        + reallyDeferred.map((x) => `${x.sid.slice(0, SID_DISPLAY_LEN)}=${Math.round(x.residual / 1000)}K`).join(' '));
    }
    if (blocked) parts.push(`${blocked} skipped on a held lock (a live worker, or a claim race)`);
    // Same count the no-flush receipt carries. A scan that flushes one session and drops three as
    // unreadable used to report the drops on NEITHER path — the counter existed and nothing printed
    // it in the half of the function that does the work.
    if (unseen) parts.push(`${unseen} blind-spot entr${unseen === 1 ? 'y' : 'ies'} THIS PROCESS (not counted above)`);
    hlog('sweep', `${flushed} flushed; ${parts.join('; ')} — next sweep in ~${Math.round(debounceMs / 60_000)}m`, currentSid);
  }
  return { scanned: rows.length, flushed, deferred: reallyDeferred.length, blocked };
}
