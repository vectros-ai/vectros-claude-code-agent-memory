// RED-PROOF: the BUILT dist/ artifact, not src/*.mjs.
//
// WHY THIS FILE EXISTS. Every other test in this suite (old and new) spawns `src/*.mjs` directly —
// package.json ships `dist` only (`"files": ["dist", ...]`), so nothing before this proved the
// thing an adopter actually installs even STARTS, let alone works. Each `dist/*.mjs` is still a
// separate, independently-runnable entry point (`tsup.config.mjs` runs `bundle:false`) — but each
// entry's OWN dependency graph is inlined into it at build time (confirmed by reading the actual
// output, not assumed from the config: shared helpers like `creds.mjs` appear duplicated, under
// esbuild-renamed local bindings, inside every entry that imports them, rather than staying a
// single shared module reached by a relative import). Neither shape is inherently wrong, but
// exactly this kind of build-time transformation is what a bundler can quietly get wrong (a
// dropped export, a stale copy of a helper, `copy-assets.mjs` missing a new asset) — and nothing
// checked any of it before this file existed.
//
// SCOPE: not full parity with every src/*-test.mjs — that would double the suite's runtime for
// marginal extra coverage once the build itself is proven faithful. This exercises the paths most
// likely to break from a bad build: `cli.mjs init` (deploys a WORKING runtime, including the
// native keyring binding — the exact class of bug a bundler can introduce), and
// `dispose.mjs`/`recall.mjs` actually running end-to-end against a fake record store, proving
// their own post-build dependency graph resolves correctly.
//
// Builds dist/ FRESH at the top of this file — cheap (~100ms, measured) — so this can never pass
// against a stale artifact left over from a previous run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

const PKG_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // package root
const DIST = path.join(PKG_ROOT, 'dist');
const SRC = path.join(PKG_ROOT, 'src');

console.log('=== 0. build dist/ fresh (never trust a stale artifact -- unless a fresh build is genuinely impossible right now) ===');
{
  const t0 = Date.now();
  // `shell: true` on Windows — `npm` resolves to `npm.cmd`, and spawnSync cannot exec a `.cmd`
  // directly without a shell (ENOENT, not a build failure — the same class of trap creds.mjs's
  // own `runKeyringHelper` header documents for the `vectros` binary).
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: PKG_ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, shell: process.platform === 'win32',
  });
  if (r.status === 0) {
    check('npm run build exits 0', true);
    console.log(`  built in ${Date.now() - t0}ms`);
  } else {
    /**
     * ⚠ AN EACCES UNLINKING AN EXISTING FILE IS A PERMISSION CONFLICT, NOT A BUILD FAILURE — found
     * live in CI, not by a test. This package's CI test job builds it ONCE already (as the job's
     * default user), then switches to an UNPRIVILEGED user for the keychain-integration cases
     * (deliberately — real OS-keychain tests need a real, narrow session, not root). This file's
     * OWN rebuild, run as that second user, then tries to unlink `dist/` content the FIRST build
     * already wrote as a different user, and loses. Trusting the EXISTING dist/ instead of
     * hard-failing is safe here specifically because CI's own explicit build step is what produced
     * it — moments before this file ran, from the same source, on the same commit — so there is no
     * staleness risk in THIS narrow case. Gated tightly, not a blanket "ignore build errors": only
     * an EACCES on an unlink, AND only when the existing dist/ already looks complete. Any other
     * failure shape (a real compile error, a missing dependency, dist/ genuinely absent) still
     * fails loudly below, exactly as before.
     */
    const stderr = r.stderr || '';
    const permissionConflict = /EACCES/.test(stderr) && /unlink/i.test(stderr);
    const existingLooksBuilt = fs.existsSync(DIST) && fs.existsSync(path.join(DIST, 'cli.mjs'));
    if (permissionConflict && existingLooksBuilt) {
      check('npm run build failed on a permission conflict, not a build error -- trusting the existing dist/ a prior step already built', true);
      console.log(`  (build stderr, for context: ${stderr.trim().slice(-300)})`);
    } else {
      check('npm run build exits 0', false, `error=${r.error} ${r.stdout}\n${stderr}`.slice(-1500));
    }
  }
}

console.log('\n=== 1. dist/ actually contains the entry points package.json ships, not just src/ ===');
{
  // The exact set the hook wiring + this package's own CLI reference depend on — a build that
  // silently drops one of these would fail nothing else in the suite (it never spawns dist/).
  // NOT the separate internal migration tools — relocated out of the package: those are one-time
  // operator-run tooling for moving data off an older storage layout, not something a fresh
  // adopter's dist/ ever needs, so they must NOT reappear here as a "required" file.
  const REQUIRED = ['cli.mjs', 'dispose.mjs', 'recall.mjs', 'orient.mjs', 'evaluate.mjs',
    'stop.mjs', 'capture.mjs', 'report.mjs', 'creds.mjs', 'candidates.mjs',
    // Unlike the migration tools above, these ARE permanent runtime components
    // (capture.mjs spawns orphan-cap-worker.mjs on every real Stop, not a one-time migration tool).
    'orphan-cap.mjs', 'orphan-cap-worker.mjs'];
  for (const f of REQUIRED) {
    check(`dist/${f} exists`, fs.existsSync(path.join(DIST, f)));
  }
  check('prompts/ was copied alongside the built files (copy-assets.mjs)',
    fs.existsSync(path.join(DIST, 'prompts')) && fs.readdirSync(path.join(DIST, 'prompts')).length > 0);
}

console.log('\n=== 2. dist/cli.mjs init deploys a WORKING runtime — same proof cli-init-test.mjs runs against src/ ===');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-smoke-init-'));
  const claudeConfig = path.join(root, 'claude-config');
  const memoryHome = path.join(root, 'vectros-memory');
  fs.mkdirSync(claudeConfig, { recursive: true });
  const env = {
    ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, VECTROS_MEMORY_HOME: memoryHome,
    // Same guard cli-init-test.mjs's own runInit() carries — init now WRITES to
    // credentialsFile() (pinKeyringAlias), and this process inherits isolate.mjs's REAL pin.
    VECTROS_HOOK_CREDENTIALS: path.join(memoryHome, 'credentials.json'),
  };
  const r = spawnSync(process.execPath, [path.join(DIST, 'cli.mjs'), 'init'], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env,
  });
  check('dist/cli.mjs init exits 0', r.status === 0, `${r.stdout}\n${r.stderr}`.slice(-1000));

  const settingsPath = path.join(claudeConfig, 'settings.json');
  check('settings.json was written', fs.existsSync(settingsPath));
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const events = Object.keys(settings.hooks || {}).sort();
    eq('exactly the five documented events are wired from the BUILT cli.mjs',
      events.join(','), ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort().join(','));
    check('every command points into the DEPLOYED runtime dir', JSON.stringify(settings).includes('recall.mjs'));
  }
  check('the runtime deployed from dist/, not src/ (no src-only marker files)',
    fs.existsSync(path.join(memoryHome, 'recall.mjs')) && !fs.existsSync(path.join(memoryHome, 'tests')));

  // THE REAL PROOF for the native binding, same as cli-init-test.mjs case 1 — a file existing is
  // not the same as Node being able to load it, and this is exactly the kind of thing a build step
  // can quietly break (a bundler rewriting the `createRequire` resolution base, for instance).
  let keyringAvailableHere = true;
  try {
    const { createRequire } = await import('node:module');
    createRequire(import.meta.url).resolve('@napi-rs/keyring/package.json');
  } catch { keyringAvailableHere = false; }
  if (!keyringAvailableHere) {
    console.log('  SKIPPED keyring round-trip: @napi-rs/keyring is not installed on this dev machine at all');
  } else {
    const deployedKeyringDir = path.join(memoryHome, 'node_modules', '@napi-rs', 'keyring');
    check('the keyring package was deployed into the BUILT runtime\'s node_modules/', fs.existsSync(deployedKeyringDir));
    const probeScript = `
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:url').pathToFileURL(process.cwd() + '/creds.mjs').href);
      const kc = req('@napi-rs/keyring');
      const entry = new kc.Entry('vectros-dist-smoke-test-probe', 'probe');
      entry.setPassword('probe-value');
      const readBack = entry.getPassword();
      entry.deleteCredential();
      console.log(readBack === 'probe-value' ? 'ROUNDTRIP_OK' : 'ROUNDTRIP_MISMATCH:' + readBack);
    `;
    const probe = spawnSync(process.execPath, ['-e', probeScript], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: memoryHome,
    });
    check('the BUILT dist/creds.mjs resolves and round-trips the real OS keychain, post-build',
      /ROUNDTRIP_OK/.test(probe.stdout || ''), `${probe.stdout}${probe.stderr}`.slice(0, 500));
  }
}

/**
 * Async `spawn`, DELIBERATELY — NOT `spawnSync`. Every fake server in this file lives in THIS
 * process's event loop; `spawnSync` blocks that event loop for the child's whole lifetime, so the
 * server could never answer a request the child makes while it runs (every fetch would time out
 * while APPEARING to pass, since the code under test is fail-open). This is the exact
 * trap `dispose-test.mjs`/`nudge-test.mjs`/etc. already work around; step 4 below used to violate
 * it — not caught by a failing test, since recall.mjs's own fail-open design meant the
 * assertion passed anyway, for the wrong reason, costing ~10-20s per run sitting near its timeout.
 * `opts.input`, if given, is written to the child's stdin and the stream is ended — the one thing
 * `spawnSync`'s `input` option did for free that `spawn` needs done by hand.
 */
function spawnAsync(argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, opts);
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), opts.timeout || 20000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
    if (opts.input !== undefined) { child.stdin.write(opts.input); child.stdin.end(); }
  });
}

console.log('\n=== 3. dist/dispose.mjs runs end-to-end against a fake record store — proves its OWN relative imports resolved post-build ===');
{
  const server = await startFakeRecordsServer();
  const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_dist_smoke', VECTROS_API_BASE_URL: server.url };
  const SID = 'dist-smoke-dispose-0001';
  const xid = `${SID}:seed-1`;
  server.seed('candidate', {
    title: 'dist smoke target', body: 'b', kind: 'observation', dest: 'memory', sessionId: SID,
    disposition: 'pending', proposedAt: '2026-01-01', externalId: xid,
  });

  const r = await spawnAsync([path.join(DIST, 'dispose.mjs'), SID, '--list'], { timeout: 20000, env: ENV });
  check('dist/dispose.mjs --list exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
  check('it correctly reads the seeded candidate from the fake record store (proves records/HTTP imports resolved)',
    r.stdout.includes('dist smoke target'), r.stdout);
  server.close();
}

console.log('\n=== 4. dist/recall.mjs runs on a minimal hook payload without crashing — proves its own import graph resolved post-build ===');
{
  const server = await startFakeRecordsServer();
  const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_dist_smoke', VECTROS_API_BASE_URL: server.url };
  const payload = JSON.stringify({ session_id: 'dist-smoke-recall-0001', prompt: 'hello from dist-smoke-test', cwd: PKG_ROOT });
  const r = await spawnAsync([path.join(DIST, 'recall.mjs')], { input: payload, timeout: 20000, env: ENV });
  check('dist/recall.mjs exits 0 on a well-formed hook payload', r.status === 0, `${r.stdout}\n${r.stderr}`.slice(-1000));
  server.close();
}

/**
 * This suite had a gap that let a bundling defect ship: it proved
 * dispose.mjs/recall.mjs's import graphs resolve post-build (steps 3/4 above), but never actually
 * RAN capture.mjs — the exact Stop-hook file that crashed, and the only way to observe the
 * dual-mode-file-inlined-into-another-entry defect this fix exists to catch. `VECTROS_MEM_REAP_OFF=1`
 * puts `runReap()` on the `{skipped: '...'}` early-return path — the specific shape that crashed
 * (reap.mjs's old CLI block, duplicated into capture.mjs's dist output, unconditionally read
 * `.plan.prune` off it) — so this exercises precisely the branch a real Stop event's most common
 * case takes, not just the rare one where the reaper actually runs.
 */
console.log('\n=== 5. dist/capture.mjs runs on a minimal hook payload without crashing — the exact file/path that crashed ===');
{
  const ENV = { ...process.env, VECTROS_MEM_REAP_OFF: '1' };
  const payload = JSON.stringify({ session_id: 'dist-smoke-capture-0001', transcript_path: '', cwd: PKG_ROOT, hook_event_name: 'Stop', reason: 'other' });
  const r = await spawnAsync([path.join(DIST, 'capture.mjs')], { input: payload, timeout: 20000, env: ENV });
  check('dist/capture.mjs exits 0 on a well-formed hook payload', r.status === 0, `${r.stdout}\n${r.stderr}`.slice(-1000));
  check('dist/capture.mjs does not crash with an uncaught exception', !/TypeError|ReferenceError|at file:/.test(r.stderr || ''), r.stderr);
}

console.log('\n=== 6. dist/orphan-cap-worker.mjs runs standalone without crashing — dry-run default, no args ===');
{
  const r = await spawnAsync([path.join(DIST, 'orphan-cap-worker.mjs')], { timeout: 20000, env: process.env });
  check('dist/orphan-cap-worker.mjs exits 0 with no args (dry-run default)', r.status === 0, `${r.stdout}\n${r.stderr}`.slice(-1000));
  check('dist/orphan-cap-worker.mjs does not crash with an uncaught exception', !/TypeError|ReferenceError|at file:/.test(r.stderr || ''), r.stderr);
}

console.log(`\n(dist smoke ran against ${DIST}, built fresh from ${SRC} at the top of this file)`);
done();
