// stop.mjs — the L2 rolling-window stash AND the liveness clock two other subsystems depend on.
//
// WHY THIS FILE EXISTS AT ALL. `stop.mjs` shipped with no test of any kind, and a later fix turned it
// from "stash a tail for the next recall" into a load-bearing correctness surface: `state.lastStopAt`
// is the staleness clock for the SWEEP (may I flush this session's transcript?) and for the ORPHAN
// NUDGE (may I hand its candidates to another agent?), while `state.transcriptPath` is the ONLY
// thing that admits a session into the sweep's enumeration at all.
//
// Both of those carried a defect that a single test here would have caught:
//   · the empty-message path RETURNED before stamping the clock, so a session resumed after a day
//     still read as idle — flushable, and its queue handed to a foreign agent while its own agent
//     was being nudged with the same candidates;
//   · the fix for that stamped `transcriptPath` too, which would have admitted every phantom Stop
//     (~1-2/min, 2,548 state files against 19 real ones) into the enumeration PERMANENTLY, each
//     costing a transcript parse per sweep forever with no reaper.
//
// The two are in tension — that is the whole point of the file. Stamp too little and a live session
// gets flushed; stamp too much and the enumeration fills with phantoms.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { stateFor } from '../paths.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-test-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'stop-test-0001';
const SP = stateFor(SID);
const TRANSCRIPT = path.join(os.tmpdir(), 'stop-test-transcript.jsonl');

fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'assistant', message: { content: 'hello' } }) + '\n');
const reset = () => { try { fs.unlinkSync(SP); } catch { /* fresh already */ } };
const readState = () => { try { return JSON.parse(fs.readFileSync(SP, 'utf8')); } catch { return null; } };

const runStop = (payload) => spawnSync(process.execPath, [path.join(DIR, 'stop.mjs')], {
  input: JSON.stringify({ session_id: SID, hook_event_name: 'Stop', transcript_path: TRANSCRIPT, ...payload }),
  encoding: 'utf8', timeout: 30000,
  env: { ...process.env, VECTROS_RECALL_EVAL: '' },
});

console.log('=== 1. a NORMAL Stop stashes the tail AND records the path + clock ===');
{
  reset();
  const r = runStop({ last_assistant_message: 'the assistant said this' });
  eq('exits 0 (a hook must never break the turn)', r.status, 0);
  const s = readState() || {};
  check('state was written', !!readState(), String(r.stderr).slice(0, 200));
  eq('the assistant tail is stashed', s.lastAssistant, 'the assistant said this');
  eq('transcriptPath is recorded — this is what admits the session to the sweep', s.transcriptPath, TRANSCRIPT);
  check('lastStopAt is stamped', typeof s.lastStopAt === 'number' && s.lastStopAt > 0, String(s.lastStopAt));
}

console.log('\n=== 2. an EMPTY message still stamps the LIVENESS CLOCK ===');
// The defect: this path returned early, so a session resumed after >24h idle kept a stale
// lastStopAt, read as done to both consumers, and could be flushed / have its queue handed away
// while it was demonstrably alive. An empty Stop is weak evidence of content and PERFECT evidence
// of liveness.
{
  reset();
  const before = Date.now();
  const r = runStop({ last_assistant_message: '' });
  eq('exits 0', r.status, 0);
  const s = readState();
  check('state exists — it did NOT return before writing', !!s);
  // Guarded: a failed write must report a clean FAIL, not throw a TypeError that reads as a crash.
  check('lastStopAt is stamped and fresh', !!s && s.lastStopAt >= before, s ? `${s.lastStopAt} vs ${before}` : 'no state');
}

console.log('\n=== 3. ...but an empty message must NOT record transcriptPath (the phantom gate) ===');
/**
 * THE LOAD-BEARING CHECK IN THIS FILE. `residual.mjs`'s `if (!s.transcriptPath) continue` is what
 * excludes phantom sessions from the sweep BY CONSTRUCTION, and `stop.mjs` is its only writer.
 * Desktop spawns ~1-2 empty Stops per minute; if this line stamps a path, every one of them becomes
 * a permanently-enumerated row (never swept, because its residual is below the floor, so `skipSwept`
 * never excludes it either) and is re-parsed on every sweep forever. There is no reaper.
 */
{
  reset();
  runStop({ last_assistant_message: '' });
  const s = readState() || {};
  check('transcriptPath is NOT set from an empty Stop', !s.transcriptPath,
    `transcriptPath=${s.transcriptPath} — this admits every phantom session into the sweep, permanently`);
  // `''`, not `undefined`: `readState` merges its defaults under the parsed file, so a session that
  // has only ever seen empty Stops carries the default empty tail rather than a missing field.
  eq('and no tail was stashed either', s.lastAssistant, '');
}

console.log('\n=== 4. an empty Stop must not ERASE a path a real turn already recorded ===');
// A session normally alternates real and empty Stops. The empty path writes state, so it must
// merge rather than replace — otherwise one phantom Stop evicts a live session from the sweep.
{
  reset();
  runStop({ last_assistant_message: 'real content' });
  eq('precondition: the path is recorded', readState().transcriptPath, TRANSCRIPT);
  runStop({ last_assistant_message: '   ' }); // whitespace-only counts as empty
  const s = readState() || {};
  eq('the previously-recorded path SURVIVES', s.transcriptPath, TRANSCRIPT);
  eq('and the stashed tail survives too', s.lastAssistant, 'real content');
  check('while the clock still advanced', typeof s.lastStopAt === 'number');
}

console.log('\n=== 5. the tail is capped, and a longer message is truncated not dropped ===');
{
  reset();
  // A DISTINCT SENTINEL, not more 'X'. `endsWith('X')` against `'X'.repeat(5000)` is true of both
  // ends and of any slice — it could not observe a change that kept the HEAD instead of the tail,
  // which is the only thing this check exists to prove.
  const SENTINEL = '<<END-OF-TURN>>';
  runStop({ last_assistant_message: 'X'.repeat(5000) + SENTINEL });
  const s = readState();
  check('state was written', !!s);
  if (s) {
    check('a long tail is stored but bounded', s.lastAssistant.length > 0 && s.lastAssistant.length <= 1200,
      String(s.lastAssistant.length));
    check('and it keeps the END of the message (recall slices its tail)',
      s.lastAssistant.endsWith(SENTINEL), JSON.stringify(s.lastAssistant.slice(-40)));
    check('...and it really dropped the head', !s.lastAssistant.startsWith('X'.repeat(1400)));
  }
}

console.log('\n=== 6. unparseable stdin is survivable — a hook must never break the turn ===');
{
  reset();
  const r = spawnSync(process.execPath, [path.join(DIR, 'stop.mjs')], {
    input: 'not json at all', encoding: 'utf8', timeout: 30000,
    env: { ...process.env, VECTROS_RECALL_EVAL: '' },
  });
  eq('still exits 0', r.status, 0);
}

reset();
try { fs.unlinkSync(TRANSCRIPT); } catch { /* best effort */ }
console.log('\ndone');
done();
