// RED-PROOF: orphan-cap-worker.mjs, the WRITE half of the orphan-cap backstop. Spawned as a real subprocess
// against a fake records server — same shape as backfill-test.mjs/dispose-test.mjs, same reason
// (spawnSync deadlocks against a same-process stub server; a subprocess has no way to receive an
// injected fetchImpl from its parent test).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';
import { verdictMutationsOffFile, orphanCapOffFile, queueDir, lockFor } from '../paths.mjs';
import { read as readQueue, append } from '../queue.mjs';
import { ORPHAN_CAP_MARKER } from '../orphan-cap.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

/**
 * A PRIVATE ROOT FOR THIS FILE, distinct from the shared suite-wide isolate.mjs root (review
 * finding, 2026-08-14, CONFIRMED: this file's own worker acts on the WHOLE corpus, so §4/§9's
 * "nothing to settle" / "untouched" assertions broke under `run-all.mjs`, where sibling test files
 * sharing the one isolated root leave their OWN breaching fixtures behind — capture-orphan-cap-
 * test.mjs's off-switch/not-due cases deliberately never settle theirs). Uses `isolate.mjs`'s own
 * `privateRoot()` rather than a hand-rolled `mkdtempSync` (review, 2026-08-17: the hand-rolled form
 * left the new root without `SPOOL_OFF`/`VERDICT_MUTATIONS_OFF`, so the structural gate against a
 * real network write was silently absent — safe only by accident, not by construction).
 */
privateRoot('orphan-cap-worker-test');

// Same opt-out as backfill-test.mjs/dispose-test.mjs — this file's only store is the fake server.
// MUST come after privateRoot() above — it re-stamps this marker into the new root, so unlinking
// it has to target the root that is actually current by the time dispose.mjs/the worker runs.
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine — not there yet */ }

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-cap-worker-test-log-')), 'hooks.log');
process.env.VECTROS_HOOKLOG_PATH = LOG;
// The worker reports via hlog() (hooks.log), never console.log — it is spawned detached with
// stdio:'ignore' in real use, so stdout is not a channel it can rely on. Read the log fresh after
// each run rather than asserting on `r.stdout`, which is always empty for a real invocation.
// Returns only what THIS run appended, not the whole shared file — a later run's assertion must
// not pass because an EARLIER run happened to contain the same substring.
function logSince(sizeBefore) {
  try { return fs.readFileSync(LOG, 'utf8').slice(sizeBefore); } catch { return ''; }
}
function logSize() { try { return fs.statSync(LOG).size; } catch { return 0; } }

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = await startFakeRecordsServer();
const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_orphan_cap_worker_test', VECTROS_API_BASE_URL: server.url, VECTROS_MEM_ORPHAN_CAP_DAYS: '7' };

function spawnAsync(argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), opts.timeout || 30000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
  });
}

// `--apply` by default: this suite's whole point is exercising the WRITE path, matching how
// capture.mjs's one real spawn site always invokes it — `run({ dryRun: true })` is the one case
// that omits it, for §0's own default-safety check. Snapshots the log size BEFORE spawning and
// hands the run's own new tail back alongside the process result — the ordering that makes
// `logSince` meaningful ("what did THIS run write").
async function run({ env = ENV, dryRun = false } = {}) {
  const before = logSize();
  const argv = [path.join(DIR, 'orphan-cap-worker.mjs')];
  if (!dryRun) argv.push('--apply');
  const r = await spawnAsync(argv, { timeout: 30000, env });
  return { ...r, log: logSince(before) };
}

function resetDebounceMarker() {
  try { fs.unlinkSync(ORPHAN_CAP_MARKER()); } catch { /* fine — not there yet, "due" is correct */ }
}

function recordDisposition(externalId) {
  const rec = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.externalId === externalId);
  return rec ? rec.payload.disposition : undefined;
}
function recordRef(externalId) {
  const rec = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.externalId === externalId);
  return rec ? rec.payload.ref : undefined;
}

/** Offer a session on `days` distinct calendar days — the file-side signal `classifyOrphanQueue`
 * breaches on, independent of how many/which candidates are seeded. */
function offerOn(sid, days) {
  for (const d of days) {
    fs.appendFileSync(path.join(queueDir(), `${sid}.jsonl`), JSON.stringify({ at: `${d}T12:00:00.000Z`, op: 'handed', toSid: randomUUID() }) + '\n');
  }
}

/** Seed a record-backed candidate — real in BOTH the fake store and the local file, offered on
 * `days` distinct calendar days (the shape a genuinely record-backed orphan queue has). */
function seedBreaching(sid, title, days) {
  const externalId = `${sid}:${randomUUID()}`;
  server.seed('candidate', {
    title, body: 'b', kind: 'observation', dest: 'memory', sessionId: sid,
    disposition: 'pending', proposedAt: '2026-01-01', externalId,
  });
  append(sid, { op: 'propose', externalId, title, body: 'b', kind: 'observation', dest: 'memory' });
  offerOn(sid, days);
  return externalId;
}

/** Seed N record-backed candidates in the SAME session, all pending, all real in both stores. */
function seedBreachingMulti(sid, n, days) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const externalId = `${sid}:${randomUUID()}`;
    server.seed('candidate', {
      title: `candidate ${i}`, body: 'b', kind: 'observation', dest: 'memory', sessionId: sid,
      disposition: 'pending', proposedAt: '2026-01-01', externalId,
    });
    append(sid, { op: 'propose', externalId, title: `candidate ${i}`, body: 'b', kind: 'observation', dest: 'memory' });
    ids.push(externalId);
  }
  offerOn(sid, days);
  return ids;
}

/** Seed a candidate whose FILE says pending but whose RECORD is already settled to `disposition`
 * — the exact shape a human's real dispose.mjs run produces when its OWN local file-backup step
 * lags or fails (documented best-effort in dispose.mjs's own backupToFile). This is the fixture
 * the overwrite-race fix (§7 below) exists to prove against. */
function seedFileStaleRecordSettled(sid, title, days, disposition) {
  const externalId = `${sid}:${randomUUID()}`;
  server.seed('candidate', {
    title, body: 'b', kind: 'observation', dest: 'memory', sessionId: sid,
    disposition, ref: 'a-real-human-verdict', proposedAt: '2026-01-01', externalId,
  });
  append(sid, { op: 'propose', externalId, title, body: 'b', kind: 'observation', dest: 'memory' }); // FILE never got the matching dispose — still pending there
  offerOn(sid, days);
  return externalId;
}

/** Seed a pending file candidate whose externalId matches NO record at all — distinct from
 * `writeoff.mjs`'s population (zero records for the WHOLE session): here the session has OTHER
 * real records (so orphan-cap.mjs legitimately finds it breaching), just not this one candidate. */
function seedRecordless(sid, title, days) {
  const externalId = `${sid}:${randomUUID()}-no-record`;
  append(sid, { op: 'propose', externalId, title, body: 'b', kind: 'observation', dest: 'memory' });
  offerOn(sid, days);
  return externalId;
}

const SEVEN_DAYS = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
const TWO_DAYS = ['2026-08-01', '2026-08-02'];

console.log('=== 0. DRY RUN IS THE DEFAULT — no --apply, nothing written, even for a real breach ===');
const SID0 = randomUUID();
const X0 = seedBreaching(SID0, 'a real breach, but the run is a dry run by default', SEVEN_DAYS);
{
  resetDebounceMarker();
  const r = await run({ dryRun: true });
  check('worker exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('reports what it WOULD do, on stdout (an operator typing its name reads this directly)', /DRY RUN/.test(r.stdout), r.stdout);
  check('logs it as a dry run too', /DRY RUN/.test(r.log), r.log);
  eq('the record was NOT touched', recordDisposition(X0), 'pending');
  const q = readQueue(SID0);
  eq('the file was NOT touched either', q.pending.length, 1);
}

console.log('\n=== 1. a queue offered on >= the cap gets its pending candidate auto-ignored — RECORD side ===');
const SID1 = randomUUID();
const X1 = seedBreaching(SID1, 'genuinely stuck, offered a week straight', SEVEN_DAYS);
{
  resetDebounceMarker();
  const r = await run();
  check('worker exits 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  eq('the record is now ignored', recordDisposition(X1), 'ignored');
  check('the ref marks it as the orphan-cap auto path, not a human ignore', String(recordRef(X1)).startsWith('auto:orphan-cap'), recordRef(X1));
}

console.log('\n=== 2. ...and the FILE side agrees (dispose.mjs\'s own backup shape) ===');
{
  const q = readQueue(SID1);
  eq('the file now shows zero pending for this session', q.pending.length, 0);
  const lines = fs.readFileSync(path.join(queueDir(), `${SID1}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const disposeEv = lines.find((l) => l.op === 'dispose');
  check('a real dispose event was appended, disposition ignored', disposeEv && disposeEv.disposition === 'ignored', JSON.stringify(disposeEv));
}

console.log('\n=== 3. a queue below the day cap is left untouched ===');
const SID2 = randomUUID();
const X2 = seedBreaching(SID2, 'only offered twice, well under the cap', TWO_DAYS);
{
  resetDebounceMarker();
  const r = await run();
  check('worker exits 0', r.status === 0, r.stdout + r.stderr);
  eq('still pending — under the cap', recordDisposition(X2), 'pending');
  const q = readQueue(SID2);
  eq('the file still shows it pending too', q.pending.length, 1);
}

console.log('\n=== 4. a run against an already-clear corpus finds nothing to settle ===');
{
  const r = await run();
  check('run exits 0', r.status === 0, r.stdout + r.stderr);
  check('logs nothing to settle', /nothing to settle/.test(r.log), r.log);
}

console.log('\n=== 5. the off switch prevents ANY write, even for a clear breach — checked by the WORKER itself ===');
const SID3 = randomUUID();
const X3 = seedBreaching(SID3, 'would breach, but the off switch is on', SEVEN_DAYS);
{
  resetDebounceMarker();
  fs.writeFileSync(orphanCapOffFile(), '1');
  const r = await run();
  fs.unlinkSync(orphanCapOffFile());
  // capture.mjs's own cheap check refuses to spawn this worker at all while disabled — but the
  // worker must ALSO honour the switch on its own, the same discipline reap.mjs's kill switch
  // gets (checked before `force`, inside runReap() itself, not only by whoever calls it): an
  // operator can run `node orphan-cap-worker.mjs` directly, bypassing capture.mjs entirely.
  check('worker exits 0', r.status === 0, r.stdout + r.stderr);
  check('logs disabled, not a settle', /disabled/.test(r.log), r.log);
  eq('X3 was NOT touched — genuinely breaching, but the switch was honoured', recordDisposition(X3), 'pending');
}

console.log('\n=== 6. MULTI-CANDIDATE: every pending candidate in a breaching queue is settled, not just the first ===');
const SID4 = randomUUID();
const MULTI = seedBreachingMulti(SID4, 4, SEVEN_DAYS);
{
  resetDebounceMarker();
  const r = await run();
  check('worker exits 0', r.status === 0, r.stdout + r.stderr);
  for (const [i, x] of MULTI.entries()) {
    eq(`candidate ${i} of 4 is ignored (not just the first)`, recordDisposition(x), 'ignored');
  }
  const q = readQueue(SID4);
  eq('the file agrees: zero pending, not 3 stuck behind the first', q.pending.length, 0);
}

console.log('\n=== 7. THE RACE FIX: a candidate already settled for REAL (record ahead of a lagging file backup) is NEVER overwritten ===');
const SID5 = randomUUID();
const X5 = seedFileStaleRecordSettled(SID5, 'a human genuinely disposed this — file backup just lagged', SEVEN_DAYS, 'stored');
{
  resetDebounceMarker();
  const r = await run();
  check('worker exits 0', r.status === 0, r.stdout + r.stderr);
  eq('the record STAYS stored — the auto-cap must never overwrite a real human verdict', recordDisposition(X5), 'stored');
  check('the ref is still the human one, not auto:orphan-cap', recordRef(X5) === 'a-real-human-verdict', recordRef(X5));
  check('logs it as already resolved by someone else, not settled', /already resolved by someone else/.test(r.log), r.log);
}

console.log('\n=== 8. a pending file candidate with NO matching record is skipped as missing, not crashed on ===');
const SID6 = randomUUID();
// SID6 needs at least one REAL record so orphan-cap.mjs's own machinery has something to work
// with beyond this recordless one — this is deliberately NOT the writeoff.mjs population
// (zero records for the whole session); it is one recordless straggler in an otherwise
// record-backed, genuinely breaching session.
const X6real = seedBreaching(SID6, 'a real sibling candidate in the same session', SEVEN_DAYS);
const X6missing = seedRecordless(SID6, 'proposed to the file, never made it into records', SEVEN_DAYS);
{
  resetDebounceMarker();
  const r = await run();
  check('worker exits 0, does not crash', r.status === 0, r.stdout + r.stderr);
  eq('the real sibling still settles normally', recordDisposition(X6real), 'ignored');
  const q = readQueue(SID6);
  // The recordless one has no record to settle, so it is reported `missing` and left pending in
  // the file — it is not this worker's population (that's writeoff.mjs's per-candidate reach,
  // covered in tools/tests/writeoff-test.mjs), only that this worker must not crash or mis-skip
  // its real sibling because of it.
  check('the recordless candidate is still pending in the file (untouched, not crashed on)',
    q.pending.some((c) => c.externalId === X6missing), JSON.stringify(q.pending));
}

console.log('\n=== 9. unreachable records mid-run — fails CLOSED per candidate, never crashes the whole batch ===');
const SID7 = randomUUID();
const X7 = seedBreaching(SID7, 'would settle, but records is unreachable this run', SEVEN_DAYS);
{
  resetDebounceMarker();
  // Same technique writeoff-test.mjs uses: port 1 is reserved and nothing binds it, so this is a
  // genuine network failure (ECONNREFUSED), not a defeated-credential-fallback false positive.
  const r = await run({ env: { ...ENV, VECTROS_API_BASE_URL: 'http://127.0.0.1:1' } });
  check('worker exits 0 (unreachable is reported, not fatal)', r.status === 0, r.stdout + r.stderr);
  eq('X7 is untouched — nothing lost, retried next debounced run', recordDisposition(X7), 'pending');
  const q = readQueue(SID7);
  eq('the file is untouched too', q.pending.length, 1);
}

console.log('\n=== 10. THE LOCK: two near-simultaneous workers never both act — one wins, one exits quietly ===');
const SID8 = randomUUID();
const X8 = seedBreaching(SID8, 'two workers race to settle this — only one may', SEVEN_DAYS);
{
  resetDebounceMarker();
  try { fs.unlinkSync(lockFor('orphan-cap-worker')); } catch { /* fine — not there yet */ }
  /**
   * FOUND IN CI (not locally): `Promise.all([run(), run()])` does not GUARANTEE genuine overlap —
   * it only starts both spawns without awaiting between them, and a slower/less-parallel CI runner
   * can serialize the two child processes entirely, so NEITHER ever observes the other's lock and
   * the "exactly one lock-loss message" assertion sees zero. Deterministic instead: spawn worker
   * #1, poll for its LOCK FILE to actually appear (proving it reached and executed `claim()`), THEN
   * spawn worker #2 — which must now see the lock held, since worker #1 still has real network work
   * left (a `bySession` fetch + a settle + a file backup) after claiming it, a window comfortably
   * larger than "detect the lock file, spawn a process".
   */
  const before = logSize();
  const p1 = spawnAsync([path.join(DIR, 'orphan-cap-worker.mjs'), '--apply'], { timeout: 30000, env: ENV });
  const lockPath = lockFor('orphan-cap-worker');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(lockPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  check('worker #1 actually claimed the lock before #2 was spawned', fs.existsSync(lockPath));
  const p2 = spawnAsync([path.join(DIR, 'orphan-cap-worker.mjs'), '--apply'], { timeout: 30000, env: ENV });
  const [r1, r2] = await Promise.all([p1, p2]);
  const combinedLog = logSince(before);
  check('both processes exit 0 (losing the race is not a failure)', r1.status === 0 && r2.status === 0, `${r1.stdout}${r1.stderr}\n---\n${r2.stdout}${r2.stderr}`);
  /**
   * THE SAFETY PROPERTY, NOT THE MECHANISM. Even with the lock-file poll above, a fast local run
   * against an in-process fake server can still have worker #1 finish and RELEASE the lock before
   * #2's spawn+claim lands (found locally, not just in CI) — the lock and the record-recheck
   * (Fix 1's race fix, earlier in this file) are TWO INDEPENDENT layers, and either one alone is
   * enough to prevent a double-settle. So the meaningful, non-flaky assertion is the outcome below
   * — settled exactly once, whichever layer did it — not which log line appears. Logged, not
   * asserted, so a genuine total loss of both layers is still visible on inspection.
   */
  const sawLockRace = /lock race|another instance is already running/.test(combinedLog);
  const sawRecheckSkip = /already resolved by someone else/.test(combinedLog);
  console.log(`  (mechanism: ${sawLockRace ? 'lock' : sawRecheckSkip ? 'record re-check' : 'sequential, no overlap observed'})`);
  eq('the candidate is settled exactly once — ignored, not corrupted by a double-write', recordDisposition(X8), 'ignored');
  const q = readQueue(SID8);
  eq('the file agrees: zero pending for THIS candidate', q.pending.some((c) => c.externalId === X8), false);
  const lines = fs.readFileSync(path.join(queueDir(), `${SID8}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  eq('exactly one dispose event landed for this candidate, not two', lines.filter((l) => l.op === 'dispose' && l.ref?.startsWith('auto:orphan-cap')).length, 1);
}

await server.close();
done();
