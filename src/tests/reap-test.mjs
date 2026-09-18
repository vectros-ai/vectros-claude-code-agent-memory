#!/usr/bin/env node
/**
 * THE REAPER — its refusals first, its deletions second.
 *
 * THIS IS A DESTRUCTIVE-LIFECYCLE TEST, so it provisions its OWN disposable runtime root inline
 * (`isolate.mjs`) and never points the subject at a shared fixture. That is not caution for its own
 * sake: the thing under test walks `state/` and calls `unlink`, and the developer's real `state/`
 * holds 5,779 live files. A predicate bug discovered by running this against the real root is a
 * predicate bug discovered by losing data.
 *
 * WHAT IS ACTUALLY BEING TESTED. Not "does it delete" — that is one line of `fs`. The reaper's whole
 * value is in what it REFUSES, so the refusals get the RED-proofs and the deletions get the arithmetic:
 *
 *   §1  the phantom predicate         — the correction that shapes the design (see reap.mjs's header)
 *   §2  the three refusals            — pending, handed, unreadable. Each RED-proven by showing the
 *                                       SAME file becomes prunable the moment the guard's input changes
 *   §3  the cap                       — bounded AND visible; a silent truncation is the failure
 *   §4  end to end on a real FS       — the applier, against a root built and destroyed here
 *   §5  the receipt                   — it must be possible to tell a healthy reap from a wrong one
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';
import { memoryHome, queueDir, reapOffFile, stateDir } from '../paths.mjs';
import { append } from '../queue.mjs';
import {
  applyReap, classifyQueue, classifySpool, classifyState, collect, planReap, reapDue, REAP_MARKER,
  reapReceipt, runReap,
} from '../reap.mjs';
import { spoolDir } from '../paths.mjs';

/**
 * ⚠ HARD PRECONDITION, BEFORE ANY FIXTURE — and it must `exit`, not `check`.
 *
 * `isolate.mjs` is deliberately DEFERENTIAL: if `VECTROS_MEMORY_HOME` is already set it does
 * nothing, so an operator can point the suite at a specific root. For every other test that is
 * correct. For this one it is a loaded gun: `VECTROS_MEMORY_HOME=~/.claude/vectros-memory node
 * tests/reap-test.mjs` — the exact invocation an operator would use to check a deployment — would
 * run `applyReap` against the operator's real `state/`.
 *
 * And nothing downstream would stop it. `assert.mjs`'s `check`/`eq` RECORD a failure and return;
 * they do not throw. So the `collect()` count assertions would fail, execution would continue, and
 * the real unlink would happen anyway — against a fake 2027 clock that ages every real file ~170
 * days past its window. The end-of-file guard that names this hazard fires long after the deletion.
 *
 * A destructive-lifecycle test must therefore refuse to run at all outside a root it created, and
 * refusing means exiting.
 */
if (!/vectros-mem-test-/.test(process.env.VECTROS_MEMORY_HOME || '')) {
  console.error('reap-test REFUSED TO RUN: VECTROS_MEMORY_HOME is not an isolate.mjs temp root '
    + `(got ${JSON.stringify(process.env.VECTROS_MEMORY_HOME || '<unset>')}). This test DELETES; it `
    + 'will not do so against a root it did not create. Unset the variable and re-run.');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed clock — nothing here reads Date.now()
const W = { phantomAfterMs: 7 * DAY, stateAfterMs: 30 * DAY, queueAfterMs: 90 * DAY, handedTtlMs: 2 * 3_600_000 };

const stateF = (over = {}) => ({ sid: 's1', size: 100, mtimeMs: NOW - 60 * DAY, state: {}, queue: null, ...over });
const queueF = (over = {}) => ({ sid: 's1', size: 100, mtimeMs: NOW - 200 * DAY, state: 'ok', pending: [], handedAt: null, lastEventAt: null, ...over });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PHANTOM PREDICATE. This proposes retention keyed on "no lastStopAt within N days".
//    Measured, 5,450 of 5,779 files have NO lastStopAt at all — the field is ABSENT, not stale —
//    so that predicate matches none of them. These two cases are the difference between a backstop
//    and a no-op that reports success.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. a phantom is aged by mtime, because it has no lastStopAt to age by ===');
eq('an old phantom (no lastStopAt, no queue) is PRUNED',
  classifyState(stateF({ state: { orientPending: true, orientSource: 'startup' }, mtimeMs: NOW - 10 * DAY }), NOW, W).action, 'prune');
eq('a YOUNG phantom is kept — the window is real, not a rubber stamp',
  classifyState(stateF({ state: { orientPending: true }, mtimeMs: NOW - 3 * DAY }), NOW, W).action, 'keep');
/**
 * THE REGRESSION GUARD FOR THE WHOLE DESIGN. If someone "simplifies" the classifier to key on
 * lastStopAt recency alone — which is what the issue text says — this case flips to `keep` and the
 * reaper silently protects 94% of the corpus forever while still reporting itself healthy.
 */
check('RED-anchor: the phantom above has NO lastStopAt, so a lastStopAt-only rule would keep it',
  classifyState(stateF({ state: { orientPending: true }, mtimeMs: NOW - 10 * DAY }), NOW, W).why.includes('mtime'),
  'the phantom was not aged by mtime — the correction has been undone');

console.log('\n=== 1b. a REAL session is aged by lastStopAt, on the longer window ===');
eq('a real session idle 40d is PRUNED (>= 30d)',
  classifyState(stateF({ state: { lastStopAt: NOW - 40 * DAY } }), NOW, W).action, 'prune');
eq('a real session idle 10d is KEPT — it is well past the PHANTOM window, and that must not apply',
  classifyState(stateF({ state: { lastStopAt: NOW - 10 * DAY }, mtimeMs: NOW - 10 * DAY }), NOW, W).action, 'keep');
/**
 * THE RESUMED-SESSION CASE — the single highest-value assertion in this file, and it went RED
 * against the shipped code. `lastStopAt` freezes at the previous session's last turn while every
 * later hook write moves mtime, so a session resumed after 40 days had its state deleted seconds
 * after being written. Age is the NEWER of the two clocks. → reap.mjs § classifyState.
 */
eq('A RESUMED session is KEPT: stale lastStopAt but a fresh mtime means it was just touched',
  classifyState(stateF({ state: { lastStopAt: NOW - 40 * DAY }, mtimeMs: NOW }), NOW, W).action, 'keep');
eq('a non-numeric lastStopAt is NOT silently demoted to the 7-day phantom window',
  classifyState(stateF({ state: { lastStopAt: new Date(NOW - 10 * DAY).toISOString() }, mtimeMs: NOW - 10 * DAY }), NOW, W).action, 'keep');
check('and it says WHICH clock it used',
  classifyState(stateF({ state: { lastStopAt: NOW - 10 * DAY } }), NOW, W).why.includes('last touched'));

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE THREE REFUSALS. Each is RED-proven by flipping ONLY the guard's input on an otherwise
//    identical, maximally-ancient file: if the sibling does not become prunable, the case proves
//    nothing about the guard (it might have been kept for some other reason entirely).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. the refusals — each proven against an otherwise-identical prunable sibling ===');

const ancient = { sid: 's1', size: 100, mtimeMs: NOW - 500 * DAY, state: { lastStopAt: NOW - 500 * DAY } };
// `state: 'ok'` on every queue fixture below is REQUIRED, and its absence was itself a finding:
// these objects modelled a queue with no read-state at all, which the guard
// (anything not 'ok' is unknowable, so it stays) correctly refuses. A fixture that cannot express
// the field the code branches on cannot test the branch.
const okQ = (over = {}) => ({ state: 'ok', pending: [], handedAt: null, ...over });
eq('control: with a settled queue, a 500d-old state file IS prunable',
  classifyState({ ...ancient, queue: okQ() }, NOW, W).action, 'prune');
eq('REFUSAL 1 — one pending candidate makes it immortal',
  classifyState({ ...ancient, queue: okQ({ pending: [{ id: 'c1' }] }) }, NOW, W).action, 'keep');
eq('REFUSAL 2 — a live handed claim keeps it',
  classifyState({ ...ancient, queue: okQ({ handedAt: NOW - 60_000 }) }, NOW, W).action, 'keep');
eq('...and an EXPIRED handed claim does not (the TTL is real)',
  classifyState({ ...ancient, queue: okQ({ handedAt: NOW - 5 * 3_600_000 }) }, NOW, W).action, 'prune');
/**
 * THE CASE THAT WAS MISSING, and the bug it now pins. `queue.read()`
 * returns `pending: []` for a queue it could NOT READ as well as for a settled one, so reading
 * only `pending.length` pruned the state file beside an unreadable queue — losing the
 * `transcriptPath` that is the only way to ever locate that queue's transcript again.
 */
eq('REFUSAL 1b — an UNREADABLE queue keeps the state file too (pending: [] does not mean settled)',
  classifyState({ ...ancient, queue: okQ({ state: 'corrupt' }) }, NOW, W).action, 'keep');
eq('...and a queue whose read came back FRESH keeps it as well (readdir listed it — a fresh read is a bug)',
  classifyState({ ...ancient, queue: okQ({ state: 'fresh' }) }, NOW, W).action, 'keep');
eq('REFUSAL 3 — unparseable state is kept, because its pending status is unknowable',
  classifyState({ ...ancient, state: null, queue: null }, NOW, W).action, 'keep');

console.log('\n=== 2b. the same three, on the QUEUE side, where the loss is worst ===');
eq('control: a settled queue idle 200d IS prunable', classifyQueue(queueF(), NOW, W).action, 'prune');
eq('one pending candidate — never eligible at ANY age',
  classifyQueue(queueF({ pending: [{ id: 'c1' }], mtimeMs: NOW - 3650 * DAY }), NOW, W).action, 'keep');
eq('a live handed claim keeps it', classifyQueue(queueF({ handedAt: NOW - 60_000 }), NOW, W).action, 'keep');
eq('an UNREADABLE queue is kept — its pending set is unknown', classifyQueue(queueF({ state: 'corrupt' }), NOW, W).action, 'keep');
/**
 * THE QUEUE-SIDE RESUME CLOCK — the same bug §1b pins on the state side, which was still live here.
 *
 * `lastEventAt` folds only `swept`/`handed`. A `captured` append — the watermark, the most frequent
 * event a live queue gets — moves mtime and NEITHER field. So `??` let a stale `lastEventAt` mask a
 * fresh mtime, and a settled queue whose session was resumed today was pruned on a 100-day-old
 * `handed`. What goes is the watermark AND the disposed/superseded sets, so the delta gate rewinds
 * to zero and re-proposes everything already settled. Every fixture above pins `lastEventAt: null`,
 * which is exactly why the branch had no coverage.
 */
eq('a settled queue with a STALE lastEventAt but a FRESH mtime is KEPT (a captured append moves only mtime)',
  classifyQueue(queueF({ lastEventAt: NOW - 200 * DAY, mtimeMs: NOW }), NOW, W).action, 'keep');
eq('...and when BOTH are old it is still prunable, so the guard is not a blanket keep',
  classifyQueue(queueF({ lastEventAt: NOW - 200 * DAY, mtimeMs: NOW - 200 * DAY }), NOW, W).action, 'prune');
check('the pending refusal names the count, so the receipt can be believed',
  /1 pending candidate/.test(classifyQueue(queueF({ pending: [{ id: 'c1' }] }), NOW, W).why));

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE CAP. Bounded is table stakes; VISIBLE is the requirement — a truncation nobody can see
//    reads as "that was all of it".
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. the per-run cap defers rather than drops ===');
{
  const many = Array.from({ length: 25 }, (_, i) => stateF({ sid: `p${i}`, state: { orientPending: true }, mtimeMs: NOW - 30 * DAY }));
  const plan = planReap({ states: many, queues: [], now: NOW, ...W, maxDeletes: 10 });
  eq('exactly maxDeletes are planned', plan.prune.length, 10);
  eq('the rest are DEFERRED, not silently dropped', plan.deferred.length, 15);
  eq('and nothing was lost between the two', plan.prune.length + plan.deferred.length, 25);
  /**
   * WITH QUEUES IN THE MIX — §3's original fixture had 25 states and ZERO queues, so
   * `prunable.slice(0, max)` passed it and the interleave (which carries a long justifying comment
   * about a ~40-day starvation) was never exercised.
   */
  {
    const manyStates = Array.from({ length: 25 }, (_, i) => stateF({ sid: `ps${i}`, state: { orientPending: true }, mtimeMs: NOW - 30 * DAY }));
    const manyQueues = Array.from({ length: 25 }, (_, i) => queueF({ sid: `pq${i}` }));
    const mixed = planReap({ states: manyStates, queues: manyQueues, now: NOW, ...W, maxDeletes: 10 });
    const kinds = mixed.prune.map((d) => d.kind);
    check('the cap does NOT starve queues behind the state backlog',
      kinds.includes('queue') && kinds.includes('state'), `planned kinds: ${kinds.join(',')}`);
    check('and it is genuinely interleaved, not just queue-first',
      new Set(kinds.slice(0, 4)).size === 2, `first four: ${kinds.slice(0, 4).join(',')}`);
  }

  check('the receipt SAYS it deferred',
    /DEFERRED 15/.test(reapReceipt(plan, { deleted: 10, bytes: 1000, failed: [], dryRun: false })),
    reapReceipt(plan, { deleted: 10, bytes: 1000, failed: [], dryRun: false }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. END TO END on a real filesystem — the applier, against a root this file owns and destroys.
//    The predicate cases above exercise predicates over synthetic listings; nothing there proves `collect` reads the
//    directories correctly or that `applyReap` unlinks the file it named. This does.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. end to end against a disposable root ===');
{
  const SD = stateDir();
  const QD = queueDir();
  /**
   * ⚠ ACTUALLY CLEAR IT FIRST — found live, the hard way. The header above already claims this
   * test "owns and destroys" this root, but nothing enforced that: `stateDir()`/`queueDir()` are
   * the SAME shared directories `isolate.mjs` points every test in a `run-all.mjs` run at, and
   * this case's own exact-count assertions (`states.length === 3`, `queues.length === 1`) only
   * held when run STANDALONE, where nothing else had written there yet. Run as part of the full
   * suite, an earlier-alphabetical test's own leftover state/queue file inflates both counts,
   * failing this case for a reason that has nothing to do with `collect()`/`applyReap()` — the
   * actual code under test — and everything to do with an unfulfilled ownership claim. Emptying
   * both directories here makes the claim in the comment above actually true.
   */
  for (const dir of [SD, QD]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.mkdirSync(SD, { recursive: true });
  fs.mkdirSync(QD, { recursive: true });

  /**
   * EVERY mtime IS SET EXPLICITLY, including the "fresh" one — and the first cut of this test did
   * not, which is worth the comment because the failure was silent-looking rather than obvious.
   *
   * `NOW` is a fixed clock in 2027 so the assertions do not drift; a file just written carries the
   * REAL mtime, which is ~174 days BEFORE that. So the "fresh" phantom aged 174d against a 7d window
   * and was correctly pruned by code that was working perfectly. A fixed fake clock and real
   * filesystem timestamps cannot be mixed — either both are real or both are stamped.
   */
  const write = (sid, body, ageDays) => {
    const p = path.join(SD, `${sid}.json`);
    fs.writeFileSync(p, JSON.stringify(body));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(p, t, t);
  };
  write('11111111-1111-1111-1111-111111111111', { orientPending: true, orientSource: 'startup' }, 60);    // old phantom -> prune
  write('22222222-2222-2222-2222-222222222222', { orientPending: true }, 1);                              // fresh phantom -> keep
  write('33333333-3333-3333-3333-333333333333', { lastStopAt: NOW - 500 * DAY }, 60);                     // ancient real, but...
  append('33333333-3333-3333-3333-333333333333', { op: 'propose', title: 'unsettled', body: 'x' });       // ...one pending -> KEEP both

  const { states, queues } = collect();
  eq('collect() found every state file', states.length, 3);
  eq('collect() found the queue', queues.length, 1);

  const plan = planReap({ states, queues, now: NOW, ...W });
  const pruned = new Set(plan.prune.map((d) => `${d.kind}:${d.sid}`));
  check('the old phantom is planned for deletion', pruned.has('state:11111111-1111-1111-1111-111111111111'));
  check('the fresh phantom is NOT', !pruned.has('state:22222222-2222-2222-2222-222222222222'));
  check('the ancient session with a PENDING candidate is NOT — this is the whole safety property',
    !pruned.has('state:33333333-3333-3333-3333-333333333333'));
  check('and neither is its queue', !pruned.has('queue:33333333-3333-3333-3333-333333333333'));

  const applied = applyReap(plan);
  eq('exactly one file was deleted', applied.deleted, 1);
  check('the old phantom is GONE from disk', !fs.existsSync(path.join(SD, '11111111-1111-1111-1111-111111111111.json')));
  check('the fresh phantom SURVIVED', fs.existsSync(path.join(SD, '22222222-2222-2222-2222-222222222222.json')));
  check('the pending session SURVIVED', fs.existsSync(path.join(SD, '33333333-3333-3333-3333-333333333333.json')));
  check('its QUEUE survived — the candidates and the watermark are intact',
    fs.existsSync(path.join(QD, '33333333-3333-3333-3333-333333333333.jsonl')));

  /**
   * B3 — `applyReap` MUST DELETE FROM THE DIRECTORIES IT IS HANDED. It took `stateD`/`queueD`,
   * defaulted them, and then read neither: the body resolved through `stateFor`/`queueFor`, i.e. the
   * process-global root. So an alternate-listing run planned against a probe directory and unlinked
   * the same-named files out of the REAL runtime — files it had never classified. The parameters
   * were never passed by any test, so the seam had no coverage at all.
   */
  {
    const probe = fs.mkdtempSync(path.join(memoryHome(), 'probe-'));
    const probeState = path.join(probe, 'state');
    fs.mkdirSync(probeState, { recursive: true });
    const sid = '44444444-4444-4444-4444-444444444444';
    fs.writeFileSync(path.join(probeState, `${sid}.json`), '{}');
    // The SAME sid in the real (isolated) root — the file that must NOT be touched.
    const decoy = path.join(stateDir(), `${sid}.json`);
    fs.writeFileSync(decoy, '{}');

    const p2 = planReap({
      states: [stateF({ sid, state: { orientPending: true }, mtimeMs: NOW - 60 * DAY })],
      queues: [], now: NOW, ...W,
    });
    applyReap(p2, { stateD: probeState, queueD: path.join(probe, 'queue') });
    check('the file in the HANDED directory is gone', !fs.existsSync(path.join(probeState, `${sid}.json`)));
    check('and the same-named file in the real root is UNTOUCHED', fs.existsSync(decoy),
      'applyReap deleted from the global root while planning against the handed one');
    fs.rmSync(decoy, { force: true });
  }

  // A delete that FAILS must be reported, and must not strand the rest of the run.
  const failing = planReap({ states: [stateF({ sid: 'x1', state: { orientPending: true }, mtimeMs: NOW - 30 * DAY }),
    stateF({ sid: 'x2', state: { orientPending: true }, mtimeMs: NOW - 30 * DAY })], queues: [], now: NOW, ...W });
  const r = applyReap(failing, { unlink: (p) => { if (p.includes('x1')) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } } });
  eq('the failure is reported, not swallowed', r.failed.length, 1);
  eq('and the OTHER file was still deleted — one locked file does not strand the run', r.deleted, 1);
  check('the receipt names the failure', /FAILED to delete 1/.test(reapReceipt(failing, r)), reapReceipt(failing, r));

  // ENOENT is the GOAL STATE, not a failure: something else already removed it.
  const gone = applyReap(failing, { unlink: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } });
  eq('already-deleted counts as deleted, not as a failure', gone.failed.length, 0);
  eq('and it is counted', gone.deleted, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE RECEIPT. Counts alone cannot separate a healthy reap from one that deleted the wrong
//    files, and a DRY RUN reporting `deleted: 0` reads as "found nothing".
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. the receipt distinguishes what a count cannot ===');
{
  const states = [
    stateF({ sid: 'a', state: { orientPending: true }, mtimeMs: NOW - 30 * DAY }),
    stateF({ sid: 'b', state: { lastStopAt: NOW - 1 * DAY } }),
    stateF({ sid: 'c', state: { lastStopAt: NOW - 500 * DAY }, queue: { pending: [{ id: 'c1' }], handedAt: null } }),
  ];
  const plan = planReap({ states, queues: [], now: NOW, ...W });
  const receipt = reapReceipt(plan, { deleted: 1, bytes: 100, failed: [], dryRun: false });
  check('it reports what was REFUSED and why, not just what was deleted',
    /refused:/.test(receipt) && /pending/.test(receipt), receipt);
  check('it reports the scan size, so "reaped 1" can be read in proportion', /scanned 3/.test(receipt), receipt);

  const dry = reapReceipt(plan, { deleted: 0, bytes: 0, failed: [], dryRun: true });
  check('a DRY RUN reports what it WOULD do — `deleted 0` next to `scanned 3` reads as "found nothing"',
    /WOULD reap 1/.test(dry), dry);
}

console.log('\n=== 6. the debounce, and that a dry run really is dry ===');
{
  /**
   * A DRY RUN MUST BE PROVEN AGAINST SOMETHING PRUNABLE. The first version of this case asserted
   * only "the directory has the same file count afterwards" — but §4 had already deleted the one
   * prunable file, so `plan.prune` was EMPTY and the assertion passed identically whether
   * `apply:false` was honoured or ignored. Hard-coding `apply = true` inside `runReap` left it
   * green. So: seed a file that WOULD be reaped, then prove it survives.
   */
  const doomed = '99999999-9999-9999-9999-999999999999';
  const p = path.join(stateDir(), `${doomed}.json`);
  fs.writeFileSync(p, JSON.stringify({ orientPending: true }));
  const t = new Date(NOW - 60 * DAY);
  fs.utimesSync(p, t, t);

  const dry = runReap({ now: NOW, apply: false, force: true, ...W });
  check('precondition: the dry run really did plan to delete something',
    dry.plan.prune.some((d) => d.sid === doomed), 'nothing prunable — this case would prove nothing');
  check('a dry run leaves the doomed file on disk', fs.existsSync(p));
  check('and reports what it WOULD have done', /WOULD reap/.test(dry.receipt), dry.receipt);

  /**
   * THE DEBOUNCE, which this case was NAMED after and did not test. Every `runReap` above passes
   * `force: true`, and the only one that could have stamped the marker passed `apply: false` — so
   * `reapDue` and `markReaped` never executed at all. That rate limiter is the only thing between a
   * ~5,800-file scan and running it on EVERY Stop (1-2/min from Desktop alone).
   */
  check('with no marker yet a reap is DUE (the debounce is a rate limit, not a gate to open)',
    reapDue(NOW, { marker: REAP_MARKER(), debounceMs: 24 * 3_600_000 }));

  const live = runReap({ now: NOW, apply: true, ...W });
  check('the WIRED path (apply:true, no force) actually ran', !live.skipped, JSON.stringify(live.skipped));
  check('...and it deleted the doomed file', !fs.existsSync(p));
  check('the marker is stamped, and UNDER THE ISOLATED ROOT (it was a memoized const)',
    fs.existsSync(REAP_MARKER()) && REAP_MARKER().includes('vectros-mem-test-'), REAP_MARKER());

  eq('an immediate second run is DEBOUNCED, not re-scanned',
    runReap({ now: NOW, apply: true, ...W }).skipped, 'debounced');
  check('and past the window it runs again',
    !runReap({ now: NOW + 48 * 3_600_000, apply: false, ...W }).skipped);

  /**
   * THE KILL SWITCH. Checked BEFORE `force`, because `force` exists to bypass the debounce and must
   * not bypass "do not delete". Its absence is what let `tests/smoke.mjs` — the documented
   * post-deploy check, which runs the REAL hooks against the REAL runtime — perform a live delete.
   */
  const doomed2 = '88888888-8888-8888-8888-888888888888';
  const p2 = path.join(stateDir(), `${doomed2}.json`);
  fs.writeFileSync(p2, JSON.stringify({ orientPending: true }));
  const t2 = new Date(NOW - 60 * DAY);
  fs.utimesSync(p2, t2, t2);

  process.env.VECTROS_MEM_REAP_OFF = '1';
  const offRun = runReap({ now: NOW + 96 * 3_600_000, apply: true, force: true, ...W });
  check('the env kill switch stops the reaper even with force:true', /disabled/.test(offRun.skipped || ''), JSON.stringify(offRun.skipped));
  check('and the doomed file survives', fs.existsSync(p2));
  delete process.env.VECTROS_MEM_REAP_OFF;

  fs.writeFileSync(reapOffFile(), 'reap-test\n');
  const offRun2 = runReap({ now: NOW + 96 * 3_600_000, apply: true, force: true, ...W });
  check('the REAP_OFF FILE stops it too (the operator-facing channel)', /disabled/.test(offRun2.skipped || ''), JSON.stringify(offRun2.skipped));
  fs.rmSync(reapOffFile(), { force: true });

  const onAgain = runReap({ now: NOW + 96 * 3_600_000, apply: true, force: true, ...W });
  check('control: with the switch cleared it runs again — the switch is real, not a permanent off',
    !onAgain.skipped, JSON.stringify(onAgain.skipped));
  check('...and NOW the doomed file is gone', !fs.existsSync(p2));

  check('the isolated root is where we think it is', memoryHome().includes('vectros-mem-test-'), memoryHome());
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SMOKE MUST NOT DELETE — the end-to-end assertion, spawning capture.mjs the way smoke does.
//
//    THIS EXISTS BECAUSE A MANUAL CHECK CAN BE VACUOUS. Measuring the real state-file count before
//    and after a smoke run, seeing it unchanged, and calling the fix verified is not sufficient —
//    if `last-reaped` was stamped minutes earlier by an explicit `--apply`, the DEBOUNCE alone
//    would suppress the reap and produce that exact same unchanged count, even if the fix itself
//    had never landed (e.g. a scripted replace that silently no-op'd). Two independent failures
//    can agree on a green.
//
//    So this drives the real child process, with the reap genuinely DUE (no marker), and asserts
//    the env var reaches it. Verify the propagation against the
//    spawn call, not by inference. `smoke.mjs` spawns with `env: { ...process.env, … }`, which is
//    what makes setting it in the parent sufficient — and that is the property under test here.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 7. a smoke-shaped capture.mjs run does not delete (the switch reaches the child) ===');
{
  const { spawnSync } = await import('node:child_process');
  const SD = stateDir();
  // A file the reaper WOULD take: old phantom, no queue. If the switch fails, this is gone.
  const bait = '77777777-7777-7777-7777-777777777777';
  const baitPath = path.join(SD, `${bait}.json`);
  fs.writeFileSync(baitPath, JSON.stringify({ orientPending: true }));
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(baitPath, old, old);
  // No marker => a reap is genuinely DUE. This is what the manual check failed to establish.
  fs.rmSync(REAP_MARKER(), { force: true });
  check('precondition: a reap is DUE, so the debounce cannot mask the result', reapDue(Date.now()));

  const payload = JSON.stringify({
    session_id: 'smoke-reap-guard', hook_event_name: 'Stop',
    transcript_path: '', last_assistant_message: 'x',
  });
  // CONTROL FIRST — without the switch the bait must actually DIE, or this test proves nothing.
  const capturePath = path.join(path.dirname(HERE), 'capture.mjs');
  spawnSync(process.execPath, [capturePath], {
    input: payload, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, VECTROS_MEM_REAP_OFF: '' },
  });
  const survivedWithout = fs.existsSync(baitPath);
  check('CONTROL: without the switch, a smoke-shaped Stop DOES delete (so this test can fail)',
    !survivedWithout, 'the bait survived even unprotected — the control proves nothing, fix the fixture');

  // Now with the switch, on a fresh bait and a due reap.
  fs.writeFileSync(baitPath, JSON.stringify({ orientPending: true }));
  fs.utimesSync(baitPath, old, old);
  fs.rmSync(REAP_MARKER(), { force: true });
  spawnSync(process.execPath, [capturePath], {
    input: payload, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, VECTROS_MEM_REAP_OFF: '1' },
  });
  check('WITH the switch, the same run leaves it alone — the env var reaches the spawned hook',
    fs.existsSync(baitPath), 'the bait was deleted: VECTROS_MEM_REAP_OFF did not reach capture.mjs');
  fs.rmSync(baitPath, { force: true });
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPOOL — a third directory, and the one where deletion is unrecoverable.
 *
 * A queue candidate also exists in the store. An UNSYNCED SPOOL ENTRY EXISTS NOWHERE ELSE: it is a
 * proposal that has not reached the corpus yet, produced by a billed pass over a transcript window
 * the watermark has already moved past. Deleting one destroys it outright.
 *
 * And the reaper is most tempted to delete exactly when the spool matters most — during an outage
 * nothing syncs, so nothing is marked, so the file simply looks idle.
 */
console.log('\n=== 8. the spool: owed writes are immortal, parked ones are not ===');
{
  const spoolF = (o = {}) => ({
    sid: 'sp-1', size: 100, mtimeMs: NOW - 200 * DAY, state: 'ok', owed: [], parked: [], ...o,
  });
  eq('control: a fully-synced spool idle 200d IS prunable', classifySpool(spoolF(), NOW, W).action, 'prune');
  eq('one unsynced proposal — never eligible at ANY age',
    classifySpool(spoolF({ owed: [{ externalId: 'e1' }], mtimeMs: NOW - 3650 * DAY }), NOW, W).action, 'keep');
  eq('an UNREADABLE spool is kept — what it owes is unknown',
    classifySpool(spoolF({ state: 'corrupt' }), NOW, W).action, 'keep');
  eq('...and so is a FRESH one (readdir listed it — a fresh read is a bug, as on the queue side)',
    classifySpool(spoolF({ state: 'fresh' }), NOW, W).action, 'keep');
  // PARKED must NOT confer immortality, or "over the retry budget" silently becomes "kept forever"
  // — an unbounded leak wearing the shape of a safety feature.
  eq('a PARKED-only spool is still prunable at age',
    classifySpool(spoolF({ parked: [{ externalId: 'e9' }] }), NOW, W).action, 'prune');
  eq('...but not before its window',
    classifySpool(spoolF({ parked: [{ externalId: 'e9' }], mtimeMs: NOW }), NOW, W).action, 'keep');
}

console.log('\n=== 8b. the applier deletes from the SPOOL dir — not the queue dir ===');
{
  /**
   * THE ROUTING RED-PROOF. `applyReap` chose its directory with `kind === 'state' ? stateD :
   * queueD`, which routes EVERY non-state kind to the queue directory. With a third kind that is
   * not a style problem: it would unlink `queue/<sid>.jsonl` while the real spool survived — and
   * report success, because a same-named queue file may well exist.
   *
   * So: build both files with the SAME sid, prune only the spool, and assert which one is gone.
   */
  fs.mkdirSync(spoolDir(), { recursive: true });
  fs.mkdirSync(queueDir(), { recursive: true });
  const sid = 'routing-probe';
  const spoolP = path.join(spoolDir(), `${sid}.jsonl`);
  const queueP = path.join(queueDir(), `${sid}.jsonl`);
  fs.writeFileSync(spoolP, '');
  fs.writeFileSync(queueP, '');

  const plan = { prune: [{ kind: 'spool', sid, bytes: 0, action: 'prune', why: 'test' }], deferred: [], kept: [], stats: {} };
  const applied = applyReap(plan, { recheckSpool: () => ({ state: 'ok', owed: [] }) });
  eq('the spool was deleted', fs.existsSync(spoolP), false);
  check('the SAME-NAMED queue file was NOT touched', fs.existsSync(queueP),
    'the applier routed a spool delete into the queue directory');
  eq('...and it counted as one delete', applied.deleted, 1);
  fs.rmSync(queueP, { force: true });
}

console.log('\n=== 8c. the applier re-checks a spool immediately before unlinking ===');
{
  /**
   * plan -> apply spans a window in which the capture worker may spool a fresh proposal. For a
   * queue that is recoverable (the candidate is also in the store); for a spool it is not.
   */
  const sid = 'recheck-probe';
  const p = path.join(spoolDir(), `${sid}.jsonl`);
  fs.writeFileSync(p, '');
  const plan = { prune: [{ kind: 'spool', sid, bytes: 0, action: 'prune', why: 'test' }], deferred: [], kept: [], stats: {} };
  const applied = applyReap(plan, { recheckSpool: () => ({ state: 'ok', owed: [{ externalId: 'raced' }] }) });
  check('a spool that gained an unsynced write between plan and apply SURVIVES', fs.existsSync(p));
  eq('...and nothing was deleted', applied.deleted, 0);
  fs.rmSync(p, { force: true });
}

console.log('\n=== 8d. the cap cannot starve the spool ===');
{
  // The queue side was fixed for exactly this: states monopolised the budget for ~40 days. A kind
  // added to the decision list but not to the round-robin inherits that bug silently.
  const many = (kind, n) => Array.from({ length: n }, (_, i) => ({
    sid: `${kind}-${i}`, size: 1, mtimeMs: NOW - 200 * DAY, state: 'ok',
    ...(kind === 'spool' ? { owed: [], parked: [] } : { pending: [], handedAt: null, lastEventAt: null }),
  }));
  const plan = planReap({
    states: [], queues: many('queue', 50), spools: many('spool', 50), now: NOW, ...W, maxDeletes: 10,
  });
  const kinds = new Set(plan.prune.map((d) => d.kind));
  check('a capped run reaches the spool as well as the queue', kinds.has('spool') && kinds.has('queue'),
    [...kinds].join(','));
}



console.log('\n=== end-to-end: a REAL spool file, through collect -> plan -> apply ===');
{
  /**
   * THE WIRING SEAM, which was covered nowhere. `classifySpool` was tested pure, `applyReap` against
   * a hand-built plan, and `planReap` against a hand-built `spools` array — three slices with
   * nothing connecting them. Deleting the spool loop in `collect()` (or dropping `spools` from its
   * destructuring in `runReap`) left every one of them green, because `planReap` DEFAULTS
   * `spools = []` — a defensive default that turns a broken wire into silence rather than a
   * TypeError. Net effect: spool files never reaped, ever, which is the unbounded on-disk leak
   * the reaper exists to prevent.
   */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-e2e-'));
  const spoolD = path.join(root, 'spool');
  fs.mkdirSync(spoolD, { recursive: true });
  const OWED = 'aaaaaaaa-1111-2222-3333-444444444444';
  const DONE = 'bbbbbbbb-1111-2222-3333-444444444444';
  // Owed: a write with no `synced`. Immortal at any age — it is the only copy of that proposal.
  fs.writeFileSync(path.join(spoolD, `${OWED}.jsonl`),
    JSON.stringify({ op: 'write', externalId: 'x1', sessionId: OWED, candidate: { title: 't' } }) + '\n');
  // Fully synced AND aged past the window: eligible.
  fs.writeFileSync(path.join(spoolD, `${DONE}.jsonl`),
    JSON.stringify({ op: 'write', externalId: 'x2', sessionId: DONE, candidate: { title: 't' } }) + '\n'
    + JSON.stringify({ op: 'synced', externalId: 'x2' }) + '\n');
  const old = (Date.now() - 200 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(spoolD, `${DONE}.jsonl`), old, old);

  const emptyD = path.join(root, 'empty');
  fs.mkdirSync(emptyD, { recursive: true });
  const collected = collect({ stateD: emptyD, queueD: emptyD, spoolD });
  eq('collect() actually reads the spool directory', collected.spools.length, 2);

  const plan = planReap({ ...collected, now: Date.now() });
  const pruned = plan.prune.filter((d) => d.kind === 'spool').map((d) => d.sid);
  check('the aged, fully-synced spool is planned for pruning', pruned.includes(DONE), pruned.join(','));
  check('...and the one that still OWES a write is not', !pruned.includes(OWED), pruned.join(','));

  const deleted = [];
  applyReap(plan, { stateD: emptyD, queueD: emptyD, spoolD, unlink: (p) => { deleted.push(path.basename(p)); } });
  check('apply deletes it from the SPOOL dir', deleted.includes(`${DONE}.jsonl`), deleted.join(','));
  check('...and never the owed one', !deleted.includes(`${OWED}.jsonl`), deleted.join(','));
  fs.rmSync(root, { recursive: true, force: true });
}

done();
