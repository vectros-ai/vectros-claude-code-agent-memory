#!/usr/bin/env node
/**
 * RED-PROOF for the recall-query cap.
 *
 * THE BUG, verified: `recall.mjs` built its outbound `/v1/search` body from `input.prompt`
 * UNCAPPED. A big pasted diff/log/review-note pushes the JSON body past the API's own 8KB
 * request-body-size cap on `/v1/search` → the real route returns 413 → `search()`'s existing
 * fail-open turns that into a silently-empty result set.
 *
 * This file cannot hit the real API from a unit test, so it proves the thing the size cap's
 * enforcement actually depends on: the ACTUAL outbound request body recall.mjs and recall-eval-worker.mjs
 * build is bounded well under 8192 bytes, for input that is FAR larger than the cap — using the
 * SAME stub-server-plus-real-process technique orient-boundary-test.mjs established, so this
 * exercises the unmodified hook's own fetch path, not a mock of the assumption.
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
const SID = 'recall-query-cap-test-0001';
const SP = stateFor(SID);

// Self-redirect before anything can hlog(); avoids landing this test's own clamp receipts
// in production hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cap-log-')), 'hooks.log');

const { RECALL_QUERY_MAX_CHARS, clampQuery } = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE PURE FUNCTION — clampQuery itself, and the request-size byte-budget it must respect.
// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 1. clampQuery(): the single-sourced bound ===');
{
  eq('short text passes through unchanged', clampQuery('hello'), 'hello');
  eq('null -> empty string, not "null"', clampQuery(null), '');
  eq('undefined -> empty string', clampQuery(undefined), '');
  const atMax = 'a'.repeat(RECALL_QUERY_MAX_CHARS);
  eq('text at EXACTLY the cap is untouched', clampQuery(atMax), atMax);
  const overMax = 'a'.repeat(RECALL_QUERY_MAX_CHARS + 5000);
  const clamped = clampQuery(overMax);
  eq('over-cap text is truncated to EXACTLY the cap', clamped.length, RECALL_QUERY_MAX_CHARS);
  check('the truncation keeps the PREFIX (first N chars carry the intent)', overMax.startsWith(clamped));

  // The API's actual request-body-size cap — the number this whole fix exists to stay under.
  const REQUEST_SIZE_CAP_BYTES = 8192;
  // Worst realistic ASCII-ish outbound body: the max-length composed query (prompt+tail, as
  // recall.mjs's search() actually clamps it — NOT clamped separately then concatenated, which
  // would test a different, easier shape than what the real code does) plus JSON structural
  // overhead ({"query":"...","mode":"HYBRID","limit":12}).
  const composedAscii = clampQuery('a'.repeat(RECALL_QUERY_MAX_CHARS + 5000) + '\n' + 'b'.repeat(600));
  const worstBodyAscii = JSON.stringify({ query: composedAscii, mode: 'HYBRID', limit: 12 });
  check(`worst-case ASCII composed body (${worstBodyAscii.length}B) stays under the ${REQUEST_SIZE_CAP_BYTES}B request-size cap`,
    Buffer.byteLength(worstBodyAscii, 'utf8') < REQUEST_SIZE_CAP_BYTES,
    `${Buffer.byteLength(worstBodyAscii, 'utf8')}B >= ${REQUEST_SIZE_CAP_BYTES}B`);

  /**
   * THE BYTE-SAFETY-NET RED-PROOF (review finding, 2026-07-22). A char-only cap is FALSE
   * ADVERTISING against a byte-count limit: MEASURED, `RECALL_QUERY_MAX_CHARS` (4000) of
   * CJK text is only 4000 UTF-16 code units but ~12000 UTF-8 bytes — the char clamp alone passes
   * this straight through, and the composed body would 413 exactly like the bug this fix exists to
   * prevent. `clampQuery`'s byte backstop must catch what the char clamp misses.
   */
  const cjkOverCap = '中'.repeat(RECALL_QUERY_MAX_CHARS + 2000); // each char is 3 bytes in UTF-8
  const cjkClamped = clampQuery(cjkOverCap);
  check('precondition: unclamped CJK text really would blow the byte budget (proves this is a real case, not a strawman)',
    Buffer.byteLength(JSON.stringify(cjkOverCap), 'utf8') > REQUEST_SIZE_CAP_BYTES);
  check('CJK text is clamped SHORTER than the char cap (the byte backstop, not the char one, is what bound it)',
    cjkClamped.length < RECALL_QUERY_MAX_CHARS, `${cjkClamped.length}c — expected well under ${RECALL_QUERY_MAX_CHARS}c`);
  const cjkBody = JSON.stringify({ query: cjkClamped, mode: 'HYBRID', limit: 12 });
  check(`CJK-heavy composed body (${Buffer.byteLength(cjkBody, 'utf8')}B) stays under the ${REQUEST_SIZE_CAP_BYTES}B request-size cap`,
    Buffer.byteLength(cjkBody, 'utf8') < REQUEST_SIZE_CAP_BYTES);
  check('the byte-safe clamp never splits a codepoint — the JSON round-trips to the same string, not mojibake',
    JSON.parse(cjkBody).query === cjkClamped);

  // Mixed content (ASCII + emoji, astral-plane codepoints that are UTF-16 SURROGATE PAIRS) — the
  // case a naive UTF-16 `.slice()`-based byte clamp would split mid-codepoint.
  const emojiOverCap = ('log line with an emoji marker 🎉 repeated many times — '.repeat(150));
  const emojiClamped = clampQuery(emojiOverCap);
  const emojiBody = JSON.stringify({ query: emojiClamped, mode: 'HYBRID', limit: 12 });
  check('an astral-plane-heavy (surrogate-pair) query also stays under the byte threshold',
    Buffer.byteLength(emojiBody, 'utf8') < REQUEST_SIZE_CAP_BYTES, `${Buffer.byteLength(emojiBody, 'utf8')}B`);
  check('and no surrogate pair was split — valid JSON round-trip, no lone/broken surrogate',
    JSON.parse(emojiBody).query === emojiClamped);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1b. THE WAF-BLOCK RED-PROOF. clampQuery must strip harness-tag markup, precisely enough
// to not corrupt this codebase's own Java/TS generic syntax — verified against the ACTUAL shape
// measured live: 13 `search HTTP 403`s in 48 hours, every one with tag-shaped content in its
// logged query excerpt (`<task-notification>`/`<tool-use-id>`, Claude Code's own hook-payload
// markup — stashed verbatim into state.lastAssistant by stop.mjs, with nothing stripping it
// before it became part of an outbound /v1/search body).
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 1b. clampQuery(): strips harness-tag markup without corrupting real content ===');
{
  // The actual measured shape (abbreviated from a real logged `shape=` excerpt).
  const withNotification = 'What should I do next?\n<task-notification>\n<task-id>abc123</task-id>\n'
    + '<tool-use-id>toolu_01Px</tool-use-id>\n<status>completed</status>\n</task-notification>';
  const stripped = clampQuery(withNotification);
  check('the opening task-notification tag is gone', !/<task-notification>/.test(stripped), stripped);
  check('the closing task-notification tag is gone', !/<\/task-notification>/.test(stripped), stripped);
  check('the nested tool-use-id tags are gone too (every tag, not just the outer one)',
    !/<tool-use-id>/.test(stripped) && !/<\/tool-use-id>/.test(stripped), stripped);
  check('the real question text survives', stripped.includes('What should I do next?'), stripped);
  // The inner tag CONTENT (ids, statuses) is allowed to survive — only the delimiters are the WAF
  // risk; stripping the whole block would throw away real (if noisy) signal for no safety benefit.
  check('inner tag content is preserved, not thrown away wholesale', stripped.includes('abc123'), stripped);

  // The false-positive guard this scoping exists for: this codebase's own content is full of
  // legitimate angle-bracket syntax that must NOT be treated as a tag.
  const withGenerics = 'the fix touches List<String> and Map<K, V> in candidates.mjs, plus a check '
    + 'that x < y before z > w';
  eq('Java/TS generic syntax (uppercase type params) survives untouched', clampQuery(withGenerics), withGenerics);

  // A lowercase-initial but genuinely-unclosed `<` (an inequality using a short lowercase name) must
  // not be corrupted either — the regex requires a CLOSING `>` to match at all.
  const withLowercaseCompare = 'is a < b in this context, and separately is b > c';
  eq('a bare lowercase comparison with no closing angle bracket survives untouched',
    clampQuery(withLowercaseCompare), withLowercaseCompare);

  // A tag truncated by the tail's own STASH_CHARS slice (no matching close survives) must still be
  // stripped on its own — each tag matches independently, not as a balanced pair.
  const truncated = 'the last thing that happened was <task-notification>\n<task-id>partial, cut off here';
  const strippedTruncated = clampQuery(truncated);
  check('a lone opening tag with no surviving close is still stripped',
    !/<task-notification>/.test(strippedTruncated), strippedTruncated);
  check('the prose before the truncated tag survives', strippedTruncated.includes('the last thing that happened was'), strippedTruncated);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1c. THE INJECTION-SHAPE RED-PROOF — the residual the harness-tag-stripping fix above left open.
// A prior dogfood measurement found a query carrying path-traversal, SSRF-literal, or
// SQL-comment-idiom shapes trips the WAF's CRS content rules on `/v1/search` exactly like tag
// markup did — this section proves clampQuery now neutralizes all three, and (just as
// importantly) does NOT corrupt the legitimate content that same measurement named as
// false-positive victims (relative markdown links, a security runbook mentioning the metadata
// IP, fenced SQL examples, ordinary CLI `--flag` syntax).
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 1c. clampQuery(): neutralizes path-traversal / SSRF-literal / SQL-comment-idiom shapes ===');
{
  // -- Path traversal (GenericLFI_BODY) --
  const traversal = 'read ../../../etc/passwd to leak secrets';
  const traversalOut = clampQuery(traversal);
  check('the literal "../" byte pattern no longer appears', !traversalOut.includes('../'), traversalOut);
  check('every path segment survives as its own token', ['etc', 'passwd'].every((w) => traversalOut.includes(w)), traversalOut);

  // Must NOT mangle a bare ordinary relative markdown link beyond the same space-insertion —
  // this is the measured false-positive case itself, not a strawman.
  const relLink = 'see ../README.md for the setup steps';
  eq('a relative markdown link gets the same defusing, staying otherwise intact',
    clampQuery(relLink), 'see .. /README.md for the setup steps');

  // -- SSRF literals (EC2MetaDataSSRF_BODY) --
  const metadataIp = 'the SSRF probe hit 169.254.169.254 and read the IAM role';
  const metadataOut = clampQuery(metadataIp);
  check('the literal metadata-IP dotted-quad no longer appears contiguously', !metadataOut.includes('169.254.169.254'), metadataOut);
  check('every octet survives', ['169', '254'].every((w) => metadataOut.includes(w)), metadataOut);

  // This label is not scoped to the metadata IP alone (confirmed via a live sampled-request
  // sweep) — ordinary loopback/localhost dev-workflow text must be defused too.
  const devLoopback = 'the dev server is at 127.0.0.1:3003 (also reachable via localhost)';
  const devLoopbackOut = clampQuery(devLoopback);
  check('the loopback dotted-quad is defused', !devLoopbackOut.includes('127.0.0.1'), devLoopbackOut);
  check('the bare "localhost" hostname is defused', !/\blocalhost\b/.test(devLoopbackOut), devLoopbackOut);
  check('the port number survives', devLoopbackOut.includes('3003'), devLoopbackOut);

  // A security runbook that merely MENTIONS the metadata endpoint (the other measured
  // false-positive class) gets the same defusing, not a differently-scoped one — there is no way
  // to distinguish "mentioning" from "exploiting" at this layer, same as the path-traversal case
  // above.
  const runbookMention = 'the runbook warns that any SSRF reaching 169.254.169.254 discloses IAM creds';
  check('a runbook merely mentioning the metadata IP is defused the same way, not left alone',
    !clampQuery(runbookMention).includes('169.254.169.254'));

  // -- SQL comment-terminator idiom (CrossSiteScripting_BODY via libinjection) --
  // Hex-escaped quotes (\x27/\x22), not literal ' / " — a bare quote inside a `[...]` class here
  // reads to this package's own `blank()` static-scan tooling (paths-test.mjs censuses tests/ too)
  // as an unterminated string and silently blanks the rest of the file. See config.mjs's
  // `SQL_COMMENT_IDIOM_RE` doc comment for the measured incident this avoids repeating.
  const NOT_COMMENT_IDIOM = (out) => !/[\x27\x22]--/.test(out) && !/\)--/.test(out) && !/\d--/.test(out);

  // Digit-adjacent (`1=1--`) — the tautology shape.
  const sqlPayload = "search for admin' OR 1=1-- and see what returns";
  check('the digit-adjacent comment terminator is broken up', NOT_COMMENT_IDIOM(clampQuery(sqlPayload)), clampQuery(sqlPayload));

  // Quote-IMMEDIATELY-adjacent (`admin'--`, no separating text) — the classic auth-bypass shape,
  // and distinct from the case above (there the quote and `--` are separated by " OR 1=1").
  const sqlQuoteAdjacent = "log in as admin'-- and bypass the check";
  check('the quote-immediately-adjacent comment terminator is broken up',
    NOT_COMMENT_IDIOM(clampQuery(sqlQuoteAdjacent)), clampQuery(sqlQuoteAdjacent));

  // Paren-adjacent (`(1)--`) — the statement-close shape.
  const sqlParenAdjacent = 'the payload closed the call with (1)-- to comment out the rest';
  check('the paren-adjacent comment terminator is broken up',
    NOT_COMMENT_IDIOM(clampQuery(sqlParenAdjacent)), clampQuery(sqlParenAdjacent));

  // Must NOT mangle ordinary CLI flag syntax — this codebase's own recall text is dense with it,
  // and a blanket "--"/";" transform was explicitly rejected for exactly this reason.
  const cliFlags = 'run with --verbose --dry-run and check the --output path';
  eq('CLI double-dash flag syntax survives completely untouched', clampQuery(cliFlags), cliFlags);

  // Must NOT mangle a fenced SQL code example — the measured false-positive class this codebase's
  // own conversations (database migration discussions) genuinely produce. A bare SQL keyword or a
  // semicolon with no adjacent quote/paren/digit is intentionally left alone (see
  // neutralizeSqlCommentIdiom's own doc comment for why: libinjection tokenizes past whitespace,
  // so there is no cheap defense for this shape without corrupting real SQL text).
  const fencedSql = 'SELECT * FROM users WHERE id = 1; -- fetch the row';
  eq('a fenced SQL example with no quote/paren-adjacent comment terminator is untouched',
    clampQuery(fencedSql), fencedSql);
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared stub-server harness (orient-boundary-test.mjs's pattern — a real HTTP server, the
// unmodified hook makes real requests against it, the body is what gets asserted).
// ═══════════════════════════════════════════════════════════════════════════
/**
 * `bodies` carries `{url, body}` pairs, not bare body text — as of 2026-08-14 (B2), recall.mjs's
 * own-session nudge ALSO calls the store (`candidates.mjs`'s `addressablePending`, a `POST
 * /v1/records/lookup`) on every steady-state prompt, alongside `/v1/search`. A bare-body capture
 * that assumed every request was a search body crashed on the new one (`parsed.query` undefined —
 * the lookup body has `type`/`field`/`value`, not `query`). Filter by URL, not position.
 */
function withStub(route, fn) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push({ url: req.url, body });
      const r = route(req.url, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  srv.listen(0, '127.0.0.1'); // 127.0.0.1, not "localhost" — Windows resolves ::1 first and hangs
  return new Promise((resolve) => {
    srv.on('listening', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { resolve(await fn(base, bodies)); } finally { srv.close(); }
    });
  });
}

const seedSteadyState = () => {
  fs.mkdirSync(path.dirname(SP), { recursive: true });
  // orientPending:false + promptCount>0 -> isFirstPrompt is false -> the STEADY-STATE single-query
  // path (`search(tail ? ... : prompt, TOP_K)`), the simplest single assertion point for the body.
  fs.writeFileSync(SP, JSON.stringify({ orientPending: false, promptCount: 5, injectedIds: [], lastAssistant: '' }));
};

const runRecall = (base, prompt) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HOOKS, 'recall.mjs')], {
    env: {
      ...process.env, VECTROS_API_BASE_URL: base, VECTROS_API_KEY: 'stub-key-for-test',
      VECTROS_HOOKLOG_PATH: process.env.VECTROS_HOOKLOG_PATH,
    },
  });
  let err = '';
  child.stdout.resume(); // drain stdout (unused here — this test asserts on the stubbed API request, not the hook's own output) so a large write cannot backpressure-stall the child
  child.stderr.on('data', (c) => { err += c; });
  child.stdin.end(JSON.stringify({ session_id: SID, prompt, cwd: os.tmpdir(), hook_event_name: 'UserPromptSubmit' }));
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('close', () => {
    clearTimeout(timer);
    if (/ReferenceError|TypeError|Cannot find|ERR_MODULE/.test(err)) return resolve({ crash: err.trim().split('\n')[0] });
    resolve({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. recall.mjs's REAL search() against a stub server — the actual fetch path, unmodified.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. recall.mjs: an over-cap prompt produces a BOUNDED outbound request body ===');
{
  try { fs.unlinkSync(SP); } catch { /* fresh */ }
  seedSteadyState();
  // A realistic oversized paste — not repeated whitespace (which some backends might collapse
  // differently); this is closer to what a pasted stack trace or diff actually looks like.
  const bigPrompt = Array.from({ length: 2000 }, (_, i) => `line ${i}: something failed at frame ${i} in module x.y.z`).join('\n');
  check('precondition: the synthetic prompt really is over the cap',
    bigPrompt.length > RECALL_QUERY_MAX_CHARS, `${bigPrompt.length}c vs cap ${RECALL_QUERY_MAX_CHARS}c`);

  const r = await withStub(
    (url) => ({ status: 200, body: url === '/v1/search' ? { results: [] } : { data: [], nextCursor: null } }),
    (base, bodies) => runRecall(base, bigPrompt).then((res) => ({ ...res, bodies })),
  );
  check('no crash', !r.crash, r.crash);
  const searchBodies = r.bodies.filter((b) => b.url === '/v1/search').map((b) => b.body);
  check('the hook actually called /v1/search', searchBodies.length > 0, 'no requests reached the stub — this proves nothing');
  for (const b of searchBodies) {
    const parsed = JSON.parse(b);
    check(`outbound query is <= RECALL_QUERY_MAX_CHARS (was ${parsed.query.length}c, prompt was ${bigPrompt.length}c)`,
      parsed.query.length <= RECALL_QUERY_MAX_CHARS);
    check('outbound BODY BYTES stay under the 8192B request-size cap', Buffer.byteLength(b, 'utf8') < 8192, `${Buffer.byteLength(b, 'utf8')}B`);
  }
}

console.log('\n=== 3. recall.mjs: a NORMAL prompt is passed through untouched (no over-eager truncation) ===');
{
  try { fs.unlinkSync(SP); } catch { /* fresh */ }
  seedSteadyState();
  const smallPrompt = 'what is the state of the branch, and what should I work on next?';
  const r = await withStub(
    (url) => ({ status: 200, body: url === '/v1/search' ? { results: [] } : { data: [], nextCursor: null } }),
    (base, bodies) => runRecall(base, smallPrompt).then((res) => ({ ...res, bodies })),
  );
  check('no crash', !r.crash, r.crash);
  const searchBodies = r.bodies.filter((b) => b.url === '/v1/search').map((b) => b.body);
  check('the hook actually called /v1/search', searchBodies.length > 0, 'no requests reached the stub');
  const parsed = searchBodies.length ? JSON.parse(searchBodies[0]) : null;
  eq('a small prompt reaches the API BYTE-FOR-BYTE, not silently altered', parsed && parsed.query, smallPrompt);
}

try { fs.unlinkSync(SP); } catch { /* cleanup */ }

// ═══════════════════════════════════════════════════════════════════════════
// 4. recall-eval-worker.mjs's REAL search() — the mid-run evaluator's query, a previously-known census
//    item explicitly named as absorbed into this cap ("clamp at the shared outbound
//    request boundary... covering recall search AND the mid-run evaluate query").
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. recall-eval-worker.mjs: the mid-run evaluate query is bounded too ===');
{
  const r = await withStub(
    () => ({ status: 200, body: { results: [] } }),
    async (base, bodies) => {
      process.env.VECTROS_API_BASE_URL = base;
      process.env.VECTROS_API_KEY = 'stub-key-for-test';
      // Cache-busted import: BASE is a frozen module-scope const resolved at import time from
      // cred(), so a fresh module instance is required to pick up the env set just above.
      const { search } = await import(pathToFileURL(path.join(HOOKS, 'recall-eval-worker.mjs')).href + `?t=${Date.now()}`);
      const overCapQuery = 'x'.repeat(RECALL_QUERY_MAX_CHARS + 3000);
      await search(overCapQuery);
      return { bodies };
    },
  );
  const searchBodies = r.bodies.filter((b) => b.url === '/v1/search').map((b) => b.body);
  check('the worker actually called /v1/search', searchBodies.length > 0, 'no requests reached the stub');
  const parsed = searchBodies.length ? JSON.parse(searchBodies[0]) : null;
  check('the worker\'s outbound query is bounded too (single-sourced clampQuery)',
    parsed && parsed.query.length <= RECALL_QUERY_MAX_CHARS,
    parsed ? `${parsed.query.length}c` : 'no request captured');
}

done();
