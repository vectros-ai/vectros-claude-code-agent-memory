/**
 * The write-ahead spool — the fold, the retry budget, and the flush receipt.
 *
 * What this is really guarding: the spool is the ONLY thing standing between a billed distillation
 * and a lost lesson. The transcript window it came from will not be re-read (the watermark moved),
 * so a proposal that fails to reach the store and fails to reach disk is simply gone. Every branch
 * below is a way that could happen quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.

process.env.VECTROS_HOOKLOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'spool-test-log-')), 'hooks.log');
process.env.VECTROS_API_KEY = 'ssk_test_fake_for_unit_tests';
// A small budget so the parking behaviour is reachable without 5 hand-written failures.
process.env.VECTROS_MEM_SPOOL_MAX_ATTEMPTS = '2';
process.env.VECTROS_MEM_SPOOL_FLUSH_MAX_PER_RUN = '2';

const { spool, spoolSupersede, read, markSynced, markFailed, flush, drainAll, listSpools, spoolPath } = await import('../spool.mjs');
const { spoolOffFile, verdictMutationsOffFile } = await import('../paths.mjs');
// The latch path is PER-CONTEXT (keyed by API base URL), so the module owns it — a test that
// addressed the bare paths.mjs name would be creating and deleting a file nothing reads.
const { gapFile: candidateSchemaGapFile } = await import('../candidates.mjs');

try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }
/**
 * THIS FILE OPTS IN TO PROMOTION, and it is the only one that may.
 *
 * `isolate.mjs` writes a `SPOOL_OFF` marker into every isolated root so no test can POST a
 * candidate to the owner's real store (credentials are deliberately not isolated). This file
 * exercises the flush itself, and does so exclusively through an INJECTED fake transport — every
 * `flush` below passes `fetchImpl`, so nothing here can reach a network whatever the marker says.
 * Removing it is therefore safe HERE and nowhere else; do not copy this line into another test.
 */
try { fs.unlinkSync(spoolOffFile()); } catch { /* fine */ }
/**
 * ...AND THE SUPERSEDE HALF NEEDS THE OTHER GATE TOO. `spoolSupersede`'s flush path runs through
 * `candidates.mjs`'s `supersedeByExternalId` -> `markSuperseded` -> `patch()`, which checks
 * `VERDICT_MUTATIONS_OFF`, not `SPOOL_OFF` — a DIFFERENT marker `isolate.mjs` also writes into
 * every isolated root (see `candidates-test.mjs`'s identical opt-in). Missing this left case 13
 * below (the REVISE-retirement test) silently exercising the "mutations are off" no-op branch
 * instead of the real patch logic it claims to prove — found because it failed the SAME way every
 * time in isolation, then differently when run inside the shared-root full suite (where
 * `candidates-test.mjs` happens to have already unlinked the marker first). Safe to remove HERE for
 * the same reason as `SPOOL_OFF` above: every call below injects `fetchImpl`, so nothing can reach
 * a real network regardless of the marker.
 */
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine */ }

const SID = 'spool-test-0001';
const P = spoolPath(SID);
const reset = () => { try { fs.unlinkSync(P); } catch { /* fine */ } };
const cand = (n) => ({ title: `t${n}`, body: `b${n}`, kind: 'project' });

// A fake transport, same shape as candidates-test's — flush reaches the network through `propose`.
function fake(seq) {
  const calls = [];
  const q = Array.isArray(seq) ? [...seq] : [seq];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body || '{}') });
    const r = q.length > 1 ? q.shift() : q[0];
    if (r.throws) { const e = new Error(r.throws); e.name = 'AbortError'; throw e; }
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: () => null },
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return { impl, calls };
}
const okWrite = { status: 201, body: { id: 'x', externalId: 'e', payload: {} } };

console.log('\n=== 1. the fold ===');
reset();
eq('a fresh spool owes nothing', read(SID).state, 'fresh');
spool(SID, 'e1', cand(1));
spool(SID, 'e2', cand(2));
eq('two proposals are owed', read(SID).owed.length, 2);
eq('...and carry their candidate', read(SID).owed[0].candidate.title, 't1');
markSynced(SID, 'e1');
const afterSync = read(SID);
eq('a synced proposal leaves the owed set', afterSync.owed.length, 1);
eq('...and is counted', afterSync.synced, 1);
eq('...leaving the right one', afterSync.owed[0].externalId, 'e2');

console.log('\n=== 2. the retry budget — a permanent failure must not retry forever ===');
reset();
spool(SID, 'e1', cand(1));
markFailed(SID, 'e1', 'boom');
eq('one failure keeps it owed', read(SID).owed.length, 1);
eq('...with the attempt counted', read(SID).owed[0].attempts, 1);
markFailed(SID, 'e1', 'boom');
const parked = read(SID);
eq('at the budget it is PARKED, not owed', parked.owed.length, 0);
eq('...and parked is visible, so the loss is measured not silent', parked.parked.length, 1);
// Parked, never deleted: the failure trail is the only evidence a doomed proposal leaves.
check('the entry is still on disk', fs.readFileSync(P, 'utf8').includes('e1'));

console.log('\n=== 3. damage containment ===');
reset();
spool(SID, 'e1', cand(1));
fs.appendFileSync(P, 'this is not json\n');
spool(SID, 'e2', cand(2));
const torn = read(SID);
eq('a torn line is skipped, not fatal', torn.owed.length, 2);
eq('...and the fold still reports ok', torn.state, 'ok');
{
  /**
   * THE REAL TEAR HAS NO TRAILING NEWLINE, and that is what the fixture above could not express.
   *
   * A crash mid-`appendFileSync` leaves a partial line; the NEXT event is then concatenated onto
   * it and BOTH are lost to the JSON.parse catch — not one record, two. The bad line above ends in
   * `
`, so it only ever cost itself, and the header's "one torn line costs its own record"
   * stayed true by fixture rather than by code.
   *
   * The bound the header actually claims still holds — the fold survives and every well-formed
   * event after the tear is read — so this pins the REAL cost rather than the comfortable one.
   */
  reset();
  spool(SID, 'k1', cand(1));
  fs.appendFileSync(P, '{"op":"write","externalId":"k2","candidate":{"title":"partial"');  // no newline
  spool(SID, 'k3', cand(3));
  const t2 = read(SID);
  eq('the fold survives a newline-less tear', t2.state, 'ok');
  eq('...and still sees the events that came before it', t2.owed.filter((e) => e.externalId === 'k1').length, 1);
  check('...but the tear consumed the NEXT event too, not just itself',
    !t2.owed.some((e) => e.externalId === 'k3'), t2.owed.map((e) => e.externalId).join(','));
  // A double-loss on a fail-open component must SAY so — review finding: this was silent while
  // every other failure branch in this file logs. RED-proofed by reverting the hlog call.
  check('...and the double-loss is LOGGED, not silent',
    fs.readFileSync(process.env.VECTROS_HOOKLOG_PATH, 'utf8').includes('torn line was skipped'));
}

console.log('\n=== 4. an unreadable spool fails CLOSED ===');
{
  // "Nothing owed" from a spool we could not read would let a caller conclude everything synced.
  // The natural next step after that conclusion is to stop asking — stranding real proposals.
  reset();
  fs.mkdirSync(P, { recursive: true });          // a directory where a file should be: EISDIR
  const s = read(SID);
  eq('an unreadable spool reports corrupt', s.state, 'corrupt');
  eq('...and owes nothing rather than guessing', s.owed.length, 0);
  const r = await flush(SID);
  eq('flush refuses to run against a corrupt spool', r.skipped, 'corrupt');
  eq('...attempting nothing', r.attempted, 0);
  fs.rmSync(P, { recursive: true, force: true });
}

console.log('\n=== 5. flush: success retires, failure counts ===');
reset();
spool(SID, 'e1', cand(1));
{
  const f = fake(okWrite);
  const r = await flush(SID, { fetchImpl: f.impl });
  eq('one attempt', r.attempted, 1);
  eq('...synced', r.synced, 1);
  eq('the entry is retired from owed', read(SID).owed.length, 0);
  // THE IDEMPOTENCY KEY: the write must carry the externalId minted at spool time, or a retry
  // after an ambiguous timeout creates a duplicate instead of upserting the same row.
  eq('the write reuses the spooled externalId', f.calls[0].body.externalId, 'e1');
  check('...and upserts', f.calls[0].url.includes('upsert=true'));
}
reset();
spool(SID, 'e2', cand(2));
{
  /**
   * A 5xx IS AN OUTAGE, NOT A VERDICT ON THIS ENTRY — so it halts and charges nothing.
   *
   * This block used to assert the opposite (`r.failed === 1`, `attempts === 1`), which is how the
   * budget came to treat a three-minute outage the same as a permanently malformed body. The
   * entry stays owed at zero attempts, and the next Stop retries it for free.
   */
  const f = fake({ status: 500, body: {} });
  const r = await flush(SID, { fetchImpl: f.impl });
  eq('an outage is NOT charged to the entry', r.failed, 0);
  eq('...the flush halts and says why', r.halted, 'unreachable');
  eq('...the entry stays owed', read(SID).owed.length, 1);
  eq('...at zero attempts, so a long outage can never park it', read(SID).owed[0].attempts, 0);
}
reset();
spool(SID, 'e3', cand(3));
{
  // THE CONTROL for the block above: the budget must still work for what it exists for. A 4xx
  // that is not auth means the store read THIS body and refused it; the same bytes fail forever.
  const f = fake({ status: 400, body: { message: "Field 'title' exceeds maxLength" } });
  for (let i = 0; i < 6; i++) await flush(SID, { fetchImpl: f.impl });
  const s = read(SID);
  eq('a genuinely rejected entry is still parked', s.parked.length, 1);
  eq('...and nothing is left owed', s.owed.length, 0);
  // The REASON is on disk, not the old constant 'propose returned null'. A parked entry's only
  // surviving evidence is this line, and it used to record that it failed without recording why.
  check('...with the REASON recorded, not a constant string',
    fs.readFileSync(P, 'utf8').includes('"why":"rejected"'),
    fs.readFileSync(P, 'utf8').split('\n').filter((l) => l.includes('failed')).join(' | '));
}
reset();
spool(SID, 'e4', cand(4));
{
  // A rotated or revoked key describes the CREDENTIAL, not the proposal. Charging it would park
  // the whole corpus for something no proposal caused and no retry could fix.
  const f = fake({ status: 401, body: { message: 'unauthorized' } });
  for (let i = 0; i < 10; i++) await flush(SID, { fetchImpl: f.impl });
  const s = read(SID);
  eq('auth failure parks nothing', s.parked.length, 0);
  eq('...and leaves the entry owed at zero attempts', s.owed[0].attempts, 0);
}
reset();
spool(SID, 'e5', cand(5));
{
  /**
   * A 429 DESCRIBES THE WINDOW, NOT THE ENTRY — the same bytes succeed once it resets. Before this
   * fix, 429 fell through to the generic 4xx bucket ('rejected') and was charged exactly like a
   * permanently malformed body: a busy drain (SPOOL_FLUSH_MAX_PER_RUN x SPOOL_DRAIN_MAX_SESSIONS,
   * up to dozens of calls in quick succession under load) could park a real candidate for good
   * within a few flushes. RED-proofed: reverting the 429 branch in candidates.mjs's classification
   * makes this test park the entry instead of leaving it owed.
   */
  const f = fake({ status: 429, body: { errorCode: 'RATE_LIMITED' } });
  for (let i = 0; i < 10; i++) await flush(SID, { fetchImpl: f.impl });
  const s = read(SID);
  eq('a rate-limited entry parks nothing', s.parked.length, 0);
  eq('...and leaves the entry owed at zero attempts', s.owed[0].attempts, 0);
}

console.log('\n=== 6. the per-run cap bounds a backlog ===');
reset();
for (let i = 1; i <= 5; i++) spool(SID, `b${i}`, cand(i));
{
  const f = fake(okWrite);
  const r = await flush(SID, { fetchImpl: f.impl });
  eq('only the capped number are attempted', r.attempted, 2);
  eq('...the rest are deferred, not dropped', r.deferred, 3);
  eq('...and the network saw exactly the cap', f.calls.length, 2);
  eq('the remainder is still owed', read(SID).owed.length, 3);
  /**
   * WHICH two, not just how many. Every assertion above passes under
   * `s.owed.slice(-SPOOL_FLUSH_MAX_PER_RUN)` — newest-first — which with a persistent backlog
   * starves the OLDEST proposals forever. Those are precisely the deploy-gate backlog the spool
   * exists to protect, so the ordering is the property and the counts are not.
   */
  eq('and they are the OLDEST, not the newest',
    f.calls.map((c) => c.body.externalId).join(','), 'b1,b2');
}

console.log('\n=== 7. nothing owed is not the same as nothing happened ===');
reset();
{
  const f = fake(okWrite);
  const r = await flush(SID, { fetchImpl: f.impl });
  eq('an empty spool attempts nothing', r.attempted, 0);
  eq('...and says so without an error', r.skipped, null);
  eq('...touching no network', f.calls.length, 0);
}

console.log('\n=== 8. an unprovisioned schema must NOT spend the retry budget ===');
{
  /**
   * THE DEPLOY-GATE BUG, pinned. Hook code ships before the prod context is provisioned — that
   * window is deliberate. If a missing schema counted as a per-entry failure, every proposal made
   * during it would PARK after the budget and provisioning later would not recover them. Measured
   * before the fix: owed=0, parked=1 after 3 flushes.
   */
  reset();
  try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }
  // A BATCH, not one entry — the single-entry fixture is what hid the defect below.
  for (let i = 1; i <= 4; i++) spool(SID, `g${i}`, cand(i));
  const missing = JSON.stringify({ message: "No schema found for type 'candidate'." });
  const f = fake({ status: 400, body: JSON.parse(missing) });
  const r1 = await flush(SID, { fetchImpl: f.impl });
  /**
   * THE BATCH-CHARGING DEFECT, pinned. This asserted `r1.failed === 1` — "the first flush
   * discovers the gap and fails the entry once" — on a spool holding exactly ONE entry, so it
   * could not see what happened to entries 2..N. What happened: item 1 hit the 400 and set the
   * latch, and items 2..N then received `null` FROM THE LATCH ITSELF and were charged too.
   * MEASURED on 4 entries: 4 attempts per TTL window, all 4 PARKED after the 5th — five hours
   * against a deploy gate that stays open for days.
   */
  eq('discovering the gap charges NOTHING, not even the entry that found it', r1.failed, 0);
  eq('...the flush halts and names the environment failure', r1.halted, 'schema-absent');
  // From here the latch is set, so every later flush must be a no-op rather than a charge.
  for (let i = 0; i < 5; i++) await flush(SID, { fetchImpl: f.impl });
  // AND the latch must survive expiring: each TTL window re-discovers the gap, and if that
  // re-discovery charged the batch, five windows would still park everything.
  for (let w = 0; w < 6; w++) {
    try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }
    await flush(SID, { fetchImpl: f.impl });
  }
  const s = read(SID);
  eq('every proposal is STILL OWED after repeated TTL expiries', s.owed.length, 4);
  eq('...none was parked', s.parked.length, 0);
  eq('...and none was ever charged an attempt', s.owed.every((e) => e.attempts === 0), true);
  const r2 = await flush(SID, { fetchImpl: f.impl });
  eq('a paused flush says why', r2.skipped, 'schema-absent');
  eq('...and attempts nothing', r2.attempted, 0);
  // The point of it all: provisioning the schema recovers the backlog.
  try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }
  const g = fake(okWrite);
  const r3 = await flush(SID, { fetchImpl: g.impl });
  // SPOOL_FLUSH_MAX_PER_RUN is 2 in this file, so the 4-entry backlog drains over two flushes —
  // which is itself the point: nothing was lost, it is merely paced.
  eq('once provisioned, the backlog starts syncing', r3.synced, 2);
  await flush(SID, { fetchImpl: g.impl });
  eq('...and the second flush finishes it, all 4 recovered', read(SID).owed.length, 0);
}

console.log('\n=== 9. the work list ===');
reset();
spool(SID, 'e1', cand(1));
check('a spooled session is listed', listSpools().includes(SID.replace(/[^\w.-]/g, '_')),
  listSpools().join(','));

console.log('\n=== 10. the spooled proposedAt survives the flush ===');
{
  /**
   * THE GAP-WINDOW DATE. `propose()` fills `proposedAt` with today when the caller omits it, and
   * a flush can legitimately run days after the proposal — that is what the spool is FOR, and the
   * deploy gate guarantees a long one. If the spooled value did not win, a whole recovered backlog
   * would be dated the day it synced, on the field the review queue orders and range-queries by.
   */
  reset();
  spool(SID, 'e1', { ...cand(1), proposedAt: '2020-01-02' });
  const f = fake(okWrite);
  await flush(SID, { fetchImpl: f.impl });
  eq('the write carries the date the proposal was MADE', f.calls[0].body.payload.proposedAt, '2020-01-02');
}

console.log('\n=== 11. the drain reaches sessions that have ENDED ===');
{
  /**
   * WHY THIS IS NOT OPTIONAL. `reap.mjs` treats a spool with owed writes as immortal — "never
   * eligible at any age" — on the assumption that something eventually syncs it. A flush that only
   * ever touched the CURRENT session breaks that assumption for exactly the population this
   * project creates deliberately: proposals made while the type was unprovisioned belong to
   * sessions that have since ended, and an ended session never Stops again. They would owe
   * forever and be kept forever, so the deploy gate's own window would be the leak.
   */
  /**
   * THE FIXTURE NAMES ARE LOAD-BEARING — do not tidy them.
   *
   * The other sessions sort BEFORE the own session, and the already-synced one sorts before all of
   * them. Both were the other way round first, and both made a sabotage pass: with names that sort
   * after `SID`, "own session goes first" is true by alphabet whether or not the code arranges it,
   * and a fully-synced session sitting at the end of the list is never reached within the bound, so
   * "it does not consume a slot" holds even when the skip is deleted. Two green assertions that
   * observed nothing.
   */
  const others = ['spool-test-0000-a', 'spool-test-0000-b', 'spool-test-0000-c'];
  const doneSid = 'spool-test-0000-0-done';
  reset();
  for (const s of [...others, doneSid]) { try { fs.unlinkSync(spoolPath(s)); } catch { /* fine */ } }
  spool(SID, 'mine', cand(0));
  for (const [i, s] of others.entries()) spool(s, `x${i}`, cand(i));
  // A spool with nothing owed, FIRST in sort order: it must not consume a slot.
  spool(doneSid, 'done', cand(9));
  markSynced(doneSid, 'done');

  const f = fake(okWrite);
  const receipts = await drainAll(SID, { fetchImpl: f.impl, maxSessions: 3 });
  eq('the bound is honoured', receipts.length, 3);
  eq('OWN session goes first — its proposals are what a nudge is about to be wrong about',
    receipts[0].sid, SID);
  eq('...and it synced', read(SID).owed.length, 0);
  const drained = receipts.map((r) => r.sid);
  check('a fully-synced session does not consume a slot — even sorting first',
    !drained.includes(doneSid), drained.join(','));
  // The bound BITES rather than being decorative: one of the three others is left for next time.
  const stillOwed = others.filter((s) => read(s).owed.length);
  eq('exactly the sessions past the bound are left owing', stillOwed.length, 1);

  // ...and the one left over is picked up by the next drain. No session starves permanently.
  const g = fake(okWrite);
  await drainAll(SID, { fetchImpl: g.impl, maxSessions: 3 });
  eq('the next drain finishes the backlog', others.filter((s) => read(s).owed.length).length, 0);

  for (const s of [...others, doneSid]) { try { fs.unlinkSync(spoolPath(s)); } catch { /* fine */ } }
}

console.log('\n=== 12. a paused drain reads ONE spool, not all of them ===');
{
  /**
   * With the schema unprovisioned every flush is a no-op, so walking the whole spool directory
   * would be dozens of file reads per Stop to learn the same thing dozens of times. The latch is
   * checked once, up front.
   */
  reset();
  const other = 'spool-test-paused-a';
  try { fs.unlinkSync(spoolPath(other)); } catch { /* fine */ }
  spool(SID, 'p1', cand(1));
  spool(other, 'p2', cand(2));
  fs.writeFileSync(candidateSchemaGapFile(), 'paused for the test\n');
  const f = fake(okWrite);
  const receipts = await drainAll(SID, { fetchImpl: f.impl, maxSessions: 5 });
  eq('only the own-session receipt is produced', receipts.length, 1);
  eq('...and it says why', receipts[0].skipped, 'schema-absent');
  eq('nothing reached the network', f.calls.length, 0);
  check('the other session still owes its proposal', read(other).owed.length === 1);
  try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ }
  try { fs.unlinkSync(spoolPath(other)); } catch { /* fine */ }
}

console.log('\n=== 13. a REVISE also retires the candidate it corrects ===');
{
  /**
   * THE REVERSE HALF, which nothing wrote before. `revises` points the new record at the old one;
   * `pending()` retires the old one by reading `supersededBy` — and the only writer of that field
   * had no production caller. The queue fold retired a corrected claim and the corpus did not, so
   * Phase B would have re-offered every candidate ever revised. `--compare` is blind to it: both
   * stores hold identical externalId sets, which is all it compares.
   */
  reset();
  try { fs.unlinkSync(spoolPath('sup-target')); } catch { /* fine */ }
  const calls = [];
  const impl = async (url, init) => {
    const b = JSON.parse(init.body || '{}');
    calls.push({ url, b });
    if (url.includes('/lookup')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '',
        json: async () => ({ data: [{ id: 'rec-OLD', externalId: b.value, payload: {} }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '',
      json: async () => ({ id: 'x', externalId: 'e', payload: {} }) };
  };
  spool(SID, 's:new', { title: 'the corrected claim', revises: 's:old' });
  spoolSupersede(SID, 's:old', 's:new');
  eq('both halves are owed', read(SID).owed.length, 2);
  const r = await flush(SID, { fetchImpl: impl });
  eq('both land', r.synced, 2);
  eq('...leaving nothing owed', read(SID).owed.length, 0);
  const patchCall = calls.find((c) => /\/v1\/records\/rec-OLD$/.test(c.url));
  check('the OLD record is patched, by id resolved from its externalId', !!patchCall,
    calls.map((c) => c.url).join(' | '));
  eq('...with the corrector as supersededBy', patchCall?.b?.payload?.supersededBy, 's:new');
  // A target that predates the cutover has no row. That is not retryable and must not park.
  reset();
  const empty = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '',
    json: async () => (url.includes('/lookup') ? { data: [] } : { id: 'x', payload: {} }) });
  spoolSupersede(SID, 's:pre-cutover', 's:new');
  const r2 = await flush(SID, { fetchImpl: empty });
  eq('a missing target is treated as done, not retried forever', r2.synced, 1);
  eq('...and parks nothing', read(SID).parked.length, 0);
}

reset();
done();
