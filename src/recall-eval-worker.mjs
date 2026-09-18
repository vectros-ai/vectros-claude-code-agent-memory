#!/usr/bin/env node
/**
 * Mid-run background recall evaluator (detached worker).
 *
 * Spawned fire-and-forget by evaluate.mjs (the PostToolUse hook), off the hot path.
 * Its job: judge whether the evolving thread has a recall opportunity, and if so stage
 * the hits for the next cheap sync injection. Steps:
 *
 *   1. Read the TAIL of the session transcript (JSONL) — the recent user+assistant text.
 *   2. Run local `claude -p` (Haiku, on the SUBSCRIPTION) with a lean replaced system
 *      prompt (prompts/recall-evaluator.md) that emits ONE JSON object: {query, reason}.
 *      Pure judgment — no MCP (zero subprocess/orphan risk), no tools, token-thrift.
 *   3. If it returns a query, run the deterministic Vectros HYBRID search and stage the
 *      not-yet-served hits to the pickup file evaluate.mjs consumes.
 *
 * DELIBERATE deviation from the design's literal "claude -p runs the search": Haiku emits
 * only the QUERY; this worker runs the search + staging as deterministic code we control.
 * That is cheaper (no MCP tool schemas loaded, no tool-call turns) and keeps the search/
 * dedup logic identical to prompt-time recall (recall.mjs) — duplicated, not shared, so the two
 * can drift apart if one is changed without the other.
 *
 * RE-ENTRANCE: the `claude -p` child is a nested Claude that fires the same hooks. We set
 * VECTROS_RECALL_EVAL=1 on it so every hook no-ops. Fully fail-open; output is ignored.
 *
 * argv: <sessionId> <transcriptPath>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cred, childEnv } from './creds.mjs';
import { reshape, renderLine } from './hit.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { readState } from './state.mjs';
import { hlog } from './hooklog.mjs';
import { stagedDir, slug } from './paths.mjs';
import { fence } from './transcript.mjs'; // neutralize forged prompt delimiters in untrusted text
import { clampQuery, EVAL_CONTRADICTION_MAX_CHARS, EVAL_CLAUDE_TIMEOUT_MS,
  EVAL_TRANSCRIPT_TAIL_CHARS, EVAL_TRANSCRIPT_TAIL_MSGS, EVAL_TOP_K,
  EVAL_SEARCH_TIMEOUT_MS } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// No STATE_DIR here on purpose: state.mjs owns that path. This file used to derive it itself,
// which is how it came to hand-roll the read (see loadServed).
const SYS_PROMPT_FILE = path.join(HERE, 'prompts', 'recall-evaluator.md');
const TRIAGE_PROMPT_FILE = path.join(HERE, 'prompts', 'recall-triage.md'); // stage 2: judge the ANSWER
/**
 * One sentence, per recall-triage.md. Capped because this string is injected VERBATIM into
 * the highest-authority block the system has, while every ordinary hit is capped at 180-260
 * (hit.mjs). Unbounded, a steered model could emit ~9.4K of attacker prose under that heading.
 */

const API_KEY = cred('VECTROS_API_KEY');
const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');

// ── Tunables (verify latency/behavior live) ──────────
const MODEL = process.env.VECTROS_RECALL_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_BIN =
  process.env.CLAUDE_CODE_BIN ||
  (process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude');



/** Extract the recent user+assistant text tail from a Claude Code JSONL transcript. */
function readTranscriptTail(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    // '' means "no recall opportunity" downstream — identical to a session with nothing to ask
    // about. ENOENT is genuinely that (a session before its first flush) and stays quiet; a real
    // read error is this worker going blind while reporting perfect health.
    if (e.code !== 'ENOENT') hlog('recall-eval', `transcript READ FAILED (${e.code}) — evaluating as if the session were empty`);
    return '';
  }
  const lines = raw.split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { /* silence-ok: append-only transcript read mid-write; a trailing partial line is expected. Costs the newest message for one tick. */ continue; }
    const role = e?.message?.role || e?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = e?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b?.type === 'text') return b.text || '';
          if (b?.type === 'tool_use') return `[tool:${b.name || '?'}]`;
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) msgs.push(`${role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`);
  }
  const tail = msgs.slice(-EVAL_TRANSCRIPT_TAIL_MSGS).join('\n');
  return tail.length > EVAL_TRANSCRIPT_TAIL_CHARS ? tail.slice(-EVAL_TRANSCRIPT_TAIL_CHARS) : tail;
}

/**
 * What this session has already been shown — so triage never re-serves it.
 *
 * THE "SIXTH SITE" — flagged three separate times, each with file:line, and the
 * first fix pass still walked past it.
 *
 * This hand-rolled the read that `state.mjs` exists to own: `JSON.parse(readFileSync(...))` inside
 * a `catch { return new Set(); }`, collapsing "fresh session, no file yet" (empty set CORRECT) into
 * "the file is there and unreadable" (empty set WRONG — it means re-serving hits the agent has
 * already seen, i.e. burning the attention this whole triage stage exists to protect). It sat one
 * function away from the fourth site, in a file that already imports the hardened primitives.
 *
 * `readState` distinguishes them, logs the corrupt case, and brings the CONTENDED retry — which
 * matters here specifically: this worker races `writeState` on every Stop, and it is the reader
 * most exposed to the Windows rename contention `atomic.mjs` measures.
 */
function loadServed(sessionId) {
  const { value: s } = readState(sessionId, { injectedIds: [] }); // read-only: nothing written back
  return new Set(Array.isArray(s.injectedIds) ? s.injectedIds : []);
}

/**
 * One judgment call to `claude -p`. Both stages share it — the flag set below is MEASURED
 * (see the token breakdown), and two copies would drift apart the moment one is tuned.
 * Returns the first JSON object in the model's reply, or null.
 */
function callModel(sysPromptFile, input) {
  let sys = '';
  try { sys = fs.readFileSync(sysPromptFile, 'utf8'); }
  catch (e) {
    // Structural, not transient: the prompt files ship beside this worker. `null` reads downstream
    // as "the model declined", which is a normal answer — so a broken install would present as a
    // model that never finds anything.
    hlog('recall-eval', `prompt UNREADABLE (${e.code}) at ${sysPromptFile} — this stage is DEAD, not declining`);
    return null;
  }

  const args = [
    '-p',
    '--model', MODEL,
    '--system-prompt', sys,            // full replace → lean, token-thrift (no default agent prompt)
    '--output-format', 'json',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', // zero MCP: no vectros subprocess (orphan-safe), no tool tokens
    '--no-session-persistence',
    // Measured (total context = cache_create + cache_read + input, which is
    // cache-state independent — measuring cache_create ALONE is misleading, since a prior
    // call's cache turns it into an unmetered cache_read):
    //   no tool flags .................. 15,371   <- every built-in schema shipped
    //   this list (10 tools) ............ 4,874   <- 3.2x cut
    //   this list + the rest below ...... 3,789   <- a further ~22%
    //   `--allowed-tools ""` ........... 15,371   <- TRAP: an empty value is IGNORED, so it
    //                                              silently ships ALL tools. Do not use it.
    // The judgment call needs no tools at all — it reads text and emits JSON — so disallow
    // every built-in by name. Unknown names are harmless, so the list can stay defensive.
    '--disallowed-tools',
    'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,' +
      'TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode,AskUserQuestion,' +
      // Every one of these is REAL TODAY and every one was absent
      // — which is the proof that a name-denylist against a growing tool surface cannot hold. The
      // note above reasons "unknown names are harmless": true, and backwards. The hazard is a tool
      // that EXISTS and is not named. This list is defence-in-depth behind `--max-turns 1` and the
      // zero-MCP ALLOW-list (which has no findings against it); it is not the control. The real
      // fix is an allowlist, if the CLI grows one.
      'Skill,ToolSearch,Monitor,SendMessage,TaskCreate,TaskUpdate,TaskOutput,TaskStop,TaskList,' +
      'TaskGet,EnterWorktree,ExitWorktree,EnterPlanMode,Artifact,Workflow,CronCreate,CronList,' +
      'CronDelete,RemoteTrigger,PushNotification,ListMcpResourcesTool,ReadMcpResourceTool',
    // One judgment turn, never an agentic loop. Without this, the call
    // runs num_turns:5 and CONTINUES the transcript's work instead of judging it.
    '--max-turns', '1',
  ];
  const res = spawnSync(CLAUDE_BIN, args, {
    // Every block is delimited as DATA by the callers. A raw transcript reads as "our
    // conversation, keep going" — the model then continues the work instead of analyzing it
    // (observed, capture worker).
    input,
    encoding: 'utf8',
    timeout: EVAL_CLAUDE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: childEnv(), // re-entrance guard + subscription token, host-auth vars stripped
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) return null;

  // Envelope: {type:"result", result:"<model text>", ...}. The model text holds our JSON.
  let modelText;
  try { modelText = JSON.parse(res.stdout).result; }
  catch { /* silence-ok: `--output-format json` is requested, not guaranteed; a plain-text reply is a supported shape, so raw stdout is the DOCUMENTED fallback. The shape checks below still reject real garbage, loudly. */ modelText = res.stdout; }
  if (typeof modelText !== 'string') return null;
  const m = modelText.match(/\{[\s\S]*\}/); // first JSON object in the model's reply
  if (!m) { hlog('recall-eval', `model reply carried no JSON object — treating as no verdict: ${modelText.slice(0, 160)}`); return null; }
  try { return JSON.parse(m[0]); }
  catch (e) {
    // A null verdict is load-bearing: triage STAGES NOTHING on null rather than falling back to
    // "keep everything". That is the right call, and it is exactly why the reason must be visible —
    // otherwise a persistently malformed reply is indistinguishable from a model that keeps
    // judging "nothing relevant here".
    hlog('recall-eval', `model reply JSON parse FAILED (${e.message}) — no verdict this cycle: ${m[0].slice(0, 160)}`);
    return null;
  }
}

/** Stage 1 — judge the QUESTION: is there a recall opportunity, and what should we ask? */
function evaluateForQuery(transcriptTail) {
  return callModel(SYS_PROMPT_FILE, `<transcript>\n${fence(transcriptTail)}\n</transcript>`);
}

/**
 * Stage 2 — judge the ANSWER. → prompts/recall-triage.md.
 *
 * Stage 1 judged the question and then the model exited; whatever the engine returned was staged
 * UNJUDGED. That is the gap this closes, and it is not a ranking problem: **semantic search always
 * returns its top N and cannot say "I have nothing."** On a corpus miss it returns the N
 * least-unrelated documents, which look exactly like an answer — measured here: a
 * number-coercion query returned five accepted ADRs (metadata ingest, DDB indexing, PHI logging,
 * subprocessor flow, ownership scopes), every one real and useless. A flat top-5 has no way to
 * express "nothing", so the agent reads five confident citations and concludes the question was
 * researched.
 *
 * Why HERE and not in recall.mjs (prompt-time recall): this worker is already detached and
 * fire-and-forget, so a second call costs ZERO latency on the user's path, and the 180s debounce
 * makes it ~1 eval per 3 minutes (~$0.018 -> ~$0.036 per eval). Prompt-time recall fires on EVERY
 * prompt synchronously — the same call
 * there would add 2-5s to every keystroke-to-response. Put judgment where the budget already is.
 *
 * Returns { keep:[id], contradiction:string|null, reason } — or null if the call failed, which the
 * caller MUST treat as "cannot judge", not as "keep everything".
 */
function triageResults(transcriptTail, query, hits) {
  const rendered = hits.map((h) => renderLine(h)).join('\n');
  // FENCE all three. Each is untrusted from a different direction, and `query` is the subtle one:
  // it is MODEL OUTPUT from stage 1, which read the same attacker-influenceable tail — so a
  // steered query is itself a second injection site aimed at this stage. `results` carry record
  // and document bodies from the store, which is a write surface of its own.
  const decision = callModel(
    TRIAGE_PROMPT_FILE,
    `<agent_activity>\n${fence(transcriptTail)}\n</agent_activity>\n\n`
    + `<query>\n${fence(query)}\n</query>\n\n`
    + `<results>\n${fence(rendered)}\n</results>`,
  );
  if (!decision) return null;
  const ids = new Set(hits.map((h) => h.id));
  // Only ids that were actually offered: a hallucinated id must not conjure a hit, and an
  // invented one would otherwise index into nothing and stage `undefined`.
  const keep = Array.isArray(decision.keep) ? decision.keep.filter((id) => ids.has(id)) : [];

  /**
   * ENFORCE the contract the prompt states, in code.
   *
   * `recall-triage.md` promises "`contradiction`: ... Requires a kept id that supports it" — and
   * this function did not check it, so the prompt was a guard comment rather than a guard. That
   * asymmetry mattered: `keep` was filtered against the offered ids (a real check, reasoned
   * about), while the field RIGHT NEXT TO IT got nothing — and `contradiction` is the more
   * dangerous of the two, because it is the one channel deliberately built to be obeyed.
   *
   * Two rules, both from the prompt's own text:
   *  - No supporting kept id => no contradiction. An unsupported one is a bare assertion injected
   *    under a heading engineered for compliance, citing nothing the agent can go check.
   *  - CAP it. Every HIT is capped (hit.mjs: 200/180/260) while this was unbounded — the model
   *    could emit ~9.4K of verbatim text into the highest-authority block in the system. It is
   *    specified as ONE SENTENCE; hold it to that.
   */
  const raw = typeof decision.contradiction === 'string' ? decision.contradiction.trim() : '';
  let contradiction = raw && keep.length ? raw : null;
  if (contradiction && contradiction.length > EVAL_CONTRADICTION_MAX_CHARS) {
    contradiction = contradiction.slice(0, EVAL_CONTRADICTION_MAX_CHARS) + '…';
  }
  if (raw && !keep.length) {
    hlog('recall-eval', `triage emitted a contradiction with NO supporting hit — dropped ("${raw.slice(0, 60)}")`);
  }
  return { keep, contradiction, reason: decision.reason || '' };
}

/**
 * This is the "mid-run evaluate query" the boundary must also cover. `query` is
 * MODEL OUTPUT (stage 1's `{query, reason}` verdict, itself derived from an unbounded transcript
 * tail it read), not directly attacker/user text, but nothing here contractually bounds its length
 * — the same gap `EVAL_CONTRADICTION_MAX_CHARS` above closed for `triageResults`' `contradiction` field after
 * a MEASURED steered reply emitted ~9.4K into an uncapped field. `clampQuery` is single-sourced with
 * recall.mjs's `search()` (config.mjs) so the two callers share one bound, not two copies of it.
 *
 * Exported (only this function; the module has no other public surface) so the boundary can be
 * tested directly against a stub server without paying for a real `claude -p` call — see
 * recall-query-cap-test.mjs.
 */
export async function search(query) {
  const clamped = clampQuery(query);
  if (clamped.length !== String(query ?? '').length) {
    hlog('recall-eval', `query clamped ${String(query ?? '').length}c -> ${clamped.length}c (RECALL_QUERY_MAX_CHARS) — avoiding a body-size 413`);
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), EVAL_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: clamped, mode: 'HYBRID', limit: EVAL_TOP_K }),
      signal: ctrl.signal,
    });
    // Same shape as recall.mjs's search, and swept with it rather than left for the next reviewer
    // to find: an HTTP error and an empty index are the same `[]` to every caller.
    // WIDENED the same way (a general pattern, not a one-off fix): requestId/x-amz-cf-id/byte-length/403
    // shape. See recall.mjs's search() for the full rationale.
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* silence-ok: the status is the receipt; an unreadable error body does not make it less true. */ }
      const detail = bodyText.slice(0, 200);
      let requestId = null;
      try { requestId = JSON.parse(bodyText)?.requestId ?? null; } catch { /* silence-ok: not every error body is the JSON contract */ }
      const cfId = res.headers.get('x-amz-cf-id') || '(none)';
      const byteLen = Buffer.byteLength(clamped, 'utf8');
      const shape = res.status === 403 ? ` shape="${clamped.slice(0, 80)}"…"${clamped.slice(-80)}"` : '';
      hlog('recall-eval',
        `search HTTP ${res.status} — 0 hits (ERROR, not an empty index) `
        + `queryBytes=${byteLen} cfId=${cfId} requestId=${requestId ?? '(null)'}${shape}${detail ? `: ${detail}` : ''}`);
      return [];
    }
    const j = await res.json();
    return Array.isArray(j.results) ? j.results : [];
  } catch (e) {
    // EVAL_SEARCH_TIMEOUT_MS, not TIMEOUT_MS — this module names its constants per-call-site
    // (EVAL_CLAUDE_TIMEOUT_MS / EVAL_SEARCH_TIMEOUT_MS) and has no bare `TIMEOUT_MS`. The line was swept in
    // from recall.mjs, which does. `.mjs` is strict mode, so the undeclared name was a
    // ReferenceError, not `undefined`: on the ONE path that reaches it — an AbortError from the
    // 6s abort above — the template literal THREW, unwound out of search() and main(), and landed
    // in `main().catch(() => {})`. Swallowed. So the line that exists to distinguish a timeout
    // from an empty index was the line that crashed whenever a timeout happened, reporting
    // nothing at all: exactly the founding failure this whole discipline exists to prevent, inside
    // the receipt written to prevent it.
    // `node --check` blesses this class (capture.mjs warns about it), and run-all.mjs's crash
    // detector reads stderr, which the swallowing catch guarantees it never reaches. The census
    // is now mechanical: tests/undeclared-const-test.mjs.
    const why = e?.name === 'AbortError' ? `timeout after ${EVAL_SEARCH_TIMEOUT_MS}ms` : (e?.code || e?.message || 'error');
    hlog('recall-eval', `search FAILED (${why}) — 0 hits (ERROR, not an empty index)`);
    return [];
  } finally { clearTimeout(to); }
}

async function main() {
  const [sessionId, transcriptPath] = process.argv.slice(2);
  if (!sessionId || !transcriptPath || !API_KEY) return;

  const tail = readTranscriptTail(transcriptPath);
  if (tail.length < 40) return; // nothing meaningful to evaluate yet

  const served = loadServed(sessionId);
  const decision = evaluateForQuery(tail);
  /**
   * CLAMP HERE, not just inside search(). `query` is stage-1 MODEL OUTPUT (read an unbounded
   * transcript tail, so a steered reply is the same risk class `EVAL_CONTRADICTION_MAX_CHARS` above already
   * guards for the `contradiction` field) and it has TWO consumers: `search()` (which has its own
   * defensive clamp — the actual Vectros request boundary, kept as-is) and `triageResults()` below,
   * which fences `query` verbatim into a SECOND local `claude -p` prompt that had no bound at all.
   * Clamping once here covers both without `search()`'s boundary clamp
   * silently protecting only half of where this value goes.
   */
  const query = clampQuery(decision && typeof decision.query === 'string' ? decision.query.trim() : '');
  if (!query) return; // evaluator judged no recall opportunity

  const hits = (await search(query)).map(reshape).filter((r) => r.id && !served.has(r.id));
  if (hits.length === 0) return;

  // Judge what came back. A null verdict means the triage call FAILED — stage nothing rather than
  // fall back to "keep everything". Falling back would restore the exact behavior this replaces,
  // silently, on every triage error; and the cost of that failure is asymmetric (an unfiltered
  // near-miss burns the agent's attention AND implies the question was researched). The next
  // debounce re-evaluates in 3 minutes, so a skipped cycle costs almost nothing.
  const verdict = triageResults(tail, query, hits);
  if (!verdict) {
    hlog('recall-eval', `triage FAILED — staged nothing (had ${hits.length} unjudged hits)`, sessionId);
    return;
  }

  const kept = verdict.keep.map((id) => hits.find((h) => h.id === id)).filter(Boolean);
  if (!kept.length && !verdict.contradiction) {
    // The valuable non-event: the engine returned N, and none of them answered. Log it — this is
    // the line that tells us whether triage is earning its call, and a silent no-op would make
    // "triage suppressed noise" indistinguishable from "the worker never ran".
    hlog('recall-eval', `triage kept 0 of ${hits.length} — nothing answered "${query.slice(0, 48)}" (${verdict.reason})`, sessionId);
    return;
  }

  fs.mkdirSync(stagedDir(), { recursive: true });
  const pickup = path.join(stagedDir(), slug(sessionId) + '.json');
  const payload = {
    hits: kept,
    contradiction: verdict.contradiction,
    at: new Date().toISOString(),
    query,
    reason: decision.reason || '',
    triage: verdict.reason,
  };
  // ATOMIC. This was `fs.writeFileSync(pickup, ...)` — truncate-then-write on a file the sync
  // injector concurrently reads, which is the same defect that tore 33.7% of state reads. The
  // injector's `catch` returns [] on a torn read, so a shredded pickup did not error: it silently
  // dropped the recall it was staging. Missed in the first census (state/hooklog/project) — this
  // was the fourth site. → *fix the census, not the instance*.
  writeFileAtomic(pickup, JSON.stringify(payload));
  hlog('recall-eval',
    `triage kept ${kept.length} of ${hits.length}${verdict.contradiction ? ' + CONTRADICTION' : ''} — staged (${verdict.reason})`,
    sessionId);
}

/**
 * THE WIDEST FAIL-OPEN SURFACE IN THIS HOOK — and it was the silent one.
 *
 * This was `main().catch(() => {})`. ANY throw anywhere in main() lands here, so a hook that dies
 * on line one and a hook that ran perfectly and had nothing to say produced the SAME observable:
 * nothing. That is the founding failure this whole discipline exists to prevent (a recall hook read
 * the wrong field name and no-op'd for a week) sitting on the outermost line of six different hooks
 * — including, pointedly, `recall-eval-worker.mjs`, whose own comment names a bug this construct
 * swallowed.
 *
 * It was also invisible to the lint that enforces that discipline: `receipt-lint-test.mjs` matched
 * only `catch (e) {` and consumed `(() => {})` as the optional binding, landing on `;` where it
 * wanted `{`, and skipping the block entirely. Six swallows, zero findings, green build. The lint
 * reads arrow handlers now.
 *
 * Exit stays 0 and nothing rethrows: a hook must never break the user's turn. The log is the whole
 * remedy — it makes "dead" distinguishable from "quiet", which is all that discipline ever asks.
 */
main().catch((e) => {
  try { hlog('recall-eval-worker', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
