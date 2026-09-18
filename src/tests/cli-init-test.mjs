#!/usr/bin/env node
/**
 * RED-PROOF: `cli.mjs init` deploys a WORKING runtime — including the OS-keychain native
 * binding, not just the plain .mjs files.
 *
 * FOUND EMPIRICALLY, before any live cutover: `deployRuntime()` originally copied `dist/*.mjs` +
 * `prompts/` and nothing else. Once deployed to the flat runtime dir (no `node_modules` of its
 * own), `creds.mjs`'s `require('@napi-rs/keyring')` always `MODULE_NOT_FOUND`ed — so
 * `CLAUDE_CODE_OAUTH_TOKEN` silently degraded to the plaintext-file tier on EVERY real install,
 * not just platforms lacking a prebuild (the only case that degradation is supposed to cover).
 * `deployKeyring()` fixes this by copying `@napi-rs/keyring` + whichever ONE platform subpackage
 * actually resolved into the deployed runtime's own `node_modules/`.
 *
 * Runs against SOURCE (`../cli.mjs`), matching every other test in this suite — dev-mode
 * resolution reaches the workspace's hoisted `node_modules` the same way a real install's
 * `node_modules` layout does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived

function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-cli-init-'));
  const claudeConfig = path.join(root, 'claude-config');
  const memoryHome = path.join(root, 'vectros-memory');
  fs.mkdirSync(claudeConfig, { recursive: true });
  return { claudeConfig, memoryHome };
}

function runInit(env) {
  return spawnSync(process.execPath, [path.join(DIR, 'cli.mjs'), 'init'], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: env.claudeConfig, VECTROS_MEMORY_HOME: env.memoryHome,
      // ⚠ MUST override, not just spread `...process.env` — `isolate.mjs` pins
      // VECTROS_HOOK_CREDENTIALS to the REAL machine credentials.json (deliberately, for
      // `*-real-test.mjs`), and this process inherits that pin. `init` now writes to
      // credentialsFile() (pinKeyringAlias) — without this override that write lands in
      // the REAL, LIVE credentials.json, not this case's isolated env.memoryHome. Real incident,
      // caught live in this exact file's case 4 before this line existed; fixed here
      // too since the mechanism is identical, not specific to case 4.
      VECTROS_HOOK_CREDENTIALS: path.join(env.memoryHome, 'credentials.json'),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A real (non-dry-run) init deploys a working keychain binding, when this dev machine has one.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. init deploys @napi-rs/keyring alongside the flat runtime, not just the .mjs files ===');
{
  const env = freshHome();
  const r = runInit(env);
  check('init exits 0', r.status === 0, `exit=${r.status} ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 500));

  let keyringAvailableHere = true;
  try { require.resolve; } catch { /* n/a — always true in CJS-ish node --test context, guard below is the real check */ }
  try {
    // Probe the SAME way cli.mjs does, from THIS process (which shares the workspace's hoisted
    // node_modules) — if it's not installed on this dev machine at all, skip the deploy assertion
    // rather than fail on an environment this package's own fail-open design already accounts for.
    const { createRequire } = await import('node:module');
    createRequire(import.meta.url).resolve('@napi-rs/keyring/package.json');
  } catch {
    keyringAvailableHere = false;
  }

  if (!keyringAvailableHere) {
    console.log('  SKIPPED: @napi-rs/keyring is not installed on this dev machine at all');
  } else {
    const deployedKeyringDir = path.join(env.memoryHome, 'node_modules', '@napi-rs', 'keyring');
    check('the keyring package itself was deployed into node_modules/', fs.existsSync(deployedKeyringDir));

    const napiScope = path.join(env.memoryHome, 'node_modules', '@napi-rs');
    const platformDirs = fs.existsSync(napiScope)
      ? fs.readdirSync(napiScope).filter((d) => d !== 'keyring')
      : [];
    check('exactly one platform-specific binary package was deployed alongside it',
      platformDirs.length === 1, `found: ${JSON.stringify(platformDirs)}`);

    // THE REAL PROOF: resolve + actually USE it from the deployed location, exactly as creds.mjs
    // does at hook-run time — a file existing on disk is not the same as Node being able to load it.
    const probeScript = `
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:url').pathToFileURL(process.cwd() + '/creds.mjs').href);
      const kc = req('@napi-rs/keyring');
      const entry = new kc.Entry('vectros-cli-init-test-probe', 'probe');
      entry.setPassword('probe-value');
      const readBack = entry.getPassword();
      entry.deleteCredential();
      console.log(readBack === 'probe-value' ? 'ROUNDTRIP_OK' : 'ROUNDTRIP_MISMATCH:' + readBack);
    `;
    const probe = spawnSync(process.execPath, ['-e', probeScript], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, cwd: env.memoryHome,
    });
    check('the deployed keyring binding actually resolves and round-trips a real OS-keychain write',
      /ROUNDTRIP_OK/.test(probe.stdout || ''), `${probe.stdout}${probe.stderr}`.slice(0, 500));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. settings.json merge is correct and idempotent — the OTHER half of a safe live cutover.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. settings.json wiring is correct and idempotent ===');
{
  const env = freshHome();
  runInit(env);
  const settingsPath = path.join(env.claudeConfig, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const events = Object.keys(settings.hooks || {}).sort();
  eq('exactly the five documented events are wired', events.join(','),
    ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort().join(','));
  check('every command points INTO the deployed runtime dir, not the source tree',
    JSON.stringify(settings).includes(env.memoryHome.replace(/\\/g, '\\\\')) || JSON.stringify(settings).includes(env.memoryHome));

  const r2 = runInit(env); // re-run — must be idempotent
  check('a second init exits 0', r2.status === 0);
  const settings2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [event, blocks] of Object.entries(settings2.hooks)) {
    eq(`${event} still has exactly one matcher block after a second init (no duplication)`, blocks.length, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. an UPGRADE that adds a file to an event already partially wired must add the NEW command,
//    not skip the whole event.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. a partially-wired event gains the missing command on re-init ===');
{
  const env = freshHome();
  // Seed settings.json AS IF an older version of this package (before `capture.mjs` joined
  // `Stop`) already wired only `stop.mjs` for the Stop event — the exact shape a real adopter's
  // settings.json would carry across an upgrade.
  const settingsPath = path.join(env.claudeConfig, 'settings.json');
  const staleStopCommand = `node "${path.join(env.memoryHome, 'stop.mjs')}"`;
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: staleStopCommand }] }] },
  }, null, 2));

  const r = runInit(env);
  check('init exits 0 against a partially-wired settings.json', r.status === 0);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stopCommands = settings.hooks.Stop.flatMap((b) => b.hooks.map((h) => h.command));
  check('the pre-existing stop.mjs command survives untouched', stopCommands.includes(staleStopCommand));
  check('the missing capture.mjs command for Stop is ADDED, not silently skipped',
    stopCommands.some((c) => c.includes('capture.mjs')), stopCommands.join(' | '));
  // Every other documented event must still get wired from scratch in the same run.
  eq('every other documented event is still wired', Object.keys(settings.hooks).sort().join(','),
    ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort().join(','));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. `init` pins the active keyring identity — never overwrites an existing
//    pin, and never touches credentials.json when there's nothing to pin.
//
// A fake `vectros` on PATH stands in for the real CLI: `resolveCommandPath` just needs a file
// named `vectros<ext>` to exist, and `keyring list --json`'s only contract this code reads is
// the `active` field — so a tiny wrapper is enough, no real keyring involved.
//
// FOUND against the REAL CLI: this fake used to accept ANY flags after
// `keyring list`/`keyring show`, which is exactly how `resolveActiveKeyringAlias()` calling
// `keyring list --format json` — a flag the real CLI's `keyring list` has never supported, only
// its sibling `keyring show` does — passed this whole suite while silently finding nothing to pin
// on every real machine. Fixed here AND in creds.mjs; the fake now checks for the EXACT real flag
// shape, so a future flag drift fails this test instead of passing it quietly.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. init pins the active keyring identity, once, and never blind-overwrites ===');
{
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-fakebin-'));
  fs.writeFileSync(path.join(fakeBinDir, 'vectros-fake.mjs'), `
    const args = process.argv.slice(2);
    if (args[0] === 'keyring' && args[1] === 'list' && args[2] === '--json') {
      process.stdout.write(JSON.stringify({ active: process.env.FAKE_VECTROS_ACTIVE || '', entries: [] }));
      process.exit(0);
    }
    // resolveKeyringSecretByAlias()'s call — 'keyring show --format raw --alias <a>'.
    if (args[0] === 'keyring' && args[1] === 'show' && args[2] === '--format' && args[3] === 'raw') {
      process.stdout.write(process.env.FAKE_VECTROS_SECRET || '');
      process.exit(0);
    }
    process.exit(1);
  `);
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    fs.writeFileSync(path.join(fakeBinDir, 'vectros.cmd'), '@echo off\r\nnode "%~dp0vectros-fake.mjs" %*\r\n');
  } else {
    fs.writeFileSync(path.join(fakeBinDir, 'vectros'), `#!/bin/sh\nexec node "$(dirname "$0")/vectros-fake.mjs" "$@"\n`);
    fs.chmodSync(path.join(fakeBinDir, 'vectros'), 0o755);
  }
  const fakePath = fakeBinDir + path.delimiter + process.env.PATH;

  function runInitWithFakeVectros(env, active, extraArgv = [], secret = '') {
    return spawnSync(process.execPath, [path.join(DIR, 'cli.mjs'), 'init', ...extraArgv], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: {
        ...process.env, CLAUDE_CONFIG_DIR: env.claudeConfig, VECTROS_MEMORY_HOME: env.memoryHome,
        PATH: fakePath, Path: fakePath, path: fakePath, FAKE_VECTROS_ACTIVE: active, FAKE_VECTROS_SECRET: secret,
        // ⚠ MUST override, not just spread — see the incident note above `runInitWithFakeVectros`.
        // `isolate.mjs` pins `VECTROS_HOOK_CREDENTIALS` to the REAL machine credentials.json
        // (deliberately, for `*-real-test.mjs`), and this test's parent process inherits that
        // pin — so a bare `...process.env` here would make `pinKeyringAlias()` write straight
        // into the REAL, LIVE credentials.json, not this case's isolated `env.memoryHome`. Caught
        // live: it briefly did exactly that on the machine authoring this file.
        VECTROS_HOOK_CREDENTIALS: path.join(env.memoryHome, 'credentials.json'),
      },
    });
  }

  // 4a. no active identity reported -> credentials.json is left untouched entirely.
  {
    const env = freshHome();
    const r = runInitWithFakeVectros(env, '');
    check('init exits 0 with no active identity to pin', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    check('no credentials.json was written at all', !fs.existsSync(path.join(env.memoryHome, 'credentials.json')));
  }

  // 4b. an active identity IS reported -> pinned verbatim into credentials.json.
  let pinnedEnv;
  {
    const env = freshHome();
    const r = runInitWithFakeVectros(env, 'my-live-alias');
    check('init exits 0 while pinning', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    check('init says it pinned the alias', /pinned keyring alias 'my-live-alias'/.test(r.stdout || ''), r.stdout);
    const creds = JSON.parse(fs.readFileSync(path.join(env.memoryHome, 'credentials.json'), 'utf8'));
    eq('the reported active alias was pinned verbatim', creds.VECTROS_KEYRING_ALIAS, 'my-live-alias');
    pinnedEnv = env;
  }

  // 4c. THE CORE OF THE FIX: a LATER init run, after the active identity has moved on to
  // something else entirely (e.g. an unrelated `bootstrap --tenant test` elsewhere), must NOT
  // silently re-point the pin — that would just relocate the footgun one layer down.
  {
    const r = runInitWithFakeVectros(pinnedEnv, 'some-other-identity-that-became-active-later');
    check('a second init (identity has since changed) still exits 0', r.status === 0);
    check('init says the alias is already pinned, not re-pinning', /already pinned: 'my-live-alias'/.test(r.stdout || ''), r.stdout);
    const creds = JSON.parse(fs.readFileSync(path.join(pinnedEnv.memoryHome, 'credentials.json'), 'utf8'));
    eq('the ORIGINAL pin survives untouched — this is the whole point of pinning',
      creds.VECTROS_KEYRING_ALIAS, 'my-live-alias');
  }

  // 4d. --dry-run never writes credentials.json, even with an active identity to pin.
  {
    const env = freshHome();
    const r = runInitWithFakeVectros(env, 'would-be-pinned', ['--dry-run']);
    check('dry-run init exits 0', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    check('dry-run never writes credentials.json', !fs.existsSync(path.join(env.memoryHome, 'credentials.json')));
    check('dry-run says what it WOULD do', /\[dry-run\] would pin keyring alias 'would-be-pinned'/.test(r.stdout || ''), r.stdout);
  }

  // 4e. pinning a TEST-shaped identity warns loudly — still pins (never silently refuses a
  // deliberate choice), but makes it visible rather than a quiet side effect of what happened to
  // be active. The mirror-image case (a live-shaped secret) must NOT warn.
  {
    const env = freshHome();
    const r = runInitWithFakeVectros(env, 'test-alias', [], 'ssk_test_fake_secret_shape');
    check('init exits 0 while pinning a test-shaped identity', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    check('init WARNS that a test-tenant identity is being pinned', /TEST-tenant identity.*about to pin it/.test(r.stdout || ''), r.stdout);
    const creds = JSON.parse(fs.readFileSync(path.join(env.memoryHome, 'credentials.json'), 'utf8'));
    eq('it still pins — the warning does not block a deliberate choice', creds.VECTROS_KEYRING_ALIAS, 'test-alias');
  }
  {
    const env = freshHome();
    const r = runInitWithFakeVectros(env, 'live-alias', [], 'ssk_live_fake_secret_shape');
    check('init exits 0 while pinning a live-shaped identity', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    check('init does NOT warn for a live-shaped identity', !/TEST-tenant identity/.test(r.stdout || ''), r.stdout);
  }
}

done();
