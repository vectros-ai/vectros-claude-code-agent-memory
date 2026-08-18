#!/usr/bin/env node
/**
 * RED-PROOF: `cli.mjs set-token` — the setup path for `CLAUDE_CODE_OAUTH_TOKEN` `init`
 * deliberately doesn't attempt (it deploys the MECHANISM, never a secret).
 *
 *   claude setup-token | claude-code-agent-memory set-token
 *
 * Reads from stdin (never argv — argv sits in shell history/`ps` for the process's lifetime),
 * stores via the OS keychain when available, falls back to the plaintext `credentials.json` tier
 * otherwise — the same file `creds.mjs`'s own read-side fallback already reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';
import { removeOAuthToken, storeOAuthToken, _peekOAuthTokenRaw } from '../creds.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived

function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-set-token-'));
  const memoryHome = path.join(root, 'vectros-memory');
  fs.mkdirSync(memoryHome, { recursive: true });
  return memoryHome;
}

/**
 * `process.env` with `CLAUDE_CODE_OAUTH_TOKEN` genuinely ABSENT — `undefined`-valued env entries
 * get stringified to `"undefined"` by child_process, not dropped, so this deletes the key instead.
 *
 * ⚠ ALSO strips `VECTROS_HOOK_CREDENTIALS`, and this is NOT optional. `isolate.mjs` deliberately
 * pins it to the REAL `credentials.json` (for the OTHER `*-real-test.mjs` files that need genuine
 * credentials) and this test file inherits that via `...process.env`. `set-token`'s file-fallback
 * write path uses `credentialsFile()`, which honours that env var — so without this line, a red-
 * test sabotaging the keychain write forces the file-fallback branch to write a FAKE test token
 * straight into the REAL, LIVE credentials file. This happened during authoring: a sabotage
 * run clobbered the real `CLAUDE_CODE_OAUTH_TOKEN` on the dogfood machine with a test placeholder,
 * unrecoverably (`writeFileAtomic` renames a temp file directly over the target — no backup is
 * kept). Recovered by re-running `claude setup-token`. Every case gets its OWN throwaway
 * credentials file, inside its own fresh `memoryHome`, so no case can ever reach the real one.
 */
function cleanEnv(memoryHome) {
  const env = { ...process.env, VECTROS_MEMORY_HOME: memoryHome };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.VECTROS_HOOK_CREDENTIALS;
  return env;
}

function runSetToken(memoryHome, stdinText) {
  return spawnSync(process.execPath, [path.join(DIR, 'cli.mjs'), 'set-token'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true, input: stdinText, env: cleanEnv(memoryHome),
  });
}

function readCred(memoryHome) {
  const probe = `import('./creds.mjs').then(({ cred }) => console.log('CRED_VALUE:' + cred('CLAUDE_CODE_OAUTH_TOKEN')));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true, cwd: DIR, env: cleanEnv(memoryHome),
  });
  const m = /CRED_VALUE:(.*)/.exec(r.stdout || '');
  return m ? m[1] : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Empty stdin is refused, loudly — not a silent no-op. Touches no credential store; always runs.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. empty stdin is refused ===');
{
  const home = freshHome();
  const r = runSetToken(home, '');
  check('exits non-zero on empty stdin', r.status !== 0, `exit=${r.status}`);
  check('says what went wrong', /nothing to store|could not read stdin/.test(r.stderr || ''), r.stderr);
}

/**
 * ⚠ SKIP BY DEFAULT ON A LOCAL MACHINE — SAFETY, not a capability check. `KEYCHAIN_SERVICE`/
 * `OAUTH_ACCOUNT` in creds.mjs are fixed, machine-wide constants — the exact entry a real
 * deployment's real CLAUDE_CODE_OAUTH_TOKEN lives in, not something `freshHome()` scopes.
 *
 * The first incident: an earlier draft's red-test sabotage clobbered the real, live
 * `credentials.json` (file tier) because `cleanEnv()` didn't strip `VECTROS_HOOK_CREDENTIALS` —
 * fixed above. A second incident, found LATER: even with that fixed, a plain non-sabotage
 * `npm test` run on a dogfood machine that had since migrated a real token into the KEYCHAIN
 * tier silently deleted it via this file's own `finally` cleanup, which unconditionally called
 * `removeOAuthToken()` with no regard for what was there before. Same root cause both times —
 * test code assuming it owns a resource it doesn't — different storage layer each time.
 *
 * Now: SKIP unless explicitly opted in (VECTROS_MEM_TEST_KEYCHAIN=1 locally, or
 * VECTROS_REQUIRE_KEYCHAIN_TESTS=1 in a CI job that provisions a fresh, disposable container),
 * AND snapshot/restore the pre-existing entry (never just delete) as defense-in-depth for
 * whichever path does run it.
 */
const optedIn = process.env.VECTROS_MEM_TEST_KEYCHAIN === '1' || process.env.VECTROS_REQUIRE_KEYCHAIN_TESTS === '1';
if (!optedIn) {
  console.log('\nSKIPPED remaining cases: touches the real, machine-wide OS keychain entry — opt in '
    + 'with VECTROS_MEM_TEST_KEYCHAIN=1 (only on a machine with nothing real in that entry) or run in CI');
} else {
  let keychainAvailableHere = true;
  let probeError;
  const preExisting = _peekOAuthTokenRaw(); // SNAPSHOT before anything below writes a single byte
  try {
    // A real usability probe (not just "is the module installed") — mirrors creds-keyring-test.mjs
    // case 4 and cli's os-keychain.test.ts: attempt the actual write the cases below need.
    storeOAuthToken(`sk-ant-oat01-probe-${process.pid}`);
  } catch (e) {
    keychainAvailableHere = false;
    probeError = e;
  }

  if (!keychainAvailableHere && process.env.VECTROS_REQUIRE_KEYCHAIN_TESTS === '1') {
    throw new Error(`VECTROS_REQUIRE_KEYCHAIN_TESTS=1 but the OS credential store did not answer `
      + `(${probeError && probeError.message}) — refusing to skip the set-token keychain cases.`);
  }

  if (!keychainAvailableHere) {
    console.log('\nSKIPPED remaining cases: @napi-rs/keyring is not available on this platform/install');
    if (preExisting != null) storeOAuthToken(preExisting); // the probe's own throw shouldn't lose it either
  } else {
    /**
     * `cred()`'s read path tries the keychain FIRST regardless of which `home` is asked, so
     * cases 2 and 3 are NOT isolated from each other via `freshHome()` the way the file-tier
     * tests are — whichever wrote to the keychain LAST wins for every subsequent read, in this
     * file or any other. Written SEQUENTIALLY on purpose, not isolated per-case; the snapshot
     * taken above (of whatever was there before EITHER case ran) is what gets restored below,
     * not an empty slot.
     */
    try {
      // ───────────────────────────────────────────────────────────────────────
      // 2. A real token piped in round-trips through the OS keychain and is readable via cred().
      // ───────────────────────────────────────────────────────────────────────
      console.log('=== 2. a piped token is stored in the OS keychain and readable back via cred() ===');
      const home = freshHome();
      const r = runSetToken(home, 'sk-ant-oat01-test-set-token-first\n');
      check('set-token exits 0', r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 500));
      // NOT a substring check — "OS credential store unavailable ... falling back" ALSO contains
      // "OS credential store", so a loose match here would pass on either branch (found the hard
      // way: it stayed green through the very sabotage run that clobbered the real credentials.json).
      check('reports the keychain tier, not the file fallback',
        /^stored CLAUDE_CODE_OAUTH_TOKEN in the OS credential store\.$/m.test(r.stdout || ''), r.stdout);
      eq('cred() reads back exactly the stored value', readCred(home), 'sk-ant-oat01-test-set-token-first');

      // ───────────────────────────────────────────────────────────────────────
      // 3. Re-running set-token UPDATES the stored value — no duplication, no stale leftover.
      //    Deliberately the SAME global keychain entry as case 2, not a fresh one.
      // ───────────────────────────────────────────────────────────────────────
      console.log('\n=== 3. a second set-token overwrites, not duplicates ===');
      runSetToken(home, 'sk-ant-oat01-first-value\n');
      runSetToken(home, 'sk-ant-oat01-second-value\n');
      eq('cred() reads back the SECOND value only', readCred(home), 'sk-ant-oat01-second-value');
    } finally {
      // ALWAYS runs, even on an assertion failure above — RESTORE, never just delete. This is a
      // REAL, machine-wide credential store entry; incident #2 was exactly this step done wrong.
      if (preExisting != null) {
        storeOAuthToken(preExisting);
        eq('cleanup: the pre-existing entry was restored, not lost', _peekOAuthTokenRaw(), preExisting);
      } else {
        const cleaned = removeOAuthToken();
        console.log(`\n(cleanup: no pre-existing entry -> removed the test residue = ${cleaned})`);
      }
    }
  }
}

done();
