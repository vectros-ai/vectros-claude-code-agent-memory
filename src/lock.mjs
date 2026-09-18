/**
 * The in-flight WORKER LOCK — held/claim/release, as three functions with no side channel.
 *
 * WHY IT IS A MODULE. This was ~25 lines inline in `capture.mjs`, inside a hook that runs `main()`
 * on import — so it could not be exercised without standing up a 100K transcript and a real spawn,
 * and it had ZERO tests. It gets a seam so it can have one (→ `tests/lock-test.mjs`).
 *
 * WHAT IT IS WORTH, precisely. It used to carry a correctness invariant: a duplicate worker was
 * DATA LOSS, because `nextId(all)` minted candidate ids by folding the queue and two workers on one
 * snapshot both produced `c1`, which the fold then resolved by destroying one. That allocator is
 * gone — ids are positional now, assigned from the append-log's own order, so the collision is
 * unrepresentable (→ `queue.mjs` § the propose/revise arm). This lock is therefore a COST guard:
 * it stops two distillers doing the same work. Do not restore a correctness argument to it.
 *
 * WHAT THE LOCK IS. A file at `locks/<slug>.lock` holding the claimant's pid; its mtime is the
 * clock. Stale after `STALE_MS` so a killed worker cannot wedge capture forever.
 *
 * FAIL-OPEN, NEVER FAIL-SILENT. Every degraded path here returns the permissive answer — a wedged
 * capture is worse than a duplicate one — and says so through `hlog`. That is the whole point of this discipline
 * distinction: the fall-back is fine, being unable to tell it apart from the healthy path is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hlog } from './hooklog.mjs';
import { LOCK_STALE_MS } from './config.mjs';

/**
 * A worker lock older than this is treated as dead. MUST exceed the worst-case drain
 * (MAX_WINDOWS_PER_RUN 8 x CLAUDE_TIMEOUT_MS 180s = 24 min of pure MODEL time, plus spawn, HTTP,
 * parse and append overhead) or a long adoption drain is declared stale while it is still running,
 * and the duplicate-worker race returns.
 *
 * RAISED 30 -> 60 MIN, and the asymmetry that preceded it is the lesson. An earlier change first gave
 * the SWEEP a 2x threshold for foreign locks while leaving `capture.mjs` on 30 min for its own — reasoning
 * that a session asking about its own lock has "no other party involved". The sweep is exactly what
 * made that false: a sweep-spawned adoption drain runs against a session whose own capture hook can
 * come back to life mid-drain (the user resumes it), see a 31-minute-old lock, unlink a LIVE
 * worker's lock, and spawn a duplicate distiller against the same session. Hardening one side of a
 * shared resource just moves the race to the other side.
 *
 * One threshold, above the real worst case, for both callers. The `staleMs` parameter stays for
 * tests and for a caller that can justify a different tolerance — but the DEFAULT is now safe for
 * the foreign case too, so nobody has to remember to pass it.
 *
 * NOW CONFIGURABLE, and its floor carries the reasoning: `config.mjs`'s `LOCK_STALE_MS`
 * refuses anything under 30 min, because that is the documented worst-case drain
 * (`MAX_WINDOWS_PER_RUN` x `CAPTURE_CLAUDE_TIMEOUT_MS` = 8 x 180s = 24 min of pure model time)
 * with no margin at all. Re-exported under the name this module's callers already use — a plain
 * named import is safe here because nothing in the config graph imports `lock.mjs`.
 */
export const STALE_MS = LOCK_STALE_MS;

/**
 * Is a LIVE worker holding this lock? Clears it if stale.
 *
 * Fail-open: anything unreadable answers "free". But an unreadable lock file that IS there is not
 * the same as no lock — answering "free" authorizes a SECOND worker onto the same queue, which is
 * the precise duplicate-spawn this guard exists to prevent. ENOENT is the normal "no lock, go
 * ahead" case and stays quiet; everything else leaves a receipt.
 */
/**
 * `staleMs` and `tag` are CALLER-SUPPLIED because there are now two callers with genuinely
 * different risk, and one shared constant was silently wrong for the new one.
 *
 * `capture.mjs` asks about its OWN session's lock: if it is stale, that session's own worker died,
 * and clearing it is self-healing with no other party involved. `sweep.mjs` asks about a FOREIGN
 * session's lock, and there the same threshold is a hazard. `STALE_MS` is 30 min against a
 * worst-case drain this module's own header computes at 24 min (8 windows x 180s) — but that 24 min
 * is pure model time, and `capture-worker.mjs` never refreshes the mtime (it is fixed at claim
 * time), so HTTP, spawn, parse and append overhead eat the 6-minute margin. A sweep-triggered
 * adoption drain of a large orphaned tail is EXACTLY the run that hits `MAX_WINDOWS_PER_RUN` — so
 * the population most likely to exceed 30 min is the one the sweep is most likely to be looking at.
 * Clearing that lock and spawning a second distiller against the same session is the duplicate the
 * lock exists to prevent, arriving through the code that checks it.
 *
 * So the sweep passes a LONGER threshold (see its call site). `tag` keeps the receipt honest: a
 * line about a foreign session's lock, written on the `capture` channel under that foreign sid,
 * names the wrong subject — the failure mode this module's own `release` was fixed for.
 */
export function isHeld(lock, sessionId, { staleMs = STALE_MS, tag = 'capture' } = {}) {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < staleMs) return true;
    fs.unlinkSync(lock); // stale — the worker died mid-drain
    hlog(tag, `cleared a stale worker lock (${Math.round(age / 1000)}s old, threshold ${Math.round(staleMs / 60_000)}m)`, sessionId);
    return false;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      hlog(tag, `lock UNREADABLE (${e.code}) — treating it as free; a duplicate worker is possible`, sessionId);
    }
    return false;
  }
}

/**
 * Claim the lock. Returns TWO facts, because they answer different questions:
 *
 *   proceed — may we spawn a worker?
 *   owned   — did WE create this lock, and may we therefore release it?
 *
 * They were one boolean (`claimed`). On a non-EEXIST failure it was set true — a deliberate
 * fail-open, since a lock we cannot write must not kill capture — and that same true then
 * authorized `unlinkSync` on the spawn-failure path, releasing a lock this process never took.
 *
 * ⚠️ THE JUSTIFICATION IS UNSETTLED. Do not write a confident sentence here — this has already
 * been argued in both directions, by parties who had not measured the thing they were arguing about.
 *
 * One claim: a `wx` claim against a file another process holds OPEN can raise EPERM/EBUSY
 * rather than EEXIST, making a LIVE worker's lock the branch's likeliest occupant. A counter-claim
 * held that anything existing raises EEXIST regardless, backed by a test cited as proof and
 * hardened into a golden doc. **The test contained no such measurement** — `claim()` writes via
 * `writeFileSync`, which opens AND closes, so no handle was ever held and no second process existed.
 * It measured a closed file in one process: the case nobody disputed.
 *
 * MEASURED, and this is all of it:
 *   wx vs. an existing CLOSED file ................... EEXIST
 *   wx vs. a directory at the path ................... EEXIST
 *
 * UNMEASURED, and not measurable from here: the disputed case. Node's libuv opens with
 * FILE_SHARE_READ|WRITE|DELETE, so a second NODE process yields EEXIST no matter what — a harness
 * built from `node:fs` can only ever confirm the answer it assumes, which is why there is no such
 * harness in the test (an earlier draft added one; it proved nothing and is gone). The realistic
 * producers of a sharing violation are a NON-Node holder (AV, indexer, backup) opening with
 * FILE_SHARE_NONE, or delete-pending state — neither reachable from `node:fs`.
 *
 * The counter-witness lives in this repo and outranks both arguments: `atomic.mjs` § CONTENDED
 * treats EPERM/EACCES/EBUSY as "someone has the target open right now", measured at 56% of renames
 * under contention on this machine. Different syscall, so it does not settle `wx` — but it is
 * evidence that this platform does produce these codes from exactly this situation, and nobody here
 * has shown `wx` is exempt.
 *
 * SO: the split is kept on its own merits — one variable, two genuinely different facts, and
 * `unlink` of a file another process holds open does succeed on Windows. Whether its trigger is
 * reachable is OPEN. Do not "simplify" it away on the strength of the paragraph above, and do not
 * re-inflate it into a fix for a proven bug either.
 *
 * The REAL defect here was silence. This branch fell open with no log line at all, so a degraded
 * capture and a healthy one were indistinguishable — this discipline's founding shape. That part is settled and
 * was worth fixing on its own.
 *
 * `wx` = create-exclusive, so the claim is ATOMIC. The predecessor was `isHeld()` then
 * `writeFileSync` — check-then-act, and two Stops in the same millisecond both saw no lock and both
 * spawned.
 */
export function claim(lock, sessionId, { tag = 'capture' } = {}) {
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return { proceed: true, owned: true };
  } catch (e) {
    if (e.code === 'EEXIST') {
      hlog(tag, 'lost the lock race to a concurrent Stop — not spawning', sessionId);
      return { proceed: false, owned: false };
    }
    // Fail-open: no lock is the status quo ante, so proceed — but SAY SO, and do not pretend to
    // own what we could not take.
    //
    // The message says only what is OBSERVED, and asserts nothing about why. It used to explain
    // that "wx raises EEXIST for anything that exists, so this is an environment failure, not
    // contention" — the same blanket claim the header 30 lines up now marks UNSETTLED, relocated
    // from the doc into the operator's log, which is the worst place for it: a receipt naming a
    // cause nobody has measured, read at 2am and believed. Report the code and the consequence;
    // the operator can see the code.
    hlog(tag,
      `lock claim FAILED (${e?.code || e?.message || 'error'}) — spawning WITHOUT the lock, `
      + 'and not releasing one we do not own. A concurrent distiller is possible this tick.',
      sessionId);
    return { proceed: true, owned: false };
  }
}

/**
 * Release ONLY a lock this process created. Returns WHICH of three things happened.
 *
 * The worker frees it in a `finally` — but if the worker never STARTED, that finally never runs and
 * the lock sits for the full STALE_MS. Capture would be wedged for half an hour by an EMFILE blip:
 * the content gate degraded back into a timer, through the one path the lock fix didn't cover.
 *
 * THREE STATES, NOT A BOOLEAN — and the boolean was already lying. This returned true/false, so a
 * caller could not tell *"not ours, correctly untouched"* from *"ours, and the release FAILED"*.
 * Both came back `false`, and capture.mjs duly reported the second as `lock left alone (not ours)`:
 * a receipt naming the wrong subject, which is worse than none because it is believed. The second
 * state is also the one that matters — it means WE wedged capture for 30 minutes and nobody knows.
 *
 * That is the same discipline violated twice over: the same conflation the lock fix exists to remove, reintroduced by the
 * shape of its own return value. Caught by `receipt-lint-test.mjs` on this very file, which flagged
 * the silent catch below and led here.
 *
 * @returns {'not-ours'|'released'|'failed'}
 */
export function release(lock, owned, sessionId, { tag = 'capture' } = {}) {
  if (!owned) return 'not-ours';
  try {
    fs.unlinkSync(lock);
    return 'released';
  } catch (e) {
    // Already gone is the GOAL STATE, not a failure: something (a finished worker, a stale sweep)
    // freed it first, and the lock is exactly as absent as we wanted.
    // silence-ok: the post-condition we care about — no lock — holds, so there is nothing to report.
    if (e.code === 'ENOENT') return 'released';
    hlog(tag,
      `lock RELEASE FAILED (${e.code}) — WE hold this lock and could not free it; `
      + `capture is wedged for this session until it goes stale (${Math.round(STALE_MS / 60_000)} min)`,
      sessionId);
    return 'failed';
  }
}
