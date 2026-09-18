#!/usr/bin/env node
/**
 * The resume thread-lookup investigation, pinned down as regression coverage.
 *
 * The header comment above `fetchOrientSet` in enumerate.mjs records the finding: the "persistent
 * shape/validation 400 on {field:'threadId'}" hypothesis did NOT reproduce (verified —
 * live `list_schemas` shows `threadId` correctly lookup-indexed as exact-match; a direct live call
 * succeeded; all 71 historical "thread lookup FAILED" lines across every retained hooks.log
 * generation trace to `orient-boundary-test.mjs`'s own stub server, not production).
 *
 * This file exists so that finding does not silently rot: it pins the REQUEST SHAPE the schema
 * actually requires (exact `value`, never `from`/`to` — a future edit that "fixes" the lookup into
 * range mode would be reintroducing the exact 400 the original hypothesis wrongly blamed on the
 * API), and RED-proves the receipt-widening (requestId/x-amz-cf-id/request-body shape) that
 * makes a FUTURE real failure, if one ever occurs, immediately diagnosable — unlike this one, whose
 * investigation took reading five log generations because the original receipt only had a status
 * code and 200 chars of response body.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived

// Isolate this file's receipts from production hooks.log.
const LOGP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enum-shape-log-')), 'hooks.log');
process.env.VECTROS_HOOKLOG_PATH = LOGP;
const since = (at) => { try { return fs.readFileSync(LOGP).slice(at).toString('utf8'); } catch { return ''; } };
const logSize = () => { try { return fs.statSync(LOGP).size; } catch { return 0; } };

function withStub(route, fn) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(body);
      const r = route(req.url, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  srv.listen(0, '127.0.0.1'); // 127.0.0.1, not "localhost" — Windows resolves ::1 first and hangs
  return new Promise((resolve) => {
    srv.on('listening', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const prev = { url: process.env.VECTROS_API_BASE_URL, key: process.env.VECTROS_API_KEY };
      process.env.VECTROS_API_BASE_URL = base;
      process.env.VECTROS_API_KEY = 'stub-key-for-test';
      try { resolve(await fn(bodies)); }
      finally {
        srv.close();
        if (prev.url === undefined) delete process.env.VECTROS_API_BASE_URL; else process.env.VECTROS_API_BASE_URL = prev.url;
        if (prev.key === undefined) delete process.env.VECTROS_API_KEY; else process.env.VECTROS_API_KEY = prev.key;
      }
    });
  });
}

console.log('=== 1. the resume thread-lookup body is EXACT-MATCH (value:), never range (from:/to:) ===');
{
  const r = await withStub(
    () => ({ status: 200, body: { data: [] } }),
    async (bodies) => {
      const { fetchOrientSet } = await import(pathToFileURL(path.join(HOOKS, 'enumerate.mjs')).href + `?t=${Date.now()}`);
      const out = await fetchOrientSet('resume-shape-test-sid', 'resume');
      return { bodies, out };
    },
  );
  check('two lookups fired (pinned + thread)', r.bodies.length === 2, `got ${r.bodies.length}`);
  const threadBody = r.bodies.map((b) => JSON.parse(b)).find((b) => b.field === 'threadId');
  check('a threadId lookup was actually sent', !!threadBody, JSON.stringify(r.bodies));
  if (threadBody) {
    eq('field is threadId', threadBody.field, 'threadId');
    eq('mode is EXACT (value), matching the schema\'s rangeEnabled:false declaration', threadBody.value, 'resume-shape-test-sid');
    check('NEVER from/to — that shape is for RANGE-enabled fields (e.g. priority), and threadId is not one',
      threadBody.from === undefined && threadBody.to === undefined, JSON.stringify(threadBody));
  }
  eq('the (fabricated, no-match) session genuinely has no thread — ok stays true, not a failure', r.out.ok, true);
}

console.log('\n=== 2. the widened receipt on a lookup failure (requestId / x-amz-cf-id / body shape) ===');
{
  const at = logSize();
  const WAF_400 = {
    status: 400,
    body: { code: 'VALIDATION_ERROR', message: 'field is not lookup-indexed', requestId: null },
    headers: { 'x-amz-cf-id': 'ENUM-CF-ID-xyz789==' },
  };
  const r = await withStub(
    (url) => (url.includes('/records/lookup') ? WAF_400 : { status: 200, body: { results: [] } }),
    async () => {
      const { fetchOrientSet } = await import(pathToFileURL(path.join(HOOKS, 'enumerate.mjs')).href + `?t=${Date.now()}`);
      return fetchOrientSet('resume-shape-test-sid-2', 'resume');
    },
  );
  eq('a failed pinned lookup (the CORE) reports ok:false — the orientation is still owed', r.ok, false);
  const fresh = since(at);
  check('the receipt captures the x-amz-cf-id header', /cfId=ENUM-CF-ID-xyz789==/.test(fresh), fresh.slice(0, 800));
  check('the receipt captures requestId (null, the edge-block shape)', /requestId=\(null\)|requestId=null/.test(fresh), fresh.slice(0, 800));
  check('a 400 specifically captures a redacted request-BODY shape (what we actually sent)',
    /reqBody="/.test(fresh), fresh.slice(0, 800));
}

done();
