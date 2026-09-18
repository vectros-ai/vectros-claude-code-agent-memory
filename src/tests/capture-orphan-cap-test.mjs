// RED-PROOF: capture.mjs's orphan-cap spawn-decision block — the one thing that decides whether
// the orphan-cap worker ever runs in real use, and previously the single
// most significant untested piece of this whole mechanism: the off-switch skip, the due-gate
// skip, the spawn args, and the debounce-marker-stamped-on-decision behaviour were all unverified.
//
// Spawns REAL capture.mjs subprocesses against a fake records server — WORKERS_OFF is set so the
// unrelated distiller/capture-worker path never fires (no Claude CLI needed), isolating this test
// to the orphan-cap block alone. Where a real end-to-end effect is asserted (the worker actually
// settling a candidate), this polls hooks.log / the fake store with a bounded timeout, since the
// detached child is unref'd and this test has no other way to wait on it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';
import { workersOffFile, orphanCapOffFile, queueDir, verdictMutationsOffFile } from '../paths.mjs';
import { append } from '../queue.mjs';
import { ORPHAN_CAP_MARKER } from '../orphan-cap.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

// A PRIVATE ROOT FOR THIS FILE — same reasoning as orphan-cap-worker-test.mjs's own header:
// §0's "nothing breaches" and §2/§3's "untouched" assertions need a corpus this file fully
// controls, not the shared suite-wide root sibling test files also leave breaching fixtures in.
// MUST come before the unlink below — `privateRoot()` re-stamps VERDICT_MUTATIONS_OFF into the
// NEW root (unlinking against the OLD shared root before moving left the new
// root's marker untouched — accidentally, not structurally, permissive).
privateRoot('capture-orphan-cap-test');

// Same opt-out as orphan-cap-worker-test.mjs — this file's only store is the
// fake server below, so the default guard against a test settling against the REAL store must go.
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine — not there yet */ }

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-orphan-cap-test-log-')), 'hooks.log');
process.env.VECTROS_HOOKLOG_PATH = LOG;
function logSince(sizeBefore) { try { return fs.readFileSync(LOG, 'utf8').slice(sizeBefore); } catch { return ''; } }
function logSize() { try { return fs.statSync(LOG).size; } catch { return 0; } }

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = await startFakeRecordsServer();
const T = path.join(os.tmpdir(), 'capture-orphan-cap-test-transcript.jsonl');
fs.writeFileSync(T, ''); // empty — keeps the ordinary distiller gate (`doCapture`) false regardless of WORKERS_OFF

// WORKERS_OFF for the WHOLE suite: isolates this file to the orphan-cap block. This file never
// spawns the CLI init/set-token verbs (the only two that write real credentials), so the separate
// run-all.mjs credentials census does not apply here — this switch is a different concern, the
// distiller/capture-worker spawn path capture.mjs also owns.
fs.writeFileSync(workersOffFile(), '1');

const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_invalid_for_capture_orphan_cap_test', VECTROS_API_BASE_URL: server.url, VECTROS_MEM_ORPHAN_CAP_DAYS: '7' };

function spawnCapture(sessionId, env = ENV) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, 'capture.mjs')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
    child.stdin.write(JSON.stringify({ session_id: sessionId, transcript_path: T, cwd: DIR, hook_event_name: 'Stop', reason: 'other' }));
    child.stdin.end();
  });
}

function resetDebounceMarker() { try { fs.unlinkSync(ORPHAN_CAP_MARKER()); } catch { /* fine — not there yet */ } }
function recordDisposition(externalId) {
  const rec = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.externalId === externalId);
  return rec ? rec.payload.disposition : undefined;
}
function offerOn(sid, days) {
  for (const d of days) fs.appendFileSync(path.join(queueDir(), `${sid}.jsonl`), JSON.stringify({ at: `${d}T12:00:00.000Z`, op: 'handed', toSid: randomUUID() }) + '\n');
}
function seedBreaching(sid, title, days) {
  const externalId = `${sid}:${randomUUID()}`;
  server.seed('candidate', { title, body: 'b', kind: 'observation', dest: 'memory', sessionId: sid, disposition: 'pending', proposedAt: '2026-01-01', externalId });
  append(sid, { op: 'propose', externalId, title, body: 'b', kind: 'observation', dest: 'memory' });
  offerOn(sid, days);
  return externalId;
}

/** Poll for a record to reach a disposition, bounded — the only way to observe a detached,
 * unref'd child's effect from a test that cannot await it directly. */
async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

const SEVEN_DAYS = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];

console.log('=== 0. due, enabled, but nothing breaches: the marker IS stamped, nothing is spawned ===');
{
  // MUST run against a genuinely clean corpus, before any breaching candidate exists anywhere in
  // this file's shared isolated root — sections 2/3 below deliberately leave their own candidates
  // permanently pending (that is what they are testing), so this assertion is only meaningful FIRST.
  resetDebounceMarker();
  const sidClear = randomUUID();
  const before = logSize();
  const r = await spawnCapture(sidClear);
  check('capture.mjs exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const log = logSince(before);
  check('nothing spawned (no breaching work found)', !/spawned worker/.test(log), log);
  check('the marker IS stamped — a due check ran even though it found nothing', fs.existsSync(ORPHAN_CAP_MARKER()));
}

console.log('\n=== 1. a real breach: capture.mjs spawns the worker WITH --apply, and it actually settles the candidate ===');
const SID1 = randomUUID();
const X1 = seedBreaching(SID1, 'a real breach capture.mjs must find and act on', SEVEN_DAYS);
{
  resetDebounceMarker();
  const before = logSize();
  const r = await spawnCapture(SID1);
  check('capture.mjs exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const log = logSince(before);
  check('capture.mjs logs that it spawned the worker', /spawned worker: 1 candidate/.test(log), log);
  check('the spawn line names 1 queue', /across 1 queue\(s\)/.test(log), log);
  const settled = await waitFor(() => recordDisposition(X1) === 'ignored');
  check('the record actually reaches ignored — the FULL chain works end to end, not just each piece alone', settled, recordDisposition(X1));
}

console.log('\n=== 2. the off switch: capture.mjs never spawns, even for a real breach ===');
const SID2 = randomUUID();
const X2 = seedBreaching(SID2, 'would breach, but capture.mjs must refuse to spawn', SEVEN_DAYS);
{
  resetDebounceMarker();
  fs.writeFileSync(orphanCapOffFile(), '1');
  const before = logSize();
  const r = await spawnCapture(SID2);
  fs.unlinkSync(orphanCapOffFile());
  check('capture.mjs exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const log = logSince(before);
  check('capture.mjs logs disabled, never a spawn', /skip: disabled/.test(log) && !/spawned worker/.test(log), log);
  // Give a real detached child every chance to have run if the off-switch check were broken —
  // then assert it did NOT.
  await new Promise((res) => setTimeout(res, 1500));
  eq('the candidate is untouched — no worker ever ran', recordDisposition(X2), 'pending');
}

console.log('\n=== 3. not due yet: capture.mjs neither spawns nor re-stamps the marker ===');
const SID3 = randomUUID();
const X3 = seedBreaching(SID3, 'would breach, but the debounce window has not elapsed', SEVEN_DAYS);
{
  // Stamp the marker as "just checked" — the opposite of resetDebounceMarker — so orphanCapDue()
  // reads false on this run.
  fs.mkdirSync(path.dirname(ORPHAN_CAP_MARKER()), { recursive: true });
  fs.writeFileSync(ORPHAN_CAP_MARKER(), new Date().toISOString());
  const markerBefore = fs.readFileSync(ORPHAN_CAP_MARKER(), 'utf8');
  const before = logSize();
  const r = await spawnCapture(SID3);
  check('capture.mjs exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const log = logSince(before);
  check('capture.mjs logs nothing about orphan-cap at all — silently skips while not due', !/orphan-cap/.test(log), log);
  const markerAfter = fs.readFileSync(ORPHAN_CAP_MARKER(), 'utf8');
  eq('the marker is NOT re-stamped — only a real due-check advances it', markerAfter, markerBefore);
  await new Promise((res) => setTimeout(res, 1500));
  eq('the candidate is untouched — nothing was spawned', recordDisposition(X3), 'pending');
}


await server.close();
done();
