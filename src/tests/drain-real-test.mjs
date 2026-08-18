// The drain loop, end-to-end, against the REAL distiller.
//
// The fake-binary seam is unusable on Windows (Node refuses to spawn a .cmd without shell:true,
// and even with it the effective cwd shifts under the fake), and stubbing at any other seam would test my
// replica of the loop rather than the loop. So: real worker, real claude -p, ~1.2M chars of
// transcript = 3 windows, ~$0.30. Coverage is measured from the capture-log, which records
// {from,to,chars,remaining,total} for every window the worker actually distilled.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { memoryHome } from '../paths.mjs';
import { DELTA_MAX_CHARS, MAX_WINDOWS_PER_RUN } from '../config.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drain-real-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'drain-real-0001';
const ROOT = memoryHome();
const QP = path.join(ROOT, 'queue', SID + '.jsonl');
const CLOG = path.join(ROOT, 'capture-log', SID + '.jsonl');
const T = path.join(os.tmpdir(), 'drain-real-transcript.jsonl');

const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { read } = await mod('queue.mjs');
const { transcriptLength } = await mod('transcript.mjs');

for (const f of [QP, CLOG]) { try { fs.unlinkSync(f); } catch {} }

// Plausible engineering prose, so the distiller behaves as it would in life. Each message carries
// a unique MARKER so coverage is measurable rather than asserted.
const TOPICS = [
  'the retry loop only fires on EPERM, which on Windows means the target is held open by a reader',
  'the watermark must never pass text no call has read, or the gap is buried forever',
  'a fail-open component that does not log is indistinguishable from a dead one',
  'the write response echoes the request, not stored state, so verify by reading back',
  'gating on a timer is uncorrelated with content: too frequent and too narrow at once',
];
const mkMsg = (i) => JSON.stringify({
  type: i % 2 ? 'assistant' : 'user',
  timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  message: { content: [{ type: 'text', text: `MARKER-${i}: ${TOPICS[i % TOPICS.length]}. ` + ('detail '.repeat(280)) }] },
});
const N = 600;
fs.writeFileSync(T, Array.from({ length: N }, (_, i) => mkMsg(i)).join('\n') + '\n');
const TOTAL = transcriptLength(T);
console.log(`transcript: ${N} msgs, ${Math.round(TOTAL / 1000)}K chars -> expect ceil(${Math.round(TOTAL/1000)}/400) windows\n`);

console.log('running the REAL worker (this makes real Haiku calls; ~1-3 min)...');
const t0 = Date.now();
const r = spawnSync(process.execPath, [path.join(DIR, 'capture-worker.mjs'), SID, T, '0'], {
  encoding: 'utf8', timeout: 900_000,
});
console.log(`worker exited ${r.status} after ${Math.round((Date.now() - t0) / 1000)}s\n`);

const windows = fs.existsSync(CLOG) ? fs.readFileSync(CLOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const q = read(SID);

/**
 * FIX: THE VACUOUS-PASS GAP. Neither check below this point actually requires `windows` to
 * be non-empty — "no gap between zero windows" and "watermark (0) equals what was read (0)" both
 * PASS if the worker distilled NOTHING, which is exactly the failure mode this file exists to
 * catch (a dead distiller, an auth failure, a silently-broken spawn). `r.status` alone is not
 * enough either: capture-worker.mjs is deliberately fail-open, so a crash deep inside it can still
 * exit 0. The only real proof of life is a MEASURED window count.
 */
const expectedWindows = Math.min(Math.ceil(TOTAL / DELTA_MAX_CHARS), MAX_WINDOWS_PER_RUN);
check('the worker process did not crash', r.status === 0, `exit=${r.status}\n${((r.stdout || '') + (r.stderr || '')).slice(0, 800)}`);
eq(`the worker actually distilled the expected window count (not a vacuous pass on an empty result)`,
  windows.length, expectedWindows);

console.log('=== windows the worker actually distilled ===');
for (const w of windows) {
  console.log(`  [${String(Math.round(w.window.from / 1000)).padStart(5)}K -> ${String(Math.round(w.window.to / 1000)).padStart(5)}K]  ${String(Math.round(w.window.chars / 1000)).padStart(3)}K chars, ${String(w.window.messages).padStart(3)} msgs, ${Math.round(w.window.remaining / 1000)}K remaining  | ${(w.captures || []).length} captures`);
}

console.log('\n=== the property that matters: CONTIGUITY (no gap between windows) ===');
let gap = false, cursor = 0;
for (const w of windows) {
  if (w.window.from !== cursor) { console.log(`  *** GAP: window starts at ${w.window.from} but the last one ended at ${cursor} — ${w.window.from - cursor} chars skipped`); gap = true; }
  cursor = w.window.to;
}
check('windows are CONTIGUOUS — every char handed to exactly one window', !gap);

console.log('\n=== the watermark tells the truth ===');
console.log(`  watermark: ${Math.round(q.offset / 1000)}K   transcript: ${Math.round(TOTAL / 1000)}K   ${q.offset === TOTAL ? 'PASS — fully drained' : (q.offset === cursor ? 'PASS — equals what was actually read (drain stopped honestly)' : '*** watermark != text read ***')}`);
check('the watermark equals what was actually read — never `total`', q.offset === cursor, `offset=${q.offset} read-to=${cursor}`);
console.log(`  candidates proposed: ${q.pending.length}`);

console.log('\n=== contrast: what the OLD code would have done with this same transcript ===');
console.log(`  read the last 400K, marked ${Math.round(TOTAL / 1000)}K captured => ${Math.round((TOTAL - 400_000) / 1000)}K (${Math.round((TOTAL - 400_000) / TOTAL * 100)}%) buried unread`);

for (const f of [QP, CLOG, T]) { try { fs.unlinkSync(f); } catch {} }
console.log('\ndone');

done();
