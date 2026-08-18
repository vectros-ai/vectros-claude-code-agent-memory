// hooklog.mjs must never be the reason a test suite corrupts the PRODUCTION hooks.log.
//
// RED-PROOF FOR THE ACTUAL BUG: before this fix, `hlog()` had no way to be told to write anywhere
// but `~/.claude/vectros-memory/hooks.log`, full stop — so `sweep-test.mjs` forcing a "marker
// append FAILED" receipt, or `nudge-budget-test.mjs` forcing a "NUDGE DROPPED" receipt, landed
// those lines in the SAME file an operator greps at 2am for a real incident. This file proves (a)
// the default is unchanged for every real session (no env var set), and (b) `VECTROS_HOOKLOG_PATH`
// actually redirects writes AWAY from the default path — not merely that a function returns a
// different string.
//
// NOTE: this file must never itself write into the real default log to prove point (a) — it
// asserts the PATH `logPath()` resolves to, and never calls `hlog()` without an override in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { memoryHome } from '../paths.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
// SPELLED OUT, not `defaultHooksLog()` — asserting `logPath() === defaultHooksLog()` compares a
// function to itself (hooklog.mjs's fallback IS that call) and cannot fail whatever either
// returns. The point of this line is to pin the LAYOUT, so the layout is written down here.
const SPELLED = path.join(memoryHome(), 'hooks.log');

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const DEFAULT_LOG = SPELLED;


console.log('=== 1. no override → resolves to the real default (every real session, unchanged) ===');
{
  delete process.env.VECTROS_HOOKLOG_PATH;
  const { logPath } = await import(pathToFileURL(path.join(HOOKS, 'hooklog.mjs')).href + '?t=1');
  eq('default path matches the LAYOUT spelled out in this file, not paths.mjs calling itself',
    logPath(), DEFAULT_LOG);
}

console.log('\n=== 2. VECTROS_HOOKLOG_PATH redirects hlog() writes AWAY from the default log ===');
{
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hooklog-redirect-')), 'hooks.log');
  process.env.VECTROS_HOOKLOG_PATH = tmp;
  // Fresh module instance (cache-busted query string) so this isn't reusing case 1's import and
  // silently proving nothing about a second read.
  const { hlog, logPath } = await import(pathToFileURL(path.join(HOOKS, 'hooklog.mjs')).href + '?t=2');
  eq('logPath() reflects the override', logPath(), tmp);

  const defaultSizeBefore = (() => { try { return fs.statSync(DEFAULT_LOG).size; } catch { return -1; } })();
  check('redirected target does not exist yet', !fs.existsSync(tmp));

  hlog('test', 'hooklog-redirect-test marker — must land in tmp, never in production hooks.log');

  check('the line landed in the REDIRECTED file', fs.existsSync(tmp) && fs.readFileSync(tmp, 'utf8').includes('hooklog-redirect-test marker'));
  const defaultSizeAfter = (() => { try { return fs.statSync(DEFAULT_LOG).size; } catch { return -1; } })();
  eq('the PRODUCTION log is byte-for-byte untouched by this call', defaultSizeAfter, defaultSizeBefore);

  delete process.env.VECTROS_HOOKLOG_PATH;
}

console.log('\n=== 3. an empty/whitespace override means "not set", same convention as config.mjs ===');
{
  process.env.VECTROS_HOOKLOG_PATH = '   ';
  const { logPath } = await import(pathToFileURL(path.join(HOOKS, 'hooklog.mjs')).href + '?t=3');
  eq('blank env var falls back to the default, not a literal blank path', logPath(), DEFAULT_LOG);
  delete process.env.VECTROS_HOOKLOG_PATH;
}

console.log('\n=== 4. the redirect is read FRESH per call, not frozen at import time ===');
{
  delete process.env.VECTROS_HOOKLOG_PATH;
  const { logPath } = await import(pathToFileURL(path.join(HOOKS, 'hooklog.mjs')).href + '?t=4');
  eq('before setting the env var, resolves to the default', logPath(), DEFAULT_LOG);
  const tmp2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hooklog-redirect-late-')), 'hooks.log');
  process.env.VECTROS_HOOKLOG_PATH = tmp2;
  eq('the SAME imported binding honors an env var set AFTER import — no import-order trap', logPath(), tmp2);
  delete process.env.VECTROS_HOOKLOG_PATH;
}

done();
