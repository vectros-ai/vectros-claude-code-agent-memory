#!/usr/bin/env node
/**
 * THE TRANSCRIPT READER, CHUNKED — equivalence with the whole-file reader it replaced.
 *
 * `readTranscript` used to be `readFileSync(path, 'utf8').split('\n')`, which cannot build a string
 * over ~512 MiB. It now reads in chunks. The contract is that NOTHING ELSE CHANGED, so the strongest
 * test is the old implementation itself, kept below as `reference*`, run against generated
 * transcripts with a deliberately TINY chunk size (down to one byte) so that every boundary the real
 * 8 MiB chunk would hit once in a million lines is hit constantly: a multi-byte character split
 * across two chunks, a line longer than a chunk, a line cut exactly at a chunk edge.
 *
 * The >512 MiB case itself is `transcript-huge-real-test.mjs` (opt-in: it writes a file that size).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs'; // MUST precede any runtime-state path use — see the file header.

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-stream-log-')), 'hooks.log');
process.env.VECTROS_HOOKLOG_PATH = LOG;
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch { /* silence-ok: no log file yet means nothing was logged. */ return []; } };

const {
  readTranscript, transcriptLength, sliceSince, readLinesForward, readLinesBackward, recentMessages, evaluatorMessageText,
} = await import('../transcript.mjs');

// ── THE REFERENCE: the previous implementation, verbatim in behaviour. ───────────────────────────
function referenceRead(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const msgs = [];
  let off = 0;
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    text = (text || '').trim();
    if (!text) continue;
    const start = off;
    off += text.length + 1;
    msgs.push({ t: o.timestamp ? Date.parse(o.timestamp) : 0, text, start, end: off });
  }
  return { msgs, total: off };
}
function referenceSlice(file, fromOffset, maxChars) {
  const { msgs, total } = referenceRead(file);
  const pending = msgs.filter((m) => m.end > fromOffset);
  const picked = [];
  let len = 0;
  for (const m of pending) {
    if (picked.length && len + m.text.length + 1 > maxChars) break;
    picked.push(m);
    len += m.text.length + 1;
  }
  const to = picked.length ? picked[picked.length - 1].end : fromOffset;
  return { text: picked.map((m) => m.text).join('\n'), total, from: fromOffset, to, remaining: Math.max(0, total - to), messages: picked.length };
}
// The evaluator's rendering: the SAME function the worker uses (one definition), so a change to it cannot hide here.
const evalExtract = evaluatorMessageText;
function referenceTail(file, count) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = evalExtract(e);
    if (t) out.push(t);
  }
  return count <= 0 ? [] : out.slice(-count);
}

// ── Fixtures: seeded, so a failure is reproducible. ──────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = ['alpha', 'béta', 'γάμμα', '日本語のテキスト', 'emoji😀😀', 'naïve', 'a\u0301', 'tab\there', 'x'.repeat(40)];
function fixture(seed, { crlf = false, finalNewline = true, partialTail = false, longLine = 0, lines = 90 } = {}) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const text = () => Array.from({ length: 1 + Math.floor(r() * 12) }, () => pick(WORDS)).join(' ');
  const out = [];
  for (let i = 0; i < lines; i++) {
    const k = Math.floor(r() * 10);
    const ts = r() < 0.8 ? { timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() } : {};
    if (k === 0) out.push('');
    else if (k === 1) out.push(JSON.stringify({ type: 'summary', summary: text() }));
    else if (k === 2) out.push(JSON.stringify({ type: 'user', ...ts, message: { role: 'user', content: [{ type: 'tool_result', content: text() }] } }));
    else if (k === 3) out.push(JSON.stringify({ type: 'assistant', ...ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: text() }] } }));
    else if (k === 4) out.push(JSON.stringify({ type: 'user', ...ts, message: { role: 'user', content: '   \n  ' } }));
    else if (k === 5) out.push(JSON.stringify({ type: 'assistant', ...ts, message: { role: 'assistant', content: [{ type: 'text', text: '  ' + text() + '  ' }, { type: 'text', text: text() }] } }));
    else out.push(JSON.stringify({ type: r() < 0.5 ? 'user' : 'assistant', ...ts, message: { content: text() } }));
  }
  if (longLine) out.splice(Math.floor(out.length / 2), 0, JSON.stringify({ type: 'assistant', message: { content: 'L'.repeat(longLine) + ' ünï😀' } }));
  if (partialTail) out.push('{"type":"assistant","message":{"content":"cut off mid-wri');
  const eol = crlf ? '\r\n' : '\n';
  return out.join(eol) + (finalNewline ? eol : '');
}
/**
 * A spy over the three `fs` calls the reader makes. `transcript.mjs` imports the `fs` default export, so
 * replacing the properties on that object is seen by it. `run(fn, { failReadOn, shortReadOn })` records
 * every requested read length, the open/close balance, and can make the Nth read fail or come back empty.
 */
function spied(fn, { failReadOn = 0, shortReadOn = 0, trim = null, appendOn = null } = {}) {
  const real = { readSync: fs.readSync, openSync: fs.openSync, closeSync: fs.closeSync };
  const rec = { reads: [], opens: 0, closes: 0 };
  let n = 0;
  fs.openSync = (...a) => { const fd = real.openSync(...a); rec.opens++; return fd; };
  fs.closeSync = (...a) => { rec.closes++; return real.closeSync(...a); };
  fs.readSync = (fd, buf, off, len, pos) => {
    n++;
    rec.reads.push(len);
    if (appendOn && n === appendOn.on) fs.appendFileSync(appendOn.file, appendOn.data); // the writer is still going
    if (n === failReadOn) { const e = new Error('injected I/O failure'); e.code = 'EIO'; throw e; }
    if (n === shortReadOn) return 0;
    if (trim && n === trim.on) len = Math.min(len, trim.bytes); // fewer bytes than asked, but not EOF
    return real.readSync(fd, buf, off, len, pos);
  };
  let result; let error = null;
  try { result = fn(); } catch (e) { error = e; } finally { Object.assign(fs, real); }
  return { rec, result, error, balanced: rec.opens === rec.closes };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-stream-'));
let n = 0;
const write = (content) => { const f = path.join(dir, `t${n++}.jsonl`); fs.writeFileSync(f, content); return f; };

const CHUNKS = [1, 2, 3, 7, 64, 1000, 4096, undefined];
const SHAPES = [
  ['plain', {}], ['CRLF', { crlf: true }], ['no final newline', { finalNewline: false }],
  ['partial last line', { partialTail: true }], ['partial, no newline', { partialTail: true, finalNewline: false }],
  ['a line longer than a chunk', { longLine: 20_000 }],
];

console.log('=== 1. readTranscript / transcriptLength == the whole-file reader, at every chunk size ===');
{
  let combos = 0; let bad = 0;
  for (const [name, opts] of SHAPES) {
    for (let seed = 1; seed <= 6; seed++) {
      const content = fixture(seed, { ...opts, lines: seed === 1 ? 14 : 90 }); // seed 1 is small enough for 1-byte chunks
      const f = write(content);
      const ref = referenceRead(f);
      for (const chunkBytes of CHUNKS) {
        if (chunkBytes === 1 && seed !== 1) continue;
        combos++;
        const got = readTranscript(f, { chunkBytes });
        if (JSON.stringify(got) !== JSON.stringify(ref)) { bad++; console.log(`  MISMATCH ${name} seed=${seed} chunk=${chunkBytes}`); }
        const lean = readTranscript(f, { chunkBytes, retain: false });
        if (lean.total !== ref.total || lean.msgs.length !== 0) { bad++; console.log(`  retain:false MISMATCH ${name} seed=${seed} chunk=${chunkBytes}`); }
      }
      if (transcriptLength(f) !== ref.total) { bad++; console.log(`  transcriptLength MISMATCH ${name} seed=${seed}`); }
    }
  }
  eq(`${combos} (shape x seed x chunk size) combinations are identical to the whole-file reader`, bad, 0);
  check('the fixtures really contain messages (a comparison of two empty results proves nothing)', referenceRead(write(fixture(2))).msgs.length > 20);
  check('...including multi-byte text, so chunk boundaries really can split a character', referenceRead(write(fixture(2))).msgs.some((m) => /[日γ😀]/u.test(m.text)));
}

console.log('\n=== 2. readLinesForward: the same lines as split(\'\\n\'), nothing split mid-character ===');
{
  const emoji = '{"k":"😀日本語é"}';
  for (const chunkBytes of [1, 2, 3, 4, 5, 64]) {
    const f = write(`${emoji}\n${emoji}\n`);
    eq(`chunk=${chunkBytes}: two lines of multi-byte text, each whole`, [...readLinesForward(f, { chunkBytes })], [emoji, emoji]);
  }
  eq('an empty file yields no lines', [...readLinesForward(write(''))], []);
  eq('a lone newline yields one empty line, as split does', [...readLinesForward(write('\n'))], ['']);
  eq('no trailing newline: the last line is still produced', [...readLinesForward(write('a\nb'), { chunkBytes: 1 })], ['a', 'b']);
  eq('blank lines in the middle are preserved (the parser skips them)', [...readLinesForward(write('a\n\nb\n'), { chunkBytes: 2 })], ['a', '', 'b']);
  const long = 'q'.repeat(50_000);
  eq('a line 50x the chunk size comes out intact', [...readLinesForward(write(`${long}\nz\n`), { chunkBytes: 1000 })], [long, 'z']);
  const f = write(fixture(3, { lines: 60 }));
  const ref = fs.readFileSync(f, 'utf8').split('\n'); if (ref[ref.length - 1] === '') ref.pop();
  eq('a generated transcript: identical line sequence', [...readLinesForward(f, { chunkBytes: 7 })], ref);
}

console.log('\n=== 3. readLinesBackward: the non-empty lines, last first ===');
{
  for (const [name, opts] of SHAPES) {
    const f = write(fixture(4, { ...opts, lines: 30 }));
    const fwd = [...readLinesForward(f)].filter(Boolean);
    for (const blockBytes of [1, 2, 3, 7, 64, 4096, undefined]) {
      eq(`${name}, block=${blockBytes}: the forward lines reversed`, [...readLinesBackward(f, { blockBytes })], [...fwd].reverse());
    }
  }
  eq('an empty file yields nothing', [...readLinesBackward(write(''))], []);
  eq('one line, no newline', [...readLinesBackward(write('only'), { blockBytes: 1 })], ['only']);
  eq('multi-byte text is decoded whole whatever the block size', [...readLinesBackward(write('😀日本\né\n'), { blockBytes: 1 })], ['é', '😀日本']);
}

console.log('\n=== 4. sliceSince windows == the whole-file reader ===');
{
  let bad = 0; let combos = 0;
  for (const [name, opts] of SHAPES) {
    const f = write(fixture(5, { ...opts, lines: 80 }));
    const total = referenceRead(f).total;
    for (const from of [0, 1, Math.floor(total / 3), Math.floor(total / 2), total - 5, total, total + 1000]) {
      for (const maxChars of [1, 50, 500, 100_000_000]) {
        combos++;
        if (JSON.stringify(sliceSince(f, from, maxChars)) !== JSON.stringify(referenceSlice(f, from, maxChars))) { bad++; console.log(`  MISMATCH ${name} from=${from} max=${maxChars}`); }
      }
    }
  }
  eq(`${combos} (offset x window) combinations are identical`, bad, 0);
  const f = write(fixture(5, { lines: 80 }));
  const total = referenceRead(f).total;
  const w = sliceSince(f, 0, 200);
  check('a window is smaller than the whole (the cap really bites), and `remaining` says more is owed', w.to < total && w.remaining === total - w.to && w.remaining > 0);
}

console.log('\n=== 5. recentMessages == the last N of the whole-file reader ===');
{
  let bad = 0; let combos = 0;
  for (const [name, opts] of SHAPES) {
    const f = write(fixture(6, { ...opts, lines: 100 }));
    for (const count of [0, 1, 5, 30, 10_000]) {
      for (const blockBytes of [1, 3, 64, 4096, undefined]) {
        if (blockBytes === 1 && count > 5) continue;
        combos++;
        if (JSON.stringify(recentMessages(f, count, evalExtract, { blockBytes })) !== JSON.stringify(referenceTail(f, count))) { bad++; console.log(`  MISMATCH ${name} count=${count} block=${blockBytes}`); }
      }
    }
  }
  eq(`${combos} (count x block size) combinations are identical`, bad, 0);
  check('it stops reading once it has enough (a count of 1 reads far less than the file)', (() => {
    const big = write(Array.from({ length: 5000 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `message ${i}` } })).join('\n') + '\n');
    let lines = 0;
    const orig = recentMessages(big, 1, (e) => { lines++; return evalExtract(e); }, { blockBytes: 256 });
    return orig[0] === 'USER: message 4999' && lines < 50;
  })());
}

console.log('\n=== 6. failure behaviour is unchanged ===');
{
  const missing = path.join(dir, 'does-not-exist.jsonl');
  const before = logLines().length;
  eq('a missing file reads as empty, as before', readTranscript(missing), { msgs: [], total: 0 });
  eq('...and a missing file is quiet (a session before its first flush)', logLines().length, before);
  eq('transcriptLength of a missing file is 0', transcriptLength(missing), 0);
  eq('the line iterators throw the I/O error (lazily), they do not swallow it',
    (() => { try { [...readLinesForward(missing)]; return 'no throw'; } catch (e) { return e.code; } })(), 'ENOENT');
  eq('recentMessages throws on a missing file (the caller decides what to log)',
    (() => { try { recentMessages(missing, 3, evalExtract); return 'no throw'; } catch (e) { return e.code; } })(), 'ENOENT');
  // A directory is not a transcript: some other I/O error, which must ANNOUNCE itself.
  const r = readTranscript(dir);
  eq('an unreadable path reads as empty', r, { msgs: [], total: 0 });
  check('...and logs READ FAILED, naming the cause', logLines().slice(before).some((l) => /transcript\s+READ FAILED \((EISDIR|EPERM|EACCES|EBADF)\)/.test(l)), logLines().slice(before).join(' | '));
}

console.log('\n=== 6b. the size options really reach the reads (a byte-counting spy) ===');
{
  const f = write(fixture(7, { lines: 120 }));
  const size = fs.statSync(f).size;
  const a = spied(() => readTranscript(f, { chunkBytes: 64 }));
  check(`readTranscript({ chunkBytes: 64 }) requests reads of at most 64 bytes (it is not silently an 8 MiB read)`, a.rec.reads.length > 0 && Math.max(...a.rec.reads) <= 64, `max=${Math.max(...a.rec.reads)}`);
  check(`...and takes at least size/64 of them (${a.rec.reads.length} reads for ${size} bytes)`, a.rec.reads.length >= Math.floor(size / 64));
  eq('...and closes its descriptor', a.balanced, true);
  const big = write(Array.from({ length: 6000 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `message number ${i}` } })).join('\n') + '\n');
  const bigSize = fs.statSync(big).size;
  const b = spied(() => recentMessages(big, 1, evalExtract, { blockBytes: 256 }));
  eq('recentMessages finds the newest message', b.result, ['USER: message number 5999']);
  const requested = b.rec.reads.reduce((x, y) => x + y, 0);
  check(`...having requested ${requested} bytes of a ${bigSize}-byte file (it read from the end and stopped)`, requested <= 256 * 4, String(requested));
  eq('...and closed its descriptor on the early exit', b.balanced, true);
  const c = spied(() => recentMessages(big, 5, evalExtract, { blockBytes: 1 << 30 }));
  check('with a huge block size it still never asks for more than the file holds', Math.max(...c.rec.reads) <= bigSize);
  // A size of zero would read nothing, forever: it is clamped.
  eq('chunkBytes: 0 is clamped, not an empty (or endless) read', [...readLinesForward(write('a\nb\n'), { chunkBytes: 0 })], ['a', 'b']);
  eq('blockBytes: 0 is clamped too', [...readLinesBackward(write('a\nb\n'), { blockBytes: 0 })], ['b', 'a']);
  eq('a non-numeric size falls back to the default', [...readLinesForward(write('a\n'), { chunkBytes: 'big' })], ['a']);
  const lean = readTranscript(f, { since: 10 });
  const full = referenceRead(f);
  eq('`since` keeps only the messages ending after the offset, and the total is unchanged', [lean.msgs.map((m) => m.end), lean.total], [full.msgs.filter((m) => m.end > 10).map((m) => m.end), full.total]);
}

console.log('\n=== 6c. a line that is not a transcript entry throws, exactly as the whole-file reader did ===');
{
  for (const [name, bad] of [['a JSON `null` line', 'null'], ['a null element inside a content array', JSON.stringify({ type: 'user', message: { content: [null] } })]]) {
    const f = write(`${JSON.stringify({ type: 'user', message: { content: 'fine' } })}\n${bad}\n${JSON.stringify({ type: 'user', message: { content: 'after' } })}\n`);
    let ref = 'no throw'; try { referenceRead(f); } catch (e) { ref = e.name; }
    const got = spied(() => readTranscript(f));
    eq(`${name}: the reference throws`, ref, 'TypeError');
    eq(`${name}: readTranscript throws the same, instead of reporting a read failure and total 0`, got.error?.name, 'TypeError');
    eq(`${name}: ...and its descriptor is closed`, got.balanced, true);
  }
  const before = logLines().length;
  const f = write(`${JSON.stringify({ type: 'user', message: { content: [null] } })}\n`);
  try { readTranscript(f); } catch { /* silence-ok: the throw is the behaviour under test and is asserted above. */ }
  eq('...and it is not mislabelled as an I/O failure in the log', logLines().slice(before).some((l) => /READ FAILED/.test(l)), false);
}

console.log('\n=== 6d. an I/O error part-way through reads as empty (all or nothing), and nothing leaks ===');
{
  const f = write(fixture(8, { lines: 200 }));
  const before = logLines().length;
  const r = spied(() => readTranscript(f, { chunkBytes: 256 }), { failReadOn: 3 });
  eq('after two good chunks, a failing read yields an EMPTY result, not a partial one', r.result, { msgs: [], total: 0 });
  check('...and logs READ FAILED with the cause', logLines().slice(before).some((l) => /transcript\s+READ FAILED \(EIO\)/.test(l)), logLines().slice(before).join(' | '));
  eq('...and the descriptor was closed', r.balanced, true);
  const g = spied(() => { const it = readLinesForward(f, { chunkBytes: 64 }); it.next(); it.return(); return 'stopped'; });
  eq('abandoning the iterator early closes the descriptor', [g.result, g.balanced], ['stopped', true]);
  const h = spied(() => recentMessages(f, 3, () => { throw new Error('extract failed'); }, { blockBytes: 64 }));
  eq('an extractor that throws propagates, and the descriptor is closed', [h.error?.message, h.balanced], ['extract failed', true]);
  const back = spied(() => [...readLinesBackward(f, { blockBytes: 64 })], { failReadOn: 2 });
  eq('a read failure in the backward reader propagates, and the descriptor is closed', [back.error?.code, back.balanced], ['EIO', true]);
}

console.log('\n=== 6e. malformed bytes: the chunked decoder agrees with the whole-file decoder ===');
{
  const lineA = Buffer.from('{"type":"user","message":{"content":"before"}}\n');
  const pieces = [
    Buffer.from([0xef, 0xbb, 0xbf]),                 // a byte-order mark at the start of the file
    lineA,
    Buffer.from('{"type":"user","message":{"content":"bad ', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from(' bytes é"}}\n', 'utf8'),
    Buffer.from('{"type":"user","message":{"content":"cut ', 'utf8'), Buffer.from([0xe2, 0x82]), Buffer.from('\n', 'utf8'), // a truncated 3-byte sequence, then a newline
    Buffer.from('{"type":"assistant","message":{"content":"ok 😀"}}\n', 'utf8'),
    Buffer.from('{"type":"user","message":{"content":"tail ', 'utf8'), Buffer.from([0xf0, 0x9f]),   // a truncated sequence at END OF FILE
  ];
  const f = write(Buffer.concat(pieces));
  const ref = fs.readFileSync(f, 'utf8').split('\n');
  let bad = 0;
  for (const chunkBytes of [1, 2, 3, 4, 5, 7, 16, 64, undefined]) {
    const got = [...readLinesForward(f, { chunkBytes })];
    const want = ref[ref.length - 1] === '' ? ref.slice(0, -1) : ref;
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`  line MISMATCH chunk=${chunkBytes}`); }
    if (JSON.stringify(readTranscript(f, { chunkBytes })) !== JSON.stringify(referenceRead(f))) { bad++; console.log(`  readTranscript MISMATCH chunk=${chunkBytes}`); }
  }
  eq('a BOM, invalid bytes, and truncated sequences (mid-file and at end of file) decode identically at every chunk size', bad, 0);
  check('(the fixture really contains replacement characters, so the comparison is not between two clean files)', ref.join('\n').includes('\uFFFD'));
}

console.log('\n=== 6f. readLinesBackward edge cases, and a file that shrinks while it is read ===');
{
  eq('trailing blank lines are skipped', [...readLinesBackward(write('a\nb\n\n\n'), { blockBytes: 2 })], ['b', 'a']);
  eq('a file of only newlines yields nothing', [...readLinesBackward(write('\n\n\n'), { blockBytes: 1 })], []);
  eq('a blank line in the middle is skipped', [...readLinesBackward(write('a\n\nb'), { blockBytes: 1 })], ['b', 'a']);
  eq('a newline exactly on a block edge', [...readLinesBackward(write('abcd\nefgh\n'), { blockBytes: 5 })], ['efgh', 'abcd']);
  const originals = ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC', 'DDDDDDDDDD'];
  const f = write(originals.join('\n') + '\n');
  const r = spied(() => [...readLinesBackward(f, { blockBytes: 7 })], { shortReadOn: 3 });
  check('when a read comes back short (the file shrank), no line is a splice of two fragments',
    r.error === null && r.result.every((l) => originals.includes(l)), JSON.stringify(r.result));
  eq('...and the descriptor is closed', r.balanced, true);
}

console.log('\n=== 6g. a file that GROWS during a forward read; a forward short read ===');
{
  const msg = (text) => JSON.stringify({ type: 'user', message: { content: text } });
  const base = [msg('first message here'), msg('second message here'), msg('third message here')].join('\n') + '\n';
  const f = write(base);
  // Between the first and second read the writer appends one complete message and the start of another.
  const grown = spied(() => readTranscript(f, { chunkBytes: 100 }), { appendOn: { on: 2, file: f, data: `${msg('appended while reading')}\n{"type":"user","message":{"content":"half writ` } });
  eq('a message appended mid-read is seen (the read goes to EOF)', grown.result.msgs.map((m) => m.text), ['first message here', 'second message here', 'third message here', 'appended while reading']);
  eq('...the partial last line is skipped, and the offsets stay consistent with the messages', grown.result.total, grown.result.msgs[grown.result.msgs.length - 1].end);
  eq('...and the descriptor is closed', grown.balanced, true);

  // A read that returns fewer bytes than asked, mid-file (not EOF): the reader must keep going.
  const g = write(fixture(9, { lines: 60 }));
  const want = referenceRead(g);
  const short = spied(() => readTranscript(g, { chunkBytes: 64 }), { trim: { on: 2, bytes: 3 } });
  eq('a short forward read (3 bytes where 64 were asked) loses nothing: identical to the whole-file reader', JSON.stringify(short.result), JSON.stringify(want));
  const shortLines = spied(() => [...readLinesForward(g, { chunkBytes: 64 })], { trim: { on: 3, bytes: 1 } });
  eq('...and the line sequence is identical too', shortLines.result, (() => { const r = fs.readFileSync(g, 'utf8').split('\n'); if (r[r.length - 1] === '') r.pop(); return r; })());
}

console.log('\n=== 6h. the size option is not reachable from the callers; a window keeps only a window ===');
{
  const f = write(fixture(10, { lines: 80 }));
  const size = fs.statSync(f).size;
  const a = spied(() => transcriptLength(f, { chunkBytes: 4 }));
  check('transcriptLength ignores a chunk size passed to it (its reads are file-sized, not 4 bytes)', Math.min(...a.rec.reads) > 4 && Math.max(...a.rec.reads) <= size, a.rec.reads.slice(0, 3).join(','));
  const b = spied(() => sliceSince(f, 0, 100, { chunkBytes: 4 }));
  check('sliceSince ignores it too', Math.min(...b.rec.reads) > 4, b.rec.reads.slice(0, 3).join(','));

  // `keepChars`: the window's messages are kept, the rest are only counted.
  const full = referenceRead(f);
  for (const keepChars of [1, 50, 400, 100_000_000]) {
    const r = readTranscript(f, { since: 0, keepChars });
    const kept = r.msgs.reduce((n, m) => n + m.text.length + 1, 0);
    check(`keepChars=${keepChars}: total is unchanged (${r.total})`, r.total === full.total);
    check(`keepChars=${keepChars}: kept ${r.msgs.length} message(s), ${kept} chars: within the window (or one oversize message)`, kept <= keepChars || r.msgs.length === 1, String(kept));
    check(`keepChars=${keepChars}: what is kept is the START of the window, in order`, JSON.stringify(r.msgs) === JSON.stringify(full.msgs.slice(0, r.msgs.length)));
  }
  check('a small window really does keep far fewer messages than there are (the bound bites)', readTranscript(f, { since: 0, keepChars: 200 }).msgs.length < full.msgs.length / 4);

  // F1: what the real caller retains. `sliceSince` passes the window size to `readTranscript`; that is
  // invisible in its output (identical with or without it), so count the message objects that were ever
  // built and stored (each one is pushed once, into the reader's list) while it runs.
  const retainedThrough = (fn) => {
    const seen = new Set(); const realPush = Array.prototype.push;
    Array.prototype.push = function (...items) {
      for (const it of items) if (it && typeof it === 'object' && 'text' in it && 'start' in it && 'end' in it) seen.add(it);
      return realPush.apply(this, items);
    };
    let result;
    try { result = fn(); } finally { Array.prototype.push = realPush; }
    return { seen: seen.size, result };
  };
  const wf = write(fixture(12, { lines: 120 }));
  const everyMessage = referenceRead(wf).msgs.length;
  check(`the fixture has plenty of messages to retain (${everyMessage})`, everyMessage > 40);
  for (const [from, maxChars] of [[0, 120], [0, 600], [Math.floor(referenceRead(wf).total / 2), 300]]) {
    const r = retainedThrough(() => sliceSince(wf, from, maxChars));
    const after = referenceRead(wf).msgs.filter((m) => m.end > from).length;
    eq(`sliceSince(from=${from}, max=${maxChars}) retains exactly the ${r.result.messages} message(s) of its window`, r.seen, r.result.messages);
    check(`...and not the ${after} pending ones (the bound reaches the reader)`, r.seen < after / 3, `${r.seen} of ${after}`);
  }
}

console.log('\n=== 6i. the window rule at its exact boundaries: maxChars = sum, sum-1, sum+1 ===');
{
  const f = write(fixture(13, { lines: 100 }));
  const ref = referenceRead(f);
  const msgs = ref.msgs;
  check(`the fixture has enough messages (${msgs.length})`, msgs.length > 25);
  let bad = 0; let combos = 0;
  for (const j of [0, 3, Math.floor(msgs.length / 2)]) {
    const from = j === 0 ? 0 : msgs[j - 1].end; // a window that starts at a message boundary
    for (let k = j; k < Math.min(msgs.length, j + 12); k++) {
      const sum = msgs[k].end - from; // the cumulative len+1 of messages j..k
      for (const maxChars of [sum - 1, sum, sum + 1]) {
        if (maxChars < 1) continue;
        combos++;
        const got = sliceSince(f, from, maxChars);
        const want = referenceSlice(f, from, maxChars);
        if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`  MISMATCH from=${from} k=${k} max=${maxChars}`); }
      }
    }
  }
  eq(`${combos} exact-fill windows are identical to the whole-file reader`, bad, 0);
  // The meaning, stated directly: a window of exactly the first three messages' length takes exactly three
  // (the message that fills it to the character fits), one character less takes two, one more still three.
  const from = 0; const three = msgs[2].end;
  eq('max == sum of the first three: three messages', sliceSince(f, from, three).messages, 3);
  eq('max == sum - 1: two messages', sliceSince(f, from, three - 1).messages, 2);
  eq('max == sum + 1: still three', sliceSince(f, from, three + 1).messages, 3);
  const r = readTranscript(f, { since: from, keepChars: three });
  eq('readTranscript keeps the same three at the exact fit', r.msgs.length, 3);
  eq('...and two when the window is one character short', readTranscript(f, { since: from, keepChars: three - 1 }).msgs.length, 2);
  // N4: the read buffer is never larger than the file (an 8 MiB buffer for a 50-byte file is waste on every call)
  const tiny = write('{"type":"user","message":{"content":"hi"}}\n');
  const tinySize = fs.statSync(tiny).size;
  const sp = spied(() => [...readLinesForward(tiny)]);
  check(`a ${tinySize}-byte file is read with a buffer of at most ${tinySize} bytes (asked for ${sp.rec.reads[0]})`, sp.rec.reads.length > 0 && Math.max(...sp.rec.reads) <= tinySize, sp.rec.reads.join(','));
}

console.log('\n=== 6j. the chunked readers make no whole-file read of the transcript (a guard on the common fs entry points) ===');
{
  // The textual census in section 7 can be fooled by an alias. This is a runtime guard: while it is
  // installed, reading the transcript through `readFileSync` (by path, URL, Buffer, or an open
  // descriptor), `readFile`, `fs.promises.readFile` or `createReadStream` throws AND is recorded in a file, so
  // a catch that swallows the error or logs only its message cannot hide it. It does not cover every
  // conceivable way to read a file (a `FileHandle`, say); it covers the ones a regression would reach for.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-guard-home-'));
  const guardFile = path.join(home, 'guard.cjs');
  fs.writeFileSync(guardFile, String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { syncBuiltinESMExports } = require('module');
const norm = (p) => {
  try {
    if (p instanceof URL) return path.resolve(fileURLToPath(p));
    if (typeof p === 'string' || Buffer.isBuffer(p)) return path.resolve(String(p));
  } catch { /* not a path */ }
  return null;
};
const target = () => (process.env.TRANSCRIPT_GUARD_PATH ? path.resolve(process.env.TRANSCRIPT_GUARD_PATH) : null);
const hit = (p) => { const g = target(); return !!g && norm(p) === g; };
const note = (file, line) => { if (file) fs.appendFileSync(file, line + '\n'); };
const block = (api) => {
  note(process.env.TRANSCRIPT_BLOCKED, api);
  const e = new Error('whole-file read of the guarded transcript (' + api + ')');
  e.code = 'EGUARD';
  return e;
};
const orig = {
  readFileSync: fs.readFileSync, readFile: fs.readFile, createReadStream: fs.createReadStream, openSync: fs.openSync,
  closeSync: fs.closeSync, promisesReadFile: fs.promises.readFile,
};
const fds = new Set();
fs.openSync = function (p, ...a) {
  const fd = orig.openSync.call(this, p, ...a);
  if (hit(p)) { fds.add(fd); note(process.env.TRANSCRIPT_TRACE, 'open'); }
  return fd;
};
fs.closeSync = function (fd, ...a) { fds.delete(fd); return orig.closeSync.call(this, fd, ...a); };
fs.readFileSync = function (p, ...a) {
  if (hit(p) || (typeof p === 'number' && fds.has(p))) throw block('readFileSync');
  return orig.readFileSync.call(this, p, ...a);
};
fs.readFile = function (p, ...a) {
  if (hit(p) || (typeof p === 'number' && fds.has(p))) throw block('readFile');
  return orig.readFile.call(this, p, ...a);
};
fs.createReadStream = function (p, ...a) {
  if (hit(p)) throw block('createReadStream');
  return orig.createReadStream.call(this, p, ...a);
};
fs.promises.readFile = function (p, ...a) {
  if (hit(p)) return Promise.reject(block('promises.readFile'));
  return orig.promisesReadFile.call(this, p, ...a);
};
syncBuiltinESMExports();
module.exports.uninstall = () => {
  fs.readFileSync = orig.readFileSync; fs.readFile = orig.readFile; fs.createReadStream = orig.createReadStream;
  fs.openSync = orig.openSync; fs.closeSync = orig.closeSync; fs.promises.readFile = orig.promisesReadFile;
  syncBuiltinESMExports();
};
`);
  const blockedFile = (name) => path.join(home, `blocked-${name}.txt`);
  const countLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

  // ── in this process
  const f = write(fixture(11, { lines: 90 }));
  const expected = referenceRead(f);
  const inBlocked = blockedFile('inproc'); const inTrace = path.join(home, 'trace-inproc.txt');
  process.env.TRANSCRIPT_GUARD_PATH = f; process.env.TRANSCRIPT_BLOCKED = inBlocked; process.env.TRANSCRIPT_TRACE = inTrace;
  const guard = createRequire(import.meta.url)(guardFile);
  let out; const fires = {};
  try {
    // self-test first: the guard really stops each way of reading the whole file, and leaves other files alone
    const trip = (name, fn) => { try { fn(); fires[name] = false; } catch (e) { fires[name] = e.code === 'EGUARD'; } };
    trip('readFileSync(path)', () => fs.readFileSync(f, 'utf8'));
    trip('readFileSync(URL)', () => fs.readFileSync(pathToFileURL(f), 'utf8'));
    trip('readFileSync(Buffer)', () => fs.readFileSync(Buffer.from(f), 'utf8'));
    const fd = fs.openSync(f, 'r');
    trip('readFileSync(fd)', () => fs.readFileSync(fd, 'utf8'));
    fs.closeSync(fd);
    trip('createReadStream', () => fs.createReadStream(f));
    trip('readFile', () => fs.readFile(f, () => {}));
    const tripAsync = async (name, fn) => { try { await fn(); fires[name] = false; } catch (e) { fires[name] = e.code === 'EGUARD'; } };
    await tripAsync('promises.readFile', () => fs.promises.readFile(f));
    // the same reads through ES module namespaces, which is how a module with a named import reaches them
    const nsFs = await import('node:fs');
    const nsPromises = await import('node:fs/promises');
    trip('import * from node:fs: readFileSync', () => nsFs.readFileSync(f, 'utf8'));
    await tripAsync('import * from node:fs/promises: readFile', () => nsPromises.readFile(f));
    for (const [name, fired] of Object.entries(fires)) check(`self-test: the guard stops ${name}`, fired);
    // ...and each one was RECORDED, not just thrown: `blocked == 0` below means something only if this holds
    eq(`self-test: the guard recorded one attempt per entry point it stopped (${Object.keys(fires).length})`, countLines(inBlocked), Object.keys(fires).length);
    check('self-test: a read of another file is untouched', fs.readFileSync(guardFile, 'utf8').length > 100);
    fs.rmSync(inBlocked, { force: true }); fs.rmSync(inTrace, { force: true });

    out = {
      len: transcriptLength(f), slice: sliceSince(f, 0, 100_000), full: readTranscript(f), tail: recentMessages(f, 5, evalExtract),
    };
  } finally { guard.uninstall(); delete process.env.TRANSCRIPT_GUARD_PATH; delete process.env.TRANSCRIPT_BLOCKED; delete process.env.TRANSCRIPT_TRACE; }
  eq('transcriptLength, sliceSince, readTranscript and recentMessages all work with whole-file reads forbidden', [out.len, out.slice.total, out.full.total, out.tail.length], [expected.total, expected.total, expected.total, 5]);
  eq('...and not one forbidden read was even attempted (recorded in a file, so a swallowed error cannot hide it)', countLines(inBlocked), 0);
  check('...and the readers did open the transcript (so the checks above are not vacuous)', countLines(inTrace) >= 4, String(countLines(inTrace)));

  // ── through the real processes (the same guard, preloaded)
  fs.writeFileSync(path.join(home, 'WORKERS_OFF'), 'test\n');
  fs.writeFileSync(path.join(home, 'SPOOL_OFF'), 'test\n');
  fs.writeFileSync(path.join(home, 'MEMORY.md'), '# test\n');
  const tfile = path.join(home, 't.jsonl');
  fs.writeFileSync(tfile, Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content: `message number ${i} with enough text to matter for the evaluator` } })).join('\n') + '\n');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runGuarded = (script, args, input) => {
    const name = path.basename(script);
    const trace = path.join(home, `trace-${name}.txt`);
    const log = path.join(home, `log-${name}.txt`);
    const blocked = blockedFile(name);
    const r = spawnSync(process.execPath, ['--require', guardFile, path.join(SRC, script), ...args], {
      input, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, TRANSCRIPT_GUARD_PATH: tfile, TRANSCRIPT_TRACE: trace, TRANSCRIPT_BLOCKED: blocked, VECTROS_MEMORY_HOME: home, VECTROS_MEMORY_INDEX: path.join(home, 'MEMORY.md'),
        VECTROS_HOOKLOG_PATH: log, VECTROS_API_KEY: 'stub-key', VECTROS_API_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_BIN: path.join(home, 'no-claude.exe'),
        VECTROS_MEM_REAP_OFF: '1', VECTROS_MEM_ORPHAN_CAP_OFF: '1', VECTROS_RECALL_EVAL: '', VECTROS_MEMORY_OFF: '', CLAUDE_PROJECT_DIR: '' },
    });
    const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return { status: r.status, opens: countLines(trace), blocked: countLines(blocked), logText };
  };
  const GUARD_MSG = /EGUARD|whole-file read of the guarded/;
  const cap = runGuarded('capture.mjs', [], JSON.stringify({ session_id: 'abcdef12-0000-0000-0000-000000000001', hook_event_name: 'Stop', cwd: home, transcript_path: tfile }));
  eq('capture.mjs (the Stop-hook gate) exits 0', cap.status, 0);
  check('...and opened the transcript (so the next checks are not vacuous)', cap.opens >= 1, String(cap.opens));
  eq('...and attempted no forbidden read of it (recorded in a file)', cap.blocked, 0);
  check('...and its log carries no guard message', !GUARD_MSG.test(cap.logText), cap.logText);
  const wk = runGuarded('recall-eval-worker.mjs', ['abcdef12-0000-0000-0000-000000000002', tfile]);
  eq('recall-eval-worker.mjs exits 0', wk.status, 0);
  check('...and opened the transcript', wk.opens >= 1, String(wk.opens));
  eq('...and attempted no forbidden read of it', wk.blocked, 0);
  check('...and its log carries no guard message', !GUARD_MSG.test(wk.logText), wk.logText);
  // capture.mjs starts a detached projector that may still be writing into `home`; removing the directory
  // can then fail on Windows. It is a temp directory, so retry briefly and never fail the run over it.
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* silence-ok: a temp directory a background process is still using; the OS temp cleaner removes it. */ }
}

console.log('\n=== 7. no other module reads a transcript whole ===');
{
  // The chunked reader only helps if nothing else reintroduces a whole-file read of a transcript.
  // A textual census of the runtime sources is a TRIPWIRE only (an alias such as `file` or `tp` would pass it);
  // section 6j adds a runtime guard that an alias does not defeat. What it proves is bounded: it matches the
  // exact resolved path string, so a different spelling of it (realpath, an 8.3 short name, different case, a
  // symlinked temp directory) evades it, and a `readSync` of a descriptor sized to the file, a
  // `fs.promises.open().readFile()` and `openAsBlob` are not covered at all.
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // A whole-file read whose argument is a transcript: by name (`transcriptPath`) or, in the two modules that
  // take a transcript path as a bare `p` (the worker's tail reader and the reader itself), by that name.
  const WHOLE_READ = /readFileSync\(\s*(?:[^)]*ranscript|p\b)/i;
  const NAMED_READ = /readFileSync\([^)]*ranscript/i;
  const BARE_P_FILES = new Set(['recall-eval-worker.mjs', 'transcript.mjs']); // where `p` IS the transcript path
  const offenders = [];
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.mjs'))) {
    fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if ((BARE_P_FILES.has(f) ? WHOLE_READ : NAMED_READ).test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  eq('no runtime module calls readFileSync on a transcript path', offenders, []);
  eq('self-test: the census flags a whole-file transcript read by name', WHOLE_READ.test("const raw = fs.readFileSync(transcriptPath, 'utf8');"), true);
  eq('self-test: ...and the worker\'s old `readFileSync(p, ...)` shape', WHOLE_READ.test("try { raw = fs.readFileSync(p, 'utf8'); }"), true);
  eq('self-test: ...and leaves an unrelated read alone', WHOLE_READ.test("fs.readFileSync(queuePath(sid), 'utf8')"), false);
}

fs.rmSync(dir, { recursive: true, force: true });
done();
