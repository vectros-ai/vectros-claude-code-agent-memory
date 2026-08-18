// RED-PROOF: dispose.mjs's session-id PREFIX resolution — before this, pasting the 8-char id an
// ORPHAN-NUDGE line displays straight into dispose.mjs silently rendered "No pending candidates",
// indistinguishable from a genuinely empty queue (bySession does an EXACT sessionId match, so a
// prefix simply matched nothing). This file proves: a full-length id (any shape, not just a UUID
// — this suite's own fixture ids are plain descriptive strings) is completely unaffected; an
// unambiguous 8-char prefix resolves and actually lists/settles the real candidates; a prefix
// matching zero or multiple sessions refuses loudly instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { append } from '../queue.mjs';
import { verdictMutationsOffFile } from '../paths.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

// A PRIVATE ROOT — this file's whole point is enumerating ALL of queueDir()'s filenames to test
// prefix ambiguity, so it must not see fixtures any sibling test file leaves behind in the
// suite-wide shared root (same reasoning as orphan-cap-worker-test.mjs's own header).
privateRoot('dispose-prefix-test');

// Case 5 below settles a real candidate against the fake server — the default structural gate
// `privateRoot()` just re-stamped into the new root has to come off for that write to land (same
// opt-out as dispose-test.mjs/orphan-cap-worker-test.mjs; found missing here by review, 2026-08-17
// — this file's settle was passing only because the OLD private-root code never carried the
// marker at all, not because this was an intentional, structural opt-in).
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine — not there yet */ }

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DISPOSE = path.join(DIR, 'dispose.mjs');
const server = await startFakeRecordsServer();
const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_dispose_prefix_test', VECTROS_API_BASE_URL: server.url };

function spawnAsync(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env: ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
  });
}

function seed(sid, title) {
  const externalId = `${sid}:${randomUUID()}`;
  server.seed('candidate', { title, body: 'b', kind: 'observation', dest: 'memory', sessionId: sid, disposition: 'pending', proposedAt: '2026-01-01', externalId });
  append(sid, { op: 'propose', externalId, title, body: 'b', kind: 'observation', dest: 'memory' });
  return externalId;
}

console.log('=== 1. a full-length id (>8 chars, non-UUID shaped) is completely unaffected ===');
{
  const sid = 'plain-descriptive-session-id-not-a-uuid';
  seed(sid, 'a candidate under a long, non-UUID session id');
  const r = await spawnAsync([DISPOSE, sid, '--list']);
  check('exits 0', r.status === 0, r.stdout + r.stderr);
  check('lists the real candidate', /1 pending candidate/.test(r.stdout), r.stdout);
  check('no "resolved prefix" note — nothing needed resolving', !/resolved prefix/.test(r.stderr), r.stderr);
}

console.log('\n=== 2. an unambiguous 8-char prefix resolves and lists the real candidates ===');
const SID2 = randomUUID();
{
  seed(SID2, 'a candidate under a real full session id, addressed by its 8-char prefix');
  const prefix = SID2.slice(0, 8);
  const r = await spawnAsync([DISPOSE, prefix, '--list']);
  check('exits 0', r.status === 0, r.stdout + r.stderr);
  check('resolves and says so, to stderr (stdout stays clean for scripting)',
    new RegExp(`resolved prefix "${prefix}" -> ${SID2}`).test(r.stderr), r.stderr);
  check('lists the real candidate', /1 pending candidate/.test(r.stdout), r.stdout);
}

console.log('\n=== 3. a prefix matching ZERO sessions refuses loudly — never reads as "no pending candidates" ===');
{
  const r = await spawnAsync([DISPOSE, 'zzzzzzzz', '--list']);
  check('exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('says "no session found", not an empty-queue read — the whole point of this fix',
    /no session found matching/.test(r.stderr), r.stderr);
  // Match the EXACT renderList phrasing ("No pending candidates for <id>.") — not a bare
  // case-insensitive substring, which would also trip on this very error's own clarifying "This
  // is NOT the same as 'no pending candidates'" aside.
  check('never claims the queue is empty', !/^No pending candidates for/m.test(r.stdout), r.stdout);
}

console.log('\n=== 4. a prefix matching MULTIPLE sessions refuses as ambiguous, never guesses ===');
const SID4A = randomUUID();
const SID4B = SID4A.slice(0, 8) + randomUUID().slice(8); // force a real 8-char collision deterministically
{
  seed(SID4A, 'first of two sessions sharing an 8-char prefix');
  seed(SID4B, 'second of two sessions sharing an 8-char prefix');
  const prefix = SID4A.slice(0, 8);
  const r = await spawnAsync([DISPOSE, prefix, '--list']);
  check('exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('says ambiguous and names both candidates',
    /ambiguous/.test(r.stderr) && r.stderr.includes(SID4A) && r.stderr.includes(SID4B), r.stderr);
}

console.log('\n=== 5. disposing (not just --list) also resolves the prefix — a settle actually lands on the record ===');
const SID5 = randomUUID();
{
  const ext = seed(SID5, 'a candidate settled entirely via its prefix');
  const prefix = SID5.slice(0, 8);
  const list = await spawnAsync([DISPOSE, prefix, '--list']);
  const m = list.stdout.match(/^(c\d+)\s/m);
  check('found an ordinal to dispose', !!m, list.stdout);
  const r = await spawnAsync([DISPOSE, prefix, `${m[1]}=ignored:test cleanup, not durable`]);
  check('exits 0', r.status === 0, r.stdout + r.stderr);
  const rec = [...server.store.values()].find((x) => x.externalId === ext);
  eq('the record settled — the resolved full id, not the raw prefix, is what actually got addressed',
    rec.payload.disposition, 'ignored');
}

console.log('\n=== 6. a GENUINE 8-char-exactly full id, with its own local file, resolves as literal ===');
{
  // The boundary case a review panel caught: at exactly SID_DISPLAY_LEN characters, a real full id
  // and a truncated prefix are indistinguishable by length alone. This confirms the fix — when its
  // own file is the ONLY candidate that matches, a real short id resolves cleanly, exactly as the
  // old exact-match code always did, never as an ambiguous prefix. (Case 9 below covers what
  // happens when it is NOT the only candidate.)
  const sid = 'abcdef12'; // exactly 8 chars, its own genuine id, not a truncation of anything
  seed(sid, 'a genuine 8-char full id, not a prefix of anything');
  const r = await spawnAsync([DISPOSE, sid, '--list']);
  check('exits 0', r.status === 0, r.stdout + r.stderr);
  check('lists its own candidate', /1 pending candidate/.test(r.stdout), r.stdout);
  check('no "resolved prefix" note — treated as literal, not resolved', !/resolved prefix/.test(r.stderr), r.stderr);
}

console.log('\n=== 7. a prefix containing a slug-affected character REFUSES rather than guesses ===');
{
  // Queue filenames are the SLUGGED id (`paths.mjs` slug/queueFor); nudge lines display the RAW
  // id's first 8 chars. slug() is LOSSY (`a:b` and `a_b` slug to the same filename), so finding a
  // file this way can prove "some session matches" but can never prove WHICH raw id it truly was.
  // The correct, safe behaviour is to say so and ask for the literal id — not to guess.
  const sid = `ab cd:ef-${randomUUID()}`;
  const rawPrefix = sid.slice(0, 8); // exactly what a nudge line would display: "ab cd:ef"
  seed(sid, 'a session id with a slug-affected character in its displayed prefix');
  const r = await spawnAsync([DISPOSE, rawPrefix, '--list']);
  check('exits non-zero — refuses rather than resolving to a possibly-wrong id', r.status !== 0, `exit=${r.status}`);
  check('explains why (slug is lossy) and asks for the full literal id',
    /can't be safely reconstructed/.test(r.stderr) && /FULL literal session id/.test(r.stderr), r.stderr);
  check('the FULL literal id still works directly, unaffected by any of this',
    (await spawnAsync([DISPOSE, sid, '--list'])).stdout.includes('1 pending candidate'));
}

console.log('\n=== 8. --reopen also resolves the prefix, not just --list and a settle spec ===');
const SID8 = randomUUID();
{
  const ext = seed(SID8, 'a candidate disposed then reopened, entirely via its prefix');
  const prefix = SID8.slice(0, 8);
  const list = await spawnAsync([DISPOSE, prefix, '--list']);
  const m = list.stdout.match(/^(c\d+)\s/m);
  check('found an ordinal to dispose', !!m, list.stdout);
  const disposeR = await spawnAsync([DISPOSE, prefix, `${m[1]}=ignored:test cleanup, not durable`]);
  check('dispose via prefix exits 0', disposeR.status === 0, disposeR.stdout + disposeR.stderr);
  const reopenR = await spawnAsync([DISPOSE, prefix, '--reopen', m[1], 'the dismissal was wrong']);
  check('reopen via prefix exits 0', reopenR.status === 0, reopenR.stdout + reopenR.stderr);
  const rec = [...server.store.values()].find((x) => x.externalId === ext);
  eq('the record is pending again — reopen landed on the RESOLVED id, not the raw prefix', rec.payload.disposition, 'pending');
}

console.log('\n=== 9. a LITERAL short id colliding with a longer sibling\'s prefix refuses, never silently picks the literal ===');
{
  // The real bug an independent review caught, 2026-08-17: an earlier version checked "does a
  // local file exist for the literal input?" FIRST and returned it immediately, without ever
  // checking whether that same literal input could ALSO be a truncated prefix of some other,
  // longer session's id sitting in the same queue directory. Two candidates for one input is
  // exactly as unresolvable as an ordinary multi-way prefix collision (case 4 above) — silently
  // preferring the literal would have been the exact silent failure mode this file exists to
  // refuse. Not reachable by two genuine Claude Code sessions (real ids are always 36-char UUIDs,
  // never exactly 8 characters), but fully reachable for the short descriptive ids this file's own
  // header says are supported.
  const literalSid = 'abc12345'; // exactly 8 chars, its own genuine id
  const longerSibling = literalSid + '-' + randomUUID(); // a DIFFERENT, longer session whose id starts with the same 8 characters
  seed(literalSid, 'the genuine 8-char id being collided with');
  seed(longerSibling, 'a longer, unrelated session that happens to start with the same 8 characters');
  const r = await spawnAsync([DISPOSE, literalSid, '--list']);
  check('exits non-zero — refuses rather than silently resolving to the literal', r.status !== 0, `exit=${r.status}`);
  check('says ambiguous and names both candidates',
    /ambiguous/.test(r.stderr) && r.stderr.includes(literalSid) && r.stderr.includes(longerSibling), r.stderr);
  check('never silently lists the literal session\'s own candidate',
    !/1 pending candidate/.test(r.stdout), r.stdout);
}

await server.close();
done();
