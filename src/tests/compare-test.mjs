/**
 * `report.mjs --compare` — the instrument that decides whether the cutover may proceed.
 *
 * What this is really guarding: Phase A ends when the queue and the record corpus AGREE, and this
 * is the only thing that measures that. So its failure modes are worse than a wrong number — a
 * comparison that reports agreement it did not observe is an authorization to flip the reads.
 *
 * Two specific ways that happens, both tested below. (1) A lookup that could not RUN returns
 * `null`, and treating it as an empty corpus turns an outage into "every candidate is missing" —
 * a false alarm that is indistinguishable from the real one and trains the reader to ignore both.
 * (2) A candidate still OWED in the spool is absent from the corpus for a completely benign
 * reason; counting it alongside a PARKED one — over budget, never to be retried, genuinely lost —
 * would bury the number that matters under the number that is expected to be large.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.

process.env.VECTROS_HOOKLOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'compare-test-log-')), 'hooks.log');
process.env.VECTROS_API_KEY = 'ssk_test_fake_for_unit_tests';
process.env.VECTROS_MEM_SPOOL_MAX_ATTEMPTS = '2';

const { compareSession } = await import('../report.mjs');
const { append } = await import('../queue.mjs');
const { spool, markFailed, spoolPath } = await import('../spool.mjs');
const { queueFor } = await import('../paths.mjs');
const { gapFile: candidateSchemaGapFile } = await import('../candidates.mjs');
const { digestOf } = await import('../capture-map.mjs');

try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }

/**
 * THE SESSION ID CONTAINS A CHARACTER THE PATH SLUG MANGLES — do not "clean it up".
 *
 * `compareSession` is handed the QUEUE FILENAME (slugged), while the records carry the RAW session
 * id, so it recovers the raw one from the externalId's prefix rather than trusting the filename.
 * With a slug-safe id like `compare-test-0001` the two are byte-identical and that whole mechanism
 * is unobservable: deleting it leaves the suite green. Today's session ids ARE uuids, so this is
 * the fixture doing the work the real world currently cannot.
 */
const RAW = 'compare test:0001';
const SID = RAW.replace(/[^\w.-]/g, '_');   // what the filename — and therefore the caller — is
const xid = (n) => `${RAW}:u${n}`;
const reset = () => {
  for (const p of [queueFor(SID), spoolPath(SID)]) { try { fs.unlinkSync(p); } catch { /* fine */ } }
};
const propose = (n, extra = {}) =>
  append(RAW, { op: 'propose', externalId: xid(n), title: `t${n}`, body: 'b', kind: 'project', ...extra });

/** A lookup transport that returns exactly the externalIds named — or refuses to run. */
function corpus(xids, { unrunnable = false } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body || '{}') });
      if (unrunnable) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'down', json: async () => ({}) };
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ data: xids.map((x) => ({ id: x, externalId: x, payload: { title: 'x' } })) }),
        text: async () => '',
      };
    },
  };
}

/** Like `corpus()`, but each row carries the payload the store actually holds. */
function corpusWith(rows) {
  const calls = [];
  return { calls, impl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body || '{}') });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '',
      json: async () => ({ data: rows.map((r) => ({ id: r.externalId, externalId: r.externalId, payload: r.payload })) }) };
  } };
}

console.log('\n=== 1. both stores hold the same set ===');
{
  reset();
  propose(1); propose(2);
  const c = corpus([xid(1), xid(2)]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('two candidates queued', r.queued, 2);
  eq('...both in the corpus', r.agreed, 2);
  eq('...nothing missing', r.missing.owed.length + r.missing.parked.length + r.missing.unspooled.length, 0);
  eq('...and no orphans', r.orphaned.length, 0);
  // The lookup must key on the sessionId the RECORDS carry, which is the externalId's prefix —
  // not the queue filename. Identical for a uuid sid, silently different for anything else.
  eq('the lookup asked for the RAW session id, not the slugged filename', c.calls[0].body.value, RAW);
  eq('...by the sessionId field', c.calls[0].body.field, 'sessionId');
}

console.log('\n=== 2. the three ways a candidate can be absent are DIFFERENT findings ===');
{
  /**
   * Right after a deploy every candidate is `owed` and none are in the corpus. If that read as
   * divergence, the instrument would scream on the one day it is supposed to say "draining".
   * Conversely `parked` and `unspooled` must never hide inside that number: the first is a lesson
   * that will never reach the store, the second means the dual-write did not happen at all.
   */
  reset();
  propose(1); propose(2); propose(3); propose(4);
  spool(RAW, xid(1), { title: 't1' });                 // owed — spooled, not yet synced
  spool(RAW, xid(2), { title: 't2' });                 // will be parked
  markFailed(RAW, xid(2), 'boom'); markFailed(RAW, xid(2), 'boom');
  //   xid(3) is never spooled at all
  const c = corpus([xid(4)]);                          // only 4 actually landed
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('one agreed', r.agreed, 1);
  eq('one is owed (expected, still draining)', JSON.stringify(r.missing.owed), JSON.stringify([xid(1)]));
  eq('one is PARKED (a real loss)', JSON.stringify(r.missing.parked), JSON.stringify([xid(2)]));
  eq('one was NEVER SPOOLED (the dual-write did not happen)', JSON.stringify(r.missing.unspooled), JSON.stringify([xid(3)]));
}

console.log('\n=== 3. an unrunnable lookup is UNKNOWN, never "the corpus is empty" ===');
{
  reset();
  propose(1); propose(2);
  const c = corpus([], { unrunnable: true });
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('the session is reported unknown', r.state, 'unknown');
  check('...and reports NO missing set to be misread', r.missing === undefined);
  eq('...while still saying how much was at stake', r.queued, 2);
}

console.log('\n=== 4. candidates proposed before the cutover are out of scope, not lost ===');
{
  /**
   * Most of the existing corpus has no externalId — it was proposed before dual-write shipped, and
   * §7's backfill is what gives it records. Counting those as "never spooled" would report several
   * hundred false divergences on the first run and drown the handful that are real.
   */
  reset();
  append(RAW, { op: 'propose', title: 'from before', body: 'b', kind: 'project' });
  propose(1);
  const c = corpus([xid(1)]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('the old one is counted separately', r.preCutover, 1);
  eq('...and is not in the comparison at all', r.queued, 1);
  eq('...which agrees', r.agreed, 1);
  eq('...with nothing reported as never-spooled', r.missing.unspooled.length, 0);
}

console.log('\n=== 5. a record with no queue row behind it ===');
{
  // Queue-first ordering is supposed to make this impossible, so a non-zero count is evidence the
  // ordering assumption is wrong — which is worth surfacing even though nothing is lost.
  reset();
  propose(1);
  const c = corpus([xid(1), `${RAW}:ghost`]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('the stray record is reported', JSON.stringify(r.orphaned), JSON.stringify([`${RAW}:ghost`]));
  eq('...without disturbing the agreed count', r.agreed, 1);
}

console.log('\n=== 6. an unreadable queue refuses to answer ===');
{
  // Same refusal every reader in this tree makes: an empty fold from a queue we could not read
  // would report zero candidates and therefore perfect agreement — the most dangerous wrong
  // answer this instrument can give.
  reset();
  fs.mkdirSync(queueFor(SID), { recursive: true });   // a directory where the file should be
  const r = await compareSession(SID, { fetchImpl: corpus([]).impl });
  eq('it says the queue is unreadable', r.state, 'unreadable-queue');
  check('...and reports no agreement', r.agreed === undefined);
  fs.rmSync(queueFor(SID), { recursive: true, force: true });
}

console.log('\n=== 7. a session with nothing post-cutover touches no network ===');
{
  // A lookup per session with nothing to compare would be 60+ pointless round trips on a corpus
  // that is almost entirely pre-cutover for the first days.
  reset();
  append(RAW, { op: 'propose', title: 'from before', body: 'b', kind: 'project' });
  const c = corpus([]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('nothing was asked of the store', c.calls.length, 0);
  eq('...and it is still a clean answer', r.state, 'ok');
  eq('...with the pre-cutover count intact', r.preCutover, 1);
}

console.log('\n=== 8. a row that EXISTS but holds the wrong content ===');
{
  /**
   * THE FAILURE `--compare` WAS BUILT FOR AND COULD NOT SEE. `POST /v1/records` ignores unknown
   * top-level keys, so sending `data` instead of `payload` returns 200 and stores an EMPTY record —
   * while `externalId`, a top-level field, lands regardless. Two staging runs were lost to exactly
   * that. A set difference over externalIds calls it perfect agreement; only content can see it.
   */
  reset();
  const ev = { op: 'propose', externalId: xid(1), title: 't1', body: 'the real claim', kind: 'project' };
  ev.digest = digestOf({ title: 't1', body: 'the real claim', kind: 'project', sourceRef: null });
  append(RAW, ev);
  // The store returns the row — with an empty payload, exactly as the silent-failure class produces.
  const c = corpus([xid(1)]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('the row is present, so it is NOT reported missing', r.missing.unspooled.length, 0);
  eq('...but the content mismatch IS reported', JSON.stringify(r.missing.divergent), JSON.stringify([xid(1)]));
  eq('...and it does not count as agreement', r.agreed, 0);
}

console.log('\n=== 9. matching content is not reported as divergence ===');
{
  // The control for §8: a faithful round trip must stay silent, or the new bucket is just noise.
  reset();
  const payload = { title: 't1', body: 'the real claim', kind: 'project', sourceRef: null };
  const ev = { op: 'propose', externalId: xid(1), ...payload };
  ev.digest = digestOf(payload);
  append(RAW, ev);
  const c = corpusWith([{ externalId: xid(1), payload }]);
  const r = await compareSession(SID, { fetchImpl: c.impl });
  eq('a faithful round trip agrees', r.agreed, 1);
  eq('...with nothing flagged divergent', r.missing.divergent.length, 0);
}

reset();
done();
