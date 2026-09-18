#!/usr/bin/env node
/**
 * RED-PROOF: `report.mjs`'s `foldQueues()` — specifically the `autoIgnoredCap` tally added
 * alongside the orphan-cap backstop. Report.mjs had NO test coverage at all before this file
 * (a pre-existing gap this doesn't try to close in full — only the new counting logic this branch
 * actually added, which had zero verification of its own).
 *
 * Each check below is written so a real regression in the counting logic — double-counting against
 * `ignored`, counting a HUMAN ignore as auto, or missing a real auto-ignore — would fail it, not
 * just exercise the code path. → the "guard silently loosened, every test still green" gotcha.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';
import { append } from '../queue.mjs';
import { foldQueues } from '../report.mjs';

// A PRIVATE ROOT FOR THIS FILE — `foldQueues()` sums across the WHOLE queue directory, and this
// file's assertions are absolute counts (2 ignored, 1 auto, …), not deltas. Under `run-all.mjs`'s
// shared suite-wide root, sibling test files' own leftover fixtures (deliberately pending/ignored
// candidates elsewhere) would inflate every count here unpredictably by run order. Same fix,
// same reasoning as orphan-cap-worker-test.mjs's own header.
privateRoot('report-fold-queues-test');

process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-fold-queues-test-log-')), 'hooks.log');

// REAL, UUID-shaped ids — foldQueues() filters every queue file through residual.mjs's isReal(),
// same reason every OTHER `--all`-style scan in this suite needs them (a human-readable id is
// silently excluded, and this file's assertions would all read 0 for the wrong reason).
const SID = randomUUID();

console.log('=== foldQueues: autoIgnoredCap is a SUBSET of ignored, not a separate bucket ===');
{
  append(SID, { op: 'propose', id: 'c1', externalId: 'x1', title: 'a human ignore', body: 'b', kind: 'observation' });
  append(SID, { op: 'dispose', id: 'c1', disposition: 'ignored', ref: 'covered:some/real/path.md' });

  append(SID, { op: 'propose', id: 'c2', externalId: 'x2', title: 'an auto-cap ignore', body: 'b', kind: 'observation' });
  append(SID, { op: 'dispose', id: 'c2', disposition: 'ignored', ref: 'auto:orphan-cap-7d' });

  append(SID, { op: 'propose', id: 'c3', externalId: 'x3', title: 'a stored candidate', body: 'b', kind: 'observation' });
  append(SID, { op: 'dispose', id: 'c3', disposition: 'stored', ref: 'some-record-uuid' });

  const d = foldQueues();
  eq('ignored counts BOTH the human and the auto one (2 total)', d.ignored, 2);
  eq('autoIgnoredCap counts ONLY the auto one, not double-counted against ignored', d.autoIgnoredCap, 1);
  eq('stored is unaffected, counted on its own', d.stored, 1);
}

console.log('\n=== a ref that merely CONTAINS "orphan-cap" but does not START WITH "auto:orphan-cap" must NOT count ===');
{
  const SID2 = randomUUID();
  append(SID2, { op: 'propose', id: 'c1', externalId: 'y1', title: 'a human citing an orphan-cap doc', body: 'b', kind: 'observation' });
  // A human's own `ignored:covered:` citation happens to mention "orphan-cap" in its path — this
  // must not be mistaken for the auto backstop's own ref shape (`startsWith`, not a bare `includes`).
  append(SID2, { op: 'dispose', id: 'c1', disposition: 'ignored', ref: 'covered:notes/orphan-cap-quirks.md' });

  const d = foldQueues();
  // Cumulative with the SID above (foldQueues scans the whole queue dir) — assert the DELTA a
  // second session contributes, not an absolute count reset to zero.
  eq('ignored grows by exactly 1 for the new session', d.ignored, 3);
  eq('autoIgnoredCap does NOT grow — this ref does not start with auto:orphan-cap', d.autoIgnoredCap, 1);
}

console.log('\n=== a REOPEN clears both halves together — the same last-write-wins shape as ordinary disposition ===');
{
  const SID3 = randomUUID();
  append(SID3, { op: 'propose', id: 'c1', externalId: 'z1', title: 'auto-ignored then reopened', body: 'b', kind: 'observation' });
  append(SID3, { op: 'dispose', id: 'c1', disposition: 'ignored', ref: 'auto:orphan-cap-7d' });
  append(SID3, { op: 'reopen', id: 'c1', why: 'a human judged it wrongly auto-ignored' });

  const d = foldQueues();
  eq('ignored does NOT count a reopened candidate', d.ignored, 3);
  eq('autoIgnoredCap does NOT count a reopened candidate either — cleared together, not left stale', d.autoIgnoredCap, 1);
  eq('the reopened candidate is genuinely pending again', d.pending, 1);
}

done();
