// The stale-queue sweep. Every check here can go RED.
//
// WHAT IS ACTUALLY LOAD-BEARING, and therefore what this file spends its checks on:
//   • the four selection gates, each independently (self / stale / floor / already-swept), because
//     each one alone is what stops a specific failure — and three of the four are SPEND gates: get
//     them wrong and the sweep bills a distiller for a phantom, a live session, or a tail it
//     already read.
//   • "one flush attempt per IDLE EPISODE, not per session" — the rule that bounds a failing
//     session's retries WITHOUT permanently blacklisting a session that came back to life. It is
//     the subtlest rule here and the easiest to break by simplifying `sweptAt >= lastStopAt` into
//     "have we ever swept this".
//   • the orphan gate — that a LIVE session's pending is NEVER handed to another agent. A
//     disposition is final and never re-offered, so a wrongly-surfaced live queue means two agents
//     judging one candidate and the second judgement silently losing.
//   • the debounce, in BOTH directions, including that an unreadable marker fails toward sweeping.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { lockFor, queueFor } from '../paths.mjs';

// Self-redirect BEFORE importing anything that can call hlog(); this file deliberately
// forces spawn/marker-append/blind-spot failure receipts, and those must land in an isolated
// file, not production hooks.log. hlog() reads the env var fresh per call (no memoized const), so
// setting it here is sufficient regardless of import order — but do it first anyway, for a reader.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-log-')), 'hooks.log');

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const { selectFlushable, sweepDue, markSweepRun, orphanedPending, planClaimRenewals, runSweep, MAX_FLUSH_PER_SWEEP, HANDED_TTL_MS } =
  await import(pathToFileURL(path.join(HOOKS, 'sweep.mjs')).href);
const { read: readQueue, markSwept, append } =
  await import(pathToFileURL(path.join(HOOKS, 'queue.mjs')).href);
const { logPath } = await import(pathToFileURL(path.join(HOOKS, 'hooklog.mjs')).href);

const H = 3600_000;
const DAY = 24 * H;
const NOW = 1_000_000_000_000; // fixed clock — no Date.now() in the assertions
const GATES = { nowMs: NOW, staleMs: DAY, floorChars: 2_000, currentSid: 'me' };

// A row as `residualBySession` emits one. Stale + fat + never swept = flushable, by default.
const row = (o = {}) => ({
  sid: 'aaaaaaaa-0000-0000-0000-000000000001',
  residual: 50_000,
  ageMs: 40 * H,
  total: 150_000,
  offset: 100_000,
  transcriptPath: '/t.jsonl',
  lastStopAt: NOW - 40 * H,
  sweptAt: null,
  ...o,
});

console.log('=== selectFlushable: the happy path ===');
{
  const r = selectFlushable([row()], GATES);
  eq('a stale session with real residual is flushed', r.flush.length, 1);
  eq('and nothing is skipped', r.skipped.length, 0);
}

console.log('\n=== gate 1: the CURRENT session is never swept (it is live by definition) ===');
{
  const r = selectFlushable([row({ sid: 'me' })], GATES);
  eq('self is not flushed', r.flush.length, 0);
  check('and the receipt says why', r.skipped[0].why.includes('self'), JSON.stringify(r.skipped));
}

console.log('\n=== gate 2: STALENESS — a live/paused session is left to its own agent ===');
{
  eq('idle 23h is NOT flushed', selectFlushable([row({ ageMs: 23 * H })], GATES).flush.length, 0);
  eq('idle exactly 24h IS flushed (>=)', selectFlushable([row({ ageMs: DAY })], GATES).flush.length, 1);
  // A session that never recorded a Stop has UNKNOWN age. Unknown must never read as "done" — that
  // is the fail-safe direction, and it is the one that protects a session we know nothing about.
  eq('unknown age (null) is NOT flushed', selectFlushable([row({ ageMs: null })], GATES).flush.length, 0);
}

console.log('\n=== gate 3: THE FLOOR — this is what keeps phantom sessions free ===');
{
  eq('residual below the floor is not flushed', selectFlushable([row({ residual: 1_999 })], GATES).flush.length, 0);
  eq('residual at the floor is flushed', selectFlushable([row({ residual: 2_000 })], GATES).flush.length, 1);
  // The phantom case, concretely: Desktop spawns ~1-2 Stops/min producing no text. They go stale
  // like anything else, and if the floor did not hold, each would eventually buy a Haiku call.
  const phantoms = Array.from({ length: 20 }, (_, i) =>
    row({ sid: `bbbbbbbb-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, residual: 0, total: 0, offset: 0 }));
  eq('20 stale phantom sessions spawn NOTHING', selectFlushable(phantoms, GATES).flush.length, 0);
}

console.log('\n=== gate 4: ONE FLUSH PER IDLE EPISODE (not one per session, ever) ===');
{
  const swept = row({ lastStopAt: NOW - 40 * H, sweptAt: NOW - 30 * H }); // swept AFTER its last Stop
  eq('a session already flushed this episode is not re-flushed', selectFlushable([swept], GATES).flush.length, 0);
  check('and the receipt says so', selectFlushable([swept], GATES).skipped[0].why.includes('already flushed'));

  // THE RULE THAT IS EASY TO BREAK. `sweptAt` alone would blacklist this session forever. It came
  // BACK, worked, and went stale again — its new tail was never distilled and is owed a flush.
  const resumed = row({ sweptAt: NOW - 30 * H, lastStopAt: NOW - 25 * H }); // Stopped AFTER the sweep
  eq('a session that RESUMED after being swept is eligible again', selectFlushable([resumed], GATES).flush.length, 1);
}

console.log('\n=== MAX_FLUSH_PER_SWEEP: the cap holds, and the remainder is REPORTED not dropped ===');
{
  const many = Array.from({ length: 5 }, (_, i) =>
    row({ sid: `cccccccc-0000-0000-0000-00000000000${i}`, residual: 10_000 * (i + 1) }));
  const r = selectFlushable(many, GATES);
  eq('flush is capped', r.flush.length, MAX_FLUSH_PER_SWEEP);
  eq('the rest are DEFERRED, not silently dropped', r.deferred.length, 5 - MAX_FLUSH_PER_SWEEP);
  eq('every eligible session is accounted for', r.flush.length + r.deferred.length, 5);
  // Biggest tail first: with a small cap, the ordering IS the policy about what gets flushed today.
  eq('the largest residual is flushed first', r.flush[0].residual, 50_000);
}

console.log('\n=== a row with no transcriptPath cannot be flushed (nothing to hand the worker) ===');
eq('no path → skipped', selectFlushable([row({ transcriptPath: '' })], GATES).flush.length, 0);

console.log('\n=== DEGENERATE residuals: the floor gate must fail CLOSED, not open ===');
{
  // `undefined < 2000` and `NaN < 2000` are both FALSE, so a `<` test would have PASSED these
  // straight through to a billed spawn. The floor is a spend gate; anything not demonstrably at or
  // above it must be refused. `withResidual:false` now makes `residual: null` a real produced value.
  eq('residual undefined → NOT flushed', selectFlushable([row({ residual: undefined })], GATES).flush.length, 0);
  eq('residual NaN → NOT flushed', selectFlushable([row({ residual: NaN })], GATES).flush.length, 0);
  eq('residual null → NOT flushed', selectFlushable([row({ residual: null })], GATES).flush.length, 0);
}

console.log('\n=== sweepDue: the debounce, both directions ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-deb-'));
  const marker = path.join(dir, 'last-swept');
  const missing = sweepDue(marker, NOW, 600_000);
  check('a MISSING marker is due (first run)', missing.due);
  eq('and reports an unknown age rather than 0', missing.ageMs, null);

  check('markSweepRun writes the marker', markSweepRun(marker, NOW) && fs.existsSync(marker));
  // The marker's MTIME is the clock, so drive the real clock rather than the written contents.
  const realNow = Date.now();
  check('just-swept is NOT due again', !sweepDue(marker, realNow, 600_000).due);
  check('and IS due once the debounce has elapsed', sweepDue(marker, realNow + 600_001, 600_000).due);
  /**
   * FAIL-OPEN TOWARD SWEEPING: an unreadable marker costing NO sweeps is the tail loss returning
   * silently, which is worse than an extra scan. NOT because the scan is free — it parses every
   * not-yet-swept stale transcript (MEASURED ~1.7s against a 10-session backlog) — but because the
   * two failures are not symmetric: an extra scan costs seconds, a missed sweep costs the text.
   *
   * Driven through the injected reader, NOT by trying to produce a real unreadable file. The first
   * draft pointed this at a DIRECTORY and failed — `statSync` on a directory SUCCEEDS and hands
   * back a usable mtime, so the check was resting on a premise that does not hold. That is the
   * `lock.mjs` trap exactly (a harness that can only confirm what it assumes), so the branch is
   * driven directly and the test claims only what it actually exercises: the LOGIC.
   */
  const thrower = (code) => () => { const e = new Error('injected'); e.code = code; throw e; };
  check('a stat that fails LOUDLY still sweeps', sweepDue(marker, realNow, 600_000, thrower('EPERM')).due);
  eq('and reports an unknown age', sweepDue(marker, realNow, 600_000, thrower('EPERM')).ageMs, null);
  check('ENOENT sweeps too (the normal first-run path)', sweepDue(marker, realNow, 600_000, thrower('ENOENT')).due);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== queue.markSwept: the marker the sweep reads back ===');
{
  const SID = `sweep-test-${process.pid}`;
  const before = readQueue(SID);
  eq('a fresh queue has no sweep marker', before.sweptAt, null);
  markSwept(SID, 50_000);
  const after = readQueue(SID);
  check('sweptAt is set after markSwept', typeof after.sweptAt === 'number', String(after.sweptAt));
  // MONOTONIC, like the watermark: an out-of-order append must not RETRACT a sweep, because
  // sweptAt gates spend and moving it backwards re-authorizes a billed drain of text already read.
  append(SID, { op: 'swept', at: '1999-01-01T00:00:00.000Z', residual: 1 });
  eq('an older swept event does NOT move sweptAt backwards', readQueue(SID).sweptAt, after.sweptAt);
  append(SID, { op: 'swept', at: 'not-a-date', residual: 1 });
  eq('an unparseable timestamp is ignored, not NaN', readQueue(SID).sweptAt, after.sweptAt);
  // The sweep marker must not look like a candidate to anything downstream.
  eq('a swept event proposes nothing', readQueue(SID).pending.length, 0);
  eq('and does not disturb the watermark', readQueue(SID).offset, 0);
  fs.rmSync(queueFor(SID), { force: true });
}

console.log('\n=== orphanedPending: ONLY stale AND flushed sessions are handed to another agent ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-orph-'));
  const SID = {
    orphan: 'dddddddd-0000-0000-0000-000000000001', // stale + swept + pending  → surfaced
    live: 'eeeeeeee-0000-0000-0000-000000000002',   // fresh + swept + pending  → NEVER surfaced
    unswept: 'ffffffff-0000-0000-0000-000000000003', // stale + pending, no sweep → not ours to hand on
    empty: 'aaaaaaaa-0000-0000-0000-000000000004',  // stale + swept, nothing pending
  };
  fs.writeFileSync(path.join(dir, SID.orphan + '.json'), JSON.stringify({ transcriptPath: '/o', lastStopAt: NOW - 40 * H }));
  fs.writeFileSync(path.join(dir, SID.live + '.json'), JSON.stringify({ transcriptPath: '/l', lastStopAt: NOW - 1 * H }));
  fs.writeFileSync(path.join(dir, SID.unswept + '.json'), JSON.stringify({ transcriptPath: '/u', lastStopAt: NOW - 40 * H }));
  fs.writeFileSync(path.join(dir, SID.empty + '.json'), JSON.stringify({ transcriptPath: '/e', lastStopAt: NOW - 40 * H }));

  const pend = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, title: `t${i}`, body: 'b' }));
  const queues = {
    [SID.orphan]: { state: 'ok', offset: 100, sweptAt: NOW - 30 * H, pending: pend(3) },
    [SID.live]: { state: 'ok', offset: 100, sweptAt: NOW - 30 * H, pending: pend(9) },
    [SID.unswept]: { state: 'ok', offset: 100, sweptAt: null, pending: pend(5) },
    [SID.empty]: { state: 'ok', offset: 100, sweptAt: NOW - 30 * H, pending: [] },
  };
  const stops = {
    [SID.orphan]: NOW - 40 * H, [SID.live]: NOW - 1 * H,
    [SID.unswept]: NOW - 40 * H, [SID.empty]: NOW - 40 * H,
  };
  const deps = {
    staleMs: DAY,
    listQueues: () => Object.keys(queues),
    readQueue: (sid) => queues[sid] || { state: 'ok', offset: 0, sweptAt: null, pending: [] },
    readLastStopAt: (sid) => stops[sid] ?? null,
  };
  const got = orphanedPending(NOW, deps);
  const sids = got.map((g) => g.sid);

  check('a stale, swept session with pending IS surfaced', sids.includes(SID.orphan), JSON.stringify(sids));
  check('a LIVE session is NEVER surfaced, even though it was swept and has the most pending',
    !sids.includes(SID.live), JSON.stringify(sids));
  check('a stale session that was never swept is not surfaced', !sids.includes(SID.unswept), JSON.stringify(sids));
  check('a swept session with nothing pending is not surfaced', !sids.includes(SID.empty), JSON.stringify(sids));
  // Residual is 0 for every row here (total === offset). The orphan nudge is about UNSETTLED
  // CANDIDATES, not about unread text — a fully-drained session can still owe disposition.
  eq('surfacing is driven by pending, not by residual', got.length, 1);
  eq('and it carries the candidates themselves', got[0].pending.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== M3: ONE dead queue must reach ONE live agent, not every idle one ===');
{
  /**
   * THE INVARIANT THIS SUBSYSTEM ASSERTS THREE TIMES — "two agents settling one queue is how a
   * candidate gets disposed twice on two different judgements, and the second judgement silently
   * loses" — was only enforced for a LIVE session's queue. `orphanedPending` sorts deterministically,
   * so every live session with nothing of its own pending computed the SAME `orphans[0]`. One dead
   * session's queue reached N agents. `dispose.mjs` idempotence stops a duplicate APPEND; it does
   * not stop two agents doing the verification work and racing to opposite conclusions on a
   * disposition that is final.
   */
  const ORPH = 'dddddddd-3333-0000-0000-000000000001';
  const pend = [{ id: 'c1', title: 't', body: 'b' }, { id: 'c2', title: 't', body: 'b' }];
  const mk = (handedAt = null, handedTo = null) => ({
    staleMs: DAY,
    listQueues: () => [ORPH],
    readQueue: () => ({ state: 'ok', offset: 10, sweptAt: NOW - 30 * H, handedAt, handedTo, pending: pend }),
    readLastStopAt: () => NOW - 40 * H,
  });

  eq('unclaimed: session A is offered it', orphanedPending(NOW, { ...mk(), forSid: 'A' }).length, 1);

  // A has it. B must NOT also be offered it — this is the check that was missing entirely.
  eq('claimed by A: session B is NOT offered the same queue',
    orphanedPending(NOW, { ...mk(NOW - 60_000, 'A'), forSid: 'B' }).length, 0);

  // ...but A itself must still see it, or the holder loses its own nudge on the next prompt.
  eq('claimed by A: A itself is still offered it', orphanedPending(NOW, { ...mk(NOW - 60_000, 'A'), forSid: 'A' }).length, 1);

  /**
   * AND THE CLAIM MUST EXPIRE. A claim with no TTL trades double-settlement for permanent
   * stranding: the claiming session is under no obligation and these are not its candidates, so the
   * common outcome is that it ends without acting. An expired claim returns the queue to
   * circulation rather than burying it.
   */
  eq('an EXPIRED claim releases the queue to another session',
    orphanedPending(NOW, { ...mk(NOW - 3 * 60 * 60 * 1000, 'A'), forSid: 'B' }).length, 1);
  eq('a claim just inside the TTL still holds',
    orphanedPending(NOW, { ...mk(NOW - (HANDED_TTL_MS - 1000), 'A'), forSid: 'B' }).length, 0);

  /**
   * THE GATE MUST FAIL CLOSED — and these three cases were asserted only in a COMMENT, which is how
   * one of them shipped false. "An unknown holder is never us" was written about `handedTo !== forSid`,
   * but `forSid` DEFAULTS to `null`, so `null !== null` is false and a claim with no holder was
   * offered to a caller with no identity: the fail-open the comment said it closed.
   *
   * A malformed claim is still a claim. Some session wrote it; we cannot tell who, so we cannot
   * tell that it is not still working. Treating "I could not identify the holder" as "nobody holds
   * it" is the same shape as treating "I could not read the queue" as "nothing is pending".
   */
  eq('a claim with a NULL holder still blocks a named session (malformed ⇒ claimed-by-unknown)',
    orphanedPending(NOW, { ...mk(NOW - 60_000, null), forSid: 'B' }).length, 0);
  eq('a claim with an EMPTY-STRING holder still blocks',
    orphanedPending(NOW, { ...mk(NOW - 60_000, ''), forSid: 'B' }).length, 0);
  // The one the comment got wrong: unknown holder AND unknown asker must not compare equal.
  eq('an unidentified caller does NOT inherit an unidentified holder\'s claim',
    orphanedPending(NOW, { ...mk(NOW - 60_000, null) }).length, 0);
  eq('...nor does an empty-string caller',
    orphanedPending(NOW, { ...mk(NOW - 60_000, ''), forSid: '' }).length, 0);
}

console.log('\n=== planClaimRenewals: who gets stamped this turn (the two shipped regressions) ===');
{
  /**
   * This selection shipped inline in `recall.mjs`'s `main()` — unreachable from a test without a
   * live API key — and carried two holes of the SAME shape: renewal was folded into the render
   * path, so it inherited that path's gate (`ownPending === 0`) and its subject (`orphans[0]`).
   * Extracting the decision is what makes the table below possible; the table is the point.
   */
  const T = 2 * 60 * 60 * 1000;      // TTL
  const R = T / 4;                   // renew no more often than this
  const NOWM = 1_000_000_000;
  const q = (sid, handedTo, agoMs) => ({ sid, handedTo, handedAt: agoMs === null ? null : NOWM - agoMs, pending: [{}] });
  const plan = (o) => planClaimRenewals({ nowMs: NOWM, renewEveryMs: R, ...o });
  const sids = (p) => p.map((x) => x.sid).sort().join(',');

  // R1(a): a holder with candidates of its own still renews. The old code stopped scanning the
  // moment `ownPending > 0`, and a session working a foreign queue is exactly one producing
  // candidates — so the queue it was mid-verification on reopened at the TTL.
  eq('a held queue is renewed even with no pick (own work in progress)',
    sids(plan({ orphans: [q('X', 'me', T)], pick: null, delivered: false, sessionId: 'me' })), 'X');

  // R1(b): renewal is not limited to the head of the list. `orphanedPending` sorts most-pending-
  // first, so a bigger orphan appearing later silently displaced the one actually held.
  eq('EVERY held queue is renewed, not just the first',
    sids(plan({ orphans: [q('BIG', 'me', T), q('MINE', 'me', T)], pick: q('BIG', 'me', T), delivered: true, sessionId: 'me' })),
    'BIG,MINE');

  // R2: no identity ⇒ no claim at all. Under the shared fallback id every such session computed
  // "I already hold this" and renewed, so the claim never expired while any of them ran.
  eq('a session with no id claims NOTHING (never renews a shared fallback claim)',
    plan({ orphans: [q('X', 'nosession', T)], pick: q('X', 'nosession', T), delivered: true, sessionId: null }).length, 0);
  eq('...and a blank id is the same case', plan({ orphans: [q('X', '  ', T)], sessionId: '  ' }).length, 0);

  // R3: the throttle. Renewal fires per PROMPT; unthrottled it grows a foreign queue by a line per
  // prompt indefinitely, and renewal is what prevents the hold from ever ending.
  eq('a recently-stamped claim is NOT re-stamped', plan({ orphans: [q('X', 'me', 60_000)], sessionId: 'me' }).length, 0);
  eq('a claim older than a quarter-TTL IS re-stamped', sids(plan({ orphans: [q('X', 'me', R + 1000)], sessionId: 'me' })), 'X');
  eq('an unknown handedAt re-stamps rather than risking silent expiry',
    sids(plan({ orphans: [q('X', 'me', null)], sessionId: 'me' })), 'X');

  // The first claim is still delivery-gated: a block dropped for budget was never seen.
  eq('a pick that was NOT delivered is not claimed',
    plan({ orphans: [], pick: q('X', null, null), delivered: false, sessionId: 'me' }).length, 0);
  eq('a delivered pick IS claimed', sids(plan({ orphans: [], pick: q('X', null, null), delivered: true, sessionId: 'me' })), 'X');
  eq('someone else\'s claim is never renewed by us',
    plan({ orphans: [q('X', 'other', T)], sessionId: 'me' }).length, 0);
  // One append per queue per turn — a delivered pick we already hold must not be stamped twice.
  eq('a delivered pick we already hold is stamped ONCE',
    plan({ orphans: [q('X', 'me', T)], pick: q('X', 'me', T), delivered: true, sessionId: 'me' }).length, 1);
}

console.log('\n=== orphanedPending: an UNREADABLE queue must not render as "nothing pending" ===');
{
  // This branch is the module's founding concern and was unreached by every prior fixture — the
  // injected readQueue never returned `corrupt`, so the one path that keeps "cannot tell" from
  // looking like "nothing to settle" was never exercised.
  const got = orphanedPending(NOW, {
    staleMs: DAY,
    listQueues: () => ['eeeeeeee-3333-0000-0000-000000000002'],
    readQueue: () => ({ state: 'corrupt', offset: 0, sweptAt: null, handedAt: null, handedTo: null, pending: [] }),
    readLastStopAt: () => NOW - 40 * H,
  });
  eq('a corrupt queue is not surfaced', got.length, 0);
}

console.log('\n=== DEGENERATE rows the fixtures were engineering away ===');
{
  /**
   * `row()` gave every phantom a clean `residual: 0, total: 0, offset: 0`, which dodges the two
   * populations where the interesting behaviour lives. Determinism-engineering in fixtures is a
   * smell to challenge, not a convenience.
   */
  // (a) a REAL short session: 0 < residual < floor. Not a phantom, but not worth a billed call.
  eq('0 < residual < floor is refused (a real short session, still under the floor)',
    selectFlushable([row({ residual: 900, total: 900, offset: 0 })], GATES).flush.length, 0);
  const skipped = selectFlushable([row({ residual: 900, total: 900, offset: 0 })], GATES).skipped[0];
  check('and the reason names the floor, not staleness', /floor/.test(skipped.why), JSON.stringify(skipped));

  // (b) TIES. With max = 1, sort order decides what gets BILLED, and the comparator was never
  // tested against equal residuals — five distinct values cannot observe stability.
  const tied = ['a', 'b', 'c'].map((c, i) =>
    row({ sid: `9999999${i}-0000-0000-0000-00000000000${i}`, residual: 50_000 }));
  // `max: 1` EXPLICITLY — the prose says "with max = 1" and `GATES` never set it, so the check
  // silently depended on MAX_FLUSH_PER_SWEEP happening to be 1. State the premise you rely on.
  const r = selectFlushable(tied, { ...GATES, max: 1 });
  eq('ties still select exactly one', r.flush.length, 1);
  eq('and account for all three', r.flush.length + r.deferred.length, 3);
  check('tie order is the enumeration order (stable sort) — the first row wins',
    r.flush[0].sid === tied[0].sid, `${r.flush[0].sid} vs ${tied[0].sid}`);
}

console.log('\n=== the orphan nudge block: capped, and honest about the cap ===');
{
  const { renderOrphanNudge, orphanSig } = await import(pathToFileURL(path.join(HOOKS, 'nudge.mjs')).href);
  const many = { sid: 'dddddddd-0000-0000-0000-000000000001', ageMs: 40 * H, pending: Array.from({ length: 20 }, (_, i) => ({ id: `c${i + 1}`, title: `title ${i}`, body: 'body', kind: 'gotcha', dest: 'doc' })) };
  const lines = renderOrphanNudge(many, '40');
  const text = lines.join('\n');
  check('it names the foreign session id (dispose.mjs is addressed per session)', text.includes(many.sid), text.slice(0, 200));
  check('it still warns the reader was not in that session (the epistemic half)', /no memory of|recollection of the session/i.test(text));
  /**
   * THE BLOCK'S JOB IS TO MOVE A READER WHO HAS SOMETHING ELSE TO DO, so the wording is the
   * mechanism and gets asserted like one.
   *
   * This check previously read `/NOT YOUR SESSION|no memory of/i` — an alternation that ACCEPTED
   * the phrase the block opened with, "THIS IS NOT YOUR SESSION'S WORK". That sentence granted
   * permission to defer, in the first clause, and the test would have preserved it through any
   * rewrite. OBSERVED over the first four hours of real sweeps (an owner report, not an instrumented
   * measurement — the measured figures elsewhere in this tree cite their conditions): every settlement on this machine
   * happened because the owner argued for it; left alone, agents deferred. A test that pins the
   * words is worth little, but a test that pins the LICENCE is worth exactly what it costs.
   */
  check('it does NOT tell the reader this is not their work (the licence to defer)',
    !/not your session'?s? work/i.test(text), text.slice(0, 300));
  check('it names the commons: no better-positioned reader exists',
    /NO SESSION BETTER POSITIONED/i.test(text) && /shared responsibility/i.test(text), text.slice(0, 400));
  // ...and the freedom survives the pressure. An agent pushed into settling what it cannot verify
  // produces a confident `ignored`, which is irreversible and destroys a true candidate silently.
  check('it keeps leaving-it-pending an explicitly CORRECT outcome',
    /DISCRETIONARY/.test(text) && /LEAVE IT PENDING/.test(text), text.slice(-400));
  /**
   * THE BLOCK MUST NOT PROMISE A RETURN IT CANNOT DELIVER — a cold review caught this one, and it
   * was FALSE IN BOTH DIRECTIONS. `orphanSig` keys on the pending SET (nudge.mjs), recall commits it
   * on delivery and re-renders only when the signature CHANGES, so a reader who settles nothing
   * never sees the queue again this session; meanwhile `planClaimRenewals` keeps the claim fresh, so
   * `orphanedPending`'s gate hides it from every other session too. "It will be offered again" was
   * the reassurance a hurried reader would lean on, and it was the one sentence that was not true.
   */
  check('it does NOT promise the queue will come back on its own',
    !/will be offered again/i.test(text), text.slice(-600));
  check('...it says pending means PARKED, not passed on',
    /PARKED, NOT PASSED ON/i.test(text), text.slice(-600));
  // And it must not overstate the machine check the reader is about to lean on: `covered:` proves
  // the file EXISTS, never that it covers the candidate. Pressure without this is pressure toward a
  // cheap irreversible dismissal that passes every automated gate.
  check('it admits `covered:` verifies existence, not coverage',
    /EXISTENCE ONLY/i.test(text), text.slice(-600));
  check('the truncation is STATED, not silent', /and 14 more not shown/.test(text), text);
  check('the whole block stays well under the 9500c budget it must fit in', text.length < 4000, String(text.length));
  eq('nothing pending → no block at all', renderOrphanNudge({ sid: 'x', ageMs: 0, pending: [] }, '1').length, 0);
  // The signature includes the SID, so finishing one orphan and moving to the next re-fires.
  check('the signature is sid-scoped',
    orphanSig({ sid: 'a', pending: [{ id: 'c1' }] }) !== orphanSig({ sid: 'b', pending: [{ id: 'c1' }] }));
}

console.log('\n=== runSweep — THE FUNCTION THAT SPENDS MONEY (was untested; 3 defects lived here) ===');
{
  // Every impure edge injected: no real spawn, no real lock, no real ~/.claude, no real clock.
  const mkDeps = (over = {}) => {
    const calls = { spawn: [], claim: [], release: [], markSwept: [], isHeld: [] };
    const deps = {
      spawn: (...a) => { calls.spawn.push(a); return { unref() {} }; },
      claim: (lock, sid) => { calls.claim.push(sid); return { proceed: true, owned: true }; },
      release: (lock, owned, sid) => { calls.release.push({ sid, owned }); return 'released'; },
      isHeld: (lock, sid) => { calls.isHeld.push(sid); return false; },
      markSwept: (sid, res) => { calls.markSwept.push({ sid, res }); return true; },
      residualBySession: () => [],
      ...over,
    };
    return { calls, deps };
  };
  const freshMarker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-run-')), 'last-swept');
  const opts = (deps, extra = {}) => ({ marker: freshMarker(), staleMs: DAY, floorChars: 2_000, debounceMs: 600_000, deps, ...extra });
  const five = Array.from({ length: 5 }, (_, i) =>
    row({ sid: `1111111${i}-0000-0000-0000-000000000000`, residual: 10_000 * (i + 1) }));

  {
    // NOT DUE → nothing at all. The debounce must gate the spend, not just the scan.
    const { calls, deps } = mkDeps({ residualBySession: () => five });
    const marker = freshMarker();
    markSweepRun(marker, Date.now());
    const r = runSweep('me', Date.now(), { ...opts(deps), marker });
    eq('not due → 0 spawns', calls.spawn.length, 0);
    eq('not due → nothing reported as flushed', r.flushed, 0);
  }
  {
    // DUE with 5 eligible → exactly ONE spawn, one marker, four deferred.
    const { calls, deps } = mkDeps({ residualBySession: () => five });
    const r = runSweep('me', NOW, opts(deps));
    eq('exactly one spawn', calls.spawn.length, MAX_FLUSH_PER_SWEEP);
    eq('exactly one markSwept', calls.markSwept.length, MAX_FLUSH_PER_SWEEP);
    eq('the rest are deferred', r.deferred, 5 - MAX_FLUSH_PER_SWEEP);
    eq('the biggest residual is the one flushed', calls.markSwept[0].res, 50_000);
    // The worker gets the OFFSET, never the total — the honest-watermark contract.
    // And `--recovered`: the sweep is the ONLY caller that knows this session ended without
    // settling, so it is the only place `origin: 'recovered'` can be decided. Nothing passed it
    // before, and the schema's second enum value was consequently never written by anything.
    eq('the worker is handed (sid, transcriptPath, offset, --recovered)', calls.spawn[0][1].slice(1).join('|'),
      ['1111111' + 4 + '-0000-0000-0000-000000000000', '/t.jsonl', '100000', '--recovered'].join('|'));
  }
  {
    /**
     * HEAD-OF-LINE BLOCKING — the defect that made the whole sweep permanently dead.
     *
     * The biggest-residual session sorts FIRST and its lock is held (a live worker, or a stale lock
     * nothing ever cleared, since a done session's capture hook never runs again). The cap must
     * bound SPAWNS, not attempts: the next eligible session must still be flushed. Before the fix
     * this returned flushed:0 on every sweep, forever, while blaming MAX_FLUSH_PER_SWEEP.
     */
    const wedged = five[4].sid;
    const { calls, deps } = mkDeps({
      residualBySession: () => five,
      isHeld: (lock, sid) => sid === wedged,
    });
    const r = runSweep('me', NOW, opts(deps));
    eq('the wedged session is NOT spawned', calls.spawn.filter((a) => a[1][1] === wedged).length, 0);
    eq('but the sweep still flushes the next one', r.flushed, 1);
    eq('and never claims the wedged lock', calls.claim.includes(wedged), false);
    check('the blocked session is COUNTED, not silently dropped', r.blocked === 1, JSON.stringify(r));
  }
  {
    /**
     * DEFERRED MUST NOT NAME A SESSION THAT WAS FLUSHED. `deferred` was `eligible.slice(max)`,
     * computed BEFORE the loop — correct only while the loop consumed the head in order. Once
     * blocked sessions are skipped rather than counted against the cap, the two disagree: with
     * [a(blocked), b] and max=1 the loop flushes `b`, while the precomputed slice also called `b`
     * deferred. The receipt then named the same session as both, and runSweep returned deferred:1
     * for a session it had just drained — the mis-attribution its own comment forbids, introduced
     * by the fix that added the skipping.
     */
    const wedged = five[4].sid;
    const { calls, deps } = mkDeps({
      residualBySession: () => [five[4], five[3]],
      isHeld: (lock, sid) => sid === wedged,
    });
    const r = runSweep('me', NOW, opts(deps));
    eq('the non-blocked session is flushed', r.flushed, 1);
    eq('the blocked one is counted as blocked', r.blocked, 1);
    eq('and NOTHING is reported as deferred — both were accounted for', r.deferred, 0);
    eq('the flushed session is the one the loop reached', calls.markSwept[0].sid, five[3].sid);
  }
  {
    // A lost claim race is not a flush, and must NOT be marked swept — the episode is still owed.
    const { calls, deps } = mkDeps({
      residualBySession: () => [five[4]],
      claim: () => ({ proceed: false, owned: false }),
    });
    const r = runSweep('me', NOW, opts(deps));
    eq('lost claim → no spawn', calls.spawn.length, 0);
    eq('lost claim → NOT marked swept (still owed)', calls.markSwept.length, 0);
    eq('and it is reported as blocked', r.blocked, 1);
  }
  {
    // A spawn that throws must RELEASE the lock we took, or capture is wedged for 30 minutes — and
    // must not mark swept, because nothing ran.
    const { calls, deps } = mkDeps({
      residualBySession: () => [five[4]],
      spawn: () => { const e = new Error('EMFILE'); e.code = 'EMFILE'; throw e; },
    });
    runSweep('me', NOW, opts(deps));
    eq('spawn failure releases the lock', calls.release.length, 1);
    check('and releases it as OWNED', calls.release[0].owned === true);
    eq('spawn failure does NOT mark swept', calls.markSwept.length, 0);
  }
  {
    // A lost `swept` append is the unbounded-retry hazard. The spawn already happened, so there is
    // nothing to undo — but it must not pass silently. (`append` returns false; the old code
    // discarded it, in the same module whose header says that return "is now CHECKED".)
    //
    // BASELINE THE LOG FIRST. This originally grepped the tail of the real hooks.log with no
    // baseline, so a matching line left by ANY earlier run of this suite satisfied it — the check
    // was byte-identical under the bug it claims to catch, which is the precise defect the
    // undeclared-const lint documents at length about its own red-proof. Assert only against bytes
    // appended by THIS call.
    const LOGP = logPath(); // the redirected, per-file-isolated log, not production
    const at = (() => { try { return fs.statSync(LOGP).size; } catch { return 0; } })();
    const { deps } = mkDeps({ residualBySession: () => [five[4]], markSwept: () => false }); // this block asserts the log receipt only; call counts aren't the point here
    const r = runSweep('me', NOW, opts(deps));
    eq('the flush still counts (the money was spent)', r.flushed, 1);
    const fresh = (() => {
      try { const b = fs.readFileSync(LOGP); return b.slice(at).toString('utf8'); } catch { return ''; }
    })();
    check('a FAILED marker append leaves a receipt naming the consequence — in bytes written by THIS call',
      /marker append FAILED/.test(fresh), JSON.stringify(fresh.slice(0, 400)));
  }
  {
    // The current session is live by definition and must never be swept, even at the head.
    const { calls, deps } = mkDeps({ residualBySession: () => five });
    runSweep(five[4].sid, NOW, opts(deps));
    eq('self is never spawned', calls.spawn.filter((a) => a[1][1] === five[4].sid).length, 0);
  }
}

console.log('\n=== M2: the steady-state "no flush" receipt must name the RIGHT cause ===');
{
  /**
   * Once the backlog drains, `skipSwept` drops every stale session BEFORE `selectFlushable` can
   * classify it, so the gate tally is empty — and the fallback used to assert "no session has been
   * idle long enough", which is false for every one of them. This shipped untested, and the entire
   * point of the fix is a STRING an operator reads at 2am, so the string is what gets asserted.
   */
  const LOGP = logPath(); // the redirected, per-file-isolated log, not production
  const at = (() => { try { return fs.statSync(LOGP).size; } catch { return 0; } })();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-m2-')), 'last-swept');
  // The enumerator returns NO rows and reports three already-flushed drops — the drained-backlog
  // steady state, which is when this line actually fires in a healthy system.
  const r = runSweep('me', NOW, {
    marker, staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
    deps: {
      spawn: () => { throw new Error('must not spawn'); },
      residualBySession: (nowMs, opts) => { if (opts && opts.stats) opts.stats.skippedSwept = 3; return []; },
    },
  });
  eq('nothing is flushed', r.flushed, 0);
  const fresh = (() => { try { return fs.readFileSync(LOGP).slice(at).toString('utf8'); } catch { return ''; } })();
  check('the receipt names ALREADY FLUSHED as the cause',
    /3 already flushed this idle episode/.test(fresh), JSON.stringify(fresh.slice(0, 400)));
  check('and it does NOT claim nothing has been idle long enough',
    !/no session has been idle long enough/.test(fresh), JSON.stringify(fresh.slice(0, 400)));
}

console.log('\n=== the blind-spot receipt fires on BOTH paths (it was dead code in the suite) ===');
{
  /**
   * WHY THIS EXISTS: `unseen` shipped with no coverage, and worse, it was UNREACHABLE from the
   * suite — every `runSweep` test injects `residualBySession`, while `blindSpots` is populated only
   * by the REAL enumerator's `noteSkip`. Both `if (unseen)` lines were therefore dead in every test,
   * and deleting them would have left the suite green. That is verbatim the failure this branch's
   * own `all-seams-injected-hides-wiring` gotcha describes — in the commit that edits that gotcha.
   *
   * The seam used here is the LEDGER, not the enumerator: push a real entry through `noteSkip`,
   * drive each receipt path, and read the bytes the sweep actually wrote.
   */
  const { blindSpots, noteSkip } = await import(pathToFileURL(path.join(HOOKS, 'residual.mjs')).href);
  const LOGP = logPath(); // the redirected, per-file-isolated log, not production
  const sizeNow = () => { try { return fs.statSync(LOGP).size; } catch { return 0; } };
  const freshFrom = (at) => { try { return fs.readFileSync(LOGP).slice(at).toString('utf8'); } catch { return ''; } };
  const tmpMarker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-unseen-')), 'last-swept');

  blindSpots.length = 0;
  noteSkip('state deadbeef.json (residual)', { code: 'EACCES' });

  {
    const at = sizeNow();
    runSweep('me', NOW, {
      marker: tmpMarker(), staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
      deps: { spawn: () => { throw new Error('must not spawn'); }, residualBySession: () => [] },
    });
    const fresh = freshFrom(at);
    check('no-flush receipt reports the blind-spot entry', /blind-spot entr/.test(fresh), fresh.slice(0, 400));
  }

  {
    const at = sizeNow();
    const rows = [row({ sid: 'eeeeeeee-0000-0000-0000-000000000001', residual: 40_000 }),
                  row({ sid: 'eeeeeeee-0000-0000-0000-000000000002', residual: 39_000 })];
    runSweep('me', NOW, {
      marker: tmpMarker(), staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
      deps: {
        spawn: () => ({ unref() {} }), residualBySession: () => rows,
        isHeld: () => false, claim: () => ({ proceed: true, owned: true }), release: () => 'released',
        markSwept: () => true,
      },
    });
    const fresh = freshFrom(at);
    check('the FLUSH-path receipt reports it too', /blind-spot entr/.test(fresh), fresh.slice(0, 500));
    check('...and still reports the deferred remainder', /deferred by the cap/.test(fresh), fresh.slice(0, 500));
  }

  /**
   * THE `|| unseen` TERM OF THE GUARD, isolated. The two-row fixture above enters that branch
   * anyway (one row is deferred by the cap), so deleting `|| unseen` left it green — the term was
   * untested inside a test that looked like it covered it. ONE row: nothing deferred, nothing
   * blocked, so the receipt exists only because a blind spot does.
   */
  {
    blindSpots.length = 0;
    noteSkip('state cafebabe.json (residual)', { code: 'EIO' });
    const at = sizeNow();
    runSweep('me', NOW, {
      marker: tmpMarker(), staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
      deps: {
        spawn: () => ({ unref() {} }),
        residualBySession: () => [row({ sid: 'eeeeeeee-0000-0000-0000-00000000000a', residual: 40_000 })],
        isHeld: () => false, claim: () => ({ proceed: true, owned: true }), release: () => 'released',
        markSwept: () => true,
      },
    });
    const fresh = freshFrom(at);
    check('a clean single flush STILL reports the blind spot (the `|| unseen` guard term)',
      /blind-spot entr/.test(fresh), fresh.slice(0, 500));
    check('...and does not claim anything was deferred', !/deferred by the cap/.test(fresh), fresh.slice(0, 500));
  }

  {
    blindSpots.length = 0;
    noteSkip('the ENTIRE state dir', { code: 'EACCES' });
    const at = sizeNow();
    runSweep('me', NOW, {
      marker: tmpMarker(), staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
      deps: { spawn: () => { throw new Error('must not spawn'); }, residualBySession: () => [] },
    });
    const fresh = freshFrom(at);
    check('a whole-dir failure is not reported as a session count', !/session\(s\) UNREADABLE/.test(fresh), fresh.slice(0, 400));
  }
  blindSpots.length = 0;
}

console.log('\n=== runSweep END-TO-END: the REAL modules, only `spawn` stubbed ===');
{
  /**
   * THIS IS THE TEST WHOSE ABSENCE SHIPPED A BLOCKER. Every check above injects `isHeld`, `claim`,
   * `release`, `markSwept` AND the enumerator, so `d.isHeld || isHeld` short-circuited and the fact
   * that `isHeld` was never IMPORTED was invisible: `runSweep` threw ReferenceError on every real
   * Stop, the sweep was dead in production, and 75 green checks said nothing about it. The seam
   * added to make the spending path testable was what hid the defect in it.
   *
   * `node --check` does not catch this either (it blesses a free identifier), and the
   * undeclared-const lint only censuses UPPER_SNAKE names. The remedy is a test that runs the real
   * module graph: everything real except `spawn`, against a temp state/queue dir.
   */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-e2e-'));
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir);
  const SID = 'abcdabcd-2222-0000-0000-000000000001';
  const tx = path.join(base, 'transcript.jsonl');
  /**
   * A transcript the REAL parser accepts — `type` (not `role`) at the top level, which is what
   * `transcript.mjs:78` filters on. The first draft of this fixture used `role`, so
   * `transcriptLength` returned 0, the residual fell under the floor, and nothing flushed. The test
   * reported that honestly instead of passing — which is the argument for building a fixture
   * against the real reader rather than against one's memory of the format.
   */
  fs.writeFileSync(tx, Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(200) + i } })).join('\n') + '\n');
  fs.writeFileSync(path.join(stateDir, SID + '.json'),
    JSON.stringify({ transcriptPath: tx, lastStopAt: Date.now() - 40 * H }));

  const spawned = [];
  const now = Date.now();
  const r = runSweep('some-other-live-session', now, {
    marker: path.join(base, 'last-swept'),
    staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
    // ONLY spawn is stubbed. isHeld/claim/release/markSwept/residualBySession are the REAL ones.
    deps: { spawn: (...a) => { spawned.push(a); return { unref() {} }; }, enumDeps: { stateDir } },
  });
  check('the real module graph runs without throwing', r && typeof r.flushed === 'number', JSON.stringify(r));
  eq('and it flushed the stale session end-to-end', r.flushed, 1);
  eq('spawning the real worker path exactly once', spawned.length, 1);
  check('the worker was handed this session and its transcript',
    !!spawned[0] && spawned[0][1][1] === SID && spawned[0][1][2] === tx,
    JSON.stringify(spawned[0] ? spawned[0][1] : 'nothing was spawned'));
  // The REAL markSwept ran, so the REAL queue now carries the marker — and gate 4 must now hold.
  const q = readQueue(SID);
  check('the real markSwept wrote a real `swept` event', typeof q.sweptAt === 'number', String(q.sweptAt));
  const again = runSweep('some-other-live-session', now, {
    marker: path.join(base, 'last-swept-2'),
    staleMs: DAY, floorChars: 2_000, debounceMs: 600_000,
    deps: { spawn: (...a) => { spawned.push(a); return { unref() {} }; }, enumDeps: { stateDir } },
  });
  eq('a second sweep does NOT re-flush the same idle episode', again.flushed, 0);
  eq('and no second worker was spawned', spawned.length, 1);
  // The REAL claim took a REAL lock file; releasing it keeps the machine clean for the next run.
  try { fs.unlinkSync(lockFor(SID)); } catch { /* already released */ }
  try { fs.unlinkSync(queueFor(SID)); } catch { /* nothing to clean */ }
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('\n=== THE COST GATE: the prompt path must not pay for what it discards ===');
{
  /**
   * The defect this guards: `orphanedPending` ran the full residual enumeration — a `readFileSync`
   * + per-line `JSON.parse` of EVERY session's transcript — and then filtered by staleness
   * afterwards, in its own loop. MEASURED on the real machine: **1818 ms per prompt, 218 MB
   * parsed, zero rows returned**, on the synchronous `UserPromptSubmit` path.
   *
   * A spy on the already-injected dep is the whole test, and it would have caught this at authoring
   * time. Assert the EXPENSIVE call is never made for a session that cannot possibly qualify.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cost-'));
  const STALE = 'aaaaaaaa-1111-0000-0000-000000000001';
  const LIVE = 'bbbbbbbb-1111-0000-0000-000000000002';
  fs.writeFileSync(path.join(dir, STALE + '.json'), JSON.stringify({ transcriptPath: '/s', lastStopAt: NOW - 40 * H }));
  fs.writeFileSync(path.join(dir, LIVE + '.json'), JSON.stringify({ transcriptPath: '/l', lastStopAt: NOW - 1 * H }));

  const seen = [];
  const queues = {
    [STALE]: { state: 'ok', offset: 10, sweptAt: NOW - 30 * H, pending: [{ id: 'c1', title: 't', body: 'b' }] },
    [LIVE]: { state: 'ok', offset: 10, sweptAt: NOW - 30 * H, pending: [{ id: 'c1', title: 't', body: 'b' }] },
  };
  const qSeen = [];
  const stateSeen = [];
  const got = orphanedPending(NOW, {
    staleMs: DAY,
    listQueues: () => [STALE, LIVE],
    readQueue: (sid) => { qSeen.push(sid); return queues[sid] || { state: 'ok', offset: 0, sweptAt: null, pending: [] }; },
    readLastStopAt: (sid) => { stateSeen.push(sid); return sid === STALE ? NOW - 40 * H : NOW - 1 * H; },
    transcriptLength: (p) => { seen.push(p); return 100; },
  });
  eq('the orphan nudge reads ZERO transcripts (it never uses residual)', seen.length, 0);
  eq('each queue is folded exactly ONCE', qSeen.join(','), [STALE, LIVE].join(','));
  eq('while still returning the orphan', got.length, 1);
  eq('and the live session is excluded', got[0].sid, STALE);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== the same gate on the sweep path: a live session costs no transcript read ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cost2-'));
  const LIVE = 'cccccccc-1111-0000-0000-000000000003';
  fs.writeFileSync(path.join(dir, LIVE + '.json'), JSON.stringify({ transcriptPath: '/l', lastStopAt: NOW - 1 * H }));
  const { residualBySession } = await import(pathToFileURL(path.join(HOOKS, 'residual.mjs')).href);
  const seen = [];
  const rows = residualBySession(NOW, {
    stateDir: dir, minAgeMs: DAY,
    readQueue: () => ({ state: 'ok', offset: 0, sweptAt: null, pending: [] }),
    transcriptLength: (p) => { seen.push(p); return 100; },
  });
  eq('a session younger than minAgeMs is skipped BEFORE the transcript read', seen.length, 0);
  eq('and yields no row', rows.length, 0);
  // Without the filter the same session IS measured — proving the gate is what skipped it, not a
  // broken fixture (a check that passes for the wrong reason is the disease here).
  const rows2 = residualBySession(NOW, {
    stateDir: dir,
    readQueue: () => ({ state: 'ok', offset: 0, sweptAt: null, pending: [] }),
    transcriptLength: (p) => { seen.push(p); return 100; },
  });
  eq('control: with no minAgeMs the transcript IS read', seen.length, 1);
  eq('control: and the row appears', rows2.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\ndone');
done();
