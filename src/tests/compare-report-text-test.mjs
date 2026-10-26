#!/usr/bin/env node
/**
 * THE TEXT `report.mjs --compare` PRINTS: its heading, its counter labels, and its closing verdict.
 *
 * Everything else about `--compare` is tested through `compare()` (compare-test.mjs) or through the
 * safety gate that stops it printing AGREED over an unreadable queue (compare-dir-unreadable-test.mjs).
 * Nothing asserted the words themselves, so a reworded or reverted label would pass every suite. This
 * runs the real script against an empty-but-readable queue directory (no sessions to compare, so no
 * network) and checks the output an operator reads: the heading names what is compared (queue entries
 * against records), the two queue counters say what they count, and the verdict is the AGREED line.
 *
 * It also asserts the absence of the migration vocabulary the output used to carry, so it fails if that
 * text comes back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, done } from './assert.mjs';
import './isolate.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived

// A PRIVATE root with a real, empty queue directory: readable, so the AGREED path is reachable.
const PRIVATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-compare-text-'));
fs.mkdirSync(path.join(PRIVATE_ROOT, 'queue'), { recursive: true });

const r = spawnSync(process.execPath, [path.join(DIR, 'report.mjs'), '--compare'], {
  encoding: 'utf8', timeout: 30_000, windowsHide: true,
  env: { ...process.env, VECTROS_MEMORY_HOME: PRIVATE_ROOT },
});
const out = (r.stdout || '') + (r.stderr || '');

check('exits 0 over a readable, empty queue', r.status === 0, `exit=${r.status}: ${out.slice(0, 600)}`);
check('heading names what is compared: queue entries against records',
  /^QUEUE \/ RECORD AGREEMENT — 0 session\(s\)/m.test(out), out.slice(0, 600));
check('counter label: queue entries with an id', /queue entries with an id\s*: 0/.test(out), out.slice(0, 800));
check('counter label: queue entries with no id (not compared; they predate the spool)',
  /queue entries with no id\s*: 0\s+<- not compared; they predate the spool/.test(out), out.slice(0, 800));
check('verdict: AGREED names the queue entries with an id',
  /AGREED — every queue entry with an id is in both stores, or owed and still draining\./.test(out), out.slice(0, 1200));
check('the migration vocabulary is gone from the output',
  !/dual-write|cutover|backfill/i.test(out), out.slice(0, 1200));

done();
