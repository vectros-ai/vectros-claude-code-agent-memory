/**
 * The record-backed candidate client — every branch, with a FAKE transport.
 *
 * WHY A FAKE AND NOT THE REAL STORE. The `candidate` type does not exist in the production context
 * yet (the deploy gate in the design), so a test that needed the real store could not run until a
 * deploy that is itself gated on this code being correct. More durably: the branches that matter
 * here are the FAILURES — a timeout, a 5xx, a malformed body, a missing schema — and none of those
 * can be produced on demand against a healthy API. A fake is the only way to assert the contract
 * that says what happens when the store does not answer.
 *
 * The three things under test are the three the header of candidates.mjs promises:
 *   1. `null` (could not run) is never confused with `[]` (ran, found nothing).
 *   2. A missing schema is a configuration state — it latches, goes quiet, and self-heals.
 *   3. The two endpoints' disagreeing field names are centralised and correct. These are asserted
 *      against the shapes VERIFIED against staging, not against what the docs imply — every one of
 *      them was wrong when first written from intuition, and one (`data` vs `payload`) fails
 *      SILENTLY with a 200.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.

process.env.VECTROS_HOOKLOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-test-log-')), 'hooks.log');
// A key must be present or every call short-circuits to null before reaching the transport,
// which would make every assertion below vacuously "pass" for the wrong reason.
process.env.VECTROS_API_KEY = 'ssk_test_fake_for_unit_tests';

const { propose, settle, reopen, markSuperseded, pending, bySession, pendingForSession,
  proposedBetween, withOrdinals, mintExternalId, TYPE } = await import('../candidates.mjs');
const { verdictMutationsOffFile } = await import('../paths.mjs');
/**
 * THIS FILE OPTS IN TO VERDICT MUTATIONS, and it is the one file that may.
 *
 * `isolate.mjs` writes a `VERDICT_MUTATIONS_OFF` marker into every isolated root so no test can
 * PATCH the real store via `settle`/`reopen`/`markSuperseded` (credentials are deliberately
 * not isolated). This file exercises those functions directly, and does so exclusively through an
 * INJECTED fake transport (`fetchImpl` on every call below) — nothing here can reach a network
 * whatever the marker says. Mirrors `spool-test.mjs`'s own `SPOOL_OFF` opt-in exactly.
 */
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine */ }
// The latch path is PER-CONTEXT (keyed by API base URL), so the module owns it — a test that
// addressed the bare paths.mjs name would be creating and deleting a file nothing reads.
const { gapFile: candidateSchemaGapFile } = await import('../candidates.mjs');

// ── A transport that records what it was asked, and answers what the test dictates.
function fake(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body || '{}') });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r.throws) { const e = new Error(r.throws); e.name = r.name || 'Error'; throw e; }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => { if (r.badJson) throw new Error('bad json'); return r.body; },
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.body ?? {})),
    };
  };
  return { impl, calls };
}
const rows = (arr) => ({ status: 200, body: { data: arr, nextCursor: null } });
const rec = (o) => ({ id: o.id || 'id-1', externalId: o.externalId || 'sid:u1', payload: { ...o } });
const clearGap = () => { try { fs.unlinkSync(candidateSchemaGapFile()); } catch { /* fine */ } };

clearGap();

// ── 1. THE REQUEST SHAPES. Verified against staging; each was wrong when written from intuition.
console.log('\n=== 1. request shapes (the silent-failure class) ===');
{
  const f = fake({ status: 201, body: rec({ title: 't', disposition: 'pending' }) });
  await propose('sid-1', { externalId: 'sid-1:u1', title: 't', body: 'b', kind: 'project' }, { fetchImpl: f.impl });
  const b = f.calls[0].body;
  eq('create names the type as `typeName`', b.typeName, TYPE);
  check('create sends `payload` — NOT `data` (a `data` key returns 200 and stores nothing)',
    !!b.payload && b.data === undefined, JSON.stringify(Object.keys(b)));
  eq('a new proposal starts pending', b.payload.disposition, 'pending');
  // The field the README documents as part of the automatic transmission — nothing previously
  // asserted it actually reaches the wire, only that it round-trips on READ (see § "field
  // census" below). A regression dropping or corrupting it on WRITE would have passed every
  // test in this file.
  eq('the session id is actually sent, not just carried on read-back', b.payload.sessionId, 'sid-1');
  check('create upserts, so a retry cannot duplicate', f.calls[0].url.includes('upsert=true'));
}
{
  const f = fake(rows([]));
  await pending({ fetchImpl: f.impl });
  const b = f.calls[0].body;
  eq('lookup names the type as `type` — NOT `typeName` (this endpoint 400s on unknown keys)', b.type, TYPE);
  check('lookup does not send typeName', b.typeName === undefined);
  check('lookup asks for the payload explicitly', b.includePayload === true);
}
{
  const f = fake({ status: 200, body: rec({ disposition: 'stored' }) });
  await settle('id-9', 'stored', { ref: 'r', resolved: 'v' }, { fetchImpl: f.impl });
  const c = f.calls[0];
  eq('settle uses PATCH', c.method, 'PATCH');
  check('settle addresses /v1/records/{id}', c.url.endsWith('/v1/records/id-9'), c.url);
  check('settle merges via `payload`', !!c.body.payload && c.body.patch === undefined);
  check('settle does NOT send typeName (immutable — a 400)', c.body.typeName === undefined);
  check('settle sends only the verdict fields, so the merge cannot erase the claim',
    Object.keys(c.body.payload).sort().join(',') === 'disposition,ref,resolved');
}

// ── 2. null IS NOT [] — the contract every read shares.
console.log('\n=== 2. unrunnable (null) is never an empty set ([]) ===');
for (const [label, resp] of [
  ['HTTP 500', { status: 500, text: 'boom' }],
  ['timeout', { throws: 'aborted', name: 'AbortError' }],
  ['malformed body', { status: 200, badJson: true }],
]) {
  clearGap();
  const f = fake(resp);
  eq(`pending() returns null on ${label}`, await pending({ fetchImpl: f.impl }), null);
  const g = fake(resp);
  eq(`bySession() returns null on ${label}`, await bySession('s', { fetchImpl: g.impl }), null);
}
{
  clearGap();
  const f = fake(rows([]));
  const p = await pending({ fetchImpl: f.impl });
  check('a genuinely empty queue is [], not null', Array.isArray(p) && p.length === 0, JSON.stringify(p));
}
{
  clearGap();
  const f = fake({ status: 200, body: { data: 'not-an-array' } });
  eq('a non-array page is malformed -> null, not an empty queue', await pending({ fetchImpl: f.impl }), null);
}

// ── 3. THE MISSING SCHEMA: a configuration state, not a fault.
console.log('\n=== 3. missing schema latches, goes quiet, and self-heals ===');
{
  clearGap();
  const f = fake({ status: 400, text: JSON.stringify({ message: "No schema found for type 'candidate'." }) });
  eq('a missing schema reads as unrunnable', await pending({ fetchImpl: f.impl }), null);
  check('it leaves a marker so the next PROCESS knows too (hooks are fresh processes)',
    fs.existsSync(candidateSchemaGapFile()));
  // The point of the marker: the NEXT call must not even reach the transport. Without this, an
  // unprovisioned context pays a failed round trip on every Stop, ~2/min, forever.
  const g = fake(rows([]));
  eq('the next call short-circuits', await pending({ fetchImpl: g.impl }), null);
  eq('...without touching the network at all', g.calls.length, 0);
}
{
  // Self-healing: provisioning the schema must fix the loop with nobody deleting a file. The TTL
  // is the mechanism, so age the marker past it.
  const old = Date.now() - (25 * 60 * 60 * 1000);
  fs.utimesSync(candidateSchemaGapFile(), old / 1000, old / 1000);
  const f = fake(rows([]));
  const p = await pending({ fetchImpl: f.impl });
  check('an expired marker retries', Array.isArray(p), JSON.stringify(p));
  eq('...and the call actually went out', f.calls.length, 1);
}
{
  // A 400 that is NOT a missing schema must not latch — otherwise one malformed request silently
  // disables the corpus for an hour.
  clearGap();
  const f = fake({ status: 400, text: JSON.stringify({ message: 'Invalid request body' }) });
  await pending({ fetchImpl: f.impl });
  check('an ordinary 400 does NOT latch the schema gap', !fs.existsSync(candidateSchemaGapFile()));
}

// ── 4. ORDINALS are derived, never allocated (the duplicate-worker fix, carried forward).
console.log('\n=== 4. ordinals derive from order, so concurrent workers cannot collide ===');
{
  const a = { externalId: 's:b', proposedAt: '2026-07-01' };
  const b = { externalId: 's:a', proposedAt: '2026-07-02' };
  const c = { externalId: 's:c', proposedAt: '2026-07-01' };
  const o = withOrdinals([b, a, c]);
  eq('sorted by proposedAt, then externalId as the tiebreak', o.map((x) => x.externalId).join(','), 's:b,s:c,s:a');
  eq('numbering starts at c1', o[0].ordinal, 'c1');
  // STABILITY is the property that matters: a later proposal must not renumber earlier ones, or a
  // nudge an agent is reading becomes wrong under it.
  const later = withOrdinals([b, a, c, { externalId: 's:d', proposedAt: '2026-07-09' }]);
  eq('a later proposal appends and does not renumber', later.slice(0, 3).map((x) => x.ordinal).join(','), 'c1,c2,c3');
  eq('...and takes the next ordinal', later[3].ordinal, 'c4');
}
eq('externalId is minted from the session + a caller-supplied uuid', mintExternalId('s1', 'u9'), 's1:u9');

// ── 5. PENDING is two conditions, and only one of them is a lookup.
console.log('\n=== 5. superseded candidates are not pending, even when disposition says so ===');
{
  clearGap();
  const f = fake(rows([
    rec({ externalId: 's:1', proposedAt: '2026-07-01', disposition: 'pending' }),
    rec({ externalId: 's:2', proposedAt: '2026-07-02', disposition: 'pending', supersededBy: 's:3' }),
  ]));
  const p = await pending({ fetchImpl: f.impl });
  eq('a superseded candidate is filtered out client-side', p.length, 1);
  eq('...leaving the open one', p[0].externalId, 's:1');
}

// ── 5a. The COMPOSITE lookup — the request shape is the whole risk.
console.log('\n=== 5a. pendingForSession sends the composite, in the DECLARED leg order ===');
{
  /**
   * WHY THE REQUEST SHAPE, NOT JUST THE RESULT. A composite is addressed by the comma-joined
   * identity in the schema's DECLARED order, and `values` is POSITIONAL. Swap the two and the
   * request is still well-formed — `'disposition,sessionId'` with `[sid, 'pending']` asks for
   * "disposition = <a session id>", which matches nothing and returns an EMPTY PAGE, not an
   * error. Empty is indistinguishable from "this session has settled everything", which is the
   * normal state. So a result-only assertion passes on a fake that echoes rows regardless, and
   * the real store would silently report an empty queue forever.
   *
   * The fixture therefore returns rows whatever is asked, and the assertion is on what was SENT.
   * The declared order is pinned independently in the blueprints suite; this asserts the client
   * agrees with it.
   */
  clearGap();
  const f = fake(rows([
    rec({ externalId: 'sess-A:1', sessionId: 'sess-A', proposedAt: '2026-07-01', disposition: 'pending' }),
    rec({ externalId: 'sess-A:2', sessionId: 'sess-A', proposedAt: '2026-07-02', disposition: 'pending',
      supersededBy: 'sess-A:3' }),
  ]));
  const p = await pendingForSession('sess-A', { fetchImpl: f.impl });
  const sent = f.calls[0].body;

  eq('addresses the composite by its comma-joined identity', sent.field, 'sessionId,disposition');
  eq('sends `values` positionally, sessionId FIRST', JSON.stringify(sent.values),
    JSON.stringify(['sess-A', 'pending']));
  eq('does NOT also send a scalar `value` (that would be a different mode)', sent.value, undefined);
  eq('still scoped to the type', sent.type, TYPE);

  // The absence half is client-side and cannot be a leg — same rule as `pending()`.
  eq('a superseded candidate is still filtered out client-side', p.length, 1);
  eq('...leaving the open one', p[0].externalId, 'sess-A:1');
  // Ordinals ARE addresses here: the population is exactly one session.
  eq('assigns a session-scoped ordinal', p[0].ordinal, 'c1');
}

// ── 5b. …and it must not be `bySession` with a filter bolted on.
console.log('\n=== 5b. pendingForSession is ONE indexed call, not a full-history page-and-discard ===');
{
  /**
   * The regression this guards is a plausible "simplification": rewriting the composite call as
   * `bySession(sid)` plus `.filter(c => c.disposition === 'pending')`. Same answer, and every
   * result assertion above still passes — but it pages the session's entire SETTLED history on
   * every prompt to throw it away, which is the cost the declaration was spent to avoid.
   * Asserted structurally, on the request, because the returned rows cannot show it.
   */
  clearGap();
  const f = fake(rows([rec({ externalId: 'sess-B:1', sessionId: 'sess-B', disposition: 'pending' })]));
  await pendingForSession('sess-B', { fetchImpl: f.impl });
  eq('exactly one request', f.calls.length, 1);
  eq('...and it constrains disposition SERVER-side', f.calls[0].body.values?.includes('pending'), true);
  eq('...so it is not a bare sessionId enumeration', f.calls[0].body.field === 'sessionId', false);
}

// ── 6. Refusals.
console.log('\n=== 6. refusals ===');
{
  const f = fake({ status: 200, body: rec({}) });
  eq('settle refuses an unknown disposition', await settle('id-1', 'maybe', {}, { fetchImpl: f.impl }), null);
  eq('...without writing anything', f.calls.length, 0);
  // `superseded` is deliberately NOT a disposition — it is a separate field, so that reopen can
  // refuse to resurrect a corrected claim. Pin it here so a future "tidy-up" cannot merge them.
  const g = fake({ status: 200, body: rec({}) });
  eq('`superseded` is not a settleable disposition', await settle('id-1', 'superseded', {}, { fetchImpl: g.impl }), null);
}
{
  const f = fake({ status: 200, body: rec({}) });
  eq('patching without an id refuses rather than hitting a bad URL', await reopen('', 'why', { fetchImpl: f.impl }), null);
  eq('...and makes no call', f.calls.length, 0);
}
{
  const f = fake({ status: 200, body: rec({ disposition: 'pending' }) });
  await reopen('id-3', 'was wrong', { fetchImpl: f.impl });
  eq('reopen returns a candidate to pending', f.calls[0].body.payload.disposition, 'pending');
  eq('...and records why', f.calls[0].body.payload.reopenedWhy, 'was wrong');
}
{
  const f = fake({ status: 200, body: rec({}) });
  await markSuperseded('id-4', 's:9', { fetchImpl: f.impl });
  eq('markSuperseded sets the pointer on the OLDER record', f.calls[0].body.payload.supersededBy, 's:9');
}
{
  /**
   * THE VERDICT_MUTATIONS_OFF GATE ITSELF — this file unlinked the marker above to opt IN for
   * every other test in this suite; here it is put back TEMPORARILY to prove the gate actually
   * refuses when present, the same way `spool-test.mjs` proves `SPOOL_OFF` halts a flush. Every
   * caller of `patch()` shares this one check, so exercising it via `settle` covers `reopen` and
   * `markSuperseded` too.
   */
  fs.writeFileSync(verdictMutationsOffFile(), 'test\n');
  const f = fake({ status: 200, body: rec({}) });
  eq('settle refuses outright when VERDICT_MUTATIONS_OFF is set',
    await settle('id-5', 'stored', {}, { fetchImpl: f.impl }), null);
  eq('...and makes no call at all', f.calls.length, 0);
  fs.unlinkSync(verdictMutationsOffFile());
  const g = fake({ status: 200, body: rec({}) });
  await settle('id-5', 'stored', {}, { fetchImpl: g.impl });
  eq('...and resumes once the marker is gone', g.calls.length, 1);
}

// ── 7. The range lookup — the queue worked by age.
console.log('\n=== 7. range lookup ===');
{
  clearGap();
  const f = fake(rows([rec({ externalId: 's:1', proposedAt: '2026-07-05' })]));
  const r = await proposedBetween('2026-07-01', '2026-07-31', { fetchImpl: f.impl });
  eq('proposedBetween sends a from/to range', `${f.calls[0].body.from}..${f.calls[0].body.to}`, '2026-07-01..2026-07-31');
  eq('...and returns ordered candidates', r.length, 1);
}

// ── 8. THE READ-BACK CENSUS. Every field the schema carries must survive `normalise`.
console.log('\n=== 8. read-back census — a field the projection forgets is write-only ===');
{
  /**
   * CAUGHT A REAL DEFECT, and the shape of the miss is the point.
   *
   * `reopenedWhy` was WRITTEN by `reopen` and never listed in `normalise`, so the audit trail for
   * undoing a verdict was write-only: the platform stored it (verified against staging), every
   * consumer read `undefined`, and nothing errored anywhere. It survived because the test above
   * asserts what `reopen` SENDS — `f.calls[0].body.payload.reopenedWhy` — and never what a read
   * gives back. A request-side assertion cannot see a response-side omission.
   *
   * `normalise` is a hand-maintained projection of the schema, so this is a CENSUS, pinned by name
   * rather than derived from the object under test: asserting "every key normalise returns is
   * non-null" would pass on a projection that had quietly stopped returning half of them. The list
   * must match the blueprint's `candidate` fields — if you add one there, add it here, and the
   * failure you get is the reminder.
   */
  clearGap();
  const FIELDS = ['title', 'body', 'kind', 'dest', 'area', 'tags', 'sourceRef', 'sessionId',
    'proposedAt', 'disposition', 'ref', 'resolved', 'origin', 'reopenedWhy', 'revises', 'supersededBy'];
  const payload = Object.fromEntries(FIELDS.map((k) => [k, k === 'tags' ? ['t1'] : `v-${k}`]));
  const f = fake(rows([rec({ externalId: 'sid:u1', ...payload })]));
  const [got] = await bySession('sid', { fetchImpl: f.impl });
  for (const k of FIELDS) {
    eq(`normalise surfaces '${k}'`, JSON.stringify(got[k]), JSON.stringify(payload[k]));
  }
  eq('...and the identity fields', `${got.id}|${got.externalId}`, 'id-1|sid:u1');
}

// ── 9. PAGINATION. The page cap sits below the population this is meant to enumerate.
console.log('\n=== 9. a multi-page lookup is followed, never silently truncated ===');
{
  clearGap();
  const page = (n, cursor) => ({ status: 200, body: { data: n.map((i) => rec({ externalId: `s:${i}` })), nextCursor: cursor } });
  {
    // Three pages. Returning page 1 and stopping is what the code did, and it looks identical to
    // a short queue — no error, no receipt, just a review list missing its tail.
    const f = fake([page([1, 2], 'c2'), page([3, 4], 'c3'), page([5], null)]);
    const r = await bySession('s', { fetchImpl: f.impl });
    eq('every page is followed', r.length, 5);
    eq('...taking one call per page', f.calls.length, 3);
    // The field name IS the regression this section exists to catch: the API's resume field is
    // `startFrom`, not `cursor` — asserting the wrong key here would still pass if the client sent
    // the guessable-but-wrong name, since nothing else in this fake distinguishes them.
    eq('the first call sends no startFrom', f.calls[0].body.startFrom, undefined);
    eq('...and each later one sends the previous page\'s', `${f.calls[1].body.startFrom},${f.calls[2].body.startFrom}`, 'c2,c3');
    // Checked against the real `undefined` on EACH call (not a template-string stand-in for it —
    // `${undefined}` and the literal string "undefined" render identically, so a stringified
    // comparison would still pass a caller that sent that literal string as a cursor value).
    eq('...and never under the wrong key (call 1)', f.calls[0].body.cursor, undefined);
    eq('...and never under the wrong key (call 2)', f.calls[1].body.cursor, undefined);
    eq('...and never under the wrong key (call 3)', f.calls[2].body.cursor, undefined);
    // The ordinals must be computed over the WHOLE set: numbering a truncated page means the `cN`
    // an agent was nudged with addresses a different candidate on the next run.
    eq('ordinals cover the full set', r[r.length - 1].ordinal, 'c5');
  }
  {
    /**
     * A cursor that never ends must not spin, and must not answer with a partial set either.
     *
     * The bound is asserted against the CONFIGURED value rather than a literal: `config.mjs`
     * freezes tunables at module load, so setting the env var here (after the import above) does
     * nothing — a test that pinned a smaller number would have been asserting against a value it
     * never actually installed.
     */
    const { CANDIDATE_MAX_PAGES } = await import('../config.mjs');
    const f = fake(page([1], 'always-more'));
    const r = await bySession('s', { fetchImpl: f.impl });
    eq('a runaway cursor stops at the page bound', f.calls.length, CANDIDATE_MAX_PAGES);
    // `null`, not a partial array: an incomplete enumeration returned as if whole is the failure
    // this module's first contract exists to prevent.
    eq('...and refuses to answer with a truncated set', r, null);
  }
}

// ── 10. MERGE-PATCH SEMANTICS. A member set to null is REMOVED, not ignored.
console.log('\n=== 10. settle omits what it was not given; reopen clears the undone verdict ===');
{
  clearGap();
  {
    const f = fake({ status: 200, body: rec({}) });
    await settle('id-1', 'stored', { ref: 'rec-9' }, { fetchImpl: f.impl });
    const pl = f.calls[0].body.payload;
    /**
     * `resolved` was NOT supplied, so it must be ABSENT. Sending `resolved: null` under RFC 7386
     * removes the member — so a settle that omitted it would delete whatever an earlier settle (or
     * a reopen-then-resettle) had recorded. `propose` states this rule; `settle` broke it.
     */
    check('an omitted field is absent, not null', !('resolved' in pl), JSON.stringify(pl));
    eq('...while the one given is sent', pl.ref, 'rec-9');
    eq('...with the verdict', pl.disposition, 'stored');
  }
  {
    const f = fake({ status: 200, body: rec({}) });
    await reopen('id-2', 'was wrong', { fetchImpl: f.impl });
    const pl = f.calls[0].body.payload;
    // The one place a null IS correct: ref/resolved describe the verdict being UNDONE. Leaving
    // them on a candidate that is pending again presents evidence for a conclusion no longer held.
    eq('reopen clears the citation of the verdict it undoes', pl.ref, null);
    eq('...and what that verdict claimed to verify', pl.resolved, null);
    eq('...while recording why', pl.reopenedWhy, 'was wrong');
  }
}

// ── 11. The gap latch is PER-CONTEXT.
console.log('\n=== 11. a staging gap does not disable production ===');
{
  clearGap();
  const f = fake({ status: 400, text: JSON.stringify({ message: "No schema found for type 'candidate'." }) });
  await pending({ fetchImpl: f.impl });
  check('the marker names the context it learned about', /\.[0-9a-f]{8}$/.test(candidateSchemaGapFile()),
    candidateSchemaGapFile());
  /**
   * One global marker encodes "the type is missing" without recording WHERE. Point the same runtime
   * home at staging and then production — which is exactly what verifying a deploy involves — and
   * one environment's gap silently disables the corpus for the other for up to an hour.
   */
  // Recompute the suffix from the base URL independently: the marker must be keyed by THAT, not by
  // something incidental. Re-importing the module would have compared it against itself.
  const base = process.env.VECTROS_API_BASE_URL || 'https://api.vectros.ai';
  const digest = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  check('...and the key is the API base URL', candidateSchemaGapFile().endsWith(`.${digest(base)}`),
    `${candidateSchemaGapFile()} should end .${digest(base)} for ${base}`);
  check('a different base URL keys a DIFFERENT marker — staging cannot latch production',
    digest('https://staging.example.com') !== digest('https://api.vectros.ai'));
}

// ── 12. THE TWO MODULES MEET. `mapCapture` emits nulls; `propose` must DROP them.
console.log('\n=== 12. a sparse capture, mapped then proposed, sends no nulls ===');
{
  /**
   * THE SEAM NEITHER TEST COVERED. `capture-map` deliberately normalises a sparse capture to
   * explicit nulls (`area: c.area ?? null`, `dest: c.dest || null`, …) and its own test asserts
   * exactly that. `propose` must then omit them, because this is an UPSERT: a retry carrying
   * `area: null` REMOVES a value the first, ambiguously-timed-out attempt had already stored — a
   * record that gets emptier the harder it is retried.
   *
   * Each file tested its own half. The `propose` request-shape test passed only
   * `{externalId,title,body,kind}`, so the four omit-guards were exercised in the false direction
   * only, and `payload.area = c.area ?? null` would have shipped green.
   */
  clearGap();
  const { mapCapture } = await import('../capture-map.mjs');
  const { candidate, externalId } = mapCapture({ op: 'NEW', title: 't', body: 'b', kind: 'project' },
    { sessionId: 's', all: new Map(), offset: 0, uuid: 'u1', proposedAt: '2026-08-01' });
  // The mapper's output really does carry nulls — otherwise this test proves nothing downstream.
  check('precondition: the mapper emits explicit nulls', candidate.area === null && candidate.dest === null);
  const f = fake({ status: 201, body: rec({}) });
  await propose('s', { ...candidate, externalId }, { fetchImpl: f.impl });
  const pl = f.calls[0].body.payload;
  for (const k of ['area', 'dest', 'sourceRef', 'tags']) {
    check(`propose drops '${k}' rather than sending null`, !(k in pl), JSON.stringify(pl));
  }
  eq('...while the fields that ARE set go out', pl.title, 't');
}

// ── 13. AN ORDINAL IS AN ADDRESS, so it must not move.
console.log('\n=== 13. ordinals are stable: an agent settles the candidate it was shown ===');
{
  clearGap();
  /**
   * `dispose.mjs <sessionId> c2=stored:…` is how an agent acts on a nudge, one turn after reading
   * it. The first sort key was `proposedAt` — a DAY-granular `date` field — with the random uuid as
   * tiebreak, so within a day the order was arbitrary AND a later proposal could sort before an
   * earlier one. MEASURED before the fix: A was `c2`, became `c3` when C arrived, then `c2` again
   * once B was settled.
   *
   * `createdAt` is server-assigned at millisecond precision in true creation order. It is NOT a
   * payload field, so the fixture has to put it where the API does — at the top level.
   */
  /**
   * THE KEYS SORT IN THE OPPOSITE ORDER TO CREATION — do not "tidy" them to `s:A`, `s:B`, `s:C`.
   *
   * With keys that happen to sort the same way as creation time, the OLD `proposedAt`+externalId
   * tiebreak produces the right answer by luck and a sabotage restoring it passes. The uuids this
   * stands in for are random, so disagreement between the two orders is the normal case, not the
   * exotic one.
   */
  const KEY = { A: 's:zz9', B: 's:aa1', C: 's:mm5', D: 's:bb2' };
  const at = (n, ms) => ({ id: `id-${n}`, externalId: KEY[n], createdAt: `2026-08-01T10:00:0${ms}.000Z`,
    payload: { title: n, proposedAt: '2026-08-01', disposition: 'pending' } });
  {
    // Arrival order B, A, C — uuid-ish keys deliberately NOT in creation order, which is the case
    // the old tiebreak got wrong.
    const f = fake(rows([at('B', 2), at('A', 1), at('C', 3)]));
    const r = await bySession('s', { fetchImpl: f.impl });
    eq('numbered by CREATION order, not by key', r.map((c) => `${c.ordinal}=${c.title}`).join(' '),
      'c1=A c2=B c3=C');
  }
  {
    // A later arrival must APPEND, never renumber what an agent has already been shown.
    const f = fake(rows([at('B', 2), at('A', 1), at('C', 3), at('D', 4)]));
    const r = await bySession('s', { fetchImpl: f.impl });
    eq('a new candidate appends and shifts nothing', r.map((c) => `${c.ordinal}=${c.title}`).join(' '),
      'c1=A c2=B c3=C c4=D');
  }
  {
    /**
     * THE OTHER HALF: numbering must be over the WHOLE session, settled included. The queue kept a
     * settled candidate's slot, so `c3` was `c3` for the session's life; numbering a filtered set
     * renumbers everything after every settle.
     */
    const settled = at('B', 2); settled.payload.disposition = 'stored';
    const f = fake(rows([at('A', 1), settled, at('C', 3)]));
    const r = await bySession('s', { fetchImpl: f.impl });
    eq('a settled candidate KEEPS its slot', r.map((c) => `${c.ordinal}=${c.title}`).join(' '),
      'c1=A c2=B c3=C');
  }
  {
    // And the cross-session queue must not pretend to hand out addresses it cannot scope.
    const f = fake(rows([at('A', 1), at('B', 2)]));
    const p = await pending({ fetchImpl: f.impl });
    check('pending() emits NO ordinal — `c2` across sessions is not an address',
      p.every((c) => c.ordinal === undefined), JSON.stringify(p.map((c) => c.ordinal)));
    eq('...but is still ordered oldest-first', p.map((c) => c.title).join(''), 'AB');
  }
}

clearGap();
done();
