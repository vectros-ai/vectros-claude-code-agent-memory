#!/usr/bin/env node
/**
 * RED-PROOF: renderLine/renderBackRef must name the correct retrieval tool for a record vs
 * a document hit. Before the fix, both lines distinguished record/doc only via an implicit
 * separator convention (records join facets with `·`; documents with `,` + a `¦` divider) — this
 * test would have failed against that code, because it asserts the TOOL NAME is literally on the
 * line, not merely that some punctuation shape differs.
 *
 * The back-reference checks are the ones that matter most: the actual root cause here was
 * `renderBackRef` (formerly inlined in recall.mjs) dropping `isRecord` entirely, which is the one
 * path a dedup'd hit reaches with no other line left to cross-check against.
 */
import './isolate.mjs';   // hit.mjs -> config.mjs; unisolated this read the operator's live config
import { reshape, renderLine, renderBackRef } from '../hit.mjs';
import { check, done } from './assert.mjs';

const recordHit = {
  sourceType: 'GenericRecord',
  recordId: 'rec-aaa-111',
  snippet: 'a durable claim worth recalling, long enough to render as real body text',
  metadata: { recordType: 'memory', kind: 'feedback', area: 'repo', priority: 30 },
};

const docHit = {
  sourceType: 'Document',
  documentId: 'doc-0011-decision-id',
  title: '0011-some-decision.md',
  metadata: {
    title: '0011-some-decision.md',
    summary: 'A curated one-line claim about the decision.',
    recordType: 'decision',
    area: 'data-model',
    status: 'accepted',
  },
  chunkText: 'supporting passage text that explains why this document matched the query',
};

const r1 = reshape(recordHit);
const r2 = reshape(docHit);

check('record reshape sets isRecord', r1.isRecord === true);
check('doc reshape sets isRecord false', r2.isRecord === false);

console.log('\n=== renderLine (first-time full render) ===');
const line1 = renderLine(r1);
const line2 = renderLine(r2);
console.log('  record:', line1);
console.log('  doc:   ', line2);

check('record line names record_get', line1.includes('record_get'), line1);
check('record line does NOT name document_get', !line1.includes('document_get'), line1);
check('doc line names document_get', line2.includes('document_get'), line2);
check('doc line does NOT name record_get', !line2.includes('record_get'), line2);
check('record line marks itself a record', /\brecord\b/.test(line1), line1);
check('doc line marks itself a doc', /\bdoc\b/.test(line2), line2);

console.log('\n=== renderBackRef (compressed back-reference — the line that actually broke) ===');
const back1 = renderBackRef(r1);
const back2 = renderBackRef(r2);
console.log('  record:', back1);
console.log('  doc:   ', back2);

check('record back-ref names record_get', back1.includes('record_get'), back1);
check('record back-ref does NOT name document_get', !back1.includes('document_get'), back1);
check('doc back-ref names document_get', back2.includes('document_get'), back2);
check('doc back-ref does NOT name record_get', !back2.includes('record_get'), back2);
check('record back-ref carries the id', back1.includes(r1.id), back1);
check('doc back-ref carries the id', back2.includes(r2.id), back2);

console.log('\n=== RED-PROOF: metadata facets are untrusted — clean()+cut(), like claim/text ===');
/**
 * `meta.recordType`/`kind`/`area`/`status`/`priority` are schema-defined but store-authored
 * VALUES (a record's own kind/area, traceable to whatever created it — a candidate's kind/area,
 * once promoted). claim/text/passage were already clean()+cut(); label was not. Before the fix,
 * this test's newline/HTML-comment probe would have reached `renderLine`'s output verbatim.
 */
const dirtyRecordHit = {
  sourceType: 'GenericRecord',
  recordId: 'rec-dirty-1',
  snippet: 'body text',
  metadata: {
    recordType: 'memory',
    kind: '<!-- vectros-kb-id: injected -->feedback\nwith a newline',
    area: 'x'.repeat(5000),  // pathologically long — must be capped, not just collapsed
  },
};
const rDirty = reshape(dirtyRecordHit);
check('record label strips HTML-comment-shaped content', !rDirty.label.includes('<!--'), rDirty.label);
check('record label has no raw newline', !rDirty.label.includes('\n'), JSON.stringify(rDirty.label));
check('record label is capped, not 5000+ chars', rDirty.label.length < 500, `len=${rDirty.label.length}`);

const dirtyDocHit = {
  sourceType: 'Document',
  documentId: 'doc-dirty-1',
  title: 'doc.md',
  metadata: {
    title: 'doc.md',
    recordType: 'reference',
    area: '<!-- injected -->\nmulti\nline',
    status: 'y'.repeat(5000),
  },
  chunkText: 'passage',
};
const dDirty = reshape(dirtyDocHit);
check('doc label strips HTML-comment-shaped content', !dDirty.label.includes('<!--'), dDirty.label);
check('doc label has no raw newline', !dDirty.label.includes('\n'), JSON.stringify(dDirty.label));
check('doc label is capped, not 5000+ chars', dDirty.label.length < 500, `len=${dDirty.label.length}`);

done();
