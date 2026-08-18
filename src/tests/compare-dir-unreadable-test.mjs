#!/usr/bin/env node
/**
 * RED-PROOF: `report.mjs --compare` must NOT print "AGREED" when the `queue/` directory
 * itself could not be listed.
 *
 * FOUND BY LINT, NOT BY DESIGN. The first-ever `eslint` pass over this source (it had no
 * config before landing under `packages/`) flagged `dirUnreadable` in `compare()` as an unused
 * variable. It was not dead code — it was a WIRED-AND-DEAD SAFETY GATE: set on a genuine
 * `fs.readdirSync(queueDir())` failure, and then never consulted. With `files = []` in that branch,
 * `results` stays empty, so both `divergent` and `unknown` are VACUOUSLY empty too, and the old
 * code fell straight through to printing "AGREED — every post-cutover candidate is in both
 * stores" over a corpus it had never looked at — the exact "missing is not broken" inversion this
 * module's own header spends thirty lines refusing (see `noteSkip('the ENTIRE queue dir', ...)`'s
 * comment). This is the automated proof the fix actually closes that gap, not just that lint is
 * quiet.
 *
 * REPRODUCED PORTABLY: replacing `queue/` with a plain FILE forces `fs.readdirSync` to throw
 * ENOTDIR on every platform, deterministically — unlike a permission-bit trick, which is a known
 * unreliable way to force a read failure on Windows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, done } from './assert.mjs';
import './isolate.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived

/**
 * A PRIVATE root, deliberately NOT the shared one `isolate.mjs` set up for this whole `run-all.mjs`
 * invocation. `run-all.mjs`'s own header documents that every test spawns children with
 * `env: {...process.env, ...}`, so `VECTROS_MEMORY_HOME` is shared across every test file in one
 * run — writing this sabotage into THAT root would poison `queue/` for every test that runs after
 * this one alphabetically. (Caught the hard way while authoring this file: `queue-test.mjs`,
 * `reap-test.mjs`, `nudge-test.mjs`, `nudge-budget-test.mjs` and `sweep-test.mjs` all failed on the
 * very next `run-all.mjs` run, every failure traceable to a `queue/` that was a FILE, not a
 * directory — this test's own doing.) Passing an explicit `env` override to `spawnSync` below,
 * rather than mutating `process.env` in this process, keeps the blast radius to this one child.
 */
const PRIVATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-compare-dirunreadable-'));
const queuePath = path.join(PRIVATE_ROOT, 'queue');
fs.writeFileSync(queuePath, 'not a directory\n'); // forces ENOTDIR on any attempt to list it

const r = spawnSync(process.execPath, [path.join(DIR, 'report.mjs'), '--compare'], {
  encoding: 'utf8', timeout: 30_000, windowsHide: true,
  env: { ...process.env, VECTROS_MEMORY_HOME: PRIVATE_ROOT },
});
const out = (r.stdout || '') + (r.stderr || '');

check('exits non-zero — a comparison that could not run is not a pass', r.status !== 0, `exit=${r.status}`);
check('does NOT print AGREED over a corpus it never looked at', !/\bAGREED\b/.test(out), out.slice(0, 800));
check('says plainly that the queue directory could not be listed', /QUEUE DIRECTORY ITSELF COULD NOT BE LISTED/.test(out), out.slice(0, 800));

done();
