#!/usr/bin/env node
/**
 * A TRANSCRIPT OVER V8'S MAXIMUM STRING LENGTH (~512 MiB) IS STILL READABLE.
 *
 * Opt-in (`npm test -- --all` or `VECTROS_MEM_TEST_ALL=1`): it writes a file of about 536 MiB into
 * the OS temp directory, reads it, and deletes it. It is not in the default run for that reason, not
 * because it is flaky. Do not enable it in a CI job that runs on every push: it writes and re-reads the
 * file several times. The file is almost entirely tool-result filler with a handful of real messages,
 * which is what a long session looks like (message text is a few percent of the bytes).
 *
 * NAMED LIMIT: the cleanup is a `finally`, so a process killed outright (SIGKILL, a CI timeout) leaves
 * the file behind in the temp directory, named by pid and time.
 *
 * THE CONTROL COMES FIRST: it proves the file really is over the limit by showing that the old way of
 * reading it, `readFileSync(path, 'utf8')`, throws `ERR_STRING_TOO_LONG` on it. Without that, a pass
 * below would only show the reader works on a big file that the old reader may also have handled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs'; // MUST precede any runtime-state path use — see the file header.

const FILE = path.join(os.tmpdir(), `transcript-huge-${process.pid}-${Date.now()}.jsonl`);
process.env.VECTROS_HOOKLOG_PATH = path.join(os.tmpdir(), `transcript-huge-log-${process.pid}.log`);
const { readTranscript, transcriptLength, sliceSince, recentMessages } = await import('../transcript.mjs');

const message = (type, text) => JSON.stringify({ type, timestamp: '2026-10-02T12:00:00.000Z', message: { role: type, content: [{ type: 'text', text }] } }) + '\n';
const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(1024 * 1024) }] } }) + '\n';
const TARGET = bufferConstants.MAX_STRING_LENGTH + 24 * 1024 * 1024; // comfortably over the limit

const real = [
  message('user', 'first message'),
  message('assistant', 'second message with multi-byte text: é 日本語 😀'),
  message('user', 'the second to last message'),
  message('assistant', 'the LAST message'),
];
const texts = ['first message', 'second message with multi-byte text: é 日本語 😀', 'the second to last message', 'the LAST message'];
const expectedTotal = texts.reduce((n, t) => n + t.length + 1, 0);

try {
  console.log(`=== writing ${(TARGET / 1048576).toFixed(0)} MiB to ${FILE} ===`);
  const fd = fs.openSync(FILE, 'w');
  let written = 0;
  const w = (s) => { const b = Buffer.from(s); fs.writeSync(fd, b); written += b.length; };
  w(real[0]); w(real[1]);
  while (written < TARGET) w(filler);
  w(real[2]); w(real[3]); // the newest messages are adjacent, at the END, as in a live session
  fs.closeSync(fd);
  const size = fs.statSync(FILE).size;
  console.log(`  ${(size / 1048576).toFixed(0)} MiB, V8 limit ${(bufferConstants.MAX_STRING_LENGTH / 1048576).toFixed(0)} MiB`);

  console.log('\n=== CONTROL: the old whole-file read fails on this file ===');
  let oldCode = 'no error';
  try { fs.readFileSync(FILE, 'utf8'); } catch (e) { oldCode = e.code; }
  eq('readFileSync(file, \'utf8\') throws ERR_STRING_TOO_LONG', oldCode, 'ERR_STRING_TOO_LONG');

  console.log('\n=== the chunked reader handles it ===');
  const t0 = Date.now();
  const total = transcriptLength(FILE);
  console.log(`  transcriptLength took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  eq('transcriptLength is the real text length, not 0', total, expectedTotal);
  const r = readTranscript(FILE);
  eq('readTranscript finds all four messages, in order, with the right offsets', r.msgs.map((m) => [m.text, m.start]), (() => { let o = 0; return texts.map((t) => { const x = [t, o]; o += t.length + 1; return x; }); })());
  const w1 = sliceSince(FILE, 0, 1_000_000);
  eq('sliceSince returns the whole text from offset 0', [w1.text, w1.to, w1.remaining, w1.messages], [texts.join('\n'), expectedTotal, 0, 4]);
  const w2 = sliceSince(FILE, texts[0].length + 1 + texts[1].length + 1, 1_000_000);
  eq('sliceSince from a stored watermark returns only what follows it', w2.text, `${texts[2]}\n${texts[3]}`);
  eq('...and a window smaller than one message still returns one whole message', sliceSince(FILE, 0, 1).text, texts[0]);

  console.log('\n=== the evaluator\'s tail read does not read the whole file ===');
  // MEASURED IN BYTES, not seconds: count what the reader asks the OS for.
  const realRead = fs.readSync;
  let requested = 0;
  fs.readSync = (fd, buf, off, len, pos) => { requested += len; return realRead(fd, buf, off, len, pos); };
  let tail;
  try { tail = recentMessages(FILE, 2, (e) => e?.message?.content?.[0]?.text || ''); } finally { fs.readSync = realRead; }
  eq('the last two messages', tail, [texts[2], texts[3]]);
  check(`...having requested ${(requested / 1048576).toFixed(0)} MiB of a ${(size / 1048576).toFixed(0)} MiB file`, requested <= 32 * 1048576, `${requested} bytes`);
  const logPath = process.env.VECTROS_HOOKLOG_PATH;
  check('no READ FAILED line was logged (and the log check is not vacuous: a log line was written by the reads above)', !(fs.existsSync(logPath) && /READ FAILED/.test(fs.readFileSync(logPath, 'utf8'))));
} finally {
  try { fs.rmSync(FILE, { force: true }); } catch { /* silence-ok: best-effort cleanup of the temp file; the OS temp directory is the backstop. */ }
  try { fs.rmSync(process.env.VECTROS_HOOKLOG_PATH, { force: true }); } catch { /* silence-ok: best-effort cleanup of the temp log. */ }
}
check('the temp file was removed', !fs.existsSync(FILE));
done();
