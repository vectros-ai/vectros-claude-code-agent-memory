#!/usr/bin/env node
/**
 * `cli.mjs --help` / `-h` / `help` print the usage and exit 0; `--version` / `-v` print the package version and
 * exit 0; an unknown command still prints the usage and exits 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(SRC, 'cli.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

for (const flag of ['--help', '-h', 'help']) {
  const r = run(flag);
  eq(`${flag} exits 0`, r.status, 0);
  check(`${flag} prints the usage`, r.stdout.includes('Usage: claude-code-agent-memory'), r.stdout);
}
for (const flag of ['--version', '-v']) {
  const r = run(flag);
  eq(`${flag} exits 0`, r.status, 0);
  eq(`${flag} prints the package version`, r.stdout.trim(), PKG.version);
}
{
  const r = run('frobnicate');
  eq('an unknown command still exits 1', r.status, 1);
  check('...and prints the usage', r.stdout.includes('Usage: claude-code-agent-memory'), r.stdout);
}
done();
