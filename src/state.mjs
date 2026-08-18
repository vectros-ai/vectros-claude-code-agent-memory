/**
 * Per-session hook state — ONE read/write path for all six hooks.
 *
 * Before this, seven hand-rolled `writeFileSync(sp, JSON.stringify(state))` calls raced across
 * six processes, and four hand-rolled readers each did `catch {}` -> silent reset. See
 * `atomic.mjs` for the measurements (33.7% torn reads; the Windows EPERM trap).
 *
 * The observability rule is `hooklog.mjs`'s own, applied to the thing that broke it:
 * **a fail-open component MUST say what it did.** A corrupt read and a lost write are data loss.
 * They stay non-fatal — a hook must never break a turn — but they are no longer silent.
 */
import fs from 'node:fs';
import { readJsonSafe, writeFileAtomic } from './atomic.mjs';
import { hlog } from './hooklog.mjs';
import { stateDir, stateFor } from './paths.mjs';

export const statePath = stateFor;

/**
 * Read this session's state. `defaults` are applied for a FRESH session (no file) — which is
 * correct — and also on corruption, which is NOT correct but is all we can do; the difference
 * is that corruption now announces itself instead of masquerading as a new session.
 */
/**
 * @returns {{value: object, state: 'fresh'|'ok'|'unreadable'|'damaged', why?: string}}
 *
 * IT RETURNS THE RECEIPT, and that is the whole point of `readJsonSafe` — which un-conflates
 * fresh/ok/corrupt and was then thrown away one line later by `return r.value`. The receipt died at
 * the return: **no caller could check it, because it was not in the return type.** So the file that
 * SIX processes race was the only one whose reader could not fail closed — while the identical
 * receipt from `queue.read()` is honoured at five sites and refuses to act at `capture.mjs`. Same
 * rule, a receipt only where someone happened to wire one — the same census discipline failure mode.
 *
 * WHY A CORRUPT READ MUST NOT BE WRITTEN BACK, which is the part worth understanding: `corrupt`
 * here overwhelmingly means a TORN read, not a broken file. `writeFileSync` truncates then writes,
 * so a reader landing in that window sees a partial file — MEASURED at 33.7% of reads (5,399/16,000)
 * under 4-way concurrency. The bytes on disk are usually FINE a millisecond later. Substituting
 * defaults and writing them back converts a transient, self-healing read failure into PERMANENT
 * data loss — which is exactly how `promptCount` went 37 -> 9 and nobody noticed for a month.
 *
 * TWO FAILURES, OPPOSITE ANSWERS — and this is the correction to the first version of this fix,
 * which refused to write on BOTH and thereby traded a transient wipe for a permanent wedge:
 *
 *   'unreadable' — the read failed; the bytes are UNKNOWN and may be perfect. Publishing defaults
 *                  would destroy content nobody looked at. DO NOT WRITE; the next hook re-reads.
 *   'damaged'    — the bytes parsed as garbage. Every writer renames, so this is real damage, not
 *                  a torn read: the content is already gone and nothing else will ever repair this
 *                  file. WRITING IS THE REPAIR. Refusing forever means a permanently stateless
 *                  session — a full orient every prompt, and evaluate.mjs's debounce stuck open
 *                  spawning a billed `claude -p` per tool call, unbounded.
 *
 * `readJsonSafe` always knew which was which; it said so only in a prose `why` that no caller could
 * branch on. -> atomic.mjs § unreadable vs damaged.
 */
export function readState(sessionId, defaults = {}) {
  const r = readJsonSafe(statePath(sessionId), defaults);
  if (r.state === 'unreadable') {
    hlog('state', `UNREADABLE (${r.why}) — the bytes are UNKNOWN and may be fine; defaults are for THIS read only. Callers MUST NOT write back.`, sessionId);
  } else if (r.state === 'damaged') {
    hlog('state', `DAMAGED (${r.why}) — parsed as garbage, and every writer renames, so this is real loss rather than a torn read. Callers SHOULD write, to repair it.`, sessionId);
  }
  return r;
}

/** Publish this session's state atomically. Returns false (and logs) if the write was lost. */
export function writeState(sessionId, state) {
  try { fs.mkdirSync(stateDir(), { recursive: true }); } catch { /* silence-ok: best-effort mkdir; if the dir is genuinely unusable the writeFileAtomic below fails and WRITE LOST reports it with the real reason. Logging here would double-report the same event. */ }
  const ok = writeFileAtomic(statePath(sessionId), JSON.stringify(state));
  if (!ok) hlog('state', 'WRITE LOST (rename stayed contended) — this update did not persist', sessionId);
  return ok;
}
