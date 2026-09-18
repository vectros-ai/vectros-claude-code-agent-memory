/**
 * The candidate WRITE-AHEAD SPOOL — what keeps an outage from costing a lesson.
 *
 * A distilled candidate is expensive: it is the product of a billed inference pass over a
 * transcript that will not be re-read (the watermark has moved). If the record write fails, the
 * claim is simply gone. So the proposal is written HERE first, locally and synchronously, and
 * promoted to a record afterwards. The store becomes the corpus; this file is the durability.
 *
 * THE READ PATH DOES NOT COME HERE, and that is the decision that makes this tractable.
 *
 * A spool that were also a read fallback would force every consumer to merge two sources forever —
 * the local fold the record move exists to delete, kept alive in six places and drifting from the
 * store in each. So reads go to records, full stop. The cost is precisely this: during an outage a
 * newly proposed candidate is not NUDGED about until sync succeeds. It is durable the whole time.
 * Nothing is lost; a notification is late. That trade is stated plainly in the design and is the
 * reason the file stays this small.
 *
 * APPEND-ONLY, folded — the same shape (and the same reasoning) as the queue it replaces. Two
 * writers, one file, no locking, because there is no read-modify-write: state is a FOLD over
 * events, so a concurrent append cannot lose an earlier one.
 *
 *   { op:'write',  at, externalId, sessionId, candidate }  — a proposal that OWES a record write
 *   { op:'synced', at, externalId }                        — it landed; stop retrying
 *   { op:'failed', at, externalId, why }                    — one attempt failed (retry budget)
 *
 * `dispose.mjs` DELIBERATELY DOES NOT USE THIS. Settling is interactive and synchronous: an agent
 * is standing there, and a failed verdict must fail in its face. A disposition that "will sync
 * later" is worse than one that visibly did not land — the agent moves on believing the candidate
 * is settled, and nothing ever tells it otherwise.
 */
import fs from 'node:fs';
import { hlog } from './hooklog.mjs';
import path from 'node:path';
import { spoolDir, spoolFor, spoolOffFile, slug } from './paths.mjs';
import { SPOOL_MAX_ATTEMPTS, SPOOL_FLUSH_MAX_PER_RUN, SPOOL_DRAIN_MAX_SESSIONS } from './config.mjs';
import { propose, paused, supersedeByExternalId, CHARGEABLE } from './candidates.mjs';

export const spoolPath = spoolFor;

/** Append one event. Never throws — a hook must not break a turn. Returns false on a lost write. */
export function append(sessionId, ev) {
  try {
    fs.mkdirSync(spoolDir(), { recursive: true });
    fs.appendFileSync(spoolPath(sessionId), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
    return true;
  } catch (e) {
    // NOT silence-ok, and this is the one place in the loop where it truly is not. A dropped spool
    // append is a candidate that never existed anywhere — no record, no local trace, no receipt.
    // Every other append failure in this tree costs a retry or a duplicate; this one costs the
    // claim itself, so it says so where someone will see it.
    hlog('spool', `APPEND FAILED (${e?.code || e?.message}) — the proposal is NOT durable and will be lost`, sessionId);
    return false;
  }
}

/**
 * Record a proposal that owes a record write. Call BEFORE attempting the write, always — that
 * ordering is the entire guarantee, and reversing it (write, then spool on failure) loses
 * everything that crashes in between.
 *
 * `externalId` is minted by the caller before the first attempt so a retry UPSERTS rather than
 * duplicating; it is the idempotency key and the reason a retry after an ambiguous timeout is safe.
 */
export function spool(sessionId, externalId, candidate) {
  return append(sessionId, { op: 'write', externalId, sessionId, candidate });
}

/**
 * Record that `targetExternalId` was CORRECTED by `byExternalId` — the reverse half of a revise.
 *
 * Spooled rather than written inline for the same reason the proposal is: it must survive the
 * provisioning gap and every outage, or the corpus ends up holding corrections whose targets were
 * never retired. It rides the same fold, the same retry budget and the same receipt.
 *
 * Its own synthetic key (`sup:<target>`) so it is tracked and retried independently of the write
 * that triggered it — and so re-applying it is idempotent, which a PATCH of a fixed field already
 * is.
 */
export function spoolSupersede(sessionId, targetExternalId, byExternalId) {
  return append(sessionId, {
    op: 'write', externalId: `sup:${targetExternalId}`, sessionId,
    supersede: { target: targetExternalId, by: byExternalId },
  });
}

/**
 * Fold the log into what is still owed.
 *
 *   owed   — proposals with no `synced`, under the attempt budget, oldest first
 *   parked — over budget: still on disk, never retried again, counted so the loss is MEASURED
 *   synced — how many landed (for the receipt)
 *
 * A malformed line is skipped, not fatal: one bad append must not strand a session's whole spool.
 */
export function read(sessionId, dir) {
  let lines = [];
  try {
    /**
     * `dir` OVERRIDES the default location, so the reaper's injected `spoolD` seam actually works.
     *
     * Without it `read` always resolved against the global `spoolDir()`, so a reaper pointed at any
     * other directory re-checked the WRONG files: every spool looked absent, the safety recheck saw
     * `state:'fresh'`, and every spool delete aborted. Production was unaffected — the two paths
     * coincide there — but the seam added for testability was fiction, which is exactly why
     * the collect -> plan -> apply wiring for spools ended up with no coverage at all.
     */
    const p = dir ? path.join(dir, `${slug(sessionId)}.jsonl`) : spoolPath(sessionId);
    lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return { owed: [], parked: [], synced: 0, events: 0, state: 'fresh' };
    /**
     * Fail CLOSED, exactly as the queue's reader does. Reporting "nothing owed" for a spool we
     * could not read would let a caller conclude everything is synced — and the natural next step
     * after that conclusion is to stop asking, which strands real proposals silently.
     */
    hlog('spool', `READ FAILED (${e.code}) — cannot tell what is owed; skipping this flush`, sessionId);
    return { owed: [], parked: [], synced: 0, events: 0, state: 'corrupt' };
  }

  const writes = new Map();
  const synced = new Set();
  const attempts = new Map();
  let events = 0;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); }
    catch {
      /**
       * NOT silence-ok, unlike the comment this replaces claimed. A crash mid-`appendFileSync`
       * leaves a line with no trailing newline; the NEXT event concatenates onto it and BOTH are
       * lost here, not one (pinned by spool-test.mjs's newline-less-tear case). Every other
       * failure branch in this file is loud about what it could not read (the ENOENT/corrupt path
       * above); this one wasn't, on a struct whose bodies are explicitly uncapped — a crash
       * mid-large-append is not a negligible edge case. One line per tear, not per event, so a
       * torn spool costs a log line, not a log flood.
       */
      hlog('spool', 'a torn line was skipped (unparseable) — the event on it, and the one appended '
        + 'directly after it with no newline between them, are both lost', sessionId);
      continue;
    }
    events++;
    if (e.op === 'write' && e.externalId) writes.set(e.externalId, e);
    else if (e.op === 'synced' && e.externalId) synced.add(e.externalId);
    else if (e.op === 'failed' && e.externalId) attempts.set(e.externalId, (attempts.get(e.externalId) || 0) + 1);
  }

  const owed = [];
  const parked = [];
  for (const [externalId, ev] of writes) {
    if (synced.has(externalId)) continue;
    const n = attempts.get(externalId) || 0;
    (n >= SPOOL_MAX_ATTEMPTS ? parked : owed).push({ ...ev, attempts: n });
  }
  return { owed, parked, synced: synced.size, events, state: 'ok' };
}

export const markSynced = (sessionId, externalId) => append(sessionId, { op: 'synced', externalId });
export const markFailed = (sessionId, externalId, why) => append(sessionId, { op: 'failed', externalId, why });

/**
 * Attempt every owed write, oldest first, up to the per-run cap.
 *
 * Returns a RECEIPT rather than a boolean: `{ attempted, synced, failed, parked, skipped }`. A
 * flush that quietly does nothing is indistinguishable from one that had nothing to do, and those
 * are very different states — the first means the corpus is diverging.
 *
 * SUCCESS IS MARKED, FAILURE IS COUNTED, NEITHER IS DELETED. The spool only ever grows within a
 * session; the reaper retires the file with the rest of that session's state once it is done. That
 * is deliberate — a spool that deleted its own lines would lose the audit trail of what failed,
 * which is the only evidence a permanently-failing proposal leaves.
 */
/** Is promotion switched off here? A file, so a fresh hook process sees it without a restart. */
export function spoolDisabled() {
  if (process.env.VECTROS_MEM_SPOOL_OFF === '1') return 'VECTROS_MEM_SPOOL_OFF';
  try { return fs.existsSync(spoolOffFile()) ? 'SPOOL_OFF file' : false; }
  catch { /* silence-ok: an unreadable home cannot be read as "switched off" — failing open here matches every other gate in this tree, and the flush's own receipts still report what it did. */ return false; }
}

export async function flush(sessionId, opts = {}) {
  /**
   * THE KILL-SWITCH COMES FIRST — before the pause latch, before the read. Spooling continues
   * (proposals stay durable); only PROMOTION stops. That is the useful shape for an off-switch on
   * a write path: turning it off must not start losing the thing the write path was protecting.
   */
  const off = spoolDisabled();
  if (off) return { attempted: 0, synced: 0, failed: 0, parked: 0, skipped: `off:${off}` };
  /**
   * A MISSING SCHEMA MUST NOT SPEND THE RETRY BUDGET — and this was a real bug, caught by probing
   * the exact sequence the deploy gate creates.
   *
   * The budget exists to stop retrying a write that CANNOT land: a malformed body fails
   * identically forever, so five attempts prove it. But "the type is not provisioned in this
   * context" is a property of the ENVIRONMENT, not of any entry — it applies to every proposal
   * equally, and it is fixed by provisioning, not by giving up.
   *
   * Measured before the fix: with the schema absent, every spooled proposal was `failed` on each
   * Stop and PARKED after the budget — so provisioning the schema later would NOT have recovered
   * them. Precisely the candidates made during the gap window, the window this project deliberately
   * creates by shipping hook code before the prod context is updated, would have been lost.
   *
   * So: skip entirely. Attempt nothing, count nothing. The gap latch carries its own TTL and
   * self-heals, and everything spooled meanwhile is still owed when it does.
   */
  if (paused()) {
    const s0 = read(sessionId);
    return { attempted: 0, synced: 0, failed: 0, parked: s0.parked.length, skipped: 'schema-absent' };
  }
  const s = read(sessionId);
  if (s.state === 'corrupt') return { attempted: 0, synced: 0, failed: 0, parked: s.parked.length, skipped: 'corrupt' };
  if (!s.owed.length) return { attempted: 0, synced: 0, failed: 0, parked: s.parked.length, skipped: null };

  const batch = s.owed.slice(0, SPOOL_FLUSH_MAX_PER_RUN);
  let synced = 0;
  let failed = 0;
  let halted = null;
  for (const item of batch) {
    /**
     * ONLY AN ENTRY-SPECIFIC REFUSAL SPENDS THE BUDGET — and getting this wrong cost the deploy
     * gate's entire guarantee.
     *
     * The old code charged every `null`, and `paused()` was checked only ONCE at flush entry. So
     * the first flush after each TTL expiry went: item 1 hits the 400, sets the latch, and returns
     * null; items 2..N then get null FROM THE LATCH ITSELF and were charged too. MEASURED on a
     * 4-entry spool with the type unprovisioned: 4 attempts charged per TTL window, all 4 PARKED
     * after the 5th — five hours against a deploy gate that is open for DAYS. Every proposal made
     * before provisioning would have been lost, by the mechanism written to prevent exactly that.
     *
     * So: classify, and charge only `rejected` — the store looked at THIS body and refused it, and
     * the same bytes will be refused forever. An environment failure (no key, auth, rate-limited,
     * schema absent, unreachable) applies identically to every remaining entry, so there is nothing
     * to learn by trying them: HALT the batch and leave everything owed. The next Stop retries for
     * free. `rate-limited` (429) joined this list after it was found falling through to
     * `rejected` — the same bytes succeed once the window resets, so charging it risked parking
     * real candidates permanently under a busy drain.
     */
    const fail = {};
    // Two kinds of owed work share one fold: a proposal to create, and a supersession to apply.
    // Dispatching here rather than in a second loop keeps them under one retry budget and one
    // halt rule — a supersession that could not run for an environment reason must stop the batch
    // exactly as a proposal does.
    const r = item.supersede
      ? await supersedeByExternalId(item.supersede.target, item.supersede.by, { ...opts, fail })
      : await propose(item.sessionId || sessionId,
        { ...item.candidate, externalId: item.externalId }, { ...opts, fail });
    if (r) {
      /**
       * CHECK THE MARKER. The record write LANDED; if the `synced` append then fails, the entry
       * stays owed and the next flush re-`propose`s it — which rewrites `disposition: 'pending'`.
       * Harmless while nothing settles records, and a silent un-settle the moment they are
       * authoritative: an agent's verdict reverted by a bookkeeping failure it never saw.
       */
      if (!markSynced(sessionId, item.externalId)) {
        hlog('spool', `the record for ${item.externalId} LANDED but its synced marker did not append `
          + '— it will be re-proposed, which resets its disposition to pending', sessionId);
      }
      synced++; continue;
    }
    if (CHARGEABLE.has(fail.reason)) {
      // The reason is RECORDED, not a constant — a parked entry's only evidence is this line, and
      // "propose returned null" told a later reader nothing about why it could not land.
      markFailed(sessionId, item.externalId, fail.reason || 'unknown');
      failed++;
      continue;
    }
    halted = fail.reason || 'unknown';
    break;
  }
  if (synced || failed || halted) {
    hlog('spool', `flush: ${synced} synced, ${failed} failed, ${s.owed.length - batch.length} deferred, ${s.parked.length} parked`
      + (halted ? ` — HALTED on '${halted}': an environment failure, so the rest stay owed and spend no budget` : ''), sessionId);
  }
  return {
    // `attempted` is what was actually tried, not the batch size — a halt leaves the remainder
    // untouched, and reporting them as attempted would overstate what this run observed.
    attempted: synced + failed, synced, failed,
    parked: s.parked.length,
    deferred: s.owed.length - (synced + failed),
    halted,
    skipped: null,
  };
}

/**
 * Flush THIS session's spool, then a bounded number of other sessions' — and the second half is
 * not a nicety, it is what keeps the reaper's contract satisfiable.
 *
 * `reap.mjs` treats a spool with owed writes as IMMORTAL ("never eligible at any age"), on the
 * stated assumption that an outage ends and something eventually syncs. A per-session-only flush
 * breaks that assumption for exactly the population this project creates on purpose: proposals made
 * while the type was unprovisioned belong to sessions that have since ENDED, and an ended session
 * never Stops again, so nothing would ever flush them. They would owe forever, be kept forever, and
 * the deploy gate's own window would be the thing that leaked.
 *
 * OWN SESSION FIRST — its proposals are the ones a nudge is about to be wrong about — then the rest
 * in a stable order, skipping any that owe nothing so the budget goes to real work.
 *
 * The bound is `maxSessions` FLUSHED sessions, and each one costs up to `SPOOL_FLUSH_MAX_PER_RUN`
 * writes, so the two multiply: the worst case is the product, not either number. No session starves
 * permanently — each one empties and drops out of the list, so a later run reaches the next.
 */
export async function drainAll(sessionId, { maxSessions = SPOOL_DRAIN_MAX_SESSIONS, ...opts } = {}) {
  // Checked here too, not just in `flush`: otherwise a disabled drain still walks the whole spool
  // directory to produce a receipt per session saying it did nothing.
  const off = spoolDisabled();
  if (off) return [{ sid: sessionId, attempted: 0, synced: 0, failed: 0, parked: 0, skipped: `off:${off}` }];
  const receipts = [];
  const seen = new Set();
  const run = async (sid) => {
    seen.add(spoolPath(sid));
    receipts.push({ sid, ...(await flush(sid, opts)) });
  };
  if (sessionId) await run(sessionId);
  // A paused flush attempts nothing, so iterating the rest would be pure file reads for no
  // possible write. Stop at the first sign of it rather than reading 60 spools to learn it 60x.
  if (paused()) return receipts;

  for (const sid of listSpools().sort()) {
    if (receipts.length >= maxSessions) break;
    if (seen.has(spoolPath(sid))) continue;   // compare PATHS: `sid` here is already slugged
    if (!read(sid).owed.length) continue;
    await run(sid);
  }
  return receipts;
}

/** Sessions with a spool file — the flush's work list, and report.mjs's census. */
export function listSpools(dir = spoolDir()) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
  } catch { /* silence-ok: no spool dir yet is the normal cold-start state, and an unreadable one yields an empty work list — the flush simply does nothing this tick, which is the same outcome as having nothing owed. */ return []; }
}
