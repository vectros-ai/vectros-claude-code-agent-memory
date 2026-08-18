// The FAILURE half of the drain. Read this header before "fixing" the seam.
//
// WHAT THIS FILE IS NOT — and used to claim to be. Its header said it drove "the REAL
// capture-worker against a fake claude … the drain loop, the watermark arithmetic and the
// failure-hold are exercised for real". It never ran the drain once. It spawns a fake via
// `fake-claude.cmd`, and `capture-worker` calls `spawnSync(CLAUDE_BIN, …)` WITHOUT `shell: true`,
// which Node >=18.20.2 refuses for `.cmd` (CVE-2024-27980). So the spawn failed, `distill`
// returned `{error}`, the drain stopped before window 1 — and the file printed
// `*** 1000 MESSAGES NEVER SEEN ***` and exited 0. Its single "PASS" was `Math.min(...[])` over an
// empty set: `Infinity >= 194` is true. **It passed BECAUSE it collected nothing.**
//
// That was a false green on this branch's marquee fix: revert `capture-worker` to tail-slice +
// `markCaptured(total)` and the old file stayed green. Three places in the SAME COMMIT already
// said the fake-binary seam was unusable on Windows — triage-test's own header, and
// `drain-real-test.mjs`, which exists *because* of it. A cold panel found it; two of its own
// agents disagreed until one checked the spawn semantics.
//
// WHAT IT IS NOW. A distiller that CANNOT RUN is a real scenario — a moved `claude.exe`, a wrong
// `CLAUDE_CODE_BIN`, an expired token — and it is the path that must never advance the watermark.
// The unspawnable seam reproduces it faithfully, so this file tests exactly that, and ASSERTS it.
//
// THE SUCCESS PATH (drain to 100%, contiguous windows, watermark == transcript length) is covered
// ONLY by `drain-real-test.mjs`, which makes real Haiku calls (~$0.30). No fake seam can cover it
// on Windows. Do not re-add one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { queueFor } from '../paths.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drain-test-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'drain-test-0001';
const QP = queueFor(SID);
const T = path.join(os.tmpdir(), 'drain-test-transcript.jsonl');

const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { read, markCaptured } = await mod('queue.mjs');
const { transcriptLength, sliceSince } = await mod('transcript.mjs');

const reset = () => { try { fs.unlinkSync(QP); } catch {} };
reset();

// ~2.0M chars — a working drain would need ~5 windows, so "watermark still 0" is unambiguous.
const mkMsg = (i) => JSON.stringify({
  type: i % 2 ? 'assistant' : 'user', timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  message: { content: [{ type: 'text', text: `MARKER-${i} ` + 'x'.repeat(1980) }] },
});
fs.writeFileSync(T, Array.from({ length: 1000 }, (_, i) => mkMsg(i)).join('\n') + '\n');
const TOTAL = transcriptLength(T);

// A binary that cannot be spawned. This is the POINT of the fixture, not an accident of it.
const FAKE = path.join(os.tmpdir(), 'fake-claude-unspawnable.cmd');
fs.writeFileSync(FAKE, '@echo off\r\nexit 1\r\n');

const runWorker = (fromOffset) => spawnSync(process.execPath,
  [path.join(DIR, 'capture-worker.mjs'), SID, T, String(fromOffset)],
  { encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_CODE_BIN: FAKE } });

console.log(`transcript ${Math.round(TOTAL / 1000)}K chars; the distiller cannot spawn (by design)\n`);

console.log('=== a distiller that cannot run must HOLD the watermark ===');
runWorker(0);
let q = read(SID);
eq('a failed distill does not advance the watermark', q.offset, 0);
eq('a failed distill proposes nothing', q.pending.length, 0);
eq('a failed distill marks nothing captured', q.events, 0);

console.log('\n=== and must STOP the drain, not skip to a later window ===');
// If the loop advanced past a failed window it would mark a LATER offset — the 72% hole wearing a
// different hat. Over a 2M-char transcript, a watermark still at 0 is the proof it stopped.
q = read(SID);
check('the drain did not jump the failed window', q.offset === 0, `offset=${q.offset}, expected 0`);

console.log('\n=== a HELD watermark is resumable, not poisoned ===');
const w1 = sliceSince(T, 0, 400_000);
markCaptured(SID, w1.to); // pretend one window succeeded earlier
runWorker(w1.to);
q = read(SID);
eq('a later failure leaves the earlier success intact', q.offset, w1.to);
check('the watermark never exceeds what was read', q.offset <= TOTAL, `offset=${q.offset} total=${TOTAL}`);

reset();
try { fs.unlinkSync(T); } catch {}
try { fs.unlinkSync(FAKE); } catch {}
done();
