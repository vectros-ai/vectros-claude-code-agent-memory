#!/usr/bin/env node
/**
 * ORPHAN CAP — pure classify/plan + the file-reading half (distinctHandedDates/
 * collectOrphanCandidates), plus the off-switch/debounce mirrored from reap-test.mjs's own
 * coverage of the identical mechanism. The WRITE half (settling a breach through records) is
 * `orphan-cap-worker.mjs`'s job and has its own test (orphan-cap-worker-test.mjs) — this file
 * never touches records.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';
import { queueDir, orphanCapOffFile } from '../paths.mjs';
import { append } from '../queue.mjs';
import {
  classifyOrphanQueue, distinctHandedDates, collectOrphanCandidates, planOrphanCap,
  orphanCapDisabled, orphanCapDue, markOrphanCapChecked, ORPHAN_CAP_MARKER,
} from '../orphan-cap.mjs';

// REAL, UUID-shaped ids — §3 below exercises collectOrphanCandidates()'s directory scan, which
// filters through residual.mjs's isReal() (the same reason every OTHER `--all`-style scan in this
// suite needs them): a human-readable id would be silently excluded, and §3's own assertions would pass for
// the wrong reason (excluded, not genuinely collected).
const SID = randomUUID();
const SID2 = randomUUID();

console.log('=== 1. classifyOrphanQueue: pure, synthetic — the day-count boundary ===');
{
  const pending = [{ id: 'c1', externalId: 'x1', title: 't' }];
  const below = { sid: SID, pending, handedDays: new Set(['2026-08-01', '2026-08-02']) };
  const atCap = { sid: SID, pending, handedDays: new Set(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']) };
  const overCap = { sid: SID, pending, handedDays: new Set([...atCap.handedDays, '2026-08-08']) };
  const opts = { capDays: 7 };

  eq('2 of 7 days: keep', classifyOrphanQueue(below, opts).action, 'keep');
  eq('exactly 7 of 7 days: breach (>=, not >)', classifyOrphanQueue(atCap, opts).action, 'breach');
  eq('8 of 7 days: breach', classifyOrphanQueue(overCap, opts).action, 'breach');
  eq('nothing pending: keep regardless of days', classifyOrphanQueue({ sid: SID, pending: [], handedDays: overCap.handedDays }, opts).action, 'keep');
  check('a breach carries the real pending list forward (the worker needs the externalIds)',
    classifyOrphanQueue(atCap, opts).pending === pending);
}

console.log('\n=== 2. distinctHandedDates: counts DAYS, not events; ignores non-handed ops; survives a torn line ===');
{
  append(SID, { op: 'propose', externalId: 'x1', title: 't', body: 'b', kind: 'observation', dest: 'memory' });
  // THREE handed events, but only TWO distinct days — the re-affirm-on-every-prompt shape measured
  // live: must count as 2, not 3, or the whole point of this module is defeated.
  append(SID, { op: 'handed', toSid: 'a' });
  append(SID, { op: 'handed', toSid: 'a' });
  const f = path.join(queueDir(), `${SID}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ at: '2026-08-02T09:00:00.000Z', op: 'handed', toSid: 'b' }) + '\n');
  fs.appendFileSync(f, '{not json\n'); // a torn line must not strand the count
  fs.appendFileSync(f, JSON.stringify({ at: '2026-08-02T23:00:00.000Z', op: 'captured', offset: 5 }) + '\n'); // not 'handed' — ignored

  const days = distinctHandedDates(SID);
  eq('two distinct days from three handed events', days.size, 2);
  check('the actual date strings are right, not just the count', days.has('2026-08-02'), [...days]);

  const noFile = distinctHandedDates('orphan-cap-test-never-existed-0000');
  eq('no queue file at all: empty set, not a throw', noFile.size, 0);
}

console.log('\n=== 3. collectOrphanCandidates: only real sids, only ones with something pending ===');
{
  // SID2 has a pending candidate but was NEVER handed — collected, with an empty handedDays set
  // (never offered is never a breach; classifyOrphanQueue's day check alone makes that safe, but
  // the collector itself must not choke on the empty-Set case).
  append(SID2, { op: 'propose', externalId: 'x2', title: 't2', body: 'b', kind: 'observation', dest: 'memory' });
  const stray = path.join(queueDir(), 'not-a-real-session-id.jsonl');
  fs.writeFileSync(stray, JSON.stringify({ at: new Date().toISOString(), op: 'propose', externalId: 'zz', title: 'stray fixture', body: 'b' }) + '\n');

  const collected = collectOrphanCandidates();
  const bySid = new Map(collected.map((q) => [q.sid, q]));
  check('SID (has pending) is collected', bySid.has(SID));
  check('SID2 (has pending, never handed) is collected too', bySid.has(SID2));
  eq('SID2 has zero handed days', bySid.get(SID2).handedDays.size, 0);
  check('the non-UUID/non-test-shaped stray file is excluded (isReal)', !bySid.has('not-a-real-session-id'));
}

console.log('\n=== 4. planOrphanCap: a queue that only PARTLY fits the budget is split, not deferred whole ===');
{
  const manyPending = Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}`, externalId: `x${i}`, title: `t${i}` }));
  const sevenDays = new Set(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
  const q1 = { sid: 'q1', pending: manyPending, handedDays: sevenDays }; // 5 candidates, breaches
  const q2 = { sid: 'q2', pending: manyPending.slice(0, 3), handedDays: sevenDays }; // 3 candidates, breaches
  const q3 = { sid: 'q3', pending: [{ id: 'c1', externalId: 'y', title: 't' }], handedDays: new Set(['2026-08-01']) }; // 1 day, keeps

  const plan = planOrphanCap({ queues: [q1, q2, q3], opts: { capDays: 7, maxPerRun: 6 } });
  eq('q3 never breaches (below the day cap)', plan.kept.some((k) => k.sid === 'q3'), true);
  eq('q1 (5) fits the budget of 6 and settles whole', plan.breach.some((b) => b.sid === 'q1' && b.pending.length === 5), true);
  // budget after q1 = 1. q2 has 3 pending: 1 settles NOW, 2 defer — SPLIT, not whole-queue deferral.
  eq('q2 appears in BOTH breach (partial) and deferred (remainder)', plan.breach.some((b) => b.sid === 'q2') && plan.deferred.some((d) => d.sid === 'q2'), true);
  eq('exactly 1 of q2\'s 3 candidates settles this run', plan.breach.find((b) => b.sid === 'q2').pending.length, 1);
  eq('the other 2 of q2\'s candidates are deferred, not lost', plan.deferred.find((d) => d.sid === 'q2').pending.length, 2);
  eq('stats: 5 (q1) + 1 (q2 partial) = 6 to settle', plan.stats.candidatesToSettle, 6);
  eq('stats: 2 (q2 remainder) deferred', plan.stats.candidatesDeferred, 2);
}

console.log('\n=== 4b. REGRESSION: a single queue larger than the WHOLE per-run budget must still make progress, every run ===');
{
  // The bug this guards: the prior shape deferred a breaching queue WHOLE the instant its own
  // pending count exceeded the budget. Since budget never exceeds maxPerRun, a queue whose OWN
  // pending count exceeds maxPerRun could never satisfy `pending.length <= budget` on ANY run —
  // permanent starvation for exactly the worst-offending queues this backstop exists to catch.
  const huge = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, externalId: `x${i}`, title: `t${i}` }));
  const sevenDays = new Set(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
  const qHuge = { sid: 'q-huge', pending: huge, handedDays: sevenDays };

  const run1 = planOrphanCap({ queues: [qHuge], opts: { capDays: 7, maxPerRun: 5 } });
  eq('run 1: settles exactly maxPerRun (5) of the 12, not zero', run1.breach.find((b) => b.sid === 'q-huge')?.pending.length, 5);
  eq('run 1: the other 7 are deferred, never silently dropped', run1.stats.candidatesDeferred, 7);

  // Simulate the SAME queue on a second run with the 5 already settled (a real worker would
  // re-derive this from a fresh collectOrphanCandidates() after actually settling run 1's 5).
  const qHugeRemainder = { sid: 'q-huge', pending: huge.slice(5), handedDays: sevenDays }; // 7 left
  const run2 = planOrphanCap({ queues: [qHugeRemainder], opts: { capDays: 7, maxPerRun: 5 } });
  eq('run 2: settles the next 5 of the remaining 7 — real forward progress, not starvation', run2.breach.find((b) => b.sid === 'q-huge')?.pending.length, 5);
  eq('run 2: 2 left, not still all 7 — the queue is shrinking run over run', run2.stats.candidatesDeferred, 2);
}

console.log('\n=== 5. off-switch + debounce — same mechanism reap.mjs already proved, exercised on this one ===');
{
  eq('not disabled by default', orphanCapDisabled(), false);
  fs.writeFileSync(orphanCapOffFile(), '1');
  eq('ORPHAN_CAP_OFF file disables it', orphanCapDisabled(), 'ORPHAN_CAP_OFF file');
  fs.unlinkSync(orphanCapOffFile());

  process.env.VECTROS_MEM_ORPHAN_CAP_OFF = '1';
  eq('env var disables it too', orphanCapDisabled(), 'VECTROS_MEM_ORPHAN_CAP_OFF');
  delete process.env.VECTROS_MEM_ORPHAN_CAP_OFF;

  try { fs.unlinkSync(ORPHAN_CAP_MARKER()); } catch { /* fine — not there yet */ }
  eq('no marker yet: due', orphanCapDue(Date.now()), true);
  markOrphanCapChecked(Date.now());
  eq('just checked: NOT due', orphanCapDue(Date.now(), { debounceMs: 60_000 }), false);
  eq('checked long ago (by the caller\'s clock): due again', orphanCapDue(Date.now() + 10 * 60_000, { debounceMs: 60_000 }), true);
}

done();
