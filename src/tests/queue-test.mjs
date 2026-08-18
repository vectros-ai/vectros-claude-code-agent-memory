// Exercise the queue + gate + transcript arithmetic for real. No inference — this tests the
// deterministic half (which is where the 33.7% torn-read bug lived, not in the model).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { queueFor, stateFor, workersOffFile } from '../paths.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'queue-test-0001';
const QP = queueFor(SID);
const SP = stateFor(SID);
const T = path.join(os.tmpdir(), 'queue-test-transcript.jsonl');

// Windows: a bare absolute path is parsed as protocol 'c:' — dynamic import needs a file:// URL.
const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { read, append, markCaptured } = await mod('queue.mjs');
const { transcriptLength, sliceSince } = await mod('transcript.mjs');

for (const f of [QP, SP, T]) { try { fs.unlinkSync(f); } catch {} }

// ---- build a transcript of a known size
const mkMsg = (type, text) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } });
const write = (n, size) => {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(mkMsg(i % 2 ? 'assistant' : 'user', `msg${i} `.padEnd(size, 'x')));
  fs.writeFileSync(T, lines.join('\n') + '\n');
};

console.log('=== transcript arithmetic ===');
write(10, 1000);
const len1 = transcriptLength(T);
console.log(`  10 msgs x ~1000 chars -> transcriptLength = ${len1}`);

console.log('\n=== queue fold: empty ===');
let q = read(SID);
eq('empty queue folds to offset 0', q.offset, 0);
eq('empty queue has nothing pending', q.pending.length, 0);

console.log('\n=== propose two candidates ===');
append(SID, { op: 'propose', id: 'c1', title: 'the ~9/min refresh rate', body: 'fabricated stat', kind: 'observation' });
append(SID, { op: 'propose', id: 'c2', title: 'atomic writes needed', body: 'real', kind: 'observation' });
q = read(SID);
eq('two proposals are pending', q.pending.map((c) => c.id).join(','), 'c1,c2');

/**
 * THE DUPLICATE-WORKER RACE — the invariant `lock.mjs` was guarding, tested where the damage
 * actually was.
 *
 * Two workers folding the same snapshot both minted `c1` via `nextId(all)` (a read-modify-write
 * over the fold), both appended, and `all.set(e.id, e)` silently DESTROYED the first candidate.
 * The module header's "an append log, never a read-modify-write ... no lost update" was true of the
 * EVENTS and false of the ID ALLOCATION.
 *
 * Note what this asserts: BOTH events are on disk — O_APPEND never lost anything — so the ONLY
 * question is whether the fold keeps them. It now names candidates by ORDINAL, so a colliding id is
 * not merely tolerated, it is unrepresentable: there is no allocator left to race.
 */
console.log('\n=== the DUPLICATE-WORKER race: two workers, same minted id ===');
append(SID, { op: 'propose', id: 'c1', title: 'worker B, racing', body: 'a DIFFERENT claim', kind: 'observation' });
q = read(SID);
eq('the colliding proposal does NOT overwrite the first — it gets its own id',
  q.pending.length, 3);
check('worker A\'s candidate survives the collision',
  q.pending.some((c) => c.title === 'the ~9/min refresh rate'),
  'THE BUG: a duplicate worker destroyed a candidate instead of merely wasting spend');
check('worker B\'s candidate is also kept',
  q.pending.some((c) => c.title === 'worker B, racing'));
eq('ids stay dense and positional', q.pending.map((c) => c.id).join(','), 'c1,c2,c3');
check('the id a writer put on the wire is IGNORED — it is not a fact it can allocate safely',
  q.pending.filter((c) => c.id === 'c1').length === 1);

console.log('\n=== REVISE c1 (the correction path) ===');
append(SID, { op: 'revise', revises: 'c1', title: 'the ~9/min stat was FABRICATED', body: 'corrected', kind: 'observation' });
q = read(SID);
eq('a REVISE retires its target and pends the correction', q.pending.map((c) => c.id).join(','), 'c2,c3,c4');
check('the superseded candidate is gone', !q.pending.some((c) => c.id === 'c1'));

console.log('\n=== dispose c2 ===');
append(SID, { op: 'dispose', id: 'c2', disposition: 'ignored' });
q = read(SID);
eq('a disposed candidate leaves the queue forever', q.pending.map((c) => c.id).join(','), 'c3,c4');

console.log('\n=== watermark is monotonic (an out-of-order append must not rewind it) ===');
markCaptured(SID, 5000);
markCaptured(SID, 9000);
markCaptured(SID, 3000); // stale/out-of-order
q = read(SID);
eq('the watermark is monotonic — an out-of-order append cannot rewind it', q.offset, 9000);

console.log('\n=== malformed line does not strand the queue ===');
fs.appendFileSync(QP, 'this is not json\n');
q = read(SID);
eq('a malformed line does not strand the queue', q.pending.length, 2);
eq('a malformed line does not lose the watermark', q.offset, 9000);

console.log('\n=== sliceSince: the FORWARD window (revised — it no longer keeps the tail) ===');
write(40, 1000);
const total = transcriptLength(T);
const s = sliceSince(T, 20000, 400000);
console.log(`  total=${total}  from 20000 -> ${s.text.length} chars, ${s.messages} msgs, to=${s.to}, remaining=${s.remaining}`);
const sAll = sliceSince(T, 0, 400000);
console.log(`  from 0           -> ${sAll.text.length} chars, ${sAll.messages} msgs, to=${sAll.to} (expect ==total ${total}), remaining=${sAll.remaining} (expect 0)`);
// A small cap must take WHOLE messages from the HEAD and report where it stopped — the caller
// marks `to`, so a partial window can never bury the rest.
const sCap = sliceSince(T, 0, 5000);
console.log(`  cap at 5000      -> ${sCap.text.length} chars, ${sCap.messages} msgs, to=${sCap.to}, remaining=${sCap.remaining}`);
console.log(`  head not tail?   ${sCap.text.startsWith('msg0 ')}  (expect true — oldest unread first)`);
console.log(`  walks forward?   ${(() => { let o = 0, n = 0; for (;;) { const w = sliceSince(T, o, 5000); if (!w.text.length || w.to <= o) break; o = w.to; n++; } return `${n} windows, ends at ${o} (expect ${total})`; })()}`);

console.log('\n=== the GATE: capture.mjs decides on content, not time ===');
const runGate = (label) => {
  const r = spawnSync(process.execPath, [path.join(DIR, 'capture.mjs')], {
    input: JSON.stringify({ session_id: SID, transcript_path: T, cwd: DIR, hook_event_name: 'Stop' }),
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, VECTROS_RECALL_EVAL: '' },
  });
  const err = (r.stderr || '').trim();
  if (/ReferenceError|TypeError|Cannot find|ERR_MODULE/.test(err)) console.log(`  ${label}: CRASH\n    ${err.split('\n')[0]}`);
  else console.log(`  ${label}: ran clean (exit ${r.status})`);
};
// WORKERS_OFF so no real distiller spawns
const OFF = workersOffFile();
const hadOff = fs.existsSync(OFF);
if (!hadOff) fs.writeFileSync(OFF, 'queue test\n');

write(400, 1000); // ~400K chars — way over the 100K gate
runGate('big delta (should gate OPEN)');
write(5, 1000);   // tiny session — under MIN_SESSION_CHARS
try { fs.unlinkSync(QP); } catch {}
runGate('tiny session (should gate SHUT)');

console.log('\n=== RED-PROOF: append() enforces QUEUE_BODY_MAX_CHARS on body/title ===');
{
  // The append-atomicity this module rests on ("a small write to a file opened O_APPEND is not
  // interleaved") is bounded by an unenforced size — this is the cap that bounds it, at the one
  // chokepoint every writer goes through.
  try { fs.unlinkSync(QP); } catch {}
  const { QUEUE_BODY_MAX_CHARS } = await mod('config.mjs');
  const hugeBody = 'x'.repeat(QUEUE_BODY_MAX_CHARS + 5000);
  const hugeTitle = 'y'.repeat(QUEUE_BODY_MAX_CHARS + 5000);
  // id is POSITIONAL (queue.mjs's own fold ignores a caller-supplied id) — this is the first
  // propose on a freshly-unlinked queue, so it lands as 'c1'.
  append(SID, { op: 'propose', title: hugeTitle, body: hugeBody, kind: 'observation', dest: 'memory' });
  const capped = read(SID).all.get('c1');
  check('body truncated to at most QUEUE_BODY_MAX_CHARS + the marker', capped.body.length <= QUEUE_BODY_MAX_CHARS + 20, `len=${capped.body.length}`);
  check('title truncated to at most QUEUE_BODY_MAX_CHARS + the marker', capped.title.length <= QUEUE_BODY_MAX_CHARS + 20, `len=${capped.title.length}`);
  check('a body under the cap is NOT truncated', (() => {
    try { fs.unlinkSync(QP); } catch {}
    const short = 'z'.repeat(200);
    append(SID, { op: 'propose', title: 't', body: short, kind: 'observation', dest: 'memory' });
    return read(SID).all.get('c1').body === short;
  })());
  try { fs.unlinkSync(QP); } catch {}
}

if (!hadOff) { try { fs.unlinkSync(OFF); } catch {} }
for (const f of [QP, SP, T]) { try { fs.unlinkSync(f); } catch {} }
done();
