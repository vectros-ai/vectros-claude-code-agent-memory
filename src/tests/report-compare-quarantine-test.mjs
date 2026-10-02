#!/usr/bin/env node
/**
 * RED-PROOF: `compareSession()` must not mislabel a candidate the redaction gate correctly
 * quarantined as `unspooled` — the bucket that means "the dual-write never happened, this is a
 * real bug". A quarantined candidate DOES have a spool entry (it was gated, not skipped), so
 * folding it into `unspooled` would trip `--compare`'s `*** N SESSION(S) DIVERGE ***` alarm on a
 * session where the gate is working exactly as designed. Found during independent review: an
 * earlier version of this file documented a `quarantined` bucket in `report.mjs`'s own header
 * comment without ever actually wiring it into `compareSession()`'s classification logic — the
 * comment described intended behavior nothing in the code implemented yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';
import { append } from '../queue.mjs';
import { spool, markQuarantined } from '../spool.mjs';
import { compareSession } from '../report.mjs';

// A PRIVATE ROOT — this file's assertions are absolute counts, same reasoning as
// report-fold-queues-test.mjs's own header.
privateRoot('report-compare-quarantine-test');

process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-compare-quarantine-test-log-')), 'hooks.log');
// A key must be present or bySession() short-circuits to null before ever reaching the fake
// transport, which `run-all.mjs`'s spawned-child isolation makes deterministic (no real key is
// inherited) but a standalone run of this file might not — depending on an ambient shell env var
// is exactly the flake this line exists to rule out.
process.env.VECTROS_API_KEY = 'ssk_test_fake_for_unit_tests';

const SID = randomUUID();
const XID = `${SID}:q1`;

// In the local queue (candidate was distilled) but NEVER in the corpus (the gate refused to
// transmit it) — exactly the shape a real quarantined candidate leaves behind.
append(SID, { op: 'propose', id: 'c1', externalId: XID, title: 'a quarantined candidate', body: 'b', kind: 'observation' });
spool(SID, XID, { title: 'a quarantined candidate', body: 'b', kind: 'observation' });
check('precondition: markQuarantined itself succeeds', markQuarantined(SID, XID, 'quarantined:customer_identifier'));

// The corpus lookup must never be reached with content that would reveal anything — same
// discipline as candidates-test.mjs's fakes — and returns no rows, matching "never transmitted".
const noRows = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '',
  json: async () => ({ data: [] }) });

console.log('=== compareSession: a quarantined candidate is its OWN bucket, never "unspooled" ===');
{
  const r = await compareSession(SID, { fetchImpl: noRows });
  eq('classified as quarantined', r.missing.quarantined.length, 1);
  eq('...by the right externalId', r.missing.quarantined[0], XID);
  eq('NOT counted as unspooled (the real dual-write-bug bucket)', r.missing.unspooled.length, 0);
  eq('NOT counted as parked (not a retry-budget loss)', r.missing.parked.length, 0);
  eq('NOT counted as "agreed" either — it never reached the corpus', r.agreed, 0);
}

done();
