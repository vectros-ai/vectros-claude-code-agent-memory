// RUN every migrated hook against a throwaway session id, with realistic stdin.
// `node --check` blessed the doSpawn ReferenceError once already — parse-checking a hook
// proves nothing. This executes them and asserts on the state file they actually produce.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, done } from './assert.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stateFor, workersOffFile } from '../paths.mjs';
// DELIBERATELY NOT importing ./isolate.mjs — see the header above. `run-all.mjs` isolates the
// whole run by setting VECTROS_MEMORY_HOME before spawning this file, so the suite stays
// hermetic; a STANDALONE run against the deployed copy keeps hitting the real runtime, which is
// the entire point of this file as an operator's post-`cp` check. (Self-isolating it here made
// the deployment verification pass green against an empty temp dir.)

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
// Single-sourced with hooklog.mjs (honors VECTROS_HOOKLOG_PATH) rather than a duplicated
// derivation. Deliberately NOT self-redirected here (unlike sweep-test.mjs / nudge-budget-test.mjs):
// per this package's own deployment/setup steps, this file is ALSO run standalone against the
// DEPLOYED `~/.claude/vectros-memory/` copy as an operator's post-`cp` verification, where writing
// into the real log is the point (it's the receipt an operator tails to confirm the deployment is
// alive). run-all.mjs's suite-wide redirect already isolates it for the automated dev-loop path.
const { logPath } = await import(pathToFileURL(path.join(DIR, 'hooklog.mjs')).href);
const LOG = logPath();
const SID = 'smoke-atomic-test-0001';
const SP = stateFor(SID);
const TRANSCRIPT = path.join(os.tmpdir(), 'smoke-transcript.jsonl');

fs.writeFileSync(TRANSCRIPT, JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(),
  message: { content: [{ type: 'text', text: 'hello from the smoke transcript' }] },
}) + '\n');
try { fs.unlinkSync(SP); } catch {}

const payload = (event) => JSON.stringify({
  session_id: SID,
  transcript_path: TRANSCRIPT,
  cwd: DIR,
  hook_event_name: event,
  prompt: 'smoke test prompt',
  reason: 'other',
});

// WORKERS_OFF so the Stop hooks don't spawn real distillers during a smoke test.
const OFF = workersOffFile();
const hadOff = fs.existsSync(OFF);
if (!hadOff) fs.writeFileSync(OFF, 'smoke test\n');

/**
 * ⚠ AND THE REAPER OFF — this file runs the REAL hooks against the REAL runtime, by design.
 *
 * `WORKERS_OFF` was the only safety measure here and it covers billed INFERENCE. It does not cover
 * the reaper: `runReap` is wired into `capture.mjs`'s Stop path, `runReap`'s `apply` defaults to
 * TRUE, and the reaper is deliberately decoupled from `WORKERS_OFF` (that switch is about spend, and
 * the reaper spends nothing). So the ONE component that deletes was the one component this file's
 * safety measure did not cover — and this package's deployment steps tell an operator to run this
 * against their live directory after `cp`.
 *
 * The exposure WIDENED when the reaper moved above `if (!API_KEY) return`. That guard was, by
 * accident, what kept the reaper away from a keyless operator's smoke run; hoisting it (correct on
 * its own terms) means a keyless operator following those deployment steps now reaches the delete too.
 *
 * ENV, not the `REAP_OFF` file: this must not touch the operator's directory in order to protect it,
 * and it must reach the SPAWNED CHILDREN — `run()` below spreads `process.env` into each spawn, which
 * is what makes setting it here sufficient. That propagation is asserted, not assumed:
 * `tests/reap-test.mjs` § "smoke must not delete" spawns capture.mjs exactly as this file does and
 * checks the state count is unchanged with a reap genuinely DUE.
 *
 * (PM cold pass 2026-07-30 found the hole; the PM DELTA pass found that my first attempt at this
 * line never landed — a scripted replace silently no-op'd and printed success anyway, and the manual
 * check that "verified" it passed only because the debounce happened to be suppressing the reap.)
 */
process.env.VECTROS_MEM_REAP_OFF = '1';

const HOOKS = [
  ['orient.mjs', 'SessionStart'],
  ['stop.mjs', 'Stop'],
  ['capture.mjs', 'Stop'],
  ['evaluate.mjs', 'PostToolUse'],
  ['recall.mjs', 'UserPromptSubmit'],
  // sessionend-probe.mjs retired 2026-07-16 — its question is answered (SessionEnd fires ~2/min,
  // always reason=other), so it is unwired from settings.json and deleted. Not a hook any more.
];

/**
 * STDERR IS THE WRONG SIGNAL, and this file was built on it (fixed 2026-07-16, cold panel).
 *
 * It grepped stderr for `ReferenceError|TypeError|…`. But every hook ends in
 * `main().catch(() => {})` — that is the fail-open contract — so **an error inside `main()`, which
 * is where all the logic lives, never reaches stderr.** The `doSpawn` ReferenceError this file was
 * written to catch would have been reported `ok`. A detector that cannot observe the thing it
 * claims is this repo's signature defect, and it was sitting in the smoke test.
 *
 * The signal that CAN observe it: every hook writes a `hooks.log` line when it does its job. So
 * run the hook and assert the log GREW for this session. That proves the body executed past its
 * guards — not merely that the process started and swallowed something.
 */
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').length; } catch { return 0; } };

for (const [file, event] of HOOKS) {
  const before = logLines();
  /**
   * `evaluate.mjs` ALONE gets a fake, test-shaped `VECTROS_API_KEY` here (its own `TEST_KEY_RE`
   * convention — `sk_test_…` — the same shape `creds.mjs` warns on elsewhere in this suite).
   *
   * FOUND EMPIRICALLY: this file passed on every author machine and failed only in CI, on exactly
   * one line — "evaluate.mjs actually ran its body." `evaluate.mjs:181` is `if (!API_KEY) return`,
   * and — deliberately, per its own comment at :175-180 — that path logs NOTHING (recall.mjs's
   * "skip: no VECTROS_API_KEY" line already makes "the loop is unconfigured" observable once per
   * prompt, so a duplicate here would be noise). An author machine with a real Vectros credential
   * configured never reaches that silent branch; a credential-less CI runner — the correct default
   * for a public OSS package's CI, and the exact case its own "fail-open" feature exists for —
   * always does. The gap was this test's assumption, not the hook: it can't observe "ran the body"
   * on a path that legitimately runs no body at all.
   *
   * A fake key is safe ONLY because `WORKERS_OFF` (set above) makes `evaluate.mjs` provably
   * network-free once past that guard: `workersDisabled()` short-circuits before the one branch
   * that would spawn a real `claude -p` / hit the Vectros API, straight to an `hlog(...)` and
   * return — see evaluate.mjs's own `workersDisabled()` branch. That is also why this is scoped to
   * `evaluate.mjs` alone, not the whole loop: `recall.mjs` genuinely passes credential-less in CI
   * today by taking its OWN documented log-and-skip path, and hasn't been checked for a synchronous
   * network call once a (fake) key makes it past that guard — widening this would risk a real
   * outbound call this fix does not need to take on.
   */
  const env = { ...process.env, VECTROS_RECALL_EVAL: '' };
  if (file === 'evaluate.mjs' && !env.VECTROS_API_KEY) env.VECTROS_API_KEY = 'sk_test_smoke00000000000000000000000';
  const r = spawnSync(process.execPath, [path.join(DIR, file)], {
    input: payload(event), encoding: 'utf8', timeout: 30000,
    env,
  });
  const err = (r.stderr || '').trim();
  const crashed = /ReferenceError|TypeError|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find/.test(err);
  const logged = logLines() > before;
  console.log(`  ${file.padEnd(22)} ${event.padEnd(17)} exit=${r.status} logged=${logged}`);
  check(`${file} does not crash`, !crashed, err.split('\n')[0]);
  check(`${file} exits 0 (fail-open: a hook must never break a turn)`, r.status === 0, `exit=${r.status}`);
  // The load-bearing one: a hook that swallowed an error exits 0 and logs NOTHING.
  check(`${file} actually ran its body (wrote a hooks.log line)`, logged,
    'exit 0 with no log line = swallowed by main().catch — the exact bug stderr cannot see');
}

/**
 * THE WORKER IS NOT A HOOK, and that is exactly why it needs its own line here.
 *
 * `capture-worker.mjs` is spawned BY `capture.mjs`, and only when the content gate opens — so the
 * loop above, which drives the five hook entry points, never loads it. It is also the only entry
 * point in this tree with a top-level `await` (the Phase A spool drain), which makes an import
 * error or an unhandled rejection at module scope a NON-ZERO exit rather than the fail-open exit 0
 * every hook is held to. The detached spawn observes neither: nothing reads the worker's status,
 * so a broken worker would present as capture silently producing no candidates, forever.
 *
 * Invoked with NO ARGUMENTS on purpose — it returns before doing anything, so this asserts the
 * module LOADS and its top-level await resolves, and it touches no transcript, no store and no
 * queue. That is the whole failure class a spawned-but-unobserved process can hide.
 */
{
  /**
   * THE HARNESS INVARIANT, asserted at the one place that spawns the worker.
   *
   * The worker ends every run with an unconditional `drainAll`, and credentials are deliberately
   * NOT isolated. So the only thing standing between a suite run and a real `POST /v1/records` with
   * the owner's key is the `SPOOL_OFF` marker `isolate.mjs` writes. That is a property of the
   * harness, not of any one test, and a property nothing asserts is one a refactor deletes.
   */
  check('the isolated root carries SPOOL_OFF — no test can promote to the real store',
    fs.existsSync(path.join(process.env.VECTROS_MEMORY_HOME || '', 'SPOOL_OFF')),
    `VECTROS_MEMORY_HOME=${process.env.VECTROS_MEMORY_HOME}`);
  const r = spawnSync(process.execPath, [path.join(DIR, 'capture-worker.mjs')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env },
  });
  const err = (r.stderr || '').trim();
  console.log(`  ${'capture-worker.mjs'.padEnd(22)} ${'(spawned, not a hook)'.padEnd(17)} exit=${r.status}`);
  check('capture-worker.mjs loads (imports resolve, top-level await settles)',
    !/ReferenceError|TypeError|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find|UnhandledPromiseRejection/.test(err),
    err.split('\n')[0]);
  check('capture-worker.mjs exits 0 with no arguments', r.status === 0, `exit=${r.status}: ${err.split('\n')[0]}`);
}

if (!hadOff) { try { fs.unlinkSync(OFF); } catch {} }

console.log('\n=== state file the hooks actually produced ===');
try {
  const raw = fs.readFileSync(SP, 'utf8');
  const s = JSON.parse(raw); // if the migration broke the shape, this throws
  console.log(`  parses OK, ${raw.length} bytes`);
  console.log(`  keys: ${Object.keys(s).join(', ')}`);
  console.log(`  promptCount=${s.promptCount}  orientPending=${s.orientPending}  lastAssistant=${(s.lastAssistant || '').length}c`);
} catch (e) {
  check('the state file the hooks produced parses', false, e.message);
}

console.log('\n=== leftover .tmp files? (a leaked temp = a rename that never landed) ===');
const dir = path.dirname(SP);
const tmps = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
check('no leaked .tmp files (a leak = a rename that never landed)', tmps.length === 0, tmps.join(', '));

try { fs.unlinkSync(SP); } catch {}
try { fs.unlinkSync(TRANSCRIPT); } catch {}
done(); // exitCode, not exit() — assert.mjs explains why (the libuv assert after a fetch)
