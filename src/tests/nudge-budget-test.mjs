// The budget-drop path. If a nudge is computed, dropped for budget, but STILL marked as shown,
// it is retired forever — the pending set only changes when a new capture lands, so it would not
// return until then, and might never. This is the failure that would be invisible in production:
// the queue fills, the agent is never told, and nothing logs an error.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { queueFor, stateFor, verdictMutationsOffFile } from '../paths.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'nudge-budget-0001';
const QP = queueFor(SID);
const SP = stateFor(SID);

// Self-redirect BEFORE spawning recall.mjs below (its `env: {...ENV, ...}` spread carries this
// into the child). This test forces a NUDGE DROPPED receipt on purpose; it must not land in
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-budget-log-')), 'hooks.log');

const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { logPath } = await mod('hooklog.mjs');

for (const f of [QP, SP]) { try { fs.unlinkSync(f); } catch {} }
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine — not there yet; this file only proposes, but candidates.mjs's call() checks the marker on every write regardless of verb */ }

/**
 * THE FAKE RECORD STORE, as of 2026-08-14 (B2) — same reason as nudge-test.mjs: recall.mjs's
 * OWN-session nudge reads `candidates.mjs`'s `addressablePending(sessionId)` now, not the local
 * file queue, so this suite has to seed records. `/v1/search` is also stubbed (empty results).
 */
const server = await startFakeRecordsServer();
const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_nudge_budget_test', VECTROS_API_BASE_URL: server.url };

/**
 * HOW "OVER BUDGET" IS PRODUCED — and it changed, for a reason worth recording.
 *
 * This used to seed 200 fat candidates and rely on the rendered block being far over 9500c. That
 * premise died when `renderNudge` gained `NUDGE_MAX`: the block is now BOUNDED (~5.8K worst case, at
 * any pending count), which is the whole point of the cap — an all-or-nothing block that can outgrow
 * its budget is a block that silently vanishes. So candidate count can no longer push it over, and a
 * test built on that premise would have quietly stopped testing the drop path while still passing.
 *
 * The drop path is still REAL and still needs cover: the orient block and recall hits share the same
 * budget, so a large orientation can leave less than the nudge needs. Rather than simulate that
 * indirectly, shrink the budget itself through the config seam (`VECTROS_MEM_CONTEXT_CAP`) —
 * the supported way to move that number, and a far more direct statement of the condition under test.
 *
 * Because this no longer depends on candidate count, it stayed correct through a LATER, unrelated
 * change to `fake-records-server.mjs`: that fake used to truncate any lookup to its first 100 rows
 * (hardcoded `nextCursor: null`), so this file's 200 seeded candidates were silently read back as
 * 100. The fake now paginates for real, and every one of the 200 is read back — harmless here only
 * because this test's assertions were already re-anchored on the budget, not the count, above.
 */
for (let i = 1; i <= 200; i++) {
  server.seed('candidate', {
    title: `candidate ${i} `.padEnd(300, 'T'), body: 'b'.repeat(300), kind: 'observation', dest: 'memory',
    sessionId: SID, disposition: 'pending', proposedAt: '2026-01-01', externalId: `${SID}:seed-${i}`,
  });
}

const TINY_CAP = '600'; // smaller than any possible nudge block, so the drop is forced, not hoped for

/**
 * ASYNC `spawn`, deliberately — NOT `spawnSync`. The fake server lives in THIS process's event
 * loop; `spawnSync` would block it for the child's whole lifetime, so the server could never
 * answer. Same trap `orient-boundary-test.mjs`/`dispose-test.mjs`/`nudge-test.mjs` already
 * document — see any of their headers for the full story.
 */
const runRecall = (prompt, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(DIR, 'recall.mjs')], { env: { ...ENV, ...env } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', () => {});
  child.stdin.end(JSON.stringify({ session_id: SID, prompt, cwd: os.tmpdir(), hook_event_name: 'UserPromptSubmit' }));
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('close', () => {
    clearTimeout(timer);
    let ctx = '';
    try { ctx = JSON.parse(out || '{}').hookSpecificOutput?.additionalContext || ''; } catch {}
    resolve({ ctx, hasNudge: ctx.includes('MEMORY CANDIDATES'), chars: ctx.length });
  });
});

const sigOf = () => { try { return JSON.parse(fs.readFileSync(SP, 'utf8')).nudgedSig || '(unset)'; } catch { return '(no state)'; } };

console.log('=== an over-budget nudge must be DROPPED, and must NOT be marked shown ===');
const LOG = logPath(); // the redirected, per-file-isolated log, not production
const logAt = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const since = (at) => { try { return fs.readFileSync(LOG).slice(at).toString('utf8'); } catch { return ''; } };

const at0 = logAt();
const r1 = await runRecall('first prompt', { VECTROS_MEM_CONTEXT_CAP: TINY_CAP });
check('an over-budget nudge is not injected', !r1.hasNudge);
console.log(`  ctx = ${r1.chars}c  (MUST be <= ${TINY_CAP})  ${r1.chars <= +TINY_CAP ? 'PASS' : '*** OVER CAP ***'}`);
eq('a DROPPED nudge is not marked shown — it must return', sigOf(), '(unset)');
// AND IT MUST SAY SO. The drop was silent: the injection line simply omits the NUDGE segment, which
// is byte-identical to "signature unchanged" and to "nothing pending", so candidates going
// unsurfaced for budget looked exactly like a healthy quiet turn.
check('a dropped nudge leaves a RECEIPT naming the cost and the count',
  /NUDGE DROPPED for budget/.test(since(at0)), JSON.stringify(since(at0).slice(0, 400)));

console.log('\n=== once it fits, it must appear (the drop was deferral, not deletion) ===');
// Drain to a size that fits — settle everything but the first 5, directly on the fake store (this
// suite tests the NUDGE, not settlement; dispose-test.mjs already covers dispose.mjs's own path).
for (const r of server.store.values()) {
  if (r.typeName !== 'candidate' || r.payload.sessionId !== SID) continue;
  const n = +String(r.payload.externalId).split('-').pop();
  if (n >= 6) r.payload.disposition = 'ignored';
}
const r2 = await runRecall('second prompt');
check('the nudge returns once it fits — the drop was deferral, not deletion', r2.hasNudge);
console.log(`  ctx = ${r2.chars}c  (MUST be <= 9500)  ${r2.chars <= 9500 ? 'PASS' : '*** OVER CAP ***'}`);
console.log(`  nudgedSig after = ${sigOf().slice(0, 40)}  (now set)`);

for (const f of [QP, SP]) { try { fs.unlinkSync(f); } catch {} }
await server.close();
done();
