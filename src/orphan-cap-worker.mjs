#!/usr/bin/env node
/**
 * Orphan-cap worker (detached) — the WRITE half of the orphan-cap backstop. `orphan-cap.mjs` is
 * pure classify/plan; this is the only thing that actually settles a capped candidate, and it needs
 * network (a records write), which is why it is a detached child rather than inline in
 * `capture.mjs`'s Stop path — the same reason `capture-worker.mjs`/`recall-eval-worker.mjs` are.
 *
 * Spawned fire-and-forget by capture.mjs once its own cheap, local, synchronous check (no network)
 * finds real breaching work AND the debounce/off-switch both allow it. Re-derives its OWN plan on
 * a fresh `collectOrphanCandidates()`/`planOrphanCap()` immediately before acting rather than
 * trusting whatever the parent saw — the gap between "cheap check" and "worker actually runs"
 * spans a process spawn, and another session may have settled the candidate in between. Same
 * reasoning as `reap.mjs`'s re-check immediately before unlinking.
 *
 * ⚠ THAT RE-CHECK USED TO STOP AT THE PLAN, AND THAT WAS A REAL BUG:
 * `planOrphanCap`'s "pending" list is derived from the LOCAL FILE, which can lag the RECORD —
 * `dispose.mjs`'s own file backup is documented best-effort and can fail, and even when it
 * succeeds the record write always lands first. So a human genuinely disposing a candidate for
 * real (`stored`/`documented`) in the window between this worker's plan and its apply loop was
 * invisible to the plan, and `settleByExternalId`/`patch()` is an UNCONDITIONAL merge-PATCH with
 * no compare-and-swap — the auto-ignore would silently overwrite the correct verdict with no
 * conflict signal. Fixed: immediately before acting on a queue, re-fetch that queue's CURRENT
 * pending set from records (fresh `bySession`, not the file) and only settle a candidate that is
 * STILL `pending` there. Anything a human (or a concurrent run) already resolved is skipped, not
 * overwritten. This is exactly the re-check discipline the paragraph above already claimed and
 * did not actually apply at the one place it mattered.
 *
 * THE OFF SWITCH IS CHECKED HERE TOO, NOT ONLY BY THE SPAWNING PARENT — same discipline
 * `reap.mjs`'s own header states for its kill switch ("checked before `force`, deliberately...
 * anything else makes the switch advisory"). `capture.mjs` already refuses to spawn this worker
 * while disabled, but an operator can run `node orphan-cap-worker.mjs` directly, and the one
 * component here that writes an unattended disposition must honour the switch on EVERY path that
 * reaches it, not just the common one.
 *
 * A LOCK IS CLAIMED HERE TOO, FOR THE SAME REASON — two
 * near-simultaneous Stop events from two live sessions could both read `orphanCapDue()` as true
 * before either restamps the debounce marker, and both spawn a worker). Rather than thread lock
 * ownership across a process spawn (the worker would have to trust a fact only the parent
 * observed), this worker claims its OWN machine-wide lock — `lock.mjs`'s same atomic `wx`-create
 * primitive `capture.mjs` uses per-session, keyed on a fixed, non-session string here since this
 * worker acts on the WHOLE corpus, not one session's queue. A second worker that loses the race
 * exits immediately, settling nothing — never a duplicate concurrent settle pass.
 *
 * DRY RUN IS THE DEFAULT — same reasoning as `reap.mjs`'s CLI ("an operator running this by hand
 * is inspecting; the one irreversible-ish action in this tree should not be what happens when you
 * type its name to see what it does"). `capture.mjs` passes `--apply` explicitly when it spawns
 * this for real; every other invocation (an operator checking live impact) reports the plan and
 * writes nothing. THE LOCK IS STILL CLAIMED ON A DRY RUN — cheap, and it means two concurrent dry
 * runs report a consistent plan rather than racing each other's reads (low stakes, but free).
 *
 * argv: [triggeringSessionId] [--apply] — sessionId is for hlog attribution only, this worker acts
 * on the WHOLE corpus of breaching queues, not one session's.
 */
import { hlog } from './hooklog.mjs';
import { append as appendQueue, read as readQueue } from './queue.mjs';
import { isHeld, claim, release } from './lock.mjs';
import { lockFor } from './paths.mjs';
import { settleByExternalId, bySession } from './candidates.mjs';
import { collectOrphanCandidates, planOrphanCap, markOrphanCapChecked, orphanCapDisabled } from './orphan-cap.mjs';
import { ORPHAN_CAP_DAYS } from './config.mjs';

const REF = `auto:orphan-cap-${ORPHAN_CAP_DAYS}d`;
// `why` is `classifyOrphanQueue`'s own human-readable verdict ("offered on N distinct days (>= cap)
// with M still pending") — reused rather than re-deriving the day count here, so the reason a
// candidate reads in `--list` always matches the reason the plan actually acted on.
const reasonFor = (why) => `${why} — auto-ignored by the orphan-cap backstop; `
  + '`dispose.mjs <sessionId> --reopen <cN>` undoes this if it was wrong.';

/**
 * THE RECORD, NOT THE FILE, DECIDES WHO IS STILL PENDING AT ACT TIME. One `bySession` per
 * breaching queue (not per candidate — the plan already bounds the number of breaching queues per
 * run), returning a Map of externalId -> the record's CURRENT disposition/supersededBy. `null`
 * means unreachable this run — every candidate in the queue is treated as `failed` (retried next
 * debounced run), never as "still pending" by default: silence must never read as permission.
 *
 * A MAP, NOT A SET OF "STILL PENDING" IDS — a candidate absent from the map (no record at all: it
 * predates the file-to-record dual-write cutover, so closing it needs a one-time migration outside
 * this worker's own reach) and a candidate PRESENT but already settled by someone else are
 * different facts and must be counted differently (`missing` vs `alreadySettled` below);
 * collapsing them to one boolean is a real diagnostic regression — both are safe (neither ever
 * gets overwritten), but only one of them means "this candidate needs that one-time migration".
 */
async function currentlyPending(sid) {
  const rows = await bySession(sid);
  if (rows === null) return null;
  return new Map(rows.map((r) => [r.externalId, r]));
}

/**
 * BACK UP THE SETTLEMENT TO THE LOCAL FILE — same shape as `dispose.mjs`'s own `backupToFile`
 * (record-first, file best-effort, never blocking): the record write is what determines success,
 * and this is what makes the local file agree with it afterward. Resolves the file's OWN
 * positional id by matching `externalId`, exactly like `dispose.mjs` does, so `report.mjs
 * --compare`'s existing fold sees the same shape it already expects from a human disposal.
 */
function backupToFile(sid, externalId, why) {
  const q = readQueue(sid);
  if (q.state !== 'ok') { hlog('orphan-cap', `${sid}: local queue unreadable — the record IS settled, no local backup written`); return; }
  let fileId = null;
  for (const [id, c] of q.all) { if (c.externalId === externalId) { fileId = id; break; } }
  if (!fileId) { hlog('orphan-cap', `${sid}: no local queue entry for externalId ${externalId} — record settled, nothing to back up`); return; }
  if (!appendQueue(sid, { op: 'dispose', id: fileId, disposition: 'ignored', ref: REF, resolved: reasonFor(why) })) {
    hlog('orphan-cap', `${sid} ${fileId}: local backup append FAILED — the record IS settled; only the local audit copy is missing`);
  }
}

// A FIXED, machine-wide lock key — deliberately not a session id, since this worker settles the
// WHOLE corpus, not one session's queue. `lockFor` just slugs whatever string it is given; a
// plain descriptive word can never collide with a real (UUID-shaped) session id.
const LOCK = lockFor('orphan-cap-worker');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const triggeringSid = args.find((a) => a !== '--apply') || null;
  const off = orphanCapDisabled();
  if (off) { hlog('orphan-cap', `worker skip: disabled (${off}) — nothing settled`, triggeringSid); return; }

  // TWO-STEP, same as capture.mjs's own per-session lock: `isHeld` first (clears a STALE lock as
  // a side effect — a crashed prior worker must not wedge this forever), THEN the atomic `wx`
  // claim. Losing the race means another worker is genuinely running right now; exit quietly,
  // settling nothing — the next debounced tick tries again.
  if (isHeld(LOCK, 'orphan-cap', { tag: 'orphan-cap' })) {
    hlog('orphan-cap', 'worker skip: another instance is already running', triggeringSid);
    return;
  }
  const { proceed, owned } = claim(LOCK, 'orphan-cap', { tag: 'orphan-cap' });
  if (!proceed) { hlog('orphan-cap', 'worker skip: lost the lock race to a concurrent run', triggeringSid); return; }
  try {
    await run(apply, triggeringSid);
  } finally {
    release(LOCK, owned, 'orphan-cap', { tag: 'orphan-cap' });
  }
}

/** The actual body, unchanged in shape from before the lock was added — split out so the lock's
 * try/finally in `main()` wraps it cleanly rather than indenting the whole function one level. */
async function run(apply, triggeringSid) {
  const plan = planOrphanCap({ queues: collectOrphanCandidates() });
  if (!plan.breach.length) {
    hlog('orphan-cap', `nothing to settle (scanned ${plan.stats.scanned}, ${plan.stats.breaching} breaching but already cleared since the parent's check)`, triggeringSid);
    markOrphanCapChecked();
    return;
  }
  if (!apply) {
    // DRY RUN: report the plan, write nothing, do NOT stamp the debounce marker (a real spawn from
    // capture.mjs always passes --apply, so an un-stamped marker after a dry run costs nothing —
    // the next real spawn still finds the same breach and acts on it).
    hlog('orphan-cap', `DRY RUN — would auto-ignore ${plan.stats.candidatesToSettle} candidate(s) `
      + `across ${plan.breach.length} queue(s); re-run with --apply to actually settle`, triggeringSid);
    console.log(`DRY RUN — would auto-ignore ${plan.stats.candidatesToSettle} candidate(s) across ${plan.breach.length} queue(s):`);
    for (const q of plan.breach) console.log(`  ${q.sid}: ${q.why}`);
    if (plan.deferred.length) console.log(`  ${plan.stats.candidatesDeferred} candidate(s) across ${plan.deferred.length} queue(s) deferred past the per-run cap`);
    console.log('\nre-run with --apply to actually settle.');
    return;
  }

  let settled = 0;
  let missing = 0;
  let failed = 0;
  let alreadySettled = 0;
  for (const q of plan.breach) {
    const fresh = await currentlyPending(q.sid);
    if (fresh === null) { failed += q.pending.length; continue; } // unreachable — retried next debounced run
    for (const c of q.pending) {
      if (!c.externalId) { missing++; continue; } // predates dual-write — needs a one-time migration, outside this worker's reach
      const rec = fresh.get(c.externalId);
      if (!rec) { missing++; continue; } // no record at all for this externalId — same pre-dual-write population, not this worker's
      if (rec.disposition !== 'pending' || rec.supersededBy) { alreadySettled++; continue; } // a human (or a concurrent run) already resolved this — never overwrite
      const r = await settleByExternalId(c.externalId, 'ignored', { ref: REF, resolved: reasonFor(q.why) });
      if (r === null) { failed++; continue; } // unreachable — retried next debounced run, nothing lost
      if (r.missing) { missing++; continue; } // no matching record for this externalId — nothing to settle
      backupToFile(q.sid, c.externalId, q.why);
      settled++;
    }
  }
  hlog('orphan-cap', `${settled} candidate(s) auto-ignored across ${plan.breach.length} queue(s) `
    + `(${missing} missing/no-record, ${failed} unreachable, ${alreadySettled} already resolved by someone else — retried/skipped, never overwritten), `
    + `${plan.stats.candidatesDeferred} deferred past the per-run cap`, triggeringSid);
  // Stamped on completion (not on spawn, unlike capture.mjs's markSwept pattern) — this worker,
  // unlike the distiller, does the network work itself rather than farming it out further, so
  // there is no asymmetric-cost argument for marking early; a crash before this line simply means
  // the next debounce window retries the same, still-accurate plan.
  markOrphanCapChecked();
}

main().catch((e) => {
  try { hlog('orphan-cap', `worker CRASHED (${e?.code || e?.name || 'error'}) — this run settled nothing new: ${e?.message || e}`); }
  catch { /* silence-ok: same as capture-worker.mjs's own crash guard — the log IS the last resort. */ }
});
