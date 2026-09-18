#!/usr/bin/env node
/**
 * RED-PROOF: the credential-delegation rewrite in `creds.mjs` — VECTROS_API_KEY via the
 * `vectros keyring show` CLI helper, CLAUDE_CODE_OAUTH_TOKEN via `@napi-rs/keyring`.
 *
 * Every case re-imports `creds.mjs` CACHE-BUSTED: `cred('VECTROS_API_KEY')`/`cred('CLAUDE_CODE_
 * OAUTH_TOKEN')` memoize per module instance (`apiKeyTried`/`keychainBinding`), so a stale import
 * would silently reuse an earlier case's resolution and never observe the env/PATH change this
 * file makes between cases — the same pattern `waf-receipt-test.mjs` uses for the identical reason.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs'; // isolates runtime state; deliberately leaves real env/credentials alone
import { _peekOAuthTokenRaw, storeOAuthToken, removeOAuthToken } from '../creds.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived
const fresh = async () => import(pathToFileURL(path.join(DIR, 'creds.mjs')).href + `?t=${Date.now()}${Math.random()}`);

const SAVED = { ...process.env };
function restore() {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. VECTROS_API_KEY — env always wins, no subprocess needed to prove it (a broken PATH would
//    make a helper spawn fail loudly if it were reached at all).
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. VECTROS_API_KEY: env wins over the keyring helper ===');
{
  process.env.VECTROS_API_KEY = 'ssk_live_test_env_wins';
  process.env.PATH = ''; // even an unreachable helper must not matter — env short-circuits first
  const { cred } = await fresh();
  eq('env value is returned verbatim', cred('VECTROS_API_KEY'), 'ssk_live_test_env_wins');
  restore();
}

console.log('\n=== 2. VECTROS_API_KEY: no env, `vectros` unresolvable on PATH -> fails open to \'\' ===');
{
  delete process.env.VECTROS_API_KEY;
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-nopath-'));
  process.env.PATH = emptyDir; // guaranteed to hold no `vectros`/`vectros.exe`/`vectros.cmd`
  process.env.Path = emptyDir; // Windows env lookups are case-insensitive at the OS level but
  process.env.path = emptyDir; // process.env keys are not — cover all three spellings defensively
  const { cred } = await fresh();
  eq('an unresolvable CLI degrades to an empty credential, not a throw', cred('VECTROS_API_KEY'), '');
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLAUDE_CODE_OAUTH_TOKEN — env wins, same as above.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. CLAUDE_CODE_OAUTH_TOKEN: env wins over the OS keychain ===');
{
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-env-wins';
  const { cred } = await fresh();
  eq('env value is returned verbatim', cred('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-test-env-wins');
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CLAUDE_CODE_OAUTH_TOKEN — a real OS-keychain round trip via @napi-rs/keyring.
//
// ⚠️ SKIPS BY DEFAULT ON A LOCAL MACHINE, even when @napi-rs/keyring is installed and usable —
// this is a SAFETY gate, not a capability one. The entry this writes to (`KEYCHAIN_SERVICE`/
// `OAUTH_ACCOUNT` in creds.mjs) is a FIXED, MACHINE-WIDE constant — the exact entry a real
// deployment's real CLAUDE_CODE_OAUTH_TOKEN lives in. A real failure mode: a routine `npm test` run
// can silently delete a real token already migrated into the keychain
// — this case's OLD cleanup unconditionally called removeOAuthToken() with no regard
// for what was there before. Opt in explicitly (VECTROS_MEM_TEST_KEYCHAIN=1) once you've
// confirmed this machine holds nothing you can't afford to lose, or rely on CI (which sets
// VECTROS_REQUIRE_KEYCHAIN_TESTS=1 against a FRESH, disposable container with nothing real in
// it). Snapshot/restore below is defense-in-depth for whichever path runs it, not a substitute
// for defaulting to skip.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. CLAUDE_CODE_OAUTH_TOKEN: OS-keychain round trip ===');
{
  const optedIn = process.env.VECTROS_MEM_TEST_KEYCHAIN === '1' || process.env.VECTROS_REQUIRE_KEYCHAIN_TESTS === '1';
  if (!optedIn) {
    console.log('  SKIPPED: touches the real, machine-wide OS keychain entry — opt in with '
      + 'VECTROS_MEM_TEST_KEYCHAIN=1 (only on a machine with nothing real in that entry) or run in CI');
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Point the FILE tier at an isolated, empty temp file for this whole case — a real deployment's
    // REAL credentials.json legitimately holds a real token (isolate.mjs deliberately
    // leaves credentials un-isolated for the *-real-test.mjs files' sake), and without this
    // override "after cleanup, the keychain is empty" would fall through to that real value
    // instead of '', which is correct production behaviour but makes THIS assertion depend on
    // the machine it runs on.
    const isolatedCredsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-creds-')), 'credentials.json');
    fs.writeFileSync(isolatedCredsFile, '{}');
    process.env.VECTROS_HOOK_CREDENTIALS = isolatedCredsFile;

    // SNAPSHOT whatever is really there — via the raw peek, not cred() (module memoization) —
    // BEFORE this case writes anything, so cleanup can put it back rather than delete it.
    const preExisting = _peekOAuthTokenRaw();

    try {
      const mod = await fresh();
      let keychainAvailable = true;
      let probeError;
      try {
        mod.storeOAuthToken('sk-ant-oat01-test-roundtrip');
      } catch (e) {
        keychainAvailable = false;
        probeError = e;
      }
      if (!keychainAvailable) {
        // A skip is honest on a platform/install with no usable store — but where a store is
        // SUPPOSED to exist (CI provisions one), an absent one is a broken harness, not a
        // platform fact. Fail loudly instead of quietly leaving this unpinned forever.
        if (process.env.VECTROS_REQUIRE_KEYCHAIN_TESTS === '1') {
          throw new Error(`VECTROS_REQUIRE_KEYCHAIN_TESTS=1 but the OS credential store did not `
            + `answer (${probeError && probeError.message}) — refusing to skip the real round trip.`);
        }
        console.log('  SKIPPED: @napi-rs/keyring not available on this platform/install');
      } else {
        const mod2 = await fresh(); // a fresh instance to prove this reads the STORE, not an in-process cache
        eq('the stored token round-trips through the real OS credential store', mod2.cred('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-test-roundtrip');
      }
    } finally {
      // RESTORE, never just delete — the entry may have held something real before this case ran.
      if (preExisting != null) {
        storeOAuthToken(preExisting);
        eq('cleanup: the pre-existing entry was restored, not lost', _peekOAuthTokenRaw(), preExisting);
      } else {
        removeOAuthToken();
        eq('cleanup: no pre-existing entry -> restored to empty', _peekOAuthTokenRaw(), null);
      }
    }
    restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. childEnv() still only carries the allow-listed names + the resolved token, nothing else new.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. childEnv() carries the resolved token and nothing extra ===');
{
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-child-env-test';
  process.env.SOME_RANDOM_SECRET = 'must-not-leak';
  process.env.VECTROS_API_KEY = 'ssk_live_must_not_reach_child'; // explicitly set — see the sabotage note below
  const { childEnv } = await fresh();
  const env = childEnv();
  eq('the resolved OAuth token is injected', env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-child-env-test');
  check('an unlisted env var never reaches the child', env.SOME_RANDOM_SECRET === undefined);
  // VECTROS_API_KEY is set above SPECIFICALLY so this assertion is red-testable — an omitted var is
  // indistinguishable from a var that was never set, so a sabotage that spreads `...process.env`
  // into the child (RED-PROVEN against `childEnv()` while writing this file) must be caught here.
  check('VECTROS_API_KEY is never passed to the child (the worker must not make its own Vectros call)',
    env.VECTROS_API_KEY === undefined);
  restore();
}

done();
