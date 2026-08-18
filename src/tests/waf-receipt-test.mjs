#!/usr/bin/env node
/**
 * THE WIDENED ERROR RECEIPT. Before this fix, `recall.mjs`'s search-error log line was
 * `status + 200 chars of body` — enough to see a 413, not enough to DIAGNOSE a 403: a fronting
 * WAF's own documented error contract puts `requestId: null` in the STATIC block body, so the real
 * correlator (the CloudFront `x-amz-cf-id` response header, the id a WAF sampled-requests lookup
 * actually keys on) was never captured, and there was no query-BYTE-length or 403-shape signal to
 * eyeball whether this looks like a WAF content-inspection rule firing on legitimate search input
 * — exactly the kind of gap that lets one environment's fronting infrastructure silently reject a
 * request shape another environment's would pass, with no signal pointing at why.
 *
 * This stands up a stub server that returns a WAF-SHAPED 403 (JSON body with requestId:null, plus
 * an x-amz-cf-id header) against the REAL recall.mjs/recall-eval-worker.mjs search paths, and reads
 * the actual hooks.log line each one wrote.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { stateFor } from '../paths.mjs';

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const SID = 'waf-receipt-test-0001';
const SP = stateFor(SID);

// Isolate this file's own receipts from a real deployment's hooks.log.
const LOGP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waf-receipt-log-')), 'hooks.log');
process.env.VECTROS_HOOKLOG_PATH = LOGP;
const since = (at) => { try { return fs.readFileSync(LOGP).slice(at).toString('utf8'); } catch { return ''; } };
const logSize = () => { try { return fs.statSync(LOGP).size; } catch { return 0; } };

function withStub(route, fn) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = route(req.url, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  srv.listen(0, '127.0.0.1'); // 127.0.0.1, not "localhost" — Windows resolves ::1 first and hangs
  return new Promise((resolve) => {
    srv.on('listening', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { resolve(await fn(base)); } finally { srv.close(); }
    });
  });
}

// The WAF's documented uniform error contract's SHAPE for an edge-authored block: requestId is null
// (the edge never had a real API request to attach an id to).
const WAF_403 = { status: 403, body: { code: 'FORBIDDEN', message: 'Request blocked', requestId: null }, headers: { 'x-amz-cf-id': 'FAKE-CF-ID-abc123XYZ==' } };

console.log('=== 1. recall.mjs: a WAF-shaped 403 leaves a receipt naming cfId, requestId, byte length, and shape ===');
{
  try { fs.unlinkSync(SP); } catch { /* fresh */ }
  fs.mkdirSync(path.dirname(SP), { recursive: true });
  fs.writeFileSync(SP, JSON.stringify({ orientPending: false, promptCount: 5, injectedIds: [], lastAssistant: '' }));

  const at = logSize();
  const r = await withStub(
    () => WAF_403,
    (base) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(HOOKS, 'recall.mjs')], {
        env: { ...process.env, VECTROS_API_BASE_URL: base, VECTROS_API_KEY: 'stub-key-for-test', VECTROS_HOOKLOG_PATH: LOGP },
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.stdin.end(JSON.stringify({ session_id: SID, prompt: 'a normal prompt', cwd: os.tmpdir(), hook_event_name: 'UserPromptSubmit' }));
      const timer = setTimeout(() => child.kill(), 30000);
      child.on('close', () => { clearTimeout(timer); resolve({ crash: /ReferenceError|TypeError|Cannot find/.test(err) ? err : null }); });
    }),
  );
  check('no crash', !r.crash, r.crash);
  const fresh = since(at);
  check('the receipt fires at all', /search HTTP 403/.test(fresh), fresh.slice(0, 600));
  check('it captures the x-amz-cf-id header (the real correlator for a WAF sampled-requests lookup)',
    /cfId=FAKE-CF-ID-abc123XYZ==/.test(fresh), fresh.slice(0, 600));
  check('it captures requestId (null, per the documented edge-block shape)',
    /requestId=\(null\)|requestId=null/.test(fresh), fresh.slice(0, 600));
  check('it captures the outgoing query BYTE length', /queryBytes=\d+/.test(fresh), fresh.slice(0, 600));
  check('on a 403 specifically, it captures a redacted SHAPE of what was sent',
    /shape="/.test(fresh), fresh.slice(0, 600));
  check('the shape does not dump the whole prompt (bounded, not the full body)',
    !fresh.includes('a normal prompt'.repeat(1)) || fresh.match(/shape="[^"]{0,90}"/),
    'the shape excerpt should be short, not the full prompt verbatim at unbounded length');
}

console.log('\n=== 2. recall.mjs: a plain 413 (no WAF headers) still gets the widened fields, gracefully ===');
{
  try { fs.unlinkSync(SP); } catch { /* fresh */ }
  fs.writeFileSync(SP, JSON.stringify({ orientPending: false, promptCount: 5, injectedIds: [], lastAssistant: '' }));
  const at = logSize();
  const r = await withStub(
    () => ({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'too large' } }), // no x-amz-cf-id
    (base) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(HOOKS, 'recall.mjs')], {
        env: { ...process.env, VECTROS_API_BASE_URL: base, VECTROS_API_KEY: 'stub-key-for-test', VECTROS_HOOKLOG_PATH: LOGP },
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.stdin.end(JSON.stringify({ session_id: SID, prompt: 'another prompt', cwd: os.tmpdir(), hook_event_name: 'UserPromptSubmit' }));
      const timer = setTimeout(() => child.kill(), 30000);
      child.on('close', () => { clearTimeout(timer); resolve({ crash: /ReferenceError|TypeError|Cannot find/.test(err) ? err : null }); });
    }),
  );
  check('no crash', !r.crash, r.crash);
  const fresh = since(at);
  check('a missing x-amz-cf-id header degrades to "(none)", not a crash or a dropped line',
    /cfId=\(none\)/.test(fresh), fresh.slice(0, 600));
  check('a 413 does NOT carry the 403-only shape field (that field is deliberately conditional)',
    !/shape="/.test(fresh), fresh.slice(0, 600));
}

/**
 * #3 — recall-eval-worker.mjs. Sections 1-2 above only ever exercised recall.mjs, despite this
 * file's own header claiming both — a real gap (testing-adequacy review finding, 2026-07-22): the
 * identical widened-receipt code landed in BOTH files' search(), and only one had a test. Direct
 * import (not a full worker spawn, which needs a real transcript + a real `claude -p` call to reach
 * search() at all) exercises exactly the code that changed, at the right scope.
 */
console.log('\n=== 3. recall-eval-worker.mjs: the SAME widened receipt on its search() ===');
{
  const at = logSize();
  const r = await withStub(
    () => WAF_403,
    async (base) => {
      process.env.VECTROS_API_BASE_URL = base;
      process.env.VECTROS_API_KEY = 'stub-key-for-test';
      // Cache-busted import: BASE/API_KEY are frozen module-scope consts resolved at import time
      // from cred(), so a fresh module instance is required to pick up the env just set.
      const { search } = await import(pathToFileURL(path.join(HOOKS, 'recall-eval-worker.mjs')).href + `?t=${Date.now()}`);
      const hits = await search('a normal worker query');
      return { hits };
    },
  );
  eq('a WAF-blocked search returns [] (fail-open), not a throw', Array.isArray(r.hits) && r.hits.length, 0);
  const fresh = since(at);
  check('the receipt fires at all', /search HTTP 403/.test(fresh), fresh.slice(0, 600));
  check('it captures the x-amz-cf-id header', /cfId=FAKE-CF-ID-abc123XYZ==/.test(fresh), fresh.slice(0, 600));
  check('it captures requestId (null, the edge-block shape)', /requestId=\(null\)|requestId=null/.test(fresh), fresh.slice(0, 600));
  check('it captures the outgoing query BYTE length', /queryBytes=\d+/.test(fresh), fresh.slice(0, 600));
  check('on a 403 specifically, it captures a redacted SHAPE of what was sent', /shape="/.test(fresh), fresh.slice(0, 600));
}

try { fs.unlinkSync(SP); } catch { /* cleanup */ }
done();
