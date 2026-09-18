#!/usr/bin/env node
/**
 * Capture worker (detached).
 *
 * Spawned fire-and-forget by capture.mjs at a Stop/PreCompact boundary. Distills the
 * session transcript tail into candidate PRIVATE `memory` records via local `claude -p`
 * (Haiku, subscription).
 *
 * THE DISTILLER PROPOSES; THE AGENT COMMITS. `claude -p` runs with NO MCP and no tools, emits
 * candidates as JSON, and this worker appends them to the per-session QUEUE (queue.mjs). The agent
 * settles each candidate via `dispose.mjs`, which verifies every claim.
 *
 * THIS WORKER NOW WRITES TO THE STORE — and the sentence it replaces ("it writes nothing to the
 * store and holds no credential that could") was the load-bearing claim, so read what actually
 * changed. It dual-writes each proposal to the SPOOL, and the drain at the end of `main` promotes
 * spooled proposals to `candidate` records (cutover Phase A of a broader rollout).
 *
 * What has NOT changed is the property that sentence was protecting. A `candidate` is store-only
 * (`indexMode: NONE`): never indexed, unreachable by search or a grounded answer under any query,
 * so an unverified claim still cannot be recalled as fact. The distiller's output reaches a
 * STAGING type and nothing else; promotion to `memory` remains the agent's act, after
 * verification, through `dispose.mjs`. The air gap moved from "no write path exists" to "the write
 * path lands somewhere search cannot see" — enforced by the platform rather than by this file
 * having no credential. Do not relax that to a searchable type. → the § below on why Option A died.
 *
 * THE "OPTION A" LIVE-WRITE PLAN IS DEAD — do not rebuild it. This header used to say the
 * dry-run was a soak to be "flipped to live writes", and pointed at a follow-on that would give
 * this sub-call the vectros MCP tools and let it reconcile + `record_create` autonomously. The
 * soak ran and killed it: its premise was "a private memory write is reversible, therefore
 * low-stakes", and reversible is not harmless when recall serves the thing back marked
 * AUTHORITATIVE and nobody knows to fire the undo. A dry-run proposed a FABRICATED statistic as
 * durable fact; the day the replacement shipped, a candidate carried a FABRICATED sourceRef URL.
 * An agent caught both. A direct-write distiller would have stored them.
 *
 * `VECTROS_CAPTURE_LIVE` is retained ONLY as a log label and is not a switch to anything. It
 * previously claimed live "is treated as dry-run with a warning in the log" — the opposite of
 * what the code does (it stamps `mode: 'LIVE (agent-validated)'` into the review log while
 * behaviour is unchanged: a lie in the log, not a warning). Nothing reads it to gate a write,
 * because there is no write path here to gate.
 *
 * Reuses recall-eval-worker's auth pattern (childEnv): re-entrance guard + subscription
 * token, host-managed session vars stripped. argv: <sessionId> <transcriptPath>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cred, childEnv } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { captureLogDir, lockFor, slug } from './paths.mjs';
import { read as readQueue, append, markCaptured } from './queue.mjs';
import { spool, spoolSupersede, drainAll } from './spool.mjs';
import { mapCapture } from './capture-map.mjs';
import { sliceSince, fence } from './transcript.mjs';
import { CAPTURE_CLAUDE_TIMEOUT_MS, DELTA_MAX_CHARS, MAX_WINDOWS_PER_RUN, NUDGE_TITLE_MAX_CHARS, NUDGE_FIELD_MAX_CHARS } from './config.mjs';

// Same untrusted-field rule as nudge.mjs/dispose.mjs — a prior candidate's title/kind is
// model-authored with no length bound of its own. `fence()` (transcript.mjs) already strips the
// delimiter tags that would let one break OUT of the <pending_candidates> block, so this isn't a
// prompt-injection gap; it's the same consistency/budget gap an OSS-readiness pass found
// everywhere else a candidate field renders (hit.mjs, nudge.mjs, dispose.mjs).
const field = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYS_PROMPT_FILE = path.join(HERE, 'prompts', 'capture-distiller.md');

const API_KEY = cred('VECTROS_API_KEY');
const LIVE = process.env.VECTROS_CAPTURE_LIVE === '1'; // label only — there is no live-write path to gate
// Set by sweep.mjs when it flushes a session that ended without settling. → `origin` below.
const RECOVERED = process.argv.includes('--recovered');

// ── Tunables (shared with recall-eval-worker) ────────────────────────────────────
const MODEL = process.env.VECTROS_CAPTURE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_BIN =
  process.env.CLAUDE_CODE_BIN ||
  (process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude');

/**
 * The window is the DELTA since the last capture — not a tail.
 *
 * It was `TRANSCRIPT_TAIL_CHARS = 12_000` + `TRANSCRIPT_TAIL_MSGS = 60`: a keyhole onto the most
 * recent turns, re-opened every 90 seconds. Measured consequences on one real session:
 *   - the 60-MSG cap bound before the char cap, so raising the tail did nothing: union coverage
 *     went 12% -> 17% as TAIL_CHARS went 12K -> 120K. The keyhole could not be widened.
 *   - the median run's delta was 5.5K against a 12K window, so most of each read was text it had
 *     already proposed on. That is where the near-duplicates came from.
 *
 * Reading `[fromOffset, to)` instead means every character is distilled exactly ONCE per session:
 * linear cost, 100% coverage, no exceptions.
 *
 * THE CAP IS A WINDOW, NOT A CLIFF. A cap is unavoidable — Haiku's context is
 * ~200K tokens and 400K chars is ~100K of them, about half, leaving room for the system prompt, the
 * priors block and the output. The BUG was what happened when it bound: the window kept the most
 * recent 400K and the worker then marked the WHOLE delta captured, so the head fell below the
 * watermark unread and was gone for good.
 *
 * MEASURED before the fix: 3,019K of 4,219K (72%) of live arc dropped. Three sessions, all of them
 * — the queue went live mid-session and met an already-long transcript at offset 0. And it was NOT
 * only an adoption artifact: a failed distill correctly HOLDS the watermark, so the delta grows and
 * the next success drops everything past the cap (one session failed at 0K, succeeded at 1391K,
 * skipped 991K). The retry logic that is right in isolation was feeding the hole.
 *
 * Now: slice FORWARD from the watermark, mark exactly `to` captured, and LOOP until drained. The
 * watermark can never pass unread text, so "everything below this is distilled" is true by
 * construction and there is no hole to name. Chunks are chronological, and each chunk's candidates
 * become the next chunk's priors — so a later chunk REVISEs an earlier chunk's wrong claim exactly
 * as a later run revises an earlier one. Draining 1983K costs ~5 Haiku calls ONCE.
 *
 * (The cost figure here read "~$0.14" and was NOTIONAL stated as measured. 1983K
 * chars is ~496K input tokens, so ~$0.50 at Haiku list, and the distiller runs on the
 * SUBSCRIPTION token, so the marginal dollar cost is neither number. The call COUNT is what the
 * argument rests on and it holds.)
 */

/**
 * Max windows per worker run. Not a coverage limit — the gate re-fires at the next Stop and the
 * drain resumes from the watermark, because the watermark is always honest now. It is a runaway
 * bound: 8 x 400K = 3.2M chars, far past any real arc, so a pathological transcript cannot spin
 * this process forever. If it ever binds, the log says so rather than the drain quietly stopping.
 */



/**
 * Render the PENDING candidates this session has already proposed.
 *
 * This is the mechanism that lets a later run correct an earlier one. Without it, every run is
 * amnesiac: it re-meets the same material and proposes a fresh variation, which is how the
 * dry-run produced 349 proposals across 7 sessions with near-duplicates and no self-correction.
 *
 * Concretely: a run once proposed a FABRICATED statistic ("~9/min") as durable fact
 * hours before the session retracted it. A later run reading the retraction in its delta
 * AND this list can emit {"op":"REVISE","revises":"c7"} instead of a fourth variant — the field's
 * answer to contradiction (Zep's t_invalid, Copilot's corrected-memory), not a fifth proposal.
 */
export function renderPending(pending) {
  if (!pending.length) return '(none — this is the first capture for this session)';
  return pending
    .map((c) => `- ${c.id} [${field(c.kind, NUDGE_FIELD_MAX_CHARS) || '?'}] ${field(c.title, NUDGE_TITLE_MAX_CHARS)}\n    ${field(c.body, 220)}`)
    .join('\n');
}

function distill(deltaText, pendingBlock) {
  let sys = '';
  try { sys = fs.readFileSync(SYS_PROMPT_FILE, 'utf8'); }
  catch (e) {
    // The prompt file ships beside this worker, so ANY failure here is structural (a broken
    // install, a bad hand-sync to ~/.claude) rather than a transient. `null` stops the drain
    // silently, which looks exactly like "nothing worth capturing" — forever.
    hlog('capture', `distiller prompt UNREADABLE (${e.code}) at ${SYS_PROMPT_FILE} — capture is DEAD, not idle`);
    return null;
  }
  const args = [
    '-p',
    '--model', MODEL,
    '--system-prompt', sys,
    '--output-format', 'json',
    '--strict-mcp-config',
    // NO MCP, deliberately and permanently. The distiller PROPOSES; the AGENT commits.
    // The old plan was to give this sub-call the vectros tools
    // so it could reconcile and write itself — that plan is dead, and with it the 135K-context
    // runaway it required (MCP tools force --max-turns > 1, which is what let this call continue
    // the transcript's work instead of distilling it). Keep it tool-less and single-turn.
    '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
    // Disallow every built-in by name — see recall-eval-worker for the measured breakdown
    // (and why `--allowed-tools ""` is a trap: an empty value is ignored, shipping ALL tools).
    '--disallowed-tools',
    'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,' +
      'TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode,AskUserQuestion,' +
      // See recall-eval-worker for why this list grew and why it is not the control: every name
      // added here was REAL and ABSENT, which is the argument against name-denylists, not for
      // them. `--max-turns 1` + the zero-MCP allow-list are what actually bound this child.
      'Skill,ToolSearch,Monitor,SendMessage,TaskCreate,TaskUpdate,TaskOutput,TaskStop,TaskList,' +
      'TaskGet,EnterWorktree,ExitWorktree,EnterPlanMode,Artifact,Workflow,CronCreate,CronList,' +
      'CronDelete,RemoteTrigger,PushNotification,ListMcpResourcesTool,ReadMcpResourceTool',
    // One judgment turn, never an agentic loop. Without this, the call runs num_turns:5,
    // CONTINUES the transcript's work instead of distilling it, and burns 135K context / ~$0.05.
    // See the <transcript> delimiting below.
    '--max-turns', '1',
  ];
  const res = spawnSync(CLAUDE_BIN, args, {
    // Both blocks are DATA, not a conversation to continue (the 135K bug above). The pending
    // list goes FIRST so the model reads what it already claimed before meeting new material —
    // that ordering is what turns a fresh variation into a REVISE.
    // FENCED. Both blocks are untrusted: the delta is raw session text, and the pending block is
    // rendered from candidate bodies a PREVIOUS distiller wrote from that same text — so an
    // unfenced forged tag would persist across runs. → transcript.mjs § fence.
    input: `<pending_candidates>\n${fence(pendingBlock)}\n</pending_candidates>\n\n`
      + `<transcript_delta>\n${fence(deltaText)}\n</transcript_delta>`,
    encoding: 'utf8', timeout: CAPTURE_CLAUDE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024, env: childEnv(), windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) return { error: `claude -p exit ${res.status}`, stderr: (res.stderr || '').slice(0, 400) };
  let modelText;
  try { modelText = JSON.parse(res.stdout).result; }
  catch { /* silence-ok: `--output-format json` is requested but not guaranteed; a plain-text reply is a supported shape, not a failure. Raw stdout is the DOCUMENTED alternative, and the `no JSON in reply` / `JSON parse` receipts below still catch real garbage. */ modelText = res.stdout; }
  if (typeof modelText !== 'string') return { error: 'no result text' };
  const m = modelText.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'no JSON in reply', raw: modelText.slice(0, 400) };
  try { return JSON.parse(m[0]); } catch (e) { return { error: 'JSON parse: ' + e.message, raw: m[0].slice(0, 400) }; }
}

/** Distil ONE window and commit its outcome. Returns the offset reached, or null to stop. */
function runWindow(sessionId, transcriptPath, fromOffset) {
  // Re-read the queue each window: the previous window's candidates are this window's PRIORS, which
  // is what lets a later chunk REVISE an earlier chunk instead of re-proposing a variant of it.
  const q = readQueue(sessionId);
  /**
   * HONOUR the corrupt receipt. `queue.read()` reports `state: 'corrupt'` when it cannot read the
   * queue — and this ignored it. An unreadable queue folds to an EMPTY `all`, so `nextId` mints
   * `c1` again and the fold's last-write-wins destroys the original candidate; the priors block
   * also goes empty, so the distiller re-proposes what it already proposed. queue.mjs added the
   * receipt and capture.mjs honours it; this caller — the one that WRITES — did not. Second of the
   * four mechanisms wired only where its bug was found.
   */
  if (q.state === 'corrupt') {
    hlog('capture-worker', 'queue read CORRUPT — refusing to distil (an empty fold would re-mint ids and destroy candidates)', sessionId);
    return null;
  }
  const { text, total, to, remaining, messages } = sliceSince(transcriptPath, fromOffset, DELTA_MAX_CHARS);
  if (text.length < 80) return null;

  const decision = distill(text, renderPending(q.pending));
  if (!decision || decision.error) {
    // Do NOT advance the watermark on a failed window — that would skip this stretch of transcript
    // forever, silently. A failed capture must be retried, not swallowed. Stop the drain here too:
    // marking a LATER window captured would jump the watermark over this failed one, which is the
    // 72% hole wearing a different hat.
    //
    // stderr is collected into `decision` on a claude -p exit failure (see `distill`'s res.status
    // branch) and this early return is the ONLY place a failed window is reported — the JSONL
    // review log below is never reached on this path. Without it here, the one field that would
    // explain WHY the child failed (auth expired, binary missing, OOM) was gathered and discarded.
    hlog('capture-worker', `distill FAILED (${decision?.error || 'no decision'})`
      + (decision?.stderr ? ` stderr="${decision.stderr.slice(0, 200)}"` : '')
      + ` — watermark HELD at ${Math.round(fromOffset / 1000)}K, drain stopped`, sessionId);
    return null;
  }

  // Append candidates to the queue. NEW -> propose; REVISE -> supersedes an earlier claim.
  const all = new Map(q.all);
  let nNew = 0, nRev = 0, nSpooled = 0;
  // Array.isArray, not `|| []` — guards SHAPE, not just null/undefined. `|| []` still iterates a
  // string or object the model returned in place of an array; recall-eval-worker.mjs's sibling
  // fields (`decision.keep`) already guard this way, this one didn't.
  for (const c of Array.isArray(decision.captures) ? decision.captures : []) {
    /**
     * THE CANDIDATE'S STABLE KEY, minted HERE and written to BOTH stores.
     *
     * Two jobs. (1) It is the idempotency key for the record write: the spool retries with the
     * same externalId, so an ambiguous timeout upserts the same row instead of creating a second
     * one. (2) It is what makes the two stores COMPARABLE — the queue event and the record carry
     * the same id, so "do these agree?" is a set difference rather than a fuzzy title match. That
     * is the check Phase A exists to run.
     *
     * A uuid, not a count. The queue's ordinal ids (`c1`…`cN`) are derived by the FOLD precisely
     * because two concurrent workers both computed `c1` and one candidate was silently destroyed;
     * minting a record key from any count would rebuild that race on the other side. Nothing here
     * reads existing state to choose it. → queue.mjs § the propose/revise arm.
     *
     * NO `id` FIELD, either — the worker does not name candidates any more; `queue.mjs`'s fold
     * does, by position. This loop used to call `nextId(all)`, a read-modify-write over that very
     * fold, which is where the collision above actually happened. The id an unsynchronized writer
     * allocates is not a fact, so it is not written.
     *
     * The shape of both writes lives in `capture-map.mjs` — pure, so it is testable, and shared
     * with the later backfill that must produce identical records from the historical queue files.
     */
    const { isRevise, ev, candidate, digest } = mapCapture(c, {
      sessionId, all, offset: to,
      uuid: randomUUID(),
      proposedAt: new Date().toISOString().slice(0, 10),
      // WHICH PATH PROPOSED THIS. The schema has carried `origin: session|recovered` from the
      // start and nothing ever wrote the second value, so the distinction it exists for — a live
      // session's own proposal vs one recovered from a session that ended without settling — was
      // simply absent from every record. The sweep passes `--recovered`; a live Stop does not.
      origin: RECOVERED ? 'recovered' : 'session',
    });
    /**
     * CHECK THE APPEND. It was discarded, and then `markCaptured(to)` ran regardless — so on any
     * append failure (ENOSPC, EACCES, a locked queue) the candidate vanished AND its source text
     * was marked distilled forever. That is the 72% watermark hole, one candidate wide, in the
     * file that implements the fix for it. `dispose.mjs` checks this same return; the worker did
     * not.
     */
    if (!append(sessionId, ev)) {
      hlog('capture-worker', `APPEND FAILED for "${String(c.title || '(untitled)').slice(0, 60)}" — abandoning this window WITHOUT advancing the watermark (it will be retried)`, sessionId);
      return null;
    }
    /**
     * DUAL-WRITE (cutover Phase A). The queue append above is still AUTHORITATIVE — every reader
     * reads it, and this branch changes no behaviour. The spool is a shadow copy that the flush
     * below promotes into a `candidate` record, so the corpus fills with real proposals for days
     * before anything depends on it.
     *
     * ORDER IS QUEUE-FIRST, and it is not arbitrary. A failed queue append abandons the window
     * without advancing the watermark, so the text is re-distilled later; anything spooled before
     * that point would have become a record with no queue entry behind it — a divergence in the
     * direction the agreement check reads as "the record store invented a candidate". Spooling
     * only after the authoritative write means the shadow can lag, never lead.
     *
     * A SPOOL FAILURE DOES NOT ABANDON THE WINDOW. In Phase A the claim is already durable in the
     * queue, so failing the window here would make dual-write strictly riskier than not
     * dual-writing — the opposite of "rollback is deleting one call". It is counted instead, and
     * the count rides the window log line so a silent divergence shows up where someone reads.
     * (`spool.mjs`'s own APPEND FAILED line says the proposal "will be lost"; that becomes true at
     * Phase B, when reads flip and the queue stops being the backstop. It is early, not wrong.)
     *
     * (The `proposedAt` stamp and the ordinal→externalId translation of `revises` both live in
     * `capture-map.mjs`, with the reasoning for each.)
     */
    ev.digest = digest;   // the content fingerprint --compare verifies the round trip against
    if (spool(sessionId, ev.externalId, candidate)) nSpooled++;
    /**
     * THE REVERSE HALF OF A CORRECTION, and nothing wrote it before.
     *
     * `candidate.revises` points the NEW record at the one it corrects. `pending()` retires the OLD
     * one by reading `supersededBy` — a field no production path ever set. The queue fold retired a
     * corrected claim; the corpus did not. Left alone, Phase B would have re-offered every
     * candidate ever revised, and `--compare` could not have warned anyone: both stores hold the
     * same externalIds, which is all it compares.
     *
     * Spooled, not written inline, so it survives the provisioning gap on the same terms as the
     * proposal that triggered it.
     */
    if (candidate.revises) spoolSupersede(sessionId, candidate.revises, ev.externalId);
    // Mirror the fold's POSITIONAL rule so a later candidate in this same batch can
    // `revises` an earlier one from it. The authoritative id still comes from queue.mjs's fold.
    all.set(`c${all.size + 1}`, ev);
    if (isRevise) nRev++; else nNew++;
  }

  // Mark EXACTLY what was read — never `total`. This is the whole fix: the watermark cannot pass
  // text no call ever saw, so "everything below this is distilled" is true by construction.
  markCaptured(sessionId, to);
  hlog('capture-worker',
    `distilled ${Math.round(text.length / 1000)}K (${messages} msgs) -> ${nNew} new + ${nRev} revised`
    // Only ever printed when it DISAGREES with the queue. Equal counts are the expected state and
    // saying so every window would train the reader to skim the one line that matters.
    + (nSpooled === nNew + nRev ? '' : ` (⚠ only ${nSpooled} SPOOLED — the record corpus will be short by ${nNew + nRev - nSpooled})`)
    + `; watermark ${Math.round(fromOffset / 1000)}K -> ${Math.round(to / 1000)}K of ${Math.round(total / 1000)}K`
    + (remaining ? ` — ${Math.round(remaining / 1000)}K still to drain` : ' — fully drained'),
    sessionId);

  // Keep the human-readable review log (this is what a reviewer reads while judging capture).
  try {
    fs.mkdirSync(captureLogDir(), { recursive: true });
    fs.appendFileSync(path.join(captureLogDir(), slug(sessionId) + '.jsonl'), JSON.stringify({
      at: new Date().toISOString(), sessionId,
      mode: LIVE ? 'QUEUED (VECTROS_CAPTURE_LIVE set, but there is no live-write path — label only)'
        : 'QUEUED (the agent validates via dispose.mjs; this worker writes nothing)',
      window: { from: fromOffset, to, chars: text.length, messages, remaining, total },
      ...decision,
    }) + '\n');
  } catch { /* silence-ok: this IS the capture-log append (the audit trail), so it has no second channel to report itself — the same bind hooklog.mjs is in. The queue append above is the durable write; this one is diagnostics. */ }

  return to;
}

/**
 * Release the in-flight lock `capture.mjs` took before spawning us.
 *
 * IT WAS NEVER RELEASED (both
 * locks still on disk ~50 min after their drains had logged "fully drained"). This file contained
 * no `lock` reference at all; the only `unlinkSync` was capture.mjs's 30-minute stale path.
 *
 * The consequence is worse than a leaked file: it silently turned the CONTENT gate into
 * "content AND a 30-minute timer" — reintroducing, 20x larger, the `DEBOUNCE_MS = 90_000` that
 * capture.mjs's own header celebrates removing as "uncorrelated with what the session produced",
 * and widening the never-distilled tail by roughly 6x. `LOCK_STALE_MS`'s comment ("a lock older
 * than this is treated as DEAD") only makes sense for a lock that is normally released; it read as
 * a backstop and was in fact the only path.
 *
 * Derived, not passed: one definition of the path would be better, but the worker must not import
 * capture.mjs (it is a hook with a top-level re-entrance `process.exit`). Keep the two in step.
 */
function releaseLock(sessionId) {
  try {
    fs.unlinkSync(lockFor(sessionId));
  } catch { /* silence-ok: already gone, or never taken (a direct worker invocation) — both fine, and both leave the lock ABSENT, which is the state this function exists to reach. Nothing to report. */ }
}

async function main() {
  const [sessionId, transcriptPath, fromOffsetArg] = process.argv.slice(2);
  if (!sessionId || !transcriptPath || !API_KEY) { if (sessionId) releaseLock(sessionId); return; }
  let offset = Number(fromOffsetArg) || 0;

  // DRAIN. One window is the common case (steady-state delta ~100-150K against a 400K window);
  // the loop only matters when the gap is large — adoption, or recovery after failures held the
  // watermark. Each pass re-slices from the offset just committed, so a crash mid-drain simply
  // leaves the rest for the next Stop: every window is independently committed.
  //
  // Termination is `runWindow`'s job alone — it returns null once there is nothing left to read.
  // Do NOT add a lookahead like `sliceSince(offset).remaining === 0` to decide whether to continue:
  // `remaining` is measured AFTER the window it describes, so on the FINAL window it is 0 and the
  // loop breaks before distilling it. MEASURED: that dropped the last 37K of a 1234K transcript —
  // the tail, where the conclusions are. The watermark held honestly (so the next Stop recovered
  // it), but a session ending there would have lost that text: the same "silently skip the arc"
  // failure this whole change exists to remove, one window wide.
  let windows = 0;
  // `finally`, not a tail call: the lock must drop on a throw too, or one crash wedges capture for
  // this session for 30 minutes with no diagnostic.
  try {
    for (; windows < MAX_WINDOWS_PER_RUN; windows++) {
      const to = runWindow(sessionId, transcriptPath, offset);
      if (to === null || to <= offset) break;  // failed, drained, or no forward progress
      offset = to;
    }
    if (windows === MAX_WINDOWS_PER_RUN) {
      hlog('capture-worker',
        `drain hit MAX_WINDOWS_PER_RUN (${MAX_WINDOWS_PER_RUN}) at ${Math.round(offset / 1000)}K — `
        + 'resumes from the watermark next Stop; nothing skipped', sessionId);
    }
    /**
     * PROMOTE the spooled proposals to records (cutover Phase A).
     *
     * UNCONDITIONAL — outside the window loop and not gated on this run having produced anything.
     * A run that distils nothing is exactly when a BACKLOG is most likely to be waiting: the
     * common reason nothing synced is that the store was unreachable or the type unprovisioned,
     * and neither of those has anything to do with whether this transcript had new text.
     *
     * HERE, in the detached worker, because this is the only part of the loop that is already off
     * the user's turn. The prompt-path hooks run under a 30s wall with a person waiting; this one
     * is fire-and-forget and nothing observes its exit.
     *
     * It cannot throw — `flush` catches everything and returns a receipt — but it is inside the
     * `try` so that the lock still drops if that ever stops being true.
     */
    const receipts = await drainAll(sessionId);
    const tot = (k) => receipts.reduce((n, r) => n + (r[k] || 0), 0);
    if (tot('attempted')) {
      hlog('capture-worker',
        `spool drain: ${tot('synced')} synced, ${tot('failed')} failed, ${tot('deferred')} deferred, `
        + `${tot('parked')} parked across ${receipts.length} session(s)`, sessionId);
    }
  } finally {
    releaseLock(sessionId);
  }
}

// A crash receipt, not just fail-open — this worker is spawned `detached, stdio: 'ignore'`
// (capture.mjs), so an uncaught throw here has NO other way to reach a human. Every sibling
// hook/worker in this directory has this guard; this was the one exception (found during an
// OSS-readiness pass — a silent death here was invisible by construction).
main().catch((e) => {
  try { hlog('capture-worker', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking further over a logging failure would be worse than the silence. */ }
});
