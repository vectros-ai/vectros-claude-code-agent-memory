/**
 * A minimal, in-memory double for the Vectros records API — the surface `candidates.mjs` and
 * `dispose.mjs`'s own `recordExists()` actually call over HTTP: `POST /v1/records?upsert=true`,
 * `POST /v1/records/lookup`, `GET /v1/records/:id`, `PATCH /v1/records/:id`.
 *
 * WHY A REAL LOCAL SERVER, NOT AN INJECTED `fetchImpl`. `candidates-test.mjs` already covers
 * `candidates.mjs`'s exported functions in-process with a fake `fetchImpl` — that is the right
 * tool for testing candidates.mjs ITSELF. But `dispose.mjs` (as of 2026-08-14, B2) is exercised as
 * a real SUBPROCESS via `spawnSync` (dispose-test.mjs, nudge-test.mjs via recall.mjs), and a
 * subprocess has no way to receive an injected function from its parent test. Pointing
 * `VECTROS_API_BASE_URL` at a real local HTTP server lets the full real code run unmodified —
 * candidates.mjs's actual `fetch()`, dispose.mjs's own direct `fetch()` calls — which is MORE
 * faithful than mocking candidates.mjs's exports would have been, not less.
 *
 * Deliberately small: enough of the wire contract to drive every branch these two test files
 * exercise, not a general-purpose Vectros API simulator. If a future test needs a shape this
 * doesn't support, extend it here rather than reaching for a second fake elsewhere.
 */
import http from 'node:http';
import crypto from 'node:crypto';

/** Monotonic ms-precision timestamps, even for records minted in the same synchronous tick — the
 * real store's `createdAt` is what `withOrdinals` sorts by, and two records created back-to-back
 * in a test must not tie (a tie falls through to the externalId tiebreak, which is fine, but a
 * test asserting ARRIVAL order needs a real ordering to assert against). */
let clock = Date.now();
function nextTimestamp() {
  clock += 1;
  return new Date(clock).toISOString();
}

/**
 * A real UUID, not `fake-rec-N`. dispose.mjs's own `recordExists()` and `coveredExists()` gate a
 * `stored:`/`covered:` citation on `/^[0-9a-f-]{16,}$/i.test(id)` to decide "is this a record id or
 * a path" — a real Vectros record id is always this shape, so a sequential test-only id would take
 * the WRONG branch (treated as a path, refused as "does not exist") and every citation-acceptance
 * case would silently fail on a test-fixture artifact, not the logic under test.
 */
function nextId() { return crypto.randomUUID(); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

/** Deep-enough JSON MERGE PATCH (RFC 7386) for flat payload objects — a `null` value deletes the
 * key, matching the real store's documented behavior (candidates.mjs's `patch()` header). */
function mergePatch(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * Start the fake server. Returns `{ url, close, store }` — `store` is the live `Map<id, record>`,
 * exposed so a test can seed/inspect state directly without a round trip when that's simpler.
 */
export function startFakeRecordsServer() {
  const store = new Map(); // id -> { id, typeName, externalId, payload, createdAt, updatedAt }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // POST /v1/records?upsert=true — create, or upsert by (typeName, externalId).
    if (req.method === 'POST' && url.pathname === '/v1/records') {
      const body = await readBody(req);
      const { typeName, externalId, payload } = body;
      if (externalId) {
        const existing = [...store.values()].find((r) => r.typeName === typeName && r.externalId === externalId);
        if (existing) {
          existing.payload = { ...existing.payload, ...payload };
          existing.updatedAt = nextTimestamp();
          return send(res, 200, shape(existing));
        }
      }
      const rec = { id: nextId(), typeName, externalId: externalId ?? null, payload: { ...payload }, createdAt: nextTimestamp(), updatedAt: null };
      store.set(rec.id, rec);
      return send(res, 201, shape(rec));
    }

    // POST /v1/records/lookup — filter by type + one field (or a declared composite pair).
    if (req.method === 'POST' && url.pathname === '/v1/records/lookup') {
      const body = await readBody(req);
      const { type, field, value, values, from, to, limit } = body;
      let rows = [...store.values()].filter((r) => r.typeName === type);
      if (field && field.includes(',')) {
        const fields = field.split(',');
        const vals = Array.isArray(values) ? values : [value];
        rows = rows.filter((r) => fields.every((f, i) => String(r.payload[f] ?? '') === String(vals[i])));
      } else if (field && (from !== undefined || to !== undefined)) {
        rows = rows.filter((r) => {
          const v = String(r.payload[field] ?? '');
          return (from === undefined || v >= from) && (to === undefined || v <= to);
        });
      } else if (field && value !== undefined) {
        rows = rows.filter((r) => String(r.payload[field] ?? '') === String(value));
      }
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const page = rows.slice(0, limit || rows.length).map(shape);
      return send(res, 200, { data: page, nextCursor: null });
    }

    // POST /v1/search — recall.mjs's hybrid-search call. Every consumer of this fake server is
    // exercising the CANDIDATE-NUDGE path, never real search relevance, so a fixed empty result is
    // the right stub: recall.mjs is fail-open on this call by design (0 hits reads as "an error or
    // an empty index", never as a reason to break the turn), so returning `{results: []}` exercises
    // exactly that path — the steady-state branch proceeds with zero hits, same as a healthy but
    // empty tenant would produce.
    if (req.method === 'POST' && url.pathname === '/v1/search') {
      await readBody(req);
      return send(res, 200, { results: [] });
    }

    const idMatch = url.pathname.match(/^\/v1\/records\/([^/]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      const rec = store.get(id);
      if (req.method === 'GET') {
        if (!rec) return send(res, 404, { message: `no such record ${id}` });
        return send(res, 200, shape(rec));
      }
      if (req.method === 'PATCH') {
        if (!rec) return send(res, 404, { message: `no such record ${id}` });
        const body = await readBody(req);
        rec.payload = mergePatch(rec.payload, body.payload || {});
        rec.updatedAt = nextTimestamp();
        return send(res, 200, shape(rec));
      }
    }

    send(res, 404, { message: `fake-records-server: no route for ${req.method} ${url.pathname}` });
  });

  function shape(rec) {
    return { id: rec.id, typeName: rec.typeName, externalId: rec.externalId, payload: rec.payload, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        /**
         * `server.close()` ALONE stops accepting NEW connections but does not end EXISTING ones —
         * an idle keep-alive socket left open by `fetch()`'s own connection pooling (undici) keeps
         * a listening server, and therefore the WHOLE process's event loop, alive regardless.
         * `closeAllConnections()` (Node 18.2+) forces every open connection closed immediately, so
         * this promise resolves promptly rather than waiting on a keep-alive timeout (or never, if
         * something reuses the connection first) — found live: a test file that skipped calling
         * `close()` at all hung indefinitely the moment something ELSE spawned it and waited on its
         * stdio pipes actually closing (`run-all.mjs`'s `spawnSync`), invisible when run directly
         * from a shell. Calling `close()` is still necessary (this file's caller's job); THIS fixes
         * the case where `close()` itself doesn't finish promptly even when called.
         */
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
        /** Seed a record directly, bypassing HTTP — for test setup that doesn't need to exercise
         * the propose path itself. Returns the created record (full shape, incl. `id`). */
        seed(typeName, fields) {
          const rec = {
            id: nextId(), typeName, externalId: fields.externalId ?? null,
            payload: { ...fields }, createdAt: nextTimestamp(), updatedAt: null,
          };
          store.set(rec.id, rec);
          return shape(rec);
        },
      });
    });
  });
}
