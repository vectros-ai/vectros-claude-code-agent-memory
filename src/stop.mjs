#!/usr/bin/env node
/**
 * Stop hook — L2 rolling-window feed.
 *
 * Fires when the assistant finishes a turn; receives `last_assistant_message`.
 * Its deterministic job: stash the tail of that message into the per-session state
 * so the NEXT UserPromptSubmit recall can condition its query on recent context —
 * the fix for terse follow-ups ("go do it"), where the retrieval signal lives in the
 * prior assistant turn, not the short user prompt. (Capture — deciding what is worth
 * remembering and writing it — is inference and stays the agent's job / a future
 * async extract-reconcile pass; this hook does NOT write memory.)
 *
 * Emits nothing; never blocks. Self-contained.
 */
import fs from 'node:fs';
import { hlog } from './hooklog.mjs';
import { readState, writeState } from './state.mjs';
import { stateDir } from './paths.mjs';
import { STASH_CHARS } from './config.mjs';

// Re-entrance guard: no-op inside the mid-run evaluator's own nested `claude -p`
// (which sets VECTROS_RECALL_EVAL=1), so it never re-fires the recall loop.
if (process.env.VECTROS_RECALL_EVAL === '1') process.exit(0);


function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { hlog('stop', 'skip: unparseable stdin'); return; }
  const msg = (input.last_assistant_message || input.assistant_message || '').toString();
  const sessionId = input.session_id || 'nosession';
  /**
   * AN EMPTY MESSAGE STILL PROVES THE SESSION IS ALIVE — and that used to return before writing
   * anything, which later work turned into a correctness bug rather than a missing tail.
   *
   * `lastStopAt` is the staleness clock for BOTH the sweep (may I flush this session's transcript?)
   * and the orphan nudge (may I hand its candidates to another agent?). A session resumed after a
   * day still read as 24h+ idle until its first NON-EMPTY Stop landed — so during that window a
   * live session could have its tail flushed and its pending candidates surfaced to a foreign
   * agent, while its own agent was being nudged with the same candidates. Two agents, one queue,
   * and a disposition is final.
   *
   * So the clock is stamped here, before the early return: it answers "is this session alive?",
   * which an empty assistant message answers perfectly well. Only the rolling-window TAIL needs a
   * message, and that is what the return below skips.
   */
  if (!msg.trim()) {
    /**
     * ONLY `lastStopAt`. NOT `transcriptPath` — and that omission is the whole point.
     *
     * `residual.mjs`'s `if (!s.transcriptPath) continue` is what excludes phantom sessions from the
     * sweep's enumeration BY CONSTRUCTION, and this hook is the only writer of that field. Desktop
     * spawns ~1-2 phantom Stops per minute, all with an empty message; stamping a path here would
     * admit every one of them permanently. MEASURED on a Windows 11 dev machine: 2,548 state files, of which
     * **19** carry a transcriptPath today. Each admitted phantom becomes an enumerated row once 24h
     * idle, is NEVER swept (its residual is below the floor, so `markSwept` never fires, so
     * `skipSwept` never excludes it), and is therefore re-read — state parse + queue fold +
     * `transcriptLength` — on every sweep, forever, against a population growing ~1,440-2,880/day.
     * There was no reaper for `state/` or `queue/` until `reap.mjs` was added, which is now wired into this same Stop path.
     *
     * The liveness fix stands on `lastStopAt` alone: an empty Stop proves the session is ALIVE,
     * which is the only question the staleness clock asks. A session that has ever produced an
     * assistant message already got its path from the normal path below; one that never has has no
     * tail worth distilling, so it has nothing to contribute to the sweep anyway.
     */
    const { value: st, state: stSt } = readState(sessionId, { injectedIds: [], lastAssistant: '' });
    if (stSt !== 'unreadable') {
      st.lastStopAt = Date.now();
      writeState(sessionId, st);
    }
    hlog('stop', `no assistant message — liveness clock stamped (no transcriptPath: that would admit every phantom into the sweep); payload keys=[${Object.keys(input).join(',')}]`, sessionId);
    return;
  }

  fs.mkdirSync(stateDir(), { recursive: true });
  const { value: state, state: stState } = readState(sessionId, { injectedIds: [], lastAssistant: '' });
  state.lastAssistant = msg.slice(-STASH_CHARS);
  // Remember WHERE this session's transcript is and WHEN it last spoke, so a
  // later pass can compute its residual (report.mjs) and — once the sweep lands — flush its
  // tail. Neither can locate a done session's transcript otherwise: the hook payload is the
  // only place the path appears, and a done session emits no more payloads. `lastStopAt` freezes at
  // the final turn, so `now - lastStopAt` is the staleness clock. The read-merge in readJsonSafe
  // preserves both fields across every OTHER hook's write (defaults are spread UNDER the parsed
  // file), so only this line needs to set them.
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  state.lastStopAt = Date.now();
  // Refuse only on UNREADABLE: a torn read hands back defaults, and publishing them erases promptCount /
  // injectedIds / orientPending to store one tail. The tail is re-stashed next turn; they are not.
  if (stState === 'unreadable') {
    hlog('stop', 'state read UNREADABLE — rolling-window tail NOT stashed (the bytes are unknown and may be fine)', sessionId);
  } else {
    writeState(sessionId, state);
  }
  hlog('stop', `stashed ${Math.min(msg.length, STASH_CHARS)}c assistant tail`, sessionId);
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
  try { hlog('stop', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
