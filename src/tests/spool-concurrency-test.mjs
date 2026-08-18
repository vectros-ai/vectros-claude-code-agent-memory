// RED-PROOF: spool.mjs's own header claims "Two writers, one file, no locking, because there is
// no read-modify-write: state is a FOLD over events, so a concurrent append cannot lose an
// earlier one." That claim rests entirely on `fs.appendFileSync` being atomic across REAL,
// SEPARATE processes racing on the same file — never previously exercised. Every other spool test
// runs single-process. This one spawns several genuine child processes appending to the SAME
// session's spool concurrently and proves every single write survives — no torn line, no lost
// event, no silently-overwritten one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { read as readSpool } from '../spool.mjs';

// A PRIVATE ROOT — this file counts every line in one session's spool file; it must not share a
// root with any sibling test that might touch the same directory tree concurrently under
// run-all.mjs. `spool()`/`append()` is never gated by SPOOL_OFF (only `flush`/`drainAll`'s network
// promotion is — see isolate.mjs's own comment), so this file needs no marker unlinked.
privateRoot('spool-concurrency-test');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived
const SPOOL_MJS_URL = pathToFileURL(path.join(DIR, 'spool.mjs')).href;

// A tiny real driver process — imports spool.mjs itself (so it exercises the EXACT same
// `fs.appendFileSync` call production does, not a re-implementation) and fires COUNT real writes
// as fast as this process can loop, no artificial delay between them, to maximize overlap with
// its siblings.
const DRIVER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-concurrency-driver-')), 'driver.mjs');
fs.writeFileSync(DRIVER, [
  `import { spool } from ${JSON.stringify(SPOOL_MJS_URL)};`,
  'const [, , sid, writerId, count] = process.argv;',
  'for (let i = 0; i < Number(count); i++) {',
  '  const ok = spool(sid, `${writerId}-${i}`, { title: `w${writerId}-c${i}`, body: "b", kind: "observation", dest: "memory" });',
  '  if (!ok) { console.error(`LOST WRITE ${writerId}-${i}`); process.exitCode = 1; }',
  '}',
].join('\n'));

function spawnWriter(sid, writerId, count) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, sid, writerId, String(count)], { env: process.env });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stderr }));
    child.on('error', (e) => resolve({ status: null, stderr: e.message }));
  });
}

console.log('=== concurrent spool.mjs append: N real child processes, same session, no coordination ===');
const SID = randomUUID();
const WRITERS = 6;
const PER_WRITER = 80;
const EXPECTED_TOTAL = WRITERS * PER_WRITER;

// Fire all writers essentially simultaneously — Promise.all, not sequential awaits, is the whole
// point: sequential spawns would never actually race on the file.
const results = await Promise.all(
  Array.from({ length: WRITERS }, (_, w) => spawnWriter(SID, `w${w}`, PER_WRITER))
);

check('every writer process exited 0 (no self-reported lost write)',
  results.every((r) => r.status === 0), JSON.stringify(results));

const folded = readSpool(SID);
eq('read() saw every event line — none torn, none dropped by the concurrent appends', folded.events, EXPECTED_TOTAL);
eq('every write is owed (none synced/failed in this test) and none collapsed into another', folded.owed.length, EXPECTED_TOTAL);

const seen = new Set(folded.owed.map((e) => e.externalId));
eq('no duplicate/collided externalId — the set is exactly as large as the list', seen.size, EXPECTED_TOTAL);

const expectedIds = new Set();
for (let w = 0; w < WRITERS; w++) for (let i = 0; i < PER_WRITER; i++) expectedIds.add(`w${w}-${i}`);
const missing = [...expectedIds].filter((id) => !seen.has(id));
check('every single expected write ID survived — not just the right COUNT', missing.length === 0, `missing: ${missing.slice(0, 10).join(', ')}`);

done();
