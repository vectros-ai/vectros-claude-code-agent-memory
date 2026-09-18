// Exercise report.mjs's residual arithmetic. The load-bearing behaviour is the CLAMP —
// an unreadable transcript reports total:0, and an unclamped `0 - offset` would be a large negative
// that understates the true residual and poisons the cross-session sum. Every check can go RED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // this file reaches config.mjs transitively; unisolated it resolved
                          // CONFIG_PATH against the operator's live config and wrote its
                          // import-time receipt into the production hooks.log.
import { logPath } from '../hooklog.mjs';

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
// NAMESPACE, not a destructure, for `lastCensus`: it is an `export let` reassigned on every
// enumeration, and destructuring copies the value at import time — the census would read
// {0,0,0,0} forever and every assertion about it would be vacuously about the initial value.
const RES = await import(pathToFileURL(path.join(HOOKS, 'report.mjs')).href);
const { residualFor, isStale, residualBySession, blindSpots } = RES;

const H = 3600_000;
const DAY = 24 * H;
const NOW = 1_000_000_000_000; // fixed clock — no Date.now() in the assertions

console.log('=== residualFor: the normal case ===');
{
  const r = residualFor({ total: 150_000, offset: 100_000, lastStopAtMs: NOW - 2 * H, nowMs: NOW });
  eq('residual = total - offset', r.residual, 50_000);
  eq('age = now - lastStopAt', r.ageMs, 2 * H);
}

console.log('\n=== residualFor: CLAMP — an unreadable transcript (total 0) must NOT go negative ===');
{
  const r = residualFor({ total: 0, offset: 80_000, lastStopAtMs: NOW - H, nowMs: NOW });
  eq('residual clamps to 0, never -80000', r.residual, 0);
}

console.log('\n=== residualFor: offset ahead of total (momentary race) also clamps ===');
eq('total<offset → 0', residualFor({ total: 40_000, offset: 55_000, lastStopAtMs: NOW, nowMs: NOW }).residual, 0);

console.log('\n=== residualFor: a session that never recorded a Stop has UNKNOWN age, not 0 ===');
{
  const r = residualFor({ total: 30_000, offset: 0, lastStopAtMs: undefined, nowMs: NOW });
  eq('residual still computed', r.residual, 30_000);
  eq('age is null when lastStopAt is missing', r.ageMs, null);
}

console.log('\n=== residualFor: missing total/offset default to 0 (no NaN) ===');
eq('undefined total → residual 0', residualFor({ offset: 10, lastStopAtMs: NOW, nowMs: NOW }).residual, 0);
eq('undefined offset → residual = total', residualFor({ total: 10, lastStopAtMs: NOW, nowMs: NOW }).residual, 10);

console.log('\n=== residualFor: a future/clock-skew lastStopAt yields age 0, never negative ===');
eq('future lastStopAt → age clamps to 0', residualFor({ total: 5, offset: 0, lastStopAtMs: NOW + H, nowMs: NOW }).ageMs, 0);

console.log('\n=== isStale: the 24h boundary ===');
check('idle 25h is stale', isStale(25 * H, DAY));
check('idle exactly 24h is stale (>=)', isStale(DAY, DAY));
check('idle 23h is NOT stale', !isStale(23 * H, DAY));
check('unknown age (null) is NOT stale — fail safe', !isStale(null, DAY));
check('unknown age (undefined) is NOT stale', !isStale(undefined, DAY));

console.log('\n=== residualBySession: the ENUMERATOR — refusals routed to blind spots (injected deps) ===');
// This is the function that reads state, enumerates sessions, and refuses TWO ways. It was untested
// while the pure residualFor was. Injected deps let it run without the real ~/.claude dirs.
{
  const dir = path.join(os.tmpdir(), `resid-enum-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const SID = {
    normal: 'aaaaaaaa-0000-0000-0000-000000000001',
    pre671: 'bbbbbbbb-0000-0000-0000-000000000002',
    corruptq: 'cccccccc-0000-0000-0000-000000000003',
    badtx: 'dddddddd-0000-0000-0000-000000000004',   // transcript reads 0, watermark advanced
    trunc: 'eeeeeeee-0000-0000-0000-000000000005',    // transcript reads BELOW watermark (0 < total < offset)
  };
  fs.writeFileSync(path.join(dir, SID.normal + '.json'), JSON.stringify({ transcriptPath: '/n', lastStopAt: NOW - 2 * H }));
  fs.writeFileSync(path.join(dir, SID.pre671 + '.json'), JSON.stringify({ lastStopAt: NOW })); // no transcriptPath
  fs.writeFileSync(path.join(dir, SID.corruptq + '.json'), JSON.stringify({ transcriptPath: '/c', lastStopAt: NOW }));
  fs.writeFileSync(path.join(dir, SID.badtx + '.json'), JSON.stringify({ transcriptPath: '/gone', lastStopAt: NOW - 30 * H }));
  fs.writeFileSync(path.join(dir, SID.trunc + '.json'), JSON.stringify({ transcriptPath: '/trunc', lastStopAt: NOW - 30 * H }));
  fs.writeFileSync(path.join(dir, 'word-sid.json'), JSON.stringify({ transcriptPath: '/w' })); // non-UUID → excluded by isReal

  const offsets = { [SID.normal]: 100_000, [SID.badtx]: 80_000, [SID.trunc]: 80_000 };
  const totals = { '/n': 150_000, '/c': 0, '/gone': 0, '/trunc': 40_000 }; // /gone reads 0, /trunc reads BELOW its 80K watermark
  const deps = {
    stateDir: dir,
    readQueue: (sid) => (sid === SID.corruptq ? { state: 'corrupt', offset: 0 } : { state: 'ok', offset: offsets[sid] || 0 }),
    transcriptLength: (p) => totals[p] || 0,
  };
  blindSpots.length = 0; // observe only THIS call's refusals (the module ledger is exported for this)
  const rows = residualBySession(NOW, deps);
  const skips = blindSpots.slice();
  const byId = Object.fromEntries(rows.map((r) => [r.sid, r]));

  check('normal session → residual 50K', byId[SID.normal] && byId[SID.normal].residual === 50_000, JSON.stringify(rows));
  check('a session with no transcriptPath → skipped, and NOT a blind spot', !byId[SID.pre671] && !skips.some((s) => s.includes(SID.pre671)));
  check('corrupt queue → skipped AND blind-spotted', !byId[SID.corruptq] && skips.some((s) => s.includes(SID.corruptq)), JSON.stringify(skips));
  check('unreadable transcript (0 chars, watermark advanced) → BLIND SPOT, not a silent residual 0',
    !byId[SID.badtx] && skips.some((s) => s.includes(SID.badtx) && /UNKNOWN/.test(s)), JSON.stringify(skips));
  check('truncated transcript (0 < total < offset) → BLIND SPOT too (the invariant is total<offset, not total===0)',
    !byId[SID.trunc] && skips.some((s) => s.includes(SID.trunc) && /UNKNOWN/.test(s)), JSON.stringify(skips));
  check('non-UUID sid excluded from the report', !rows.some((r) => String(r.sid).startsWith('word')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\ndone');
// ─────────────────────────────────────────────────────────────────────────────
// THE ENUMERATION BACKSTOP. It shipped with no test at all, and the tunable census passed it
// as "consumed" purely because the NAME appears in residual.mjs — a census that greenlights a knob
// nothing exercises.
//
// What it guards cannot be caught any other way: the sweep's cost is bounded by
// `if (!s.transcriptPath) continue`, an invariant in ANOTHER FILE that is
// one change away from inverting. The cap does not prevent that regression; it makes it
// DEGRADE rather than compound. So the test is about the cap firing AND saying so.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== the enumeration cap ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resid-cap-'));
  // 12 REAL-shaped sessions (uuid-ish sids, each with a transcriptPath so they reach the expensive
  // path) — the population the cap is meant to bound.
  const sids = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`);
  const tr = path.join(dir, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } }) + '\n');
  for (const sid of sids) {
    fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ transcriptPath: tr, lastStopAt: 1 }));
  }

  const uncapped = residualBySession(Date.now(), { stateDir: dir, maxEnumerate: 1000 });
  eq('control: uncapped, every session is enumerated', uncapped.length, 12);

  const capped = residualBySession(Date.now(), { stateDir: dir, maxEnumerate: 5 });
  check('the cap TRUNCATES the enumeration', capped.length <= 5, `got ${capped.length} rows past a cap of 5`);
  check('and it is a real reduction, not an empty result', capped.length > 0);

  // A SILENT cap reads as "covered everything" — which is the failure this whole subsystem's
  // receipts exist to prevent. The line must be findable in the log the sweep actually writes to.
  // The log is created lazily by the first hlog; read it defensively so a missing file reports as
  // 'the cap said nothing' rather than crashing the run.
  let log = '';
  try { log = fs.readFileSync(logPath(), 'utf8'); } catch { /* no line written — the checks below fail, which is the correct report */ }
  check('the cap SAYS it fired, in hooks.log', /residual is INCOMPLETE — measured 5 session\(s\)/.test(log),
    'no receipt — a truncation nobody can see reads as "that was all of it"');
  check('and it reports the unread remainder', /7 state file\(s\) unread/.test(log), log.slice(-300));
  /**
   * IT MUST NOT DIAGNOSE ANOTHER FILE'S INVARIANT. The line this replaced asserted "the phantom
   * exclusion in stop.mjs is no longer holding" and prescribed `reap.mjs`. Both were false on the
   * machine where it fired daily for a week: the exclusion was holding perfectly (that is what
   * produced the phantoms), and the reaper was already running at its per-run maximum. A receipt
   * that names a cause it cannot observe sends its reader to audit a healthy mechanism.
   */
  check('it does NOT accuse stop.mjs of a broken invariant', !/stop\.mjs/.test(log), log.slice(-300));
  check('...nor prescribe a reap that does not address it', !/reap\.mjs/.test(log), log.slice(-300));
}

console.log('\n=== the cap counts MEASURABLE sessions, not state files ===');
{
  /**
   * THE FIXTURE ABOVE IS 100% REAL SESSIONS. PRODUCTION IS 98.7% PHANTOMS — and that gap is
   * precisely why the defect this guards shipped and then fired daily for a week unnoticed.
   *
   * A phantom (no `transcriptPath` — a session that never reached a Stop with one) is discarded by
   * the loop for the cost of one small JSON parse. The old cap was applied to the FILE list one
   * step before that discard, so phantoms ate the budget: measured,
   * 1,969 of 2,000 slots went to files thrown away immediately, and only 31 of 61 real
   * sessions were enumerated. The cap could never stop firing either — the reaper deliberately
   * keeps a phantom 7 days and the machine mints ~368/day, so the population sits permanently
   * above any file cap.
   *
   * So: a phantom-dominated directory must NOT trigger the cap, and every real session must be
   * measured. This is the case the original fixture could not express.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resid-phantom-'));
  const tr = path.join(dir, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } }) + '\n');
  const REAL = 12;
  const PHANTOMS = 400;   // same shape as production's: {orientPending, orientSource, orientedAt}
  /**
   * REAL SESSIONS ARE WRITTEN FIRST, PHANTOMS SECOND — so the phantoms are NEWER by mtime. Do not
   * swap this: it is the whole point, and the first draft had it backwards.
   *
   * The enumeration sorts mtime-DESCENDING, so with the real files written last they land at the
   * front and survive even a file-based cap. That made the headline assertion pass under a
   * sabotage that restored the original defect. Production's ordering is this one: phantoms arrive
   * continuously (~368/day) while a real session goes idle the moment its work ends, so real
   * sessions sink and are exactly what a file cap evicts.
   */
  for (let i = 0; i < REAL; i++) {
    fs.writeFileSync(path.join(dir, `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd.json`),
      JSON.stringify({ transcriptPath: tr, lastStopAt: 1 }));
  }
  for (let i = 0; i < PHANTOMS; i++) {
    fs.writeFileSync(path.join(dir, `${String(i).padStart(8, 'f')}-eeee-bbbb-cccc-dddddddddddd.json`),
      JSON.stringify({ orientPending: true, orientSource: 'startup', orientedAt: '2026-07-27T15:56:05.597Z' }));
  }

  const before = (() => { try { return fs.readFileSync(logPath(), 'utf8').length; } catch { return 0; } })();
  // A cap of 100: far BELOW the 412 files, far ABOVE the 12 measurable sessions. Under the old
  // file-cap this truncates at 100 files and finds only whichever handful of real ones survive.
  const rows = residualBySession(Date.now(), { stateDir: dir, maxEnumerate: 100 });
  eq('every real session is measured despite 400 phantoms outnumbering the cap', rows.length, REAL);
  eq('...and the census says what it looked at', RES.lastCensus.phantoms, PHANTOMS);
  eq('...having capped nothing', RES.lastCensus.capped, 0);
  const after = (() => { try { return fs.readFileSync(logPath(), 'utf8').slice(before); } catch { return ''; } })();
  check('the receipt stays SILENT — nothing was truncated, so there is nothing to report',
    !/residual is INCOMPLETE/.test(after), after.slice(0, 300));
}

console.log('\n=== the QUEUE FOLD is capped too, not just the transcript read ===');
{
  /**
   * THE HALF THE CAP STOPPED COVERING when it moved from files to measured sessions.
   *
   * A queue fold is a full JSONL read per session — the second-expensive leg. Charging the budget
   * only at the transcript read leaves it unbounded in one specific shape: the phantom invariant
   * inverts AND the cheap gates fire, so every file reaches the fold and none reaches `tLen`.
   * `skipSwept` with already-swept queues reproduces it exactly, and it is not exotic — it is how
   * the sweep itself calls this function.
   *
   * MEASURED: 300 files at cap 50 → 50 folds with the bound, 300 without.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resid-fold-'));
  const tr = path.join(dir, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(50) }] } }) + '\n');
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(dir, `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd.json`),
      JSON.stringify({ transcriptPath: tr, lastStopAt: 1 }));
  }
  let folds = 0;
  residualBySession(Date.now(), {
    stateDir: dir, maxEnumerate: 50, skipSwept: true,
    readQueue: () => { folds++; return { state: 'ok', offset: 0, sweptAt: 9e12 }; },
  });
  eq('the fold is bounded by the cap, not by the directory size', folds, 50);
  fs.rmSync(dir, { recursive: true, force: true });
}

done();
