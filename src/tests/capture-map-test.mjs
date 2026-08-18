/**
 * The DUAL-WRITE mapping — one distiller capture into a queue event and a record.
 *
 * What this is really guarding: during cutover Phase A both stores receive every proposal, and the
 * whole phase is judged on whether they AGREE. This function is where a disagreement would be
 * born, and most of its ways of being wrong are silent — a dropped field reads as a candidate the
 * distiller never filled in, a mistranslated `revises` reads as a correction that corrected
 * nothing, and a `proposedAt` taken from the wrong clock reads as a review queue in the wrong
 * order. None of those raise anything anywhere.
 *
 * It is a separate module precisely so this file can exist: the worker's distiller cannot be faked
 * on Windows (see `drain-test.mjs`'s header for the false green that cost), so the mapping was
 * previously unreachable by any test.
 */
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.

const { mapCapture } = await import('../capture-map.mjs');

const SID = 'capture-map-test-0001';
const base = { sessionId: SID, all: new Map(), offset: 4200, uuid: 'u-1', proposedAt: '2026-08-01' };
const full = {
  op: 'NEW', title: 'a claim', body: 'the durable fact', kind: 'project',
  area: 'search', tags: ['recall', 'ranking'], sourceRef: 'docs/x.md', dest: 'memory',
};

console.log('\n=== 1. one key, both stores ===');
{
  const { ev, externalId, candidate } = mapCapture(full, base);
  eq('the externalId is session-qualified', externalId, `${SID}:u-1`);
  eq('...and is on the queue event', ev.externalId, externalId);
  // The KEY is what makes the two stores comparable at all. If the record were keyed by anything
  // the queue does not also hold, the Phase A agreement check degrades to matching on title —
  // which two near-duplicate proposals from the same session defeat by construction.
  check('nothing allocates it from a count (no read-modify-write to race)',
    !JSON.stringify({ ev, candidate }).includes('"c1"'));
}

console.log('\n=== 2. every field the distiller emits reaches the RECORD ===');
{
  /**
   * THE LOSSY-COPY BUG, pinned. The candidate schema originally modelled neither `dest` nor
   * `sourceRef`, and both are RENDERED today — `dest` in the nudge line every prompt carries,
   * `sourceRef` in `dispose --list`. Dual-write would have written records that looked complete
   * and were not, and the loss would have surfaced at Phase B as a review surface that quietly
   * stopped showing a verifier where to start.
   */
  const { candidate } = mapCapture(full, base);
  for (const [k, v] of Object.entries({
    title: 'a claim', body: 'the durable fact', kind: 'project',
    area: 'search', sourceRef: 'docs/x.md', dest: 'memory',
  })) eq(`candidate.${k} survives the mapping`, candidate[k], v);
  eq('...including tags', JSON.stringify(candidate.tags), '["recall","ranking"]');
}

console.log('\n=== 3. proposedAt comes from the CALLER, not from "now" ===');
{
  /**
   * THE GAP-WINDOW DATE BUG. `propose()` defaults `proposedAt` to today when it is absent, and the
   * flush that calls it can run days after the proposal — that is the spool's entire purpose, and
   * the deploy gate guarantees it will. Stamping at flush time would date a whole recovered
   * backlog to the day it SYNCED, on the one field the review queue sorts and range-queries by.
   */
  const { candidate } = mapCapture(full, { ...base, proposedAt: '2020-01-02' });
  eq('the injected date is what lands', candidate.proposedAt, '2020-01-02');
  check('...and it is not silently replaced by today',
    candidate.proposedAt !== new Date().toISOString().slice(0, 10));
}

console.log('\n=== 4. `revises` is TRANSLATED between the two id spaces ===');
{
  // The queue names candidates by their ordinal in its own log; the corpus keys on externalId.
  const all = new Map([['c1', { externalId: `${SID}:older` }]]);
  const { isRevise, ev, candidate } = mapCapture({ ...full, op: 'REVISE', revises: 'c1' }, { ...base, all });
  check('it is a revise', isRevise);
  eq('the queue event keeps the ORDINAL', ev.revises, 'c1');
  eq('the record gets the target EXTERNALID', candidate.revises, `${SID}:older`);
  eq('...and the op is recorded', ev.op, 'revise');
}

console.log('\n=== 5. a target that predates dual-write has no id to cite ===');
{
  /**
   * Every candidate proposed before this change has no `externalId`, so a correction to one cannot
   * point at a row that was never written. OMITTING the key is the honest answer; the alternatives
   * are worse in both directions — a `null` would overwrite a good value on an upsert retry, and
   * carrying the ordinal (`"c1"`) would write a dangling reference that LOOKS resolvable and
   * resolves to nothing.
   */
  const all = new Map([['c1', { title: 'proposed before the cutover' }]]);
  const { isRevise, ev, candidate } = mapCapture({ ...full, op: 'REVISE', revises: 'c1' }, { ...base, all });
  check('the queue side still records the correction', isRevise && ev.revises === 'c1');
  check('the record side omits `revises` entirely', !('revises' in candidate));
}

console.log('\n=== 6. an unresolvable target degrades to a plain proposal ===');
{
  // A stale or hallucinated ordinal would otherwise produce an event that supersedes nothing while
  // being counted as a correction — leaving the claim it meant to fix pending forever, unexplained.
  const { isRevise, ev, candidate } = mapCapture({ ...full, op: 'REVISE', revises: 'c99' }, base);
  check('not treated as a revise', !isRevise);
  eq('...the event is a plain propose', ev.op, 'propose');
  check('...carrying no dangling pointer on either side',
    !('revises' in ev) && !('revises' in candidate));
}

console.log('\n=== 7. a sparse capture normalises to a FULL shape, never to `undefined` ===');
{
  /**
   * The distiller omits fields freely — most captures carry no `area` and no `sourceRef`. Both
   * sides get an explicit `null` rather than a missing key, because `undefined` is a legal value
   * everywhere and a consumer reading one cannot tell "the distiller said nothing" from "I spelled
   * the field wrong". (Dropping the nulls from the WIRE is `propose()`'s job and is tested there,
   * for a different reason: this is an upsert, so a null would erase what a timed-out retry had
   * already stored.)
   */
  const { ev, candidate } = mapCapture({ op: 'NEW', title: 't' }, base);
  for (const k of ['area', 'sourceRef', 'dest']) {
    eq(`ev.${k} is an explicit null`, ev[k], null);
    eq(`candidate.${k} is an explicit null`, candidate[k], null);
  }
  eq('tags default to an empty list on the event', JSON.stringify(ev.tags), '[]');
  eq('...and on the candidate', JSON.stringify(candidate.tags), '[]');

  /**
   * `body` and `kind` are the deliberate exceptions: PASSED THROUGH, so an absent one stays
   * `undefined` and `JSON.stringify` drops the key from both the queue line and the request body.
   *
   * That asymmetry is not tidiness, it is the safe direction for an ENUM. `kind` accepts a fixed
   * vocabulary, and whether the store also accepts an explicit `null` there is UNTESTED — so the
   * mapping never finds out. A dropped key is a field the record simply does not have; a rejected
   * one would fail the write for a candidate whose only defect is that the distiller was terse.
   */
  check('kind is left undefined rather than nulled (an enum, and a dropped key is the safe answer)',
    candidate.kind === undefined && !('kind' in JSON.parse(JSON.stringify(candidate))));
  check('...same for body', candidate.body === undefined);
}

console.log('\n=== 8. the window offset rides the event ===');
{
  const { ev } = mapCapture(full, { ...base, offset: 123456 });
  eq('the queue event records the offset this window reached', ev.offset, 123456);
  check('the record does NOT — it is queue bookkeeping, not a fact about the claim',
    !('offset' in mapCapture(full, { ...base, offset: 123456 }).candidate));
}

done();
