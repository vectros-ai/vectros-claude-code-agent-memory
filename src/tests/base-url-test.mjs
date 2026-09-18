#!/usr/bin/env node
/**
 * RED-PROOF: `base-url.mjs`'s Vectros-host allow-list, and its wiring into `creds.mjs`'s
 * `cred('VECTROS_API_BASE_URL')` — the credential-exfil guard for the six network call sites that
 * read this value (recall.mjs, candidates.mjs, dispose.mjs, enumerate.mjs, project.mjs,
 * recall-eval-worker.mjs).
 *
 * `cred()` memoizes the file tier per module instance (`cachedFile` in creds.mjs), so every case
 * that touches the file tier re-imports CACHE-BUSTED — same pattern `creds-keyring-test.mjs` uses.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs'; // isolated runtime root + hooks.log — see its own header
import { validateApiBaseUrl, INSECURE_BASE_URL_ENV } from '../base-url.mjs';
import { logPath } from '../hooklog.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived
const freshCreds = async () => import(pathToFileURL(path.join(DIR, 'creds.mjs')).href + `?t=${Date.now()}${Math.random()}`);

const SAVED = { ...process.env };
function restore() {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. validateApiBaseUrl() — the allow-list itself, no cred()/env involved.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. validateApiBaseUrl: the host allow-list ===');
{
  delete process.env[INSECURE_BASE_URL_ENV];
  eq('official apex accepted', validateApiBaseUrl('https://vectros.ai'), 'https://vectros.ai');
  eq('*.vectros.ai subdomain accepted', validateApiBaseUrl('https://api.vectros.ai'), 'https://api.vectros.ai');
  eq('loopback http accepted', validateApiBaseUrl('http://localhost:4000'), 'http://localhost:4000');
  eq('loopback 127.0.0.1 http accepted', validateApiBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  eq('non-loopback http REFUSED (undefined, not thrown)', validateApiBaseUrl('http://api.vectros.ai'), undefined);
  eq('arbitrary https host REFUSED', validateApiBaseUrl('https://collector.attacker.example'), undefined);
  eq('suffix-confusable host REFUSED (api.vectros.ai.evil.com)', validateApiBaseUrl('https://api.vectros.ai.evil.com'), undefined);
  eq('apex-confusable host REFUSED (evilvectros.ai)', validateApiBaseUrl('https://evilvectros.ai'), undefined);
  eq('unparseable URL REFUSED, not thrown', validateApiBaseUrl('not a url'), undefined);
}

console.log('\n=== 2. validateApiBaseUrl: the loud opt-out ===');
{
  process.env[INSECURE_BASE_URL_ENV] = '1';
  eq('opt-out permits an arbitrary https host', validateApiBaseUrl('https://collector.attacker.example'), 'https://collector.attacker.example');
  eq('opt-out permits plain http too', validateApiBaseUrl('http://collector.attacker.example'), 'http://collector.attacker.example');
  eq('opt-out still refuses a non-http(s) scheme', validateApiBaseUrl('file:///etc/passwd'), undefined);
  delete process.env[INSECURE_BASE_URL_ENV];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. cred('VECTROS_API_BASE_URL') — env tier: an attacker-controlled override falls open to '',
//    which every real call site turns into the safe default, NOT the attacker's URL.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. cred(VECTROS_API_BASE_URL): env tier is validated, fails open to \'\' ===');
{
  process.env.VECTROS_API_BASE_URL = 'https://collector.attacker.example';
  const { cred } = await freshCreds();
  eq('an untrusted env override never reaches a caller — falls open to \'\'', cred('VECTROS_API_BASE_URL'), '');
  restore();
}
{
  process.env.VECTROS_API_BASE_URL = 'https://api.vectros.ai';
  const { cred } = await freshCreds();
  eq('a trusted env override is returned verbatim', cred('VECTROS_API_BASE_URL'), 'https://api.vectros.ai');
  restore();
}
{
  process.env.VECTROS_API_BASE_URL = 'http://collector.attacker.example';
  const { cred } = await freshCreds();
  eq('plain http to a non-loopback host never reaches a caller either', cred('VECTROS_API_BASE_URL'), '');
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. cred('VECTROS_API_BASE_URL') — the plaintext credentials.json fallback tier (`cred()`'s other
//    read path for this name) gets the SAME guard, not just the env var.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. cred(VECTROS_API_BASE_URL): the file tier is validated too ===');
{
  delete process.env.VECTROS_API_BASE_URL;
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-baseurl-'));
  const credsFile = path.join(credsDir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify({ VECTROS_API_BASE_URL: 'https://collector.attacker.example' }));
  process.env.VECTROS_HOOK_CREDENTIALS = credsFile;
  const { cred } = await freshCreds();
  eq('an untrusted file-tier value never reaches a caller — falls open to \'\'', cred('VECTROS_API_BASE_URL'), '');
  restore();
}
{
  delete process.env.VECTROS_API_BASE_URL;
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-baseurl-'));
  const credsFile = path.join(credsDir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify({ VECTROS_API_BASE_URL: 'https://api.vectros.ai' }));
  process.env.VECTROS_HOOK_CREDENTIALS = credsFile;
  const { cred } = await freshCreds();
  eq('a trusted file-tier value is returned verbatim', cred('VECTROS_API_BASE_URL'), 'https://api.vectros.ai');
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Every real call site's own fallback (`cred(...) || 'https://api.vectros.ai'`) actually lands on
//    the real default once cred() itself falls open — proving the two halves compose, not just each
//    in isolation.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. the real call-site pattern composes: refused override -> the real default ===');
{
  process.env.VECTROS_API_BASE_URL = 'https://collector.attacker.example';
  const { cred } = await freshCreds();
  const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');
  check('the attacker host never becomes BASE', BASE === 'https://api.vectros.ai', BASE);
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Precedence survives validation: env wins over the file tier when BOTH are set to DIFFERENT
//    (here, both trusted) values — proving the two new validation call sites didn't accidentally
//    swap which tier wins, not just that each tier is independently validated.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 6. env still wins over the file tier when both are set ===');
{
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-baseurl-'));
  const credsFile = path.join(credsDir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify({ VECTROS_API_BASE_URL: 'https://vectros.ai' }));
  process.env.VECTROS_HOOK_CREDENTIALS = credsFile;
  process.env.VECTROS_API_BASE_URL = 'https://api.vectros.ai';
  const { cred } = await freshCreds();
  eq('env value wins even though the file tier also holds a trusted value', cred('VECTROS_API_BASE_URL'), 'https://api.vectros.ai');
  restore();
}
{
  // And precedence holds in the security-relevant direction too: an UNTRUSTED env value falls
  // open to '' rather than falling through to a trusted file value sitting behind it — cred()'s
  // env branch returns unconditionally once `env` is truthy, it never "tries the next tier" on
  // a refusal.
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-baseurl-'));
  const credsFile = path.join(credsDir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify({ VECTROS_API_BASE_URL: 'https://api.vectros.ai' }));
  process.env.VECTROS_HOOK_CREDENTIALS = credsFile;
  process.env.VECTROS_API_BASE_URL = 'https://collector.attacker.example';
  const { cred } = await freshCreds();
  eq('a refused env value falls open to \'\' — it does not fall through to the file tier', cred('VECTROS_API_BASE_URL'), '');
  restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. STATIC census: every one of the six real hook files still routes VECTROS_API_BASE_URL
//    through cred() rather than reading process.env / the credentials file directly. The
//    six lines are byte-identical today, so testing the pattern once (sections 3-6 above)
//    proves nothing about a FUTURE edit to just one file reintroducing the raw read there —
//    this is the mechanical backstop for that.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 7. static census: all six hook files still route through cred() ===');
{
  const HOOK_FILES = [
    'recall.mjs', 'candidates.mjs', 'dispose.mjs', 'enumerate.mjs', 'project.mjs', 'recall-eval-worker.mjs',
  ];
  for (const f of HOOK_FILES) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    check(`${f}: computes BASE via cred('VECTROS_API_BASE_URL')`, /cred\(\s*['"]VECTROS_API_BASE_URL['"]\s*\)/.test(src));
    // A raw process.env read of this name, anywhere in the file, would bypass the guard —
    // whether or not it's the one feeding BASE. None of the six should ever have one.
    check(`${f}: no direct process.env.VECTROS_API_BASE_URL read (would bypass validation)`,
      !/process\.env(?:\.VECTROS_API_BASE_URL|\[\s*['"]VECTROS_API_BASE_URL['"]\s*\])/.test(src));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. hlog side effect: a refusal actually writes the receipt, not just returns undefined.
//    hooklog.mjs is deliberately fail-open (never throws), so a broken hlog call inside
//    validateApiBaseUrl would otherwise be invisible to every test above.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 8. a refusal writes an hlog receipt ===');
{
  const before = (() => { try { return fs.readFileSync(logPath(), 'utf8'); } catch { return ''; } })();
  const result = validateApiBaseUrl('https://collector.attacker.example');
  eq('refused as expected', result, undefined);
  const after = fs.readFileSync(logPath(), 'utf8');
  check('hlog wrote a new line naming the refused host', after.length > before.length && after.includes('collector.attacker.example'));
}

done();
