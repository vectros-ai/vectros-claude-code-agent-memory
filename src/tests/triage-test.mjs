// Answer-triage: does judging the ANSWER actually change what reaches the agent?
//
// The interesting cases all produce SILENCE or an INTERRUPT — neither of which the old code
// could express. Drives the real evaluate.mjs injector against staged payloads, and unit-tests
// the worker's id-filtering directly (the worker's model call needs a real binary; the fake-.cmd
// seam is unusable on Windows — spawning a .cmd shim there shifts the effective cwd out from
// under the fake).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { memoryHome, workersOffFile } from '../paths.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into a real
// deployment's hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'triage-test-0001';
const ROOT = memoryHome();
const STAGED = path.join(ROOT, 'staged', SID + '.json');
const STATE = path.join(ROOT, 'state', SID + '.json');
const T = path.join(os.tmpdir(), 'triage-test-transcript.jsonl');

fs.writeFileSync(T, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }) + '\n');
const reset = () => { for (const f of [STAGED, STATE]) { try { fs.unlinkSync(f); } catch {} } };

/**
 * TWO REAL BUGS FOUND HERE (CI-only symptom, both live on any machine with a real credential):
 *
 * 1. `VECTROS_WORKERS_OFF` (the env var this file used to set below) is not a thing —
 *    `workersDisabled()` (creds.mjs) only ever checks the `WORKERS_OFF` FILE marker
 *    (`workersOffFile()`). The env var was silently inert, so every `inject()` call below, on any
 *    machine with a real credential resolvable, was letting `evaluate.mjs` fall through to its
 *    real debounced trigger and fire-and-forget spawn a REAL `recall-eval-worker.mjs` — a real
 *    `claude -p` Haiku call — in the background. It never touched what THIS file asserts (the
 *    injector reads the pre-staged payload synchronously, independent of that spawn), so it never
 *    showed up as a failure locally — only as uncounted spend and a non-hermetic "unit" test.
 * 2. `evaluate.mjs:181`'s `if (!API_KEY) return` exits before the injector ever runs, and does so
 *    SILENTLY by design (see evaluate.mjs's own comment) — so on a CI runner with no real
 *    credential configured (the correct default for this package's public OSS CI), every
 *    `inject()` call below returns an empty context. That empties tests 2-5 identically, which is
 *    exactly the CI-only failure this fixes; an author machine with a real credential never took
 *    this branch, hence "passes for everyone but CI."
 *
 * Fixed together: a real FILE marker actually disables the worker spawn (so this test is finally
 * hermetic — no more background inference on every local run either), and a fake, test-shaped key
 * (this repo's own `TEST_KEY_RE` convention, `sk_test_…`) gets the injector's guard open safely —
 * safely BECAUSE the file marker above means `evaluate.mjs` never reaches a real network call with
 * it. Restored afterward: `run-all.mjs` shares one isolated root across every test file in a run,
 * so leaving the marker behind would silently disable workers for whichever file runs next.
 */
const OFF = workersOffFile();
const hadOff = fs.existsSync(OFF);
if (!hadOff) fs.writeFileSync(OFF, 'triage-test\n');

// Stage a payload exactly as the worker would, then run the REAL injector.
const inject = (payload) => {
  fs.mkdirSync(path.dirname(STAGED), { recursive: true });
  fs.writeFileSync(STAGED, JSON.stringify(payload));
  const env = { ...process.env };
  if (!env.VECTROS_API_KEY) env.VECTROS_API_KEY = 'sk_test_invalid_triage00000000000000000';
  const r = spawnSync(process.execPath, [path.join(DIR, 'evaluate.mjs')], {
    input: JSON.stringify({ session_id: SID, transcript_path: T, cwd: os.tmpdir(), hook_event_name: 'PostToolUse' }),
    encoding: 'utf8', timeout: 20000,
    env,
  });
  const err = (r.stderr || '').trim();
  if (/ReferenceError|TypeError|Cannot find|ERR_MODULE|Assertion/.test(err)) return { crash: err.split('\n')[0] };
  let ctx = '';
  try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''; } catch {}
  return { ctx, chars: ctx.length };
};

const hit = (id, label) => ({ id, label, kind: 'decision', area: 'search', claim: 'a claim about ' + label, passage: 'matched text for ' + label });

console.log('=== 1. THE CASE THAT MATTERS: triage kept nothing -> agent sees SILENCE ===');
console.log('    (old behaviour: five confident wrong ADRs)');
reset();
let r = inject({ hits: [], contradiction: null, query: 'number coercion', reason: 'x', triage: 'nothing answered' });
check('triage kept nothing => the agent sees SILENCE (was: five confident wrong ADRs)', !r.crash && r.chars === 0, r.crash || `injected ${r.chars}c`);

console.log('\n=== 2. triage kept 1 of 5 -> only the answer is injected ===');
reset();
r = inject({ hits: [hit('decision-0042', 'decision 42: retry-policy revert')], contradiction: null, query: 'q', reason: 'x' });
if (r.crash) check('worker did not crash on a single-hit triage payload', false, r.crash);
else {
  console.log(`  injected: ${r.chars}c`);
  check('the kept hit reaches the injected context', r.ctx.includes('decision-0042'), r.ctx);
  check('hits are framed as TRIAGED (not just ranked)', r.ctx.includes('ANSWERS the question'), r.ctx);
}

console.log('\n=== 3. CONTRADICTION -> arrives as an obligation, FIRST, above the hits ===');
reset();
r = inject({ hits: [hit('decision-0042', 'decision 42')], contradiction: 'You are adding a fixed retry ceiling; decision 42 rejected that — the right ceiling moves with payload size.', query: 'q', reason: 'x' });
if (r.crash) check('worker did not crash on a contradiction+hit triage payload', false, r.crash);
else {
  const ci = r.ctx.indexOf('POSSIBLE CONTRADICTION');
  const hi = r.ctx.indexOf('Recall surfaced mid-task');
  check('contradiction is present in the injected context', ci >= 0, r.ctx);
  check('contradiction is positioned before the hits', ci >= 0 && (hi < 0 || ci < hi), r.ctx);
  check('contradiction is framed as fallible judgment, not a verdict', r.ctx.includes('can be wrong'), r.ctx);
  check('contradiction demands a response from the agent', r.ctx.includes('say why it does not apply'), r.ctx);
}

console.log('\n=== 4. contradiction with NO fresh hits must NOT be swallowed ===');
console.log('    (the `if (lines.length === 0) return` trap)');
reset();
r = inject({ hits: [], contradiction: 'You are re-deriving a decided question.', query: 'q', reason: 'x' });
if (r.crash) console.log('  CRASH: ' + r.crash);
else check('a contradiction with NO fresh hits is NOT swallowed', r.ctx.includes('POSSIBLE CONTRADICTION'));

console.log('\n=== 5. an oversized block assembles to FIT, never a mid-word slice ===');
reset();
const many = Array.from({ length: 60 }, (_, i) => hit('h' + i, 'hit ' + i + ' ' + 'y'.repeat(400)));
r = inject({ hits: many, contradiction: 'Short but critical contradiction.', query: 'q', reason: 'x' });
if (r.crash) console.log('  CRASH: ' + r.crash);
else {
  check('an oversized block assembles to FIT the cap', r.chars <= 9500, `injected ${r.chars}c`);
  check('the contradiction is never what drops for budget', r.ctx.includes('Short but critical'));
}

console.log('\n=== 6. worker: a hallucinated id cannot conjure a hit ===');
const wmod = await import(pathToFileURL(path.join(DIR, 'recall-eval-worker.mjs')).href).catch((e) => ({ err: e.message }));
check('recall-eval-worker.mjs loads without a ReferenceError/module-load failure', !wmod.err, wmod.err);

reset();
try { fs.unlinkSync(T); } catch {}
if (!hadOff) { try { fs.unlinkSync(OFF); } catch {} }
done();
