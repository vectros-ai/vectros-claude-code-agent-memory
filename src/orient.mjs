#!/usr/bin/env node
/**
 * SessionStart hook — MARK THE ORIENTATION BOUNDARY. That is the whole job.
 *
 * No network, no enumeration, no injection: one small file write. The actual orientation
 * (pinned set + resumed-thread memory + the multi-query recall) happens in recall.mjs, on the
 * FIRST REAL USER PROMPT, which is the moment the session actually starts working.
 *
 * ── WHY THIS DOES NOTHING ────────────────────────────────────────────────────────────────────
 * This hook used to enumerate the pinned set and inject it here. Then the hook log grew a field
 * saying WHO started the session, and the answer was ugly:
 *
 *   ~180 sessions in 5h fired orient and NOTHING else — no recall, no evaluate, no stop. A
 *   steady ~1/min drip, never bursting, every one `source=startup cwd=<HOME>`. A typical user
 *   runs 3-6 real sessions; the rest were Claude Desktop spawning a session process in the home
 *   directory about once a minute, which boots, fires SessionStart, and dies without ever
 *   taking a prompt. Caught in the act: a new `claude-code/…/claude.exe --output-format
 *   stream-json …` parented by the Desktop app, two seconds before each phantom orient.
 *
 * The rate, corrected: 180 sessions in 5h is 864/day, not the ~1400/day
 * this comment originally claimed — and the live log measures 741 fires in 23.1h, ~770/day. The
 * load-bearing conclusion (>95% wasted, so move the enumeration to the first real PROMPT) HOLDS;
 * the headline number was inflated ~1.7x by arithmetic nobody re-did. Stated as measured, it was
 * not.
 *
 * So >95% of this hook's work — a REST call and a 10-record fetch each time, ~800/day — was
 * spent orienting sessions that never did anything. Not a bug in the app: a bug in ASSUMING
 * "a session process exists" means "a session is about to work."
 *
 * The fix is to stop paying at process start and start paying at first prompt. A session that
 * never gets a prompt now costs one file write. Nothing is lost: the pinned set still lands
 * before the agent does any work, because the first prompt IS the first work. It also deletes
 * the awkward split where SessionStart enumerated while UserPromptSubmit searched — one
 * orientation, one place, one trigger.
 *
 * (Ruled out first, so nobody re-runs these: subagents do NOT fire SessionStart — a synchronous
 * probe measured delta 0. The `claude -p` workers are re-entrance-guarded and verified silent.
 * Every 60s A/B probe against a ~1/min background drip sits inside the noise floor and proves
 * nothing; the `cwd` fingerprint is what actually settled it. And `ppid` is useless here — it is
 * the hook's transient bash shell, not the session process.)
 *
 * Fail-open: any error means the boundary is unmarked, and recall.mjs's pre-flag fallback still
 * orients on a session whose promptCount is 0. Self-contained.
 */
import fs from 'node:fs';
import { hlog } from './hooklog.mjs';
import { readState, writeState } from './state.mjs';
import { stateDir } from './paths.mjs';

if (process.env.VECTROS_RECALL_EVAL === '1') process.exit(0); // re-entrance guard


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
  try { input = JSON.parse(await readStdin()); } catch { hlog('orient', 'skip: unparseable stdin'); return; }
  const sessionId = input.session_id || 'nosession';
  const source = input.source || 'startup'; // startup | resume | clear

  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const { value: state, state: stState } = readState(sessionId);
    // The NEXT user prompt is this session's kickoff: recall.mjs spends the full orientation on
    // it. An explicit flag, not a promptCount proxy — see recall.mjs for why that proxy lies in
    // both directions. capture.mjs sets the same flag at PreCompact, the boundary this hook
    // never sees (a compact keeps the session_id and SessionStart does not re-fire).
    state.orientPending = true;
    // Carry `source` forward: only a RESUME earns the thread-episodic lookup, and by the time
    // the first prompt arrives this is the only record of how the session began.
    state.orientSource = source;
    state.orientedAt = new Date().toISOString();
    // Refuse only on UNREADABLE — see state.mjs. Defaults published here would erase the very fields this hook
    // exists to protect, to record that a session started.
    if (stState === 'unreadable') {
      hlog('orient', 'state read UNREADABLE — boundary NOT marked (the bytes are unknown and may be fine); the !promptCount fallback in recall.mjs still covers a fresh session', sessionId);
      return;
    }
    writeState(sessionId, state);
  } catch (e) {
    // recall.mjs's !promptCount fallback still orients, so this stays fail-open — but a throw here
    // is UNEXPECTED (writeState is itself fail-soft and logs its own lost writes), which is exactly
    // why it must not be swallowed. Silence here would hide orientPending never being set, and the
    // only symptom is a kickoff prompt that quietly gets a thinner recall.
    hlog('orient', `state write threw (${e?.code || e?.message || 'error'}) — orientPending not set; falling back to recall.mjs's !promptCount path`, sessionId);
  }

  // cwd is the field that carries signal (a phantom runs in HOME, a real session in its
  // worktree). Kept deliberately: it is what identified the drip, and it is how we would notice
  // a regression. Costs nothing now that this hook makes no network call.
  const cwd = (input.cwd || process.cwd() || '?').split(/[\\/]/).pop();
  hlog('orient', `boundary marked (source=${source}) cwd=${cwd}`, sessionId);
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
  try { hlog('orient', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
