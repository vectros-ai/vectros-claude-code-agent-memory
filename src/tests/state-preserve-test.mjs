// The invariant stop.mjs:52-54 leans on: a field one hook writes must SURVIVE every OTHER
// hook's read-modify-write, even hooks whose `readState` defaults don't mention it. That holds only
// because readJsonSafe merges `{...defaults, ...parsedFile}` — defaults UNDER the file. This project's
// worst bug (promptCount 37->9) was a state reset, so this invariant is worth a RED-provable lock,
// not just a comment. (Cold-panel test-adequacy finding, 2026-07-17.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-preserve-log-')), 'hooks.log');

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/
const { readState, writeState, statePath } = await import(pathToFileURL(path.join(HOOKS, 'state.mjs')).href);

const SID = 'state-preserve-test-0001'; // word sid — report.mjs's isReal excludes it from stats
const clean = () => { try { fs.unlinkSync(statePath(SID)); } catch {} };

try {
  clean();
  // 1. stop.mjs-style write: stash the tail AND the two load-bearing fields.
  writeState(SID, { injectedIds: ['r1'], lastAssistant: 'tail', promptCount: 7, transcriptPath: '/some/transcript.jsonl', lastStopAt: 1234567 });

  // 2. a DIFFERENT hook reads with defaults that DO NOT mention transcriptPath/lastStopAt/promptCount,
  //    mutates its own field, and writes back the whole object (capture/evaluate/recall all do this).
  const { value: s } = readState(SID, { injectedIds: [], lastAssistant: '' });
  eq('read-merge preserved transcriptPath despite absent default', s.transcriptPath, '/some/transcript.jsonl');
  eq('read-merge preserved lastStopAt', s.lastStopAt, 1234567);
  eq('read-merge preserved promptCount', s.promptCount, 7);
  s.lastAssistant = 'newer tail';
  writeState(SID, s);

  // 3. re-read: the fields must still be there after the other hook's write cycle.
  const { value: s2 } = readState(SID, { injectedIds: [] });
  eq('transcriptPath survives another hook write-back', s2.transcriptPath, '/some/transcript.jsonl');
  eq('lastStopAt survives another hook write-back', s2.lastStopAt, 1234567);
  eq('the other hook did update its own field', s2.lastAssistant, 'newer tail');
  check('promptCount was not reset', s2.promptCount === 7, `promptCount=${s2.promptCount}`);
} finally {
  clean();
}

// END-TO-END: the block above proves the state.mjs read-merge invariant stop.mjs RELIES on; this
// proves stop.mjs itself actually SETS transcriptPath/lastStopAt from the hook payload (this discipline — the
// contract, not a proxy). Spawn the real hook with a synthetic Stop payload.
const SID2 = 'state-preserve-e2e-0002'; // word sid — excluded from report stats
const clean2 = () => { try { fs.unlinkSync(statePath(SID2)); } catch {} };
try {
  clean2();
  spawnSync(process.execPath, [path.join(HOOKS, 'stop.mjs')], {
    input: JSON.stringify({ session_id: SID2, transcript_path: '/e2e/transcript.jsonl', last_assistant_message: 'a tail from the e2e run', hook_event_name: 'Stop' }),
    encoding: 'utf8',
  });
  const { value: e2e } = readState(SID2, {});
  eq('stop.mjs persisted transcriptPath from the payload', e2e.transcriptPath, '/e2e/transcript.jsonl');
  check('stop.mjs stamped a numeric lastStopAt', typeof e2e.lastStopAt === 'number' && e2e.lastStopAt > 0, `lastStopAt=${e2e.lastStopAt}`);
  check('stop.mjs still stashed the assistant tail', typeof e2e.lastAssistant === 'string' && e2e.lastAssistant.includes('e2e run'));
} finally {
  clean2();
}

console.log('\ndone');
done();
