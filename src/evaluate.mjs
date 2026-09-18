#!/usr/bin/env node
/**
 * PostToolUse hook — mid-run recall.
 *
 * The user prompt is a shrinking fraction of the signal: autonomous sessions run
 * many tool-driven turns before a user speaks, and the rich content comes from the
 * agent. Prompt-time recall (UserPromptSubmit) only fires on user turns, so recall must ALSO track
 * the evolving thread mid-run. `PostToolUse` is the one hook that fires inside the
 * autonomous loop AND can inject `additionalContext` the model then acts on.
 *
 * Because an ASYNC hook can't inject ("the agent has already moved on"), evaluation
 * (heavy, inference) and injection (cheap, sync) are DECOUPLED into one hook with two jobs:
 *
 *   1. INJECTOR (every call, sync, no inference): read the staged pickup file; if the
 *      background worker has staged fresh, not-yet-served recall, inject it via
 *      `additionalContext` and mark it served. Negligible latency; lands at this tool
 *      call. "A bit late" is fine — associative recall shortly after you start down a
 *      path is still valuable.
 *   2. TRIGGER (debounced — EVAL_DEBOUNCE_MS, currently 180s): fire-and-forget a DETACHED background
 *      worker (`recall-eval-worker.mjs`) that runs local `claude -p` (Haiku, on the
 *      subscription) to judge "is there a recall opportunity + what's the query," runs
 *      the Vectros search, and stages the hits. Off the hot path.
 *
 * RE-ENTRANCE GUARD: the worker's nested `claude -p` is itself a Claude session that
 * fires these same hooks. The worker sets VECTROS_RECALL_EVAL=1 on that child; every
 * hook (this one, recall.mjs, stop.mjs, capture.mjs) no-ops when it's set, so the
 * evaluator's own tool calls don't re-fire the loop. Self-contained. Fail-open.
 *
 * Config source: VECTROS_API_KEY (+ optional VECTROS_API_BASE_URL) from the hook env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cred, workersDisabled } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { stagedDir, stateDir, slug } from './paths.mjs';
import { readState, writeState } from './state.mjs';
import { renderLine, AUTHORITY } from './hit.mjs';
import { CONTEXT_CAP, EVAL_DEBOUNCE_MS } from './config.mjs';

// Re-entrance guard: no-op entirely inside the evaluator's own nested claude -p.
if (process.env.VECTROS_RECALL_EVAL === '1') process.exit(0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'recall-eval-worker.mjs');

const API_KEY = cred('VECTROS_API_KEY');
// Min wall-clock between background evaluations. Token-thrift lever: each eval is a fresh
// ephemeral `claude -p`, so it pays cache CREATION every time (cache_read is 0 — no reuse
// across calls), unlike the main session's cheap cache reads. MEASURED $0.0176/eval.
//
// Cost curve (vs a ~$30/hr Opus stream): 25s 9.8% · 60s 4.9% · 120s 3.1% · 180s 2.6% ·
// 300s 2.1%. The knee is ~120-180s; below it capture's fixed floor dominates.
//
// ⚠️ The VALUE side of this trade was wrong, and the correction matters more than the number.
// This was set to 180s reasoning that "mid-run recall is no longer the primary mechanism —
// orient recall front-loads knowledge, leaving it a sparse drift-catcher." A live session
// falsified that:
//
//   Orient recall AND the session's hand-written kickoff BOTH missed a decision doc that
//   governed the half of the issue that was wrong — and missed it for the SAME reason. Both
//   keyed off the issue's framing, and the issue framed the problem as a coercion bug. Mid-run
//   recall found it, on the tool call where the session was grepping the relevant code path.
//
// The asymmetry is structural, not incidental: prompt-time recall inherits the prompt's
// framing INCLUDING ITS ERRORS. Mid-run recall keys on what you actually did, so it cannot
// inherit a framing error it never saw. That makes it the half of the loop that catches the
// miss the other half is blind to by construction — not a redundant backstop.
//
// HELD at 180s anyway, deliberately. In that same session mid-run recall fired, hit, and was
// WASTED: the line pitched a filename and the session skipped it (see hit.mjs). Delivering unactionable
// payloads more often buys nothing. The payload is fixed now; re-tune when there is evidence
// the richer line actually gets USED — that is the measurement that should move this number,
// not the cost curve, which was never the binding constraint.
// CONTEXT_CAP now comes from ./config.mjs — single-sourced with recall.mjs; the two MUST agree on
// the 10K additionalContext ceiling, which is exactly why this was the first duplicated const the
// config seam removed.

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

/** Read stdin fully (async — a sync fd-0 read trips a libuv assert on Windows pipes). */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function stagedPath(sessionId) { return path.join(stagedDir(), slug(sessionId) + '.json'); }

/**
 * THE STATE-RESET BUG WAS STILL LIVE HERE.
 *
 * `state.mjs` was written to be "ONE read/write path for all six hooks", and `recall.mjs` quotes
 * this exact body as the root cause it fixed. This hook never got the fix: it kept the hand-rolled
 * reader whose `catch` hands back a FRESH session on a torn read, while importing `readState` and
 * never calling it — a half-finished refactor that reads as done.
 *
 * It was the worst place to miss. `evaluate.mjs` is `PostToolUse`: it fires on EVERY tool call, so
 * it is both the most frequent reader and the most likely to catch a torn write. And unlike the
 * original, it then **durably publishes the reset** (`writeState` below): one torn read silently
 * erased `promptCount`, `orientPending`, `orientSource`, `lastProjectAt` and `nudgedSig`, and
 * blanked `lastAssistant`. The cascades are exactly the failures other fixes on this branch were
 * built to prevent — a wiped `promptCount` fires a spurious mid-session ORIENT (and wipes the
 * `orientPending` flag added to fix that), a blanked `lastAssistant` kills the rolling-window
 * query, and `lastEvalAt: 0` forces an unbudgeted worker spawn.
 *
 * It also bypassed `readState`'s CORRUPT receipt, so this hook violated the very discipline this
 * branch added: a signal must be able to observe the thing it claims. Fifth site of the same
 * defect; the census (state, hooklog, project, staged-pickup) missed the hook that runs most —
 * fix the census, not the instance.
 */
/**
 * NOTE THE DEFAULTS, and what they do NOT list: `promptCount`, `orientPending`, `orientSource`,
 * `lastProjectAt`, `nudgedSig`. On a corrupt read those are absent from `value`, and the write-back
 * below would publish them GONE — durably. This header called the state-reset bug fixed; what was
 * fixed was the SILENCE (state.mjs logs CORRUPT), not the reset. The receipt now comes back with
 * the value, and the write is gated on it.
 */
function loadState(sessionId) {
  return readState(sessionId, { injectedIds: [], lastAssistant: '', lastEvalAt: 0 });
}

/**
 * Read + consume the pickup file the worker stages recall into (delete after read).
 *
 * Returns the whole payload now, not just `hits`: the worker's TRIAGE stage can also emit a
 * `contradiction` — the rare case where a hit says the agent is heading somewhere already decided
 * against — and that must reach the injector, which renders it as an obligation rather than a
 * sixth FYI line. → recall-eval-worker.mjs § triageResults.
 */
function takeStaged(sessionId) {
  const p = stagedPath(sessionId);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.rmSync(p, { force: true });
    return {
      hits: Array.isArray(j.hits) ? j.hits : [],
      contradiction: typeof j.contradiction === 'string' ? j.contradiction : null,
    };
  } catch (e) {
    /**
     * SAY IT (this discipline, wired here — censused at 1 of 6 sites).
     *
     * ENOENT is the normal case — nothing staged — and stays quiet. ANYTHING ELSE is a fallback
     * that DROPS recall the worker paid two Haiku calls to find: a torn pickup (the worker writes
     * it atomically now, but a partial legacy file or a locked read still lands here) parsed as
     * empty and this returned `{hits: []}` in silence, indistinguishable from "the worker staged
     * nothing". The pickup is then never re-staged, because the worker filters on `served`.
     *
     * The surrounding no-op path (debounce not elapsed, nothing staged) stays silent — but NOT for
     * the reason this comment used to give. It argued "the rule governs FALLBACKS, not a component
     * correctly doing nothing" — true of the old degradation-only rule in isolation, and exactly the
     * carve-out the merge removed: this discipline's first half (existence — ran vs. never fired) governs existence, so a component doing nothing
     * still owes evidence that it ran. The silence is legitimate here for a different and narrower
     * reason — the DEBOUNCE makes it countable (see the `!didSpawn` guard in main()). Kept
     * wrong-and-corrected: a reviewer endorsed the old reasoning, and the rule it leaned on was
     * retired one round later.
     */
    if (e.code !== 'ENOENT') {
      hlog('evaluate', `staged pickup UNREADABLE (${e.code || e.message}) — recall DROPPED for this tick`, sessionId);
    }
    return { hits: [], contradiction: null };
  }
}

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { hlog('evaluate', 'skip: unparseable stdin'); return; }
  const sessionId = input.session_id || 'nosession';
  const transcriptPath = input.transcript_path || '';
  // silence-ok: no credential → nothing to recall against. this discipline's first half (existence — ran vs. never fired) is satisfied ELSEWHERE
  // and deliberately: `!API_KEY` is a GLOBAL condition, and recall.mjs logs `skip: no
  // VECTROS_API_KEY` once per prompt — so "the loop is unconfigured" is already observable, and a
  // per-tool-call duplicate here would be noise, not information. (If a key IS present this line
  // never runs.) loadCreds separately shouts when the key is missing because the FILE is broken
  // rather than absent — the case that would otherwise masquerade as this one.
  if (!API_KEY) return;

  fs.mkdirSync(stateDir(), { recursive: true });
  fs.mkdirSync(stagedDir(), { recursive: true });
  const { value: state, state: stState } = loadState(sessionId); // state.mjs returns the RECEIPT

  // ── 1. INJECTOR (cheap, sync) ────────────────────────────────────────────
  const { hits: staged, contradiction } = takeStaged(sessionId);
  /**
   * Build lines WITH ids; mark served only at delivery (below). Same defect as recall.mjs, and
   * strictly worse here: `takeStaged` DELETES the pickup on read and recall-eval-worker filters
   * every future search by `!served.has(r.id)`. So a hit dropped for budget was gone from the
   * pickup, marked served, never displayed, and permanently excluded from re-staging — mid-run
   * recall destroyed recall it had paid Haiku twice to find. Fix the census, not the instance — the same rule was
   * written for the nudge.
   */
  const served = new Set(state.injectedIds);
  const lines = [];
  for (const r of staged) {
    if (!r || !r.label) continue;
    if (r.id && served.has(r.id)) continue; // already served this session — drop, don't re-spend
    // The worker already reshaped + capped these (hit.mjs). Rendering them a THIRD way here is
    // how the format drifts — one renderer, shared.
    lines.push({ text: renderLine(r), id: r.id || null });
  }

  // ── 2. TRIGGER (debounced background evaluation) ─────────────────────────
  const now = Date.now();
  let stateDirty = false;
  let didSpawn = false;
  // The INJECTOR above still runs when workers are off — anything already staged is free to
  // serve (it is a file read; no inference, no credential). Only the nested `claude -p` stops.
  // That split is what makes the switch a clean experiment: it removes exactly the inference
  // calls and nothing else. → creds.mjs § KILL SWITCH.
  if (workersDisabled()) {
    /**
     * FOUND LIVE (triage-test.mjs § 4, once its own WORKERS_OFF signal was fixed to actually
     * reach here — it never had before): this was `if (lines.length === 0) return`, with no
     * `contradiction` check — the exact swallow this file's header names as "the founding story"
     * and the LATER guard at the bottom of this function (`lines.length === 0 && !contradiction`)
     * was already written to prevent. This site was the second, unguarded copy of the same trap:
     * an operator running WORKERS_OFF (the documented spend kill-switch) with a pending
     * contradiction and no FRESH hit this tick had it silently dropped, before it ever reached the
     * later check that exists specifically to deliver it. `lines.length === 0` alone is not
     * sufficient to justify returning here, same reasoning, same fix, as the guard below.
     */
    if (lines.length === 0 && !contradiction) { hlog('evaluate', 'workers OFF (WORKERS_OFF present) — no spawn', sessionId); return; }
  } else if (!transcriptPath) {
    /**
     * this discipline's first half (existence — ran vs. never fired), and it is the FOUNDING STORY waiting to happen again.
     *
     * This hook's entire trigger hangs off one field. `transcript_path` absent or renamed => the
     * spawn branch below never runs => `didSpawn` stays false => the guard returns in silence,
     * forever, in every session — and the log looks EXACTLY like a healthy idle hook. That is
     * verbatim the bug that killed recall.mjs for a week (it read `user_prompt`; the field was
     * `prompt`), in the same system, on the same class of field.
     *
     * ONCE per session, not per invocation: this fires on every tool call, so an unconditional
     * line would drown the log this discipline exists to keep readable. Once is the countable form here —
     * the condition is static for the session, so repeating it adds noise, not information.
     * Log the payload SHAPE, which is the line that identifies a contract mismatch.
     */
    if (!state.noTranscriptLogged) {
      hlog('evaluate', `no transcript_path — background evaluation can NEVER fire this session; payload keys=[${Object.keys(input).join(',')}]`, sessionId);
      state.noTranscriptLogged = true;
      stateDirty = true;
    }
  } else if (now - (state.lastEvalAt || 0) >= EVAL_DEBOUNCE_MS) {
    state.lastEvalAt = now;
    stateDirty = true;
    try {
      const child = spawn(process.execPath, [WORKER, sessionId, transcriptPath], {
        detached: true,
        stdio: 'ignore',
        // NOTE: the worker itself is not a hook; it sets VECTROS_RECALL_EVAL=1
        // only on the `claude -p` grandchild it spawns.
        env: process.env,
        // REQUIRED on Windows: `detached: true` otherwise gives the child its own CONSOLE, which
        // flashes a visible CLI window on the user's screen every time this hook fires. This one
        // runs on tool calls, so it is the most visible offender of all.
        windowsHide: true,
      });
      child.unref();
      didSpawn = true;
    } catch (e) {
      // "Fire-and-forget" describes the SUCCESS path — we deliberately never wait for the child.
      // It does not license silence on the failure path: a spawn that never starts means no
      // background recall AT ALL, permanently if the cause is structural (Node >=18.20.2 refuses
      // to spawn a .cmd without shell:true — a real trap this project has already hit). Nothing
      // downstream can observe the difference between "spawned and found nothing" and "never ran".
      hlog('evaluate', `worker spawn FAILED (${e?.code || e?.message || 'error'}) — no background recall this tick`, sessionId);
    }
  }

  // NOTE: injectedIds is NOT committed here. It commits at delivery, after the budget fit below —
  // otherwise a dropped hit is marked served and mid-run recall can never re-stage it. This write persists only
  // the debounce clock (`lastEvalAt`), which is about the spawn above, not about what was shown.
  // Refuse only on UNREADABLE. This is the MOST FREQUENT hook (PostToolUse) and therefore the likeliest to catch
  // a torn write — and its defaults omit five fields, so publishing them erases the orient boundary,
  // the prompt count, the projection clock and the nudge signature. The wiped `orientPending` then
  // lands in recall's pre-flag path and the session never orients again. → state.mjs.
  if (stateDirty && stState === 'unreadable') {
    hlog('evaluate', 'state read UNREADABLE — NOT writing back (its defaults omit promptCount/orientPending/orientSource/lastProjectAt/nudgedSig; publishing them would erase the session)', sessionId);
  } else if (stateDirty) {
    writeState(sessionId, state);
  }

  // Guard on lines AND contradiction. `if (lines.length === 0) return` would silently swallow a
  // contradiction that arrived without a fresh hit (every supporting hit already served this
  // session) — dropping the one message here that is not optional. Same shape as recall.mjs's
  // hits-AND-orientLines guard, and the same reason.
  if (lines.length === 0 && !contradiction) {
    /**
     * silence-ok on the `!didSpawn` path — the DEBOUNCE is what makes it countable.
     *
     * this discipline's first half (existence — ran vs. never fired) demands that *never fired* and *fired and no-op'd* be distinguishable, not
     * that every invocation emit a line. Here the debounce supplies the heartbeat by construction:
     * this hook fires per tool call, but any active session crosses EVAL_DEBOUNCE_MS within 180s and
     * emits the spawn line below. So a LIVE hook logs on a bounded clock and a DEAD one logs
     * nothing — the invariant holds without a line per tool call, which would drown the log.
     * The one way that reasoning fails is the trigger never arming at all, which is precisely the
     * `no transcript_path` case handled above, once, loudly.
     */
    if (didSpawn) hlog('evaluate', 'spawned background evaluator (nothing staged yet)', sessionId);
    return;
  }

  // Assemble to FIT — never `slice(0, CAP)` the finished string (this was a blind tail-slice).
  // Priority: the contradiction is an obligation and is never what drops; hits are ranked, so the
  // tail goes first and the weakest is what is lost.
  let ctx = '';
  const add = (s) => {
    if (ctx.length + s.length + 2 > CONTEXT_CAP) return false;
    ctx += (ctx ? '\n\n' : '') + s;
    return true;
  };

  // The CONTRADICTION goes first and reads as an OBLIGATION, not a hit.
  //
  // This is the one channel here that interrupts rather than informs, and that asymmetry is the
  // whole point: recall is FYI and gets read probabilistically; the capture nudge is a TODO and
  // demonstrably gets acted on (observed: an agent fact-checked a candidate, corrected it, then
  // stored it). Same agent, same session, opposite outcomes — the difference is that one asks for
  // a response. Triage emits this only when a hit shows the agent heading somewhere already
  // decided against, so it must be rare enough to stay loud.
  if (contradiction) {
    add(
      '⚠️ RECALL — POSSIBLE CONTRADICTION. A background pass compared what you are doing against '
      + 'what has already been decided, and thinks they disagree:\n'
      + `    ${contradiction}\n`
      + 'This is a JUDGMENT from a small model reading your transcript tail, not a verdict — it can '
      + 'be wrong, and a stale decision can be overturned. But do not proceed as if it was never '
      + 'raised: check the cited item, then either follow it or say why it does not apply.',
    );
  }

  // This preamble earns its keep: mid-run recall is the ONLY recall that does not inherit the prompt's
  // framing (see the header comment), so its hits are exactly the ones the session did not think
  // to ask for. Say that — an unexplained hit reads as noise and gets skipped. These hits are
  // also TRIAGED now: a second pass judged that they actually answer the query, rather than
  // merely ranking top-5 (the engine always returns its top N and cannot say "nothing").
  const preamble =
    'Recall surfaced mid-task from your Vectros memory + curated KB — matched against what you '
    + 'are ACTUALLY DOING right now, not against what you were asked, and filtered by a pass that '
    + 'judged each hit ANSWERS the question rather than merely ranking near it. So it can surface '
    + 'things the task framing missed; if a hit looks unrelated to the ask but relates to the code '
    + 'you just touched, that is the point, not noise. ' + AUTHORITY;

  // Fit the hits LINE BY LINE, not as one atomic block. An all-or-nothing hits block silently
  // drops EVERY hit the moment it overflows — measured in test: 60 hits -> 0 injected. TOP_K is 5
  // today (~2.6K against a 9500 cap) so it cannot bite, which is precisely the reasoning that left
  // the hooklog rotation defect dormant behind a size fuse. Fit it properly instead.
  let kept = [];
  if (lines.length) {
    let budget = CONTEXT_CAP - ctx.length - 2 - preamble.length - 1;
    for (const l of lines) {
      if (budget - (l.text.length + 1) < 0) break;
      budget -= l.text.length + 1;
      kept.push(l);
    }
    if (kept.length) add(preamble + '\n' + kept.map((l) => l.text).join('\n'));
  }
  if (!ctx) return; // nothing fit — say nothing rather than emit a fragment

  // COMMIT ON DELIVERY: only what is really in `ctx`. A dropped hit stays unserved, so the worker
  // can stage it again — instead of it being deleted from the pickup, marked shown, and filtered
  // out of every future search.
  if (kept.length) {
    for (const l of kept) if (l.id) served.add(l.id);
    state.injectedIds = [...served].slice(-200);
    // THE SEVENTH WRITE-BACK, and the one the census missed. `stateDirty` is not even required to
    // reach it: with `kept.length > 0` this is the ONLY write on the path — so gating `:278` and
    // leaving this ungated reneged on that gate's own log line 86 rows up ("NOT writing back …
    // publishing them would erase the session"). The reader half was fixed 7/7; the writer half was
    // 6/7, in the commit whose message invokes the census discipline. Fixing six of seven sites IS the census bug.
    if (stState === 'unreadable') {
      hlog('evaluate', 'state UNREADABLE — served ids NOT persisted (the bytes are unknown and may be fine); these hits may be re-offered', sessionId);
    } else {
      writeState(sessionId, state);
    }
  }

  const dropped = lines.length - kept.length;
  hlog('evaluate',
    `injected ${contradiction ? 'CONTRADICTION + ' : ''}${kept.length} triaged hits`
    + `${dropped ? ` (${dropped} DROPPED for budget)` : ''}, ${ctx.length}c`,
    sessionId);
  return out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } });
}

/**
 * THE WIDEST FAIL-OPEN SURFACE IN THIS HOOK — and it was the silent one.
 *
 * This was `main().catch(() => {})`. ANY throw anywhere in main() lands here, so a hook that dies
 * on line one and a hook that ran perfectly and had nothing to say produced the SAME observable:
 * nothing. That is the founding story behind this discipline (a recall hook read the wrong field name and no-op'd for a
 * week) sitting on the outermost line of six different hooks — including, pointedly,
 * `recall-eval-worker.mjs`, whose own comment names a bug this construct swallowed.
 *
 * It was also invisible to this discipline's own ENFORCER: `receipt-lint-test.mjs` matched only `catch (e) {` and
 * consumed `(() => {})` as the optional binding, landing on `;` where it wanted `{`, and skipping
 * the block entirely. Six swallows, zero findings, green build. The lint reads arrow handlers now.
 *
 * Exit stays 0 and nothing rethrows: a hook must never break the user's turn. The log is the whole
 * remedy — it makes "dead" distinguishable from "quiet", which is all this discipline ever asks.
 */
main().catch((e) => {
  try { hlog('evaluate', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
