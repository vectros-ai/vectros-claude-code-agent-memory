#!/usr/bin/env node
/**
 * THE REAPER — prune `state/` and `queue/`, and refuse loudly rather than delete quietly.
 *
 * WHY IT EXISTS. Both directories grow monotonically and nothing prunes them. Re-measured
 * (the issue's own figures were stale and had more than doubled):
 *
 *   state/ ...... 5,779 files, 0.8 MB, in a corpus 15.7 days old   -> ~368/day, unbounded
 *   queue/ ......    58 files, 694 KB — 12 with pending, 46 settled
 *
 * The cost is NOT disk. 0.8 MB is nothing. The cost is ENUMERATION: `report.mjs` `JSON.parse`s every
 * one of those files to compute a tally, and the sweep stats them on a debounced Stop. That is what
 * grows without bound.
 *
 * ── THE CORRECTION THAT SHAPES THE WHOLE DESIGN ─────────────────────────────────────────────────
 *
 * The original design said: *"Desktop spawns ~1-2 empty Stops per minute, each of which creates a state file."*
 * That is not what is happening, and believing it produces a reaper that does nothing.
 *
 * MEASURED: 5,450 of the 5,779 files hold EXACTLY `{orientPending, orientSource, orientedAt}` —
 * byte-for-byte what `orient.mjs` writes at SessionStart. `stop.mjs` is the only writer of
 * `lastStopAt`, and only 56 files carry it. So the phantoms are SessionStart-created and NEVER
 * REACHED A STOP; they have no `lastStopAt` and never will.
 *
 * The issue proposes retention keyed on "no `lastStopAt` within N days". Applied literally, that
 * predicate never matches a phantom — the field is absent, not old — so the reaper would protect
 * 94% of the population forever while reporting itself healthy. THE FALLBACK CLOCK IS mtime, which
 * for a file written once at SessionStart is its creation time. That is the difference between a
 * backstop and a no-op with a receipt.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────────────────────────
 *
 * Three refusals, and each is a fact about what the file is worth rather than a safety reflex:
 *
 *   PENDING CANDIDATES — never, at any age. They are unrecovered learning; `report.mjs`'s
 *     PENDING tally is the check, and this is it. A queue with one pending candidate is immortal
 *     until someone settles it.
 *   A HANDED CLAIM — a queue offered to a live session inside `HANDED_TTL_MS` is being worked on by
 *     an agent right now, and deleting it mid-disposal loses the judgement AND the candidates.
 *   THE WATERMARK — a queue holds the `captured` offset. Losing it does not merely lose history: the
 *     delta gate rewinds to 0, re-reads the entire session arc, and re-proposes every candidate that
 *     was already disposed. That is why queues get the longest window in the config and why
 *     "settled" is a hard precondition rather than a tiebreak.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `planReap` is PURE — it takes a listing and returns a decision for every file, deleting nothing.
 * `applyReap` is the only thing that touches the filesystem. That split is not stylistic: this is
 * the one component in the tree that DELETES, so the predicates have to be exercisable without a
 * predicate bug costing real data to discover. (→ `tests/reap-test.mjs`, which drives the planner
 * over synthetic listings and the applier over a disposable root of its own.)
 *
 * Every decision carries a `why`, and the receipt prints the refusals as well as the deletions:
 * a reaper that says "pruned 5,450" and nothing else cannot be distinguished from one that
 * deleted the wrong 5,450.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inMemoryHome, queueDir, reapOffFile, slug, spoolDir, stateDir } from './paths.mjs';
import { readJsonSafe } from './atomic.mjs';
import { read as readQueue } from './queue.mjs';
import { read as readSpool } from './spool.mjs';
import {
  HANDED_TTL_MS, REAP_DEBOUNCE_MS, REAP_MAX_DELETES_PER_RUN,
  REAP_PHANTOM_AFTER_MS, REAP_QUEUE_AFTER_MS, REAP_STATE_AFTER_MS,
} from './config.mjs';

/**
 * Marker file holding the last reap time — same pattern as the sweep's `last-swept`, and a
 * FUNCTION for the reason `paths.mjs`'s header gives: a memoized module constant honours
 * `VECTROS_MEMORY_HOME` only if it happened to be set before this module was first imported, which
 * is a property of file order rather than intent. It shipped as a const, which meant a test that
 * reached `reap.mjs` before `isolate.mjs` would stamp the marker into the OPERATOR'S real runtime
 * while reading everything else from the temp root.
 */
export const REAP_MARKER = () => inMemoryHome('last-reaped');

/**
 * Classify ONE state file. Pure: every input is a parameter.
 *
 * @param {{sid, mtimeMs, size, state: object|null, queue: {pending: [], handedAt: number|null}|null}} f
 * @returns {{sid, action: 'prune'|'keep', why: string, bytes: number}}
 *
 * ORDER IS SIGNIFICANT and the refusals come FIRST. A file that is both ancient and pending must be
 * KEPT, so age can never be evaluated before the guards — the same "check the expensive invariant
 * before the cheap one" rule that keeps `markSwept` honest.
 */
export function classifyState(f, now, opts = {}) {
  const phantomAfter = opts.phantomAfterMs ?? REAP_PHANTOM_AFTER_MS;
  const stateAfter = opts.stateAfterMs ?? REAP_STATE_AFTER_MS;
  const handedTtl = opts.handedTtlMs ?? HANDED_TTL_MS;
  const keep = (why) => ({ sid: f.sid, action: 'keep', why, bytes: f.size });
  const prune = (why) => ({ sid: f.sid, action: 'prune', why, bytes: f.size });

  // 1. UNREADABLE STATE IS NOT A LICENCE TO DELETE. `readJsonSafe`'s whole contract is that
  //    "the read failed" and "the content is garbage" are different facts; here they collapse to
  //    the same conservative answer, because a file we could not parse is a file whose pending
  //    status we do not know. Keeping it costs one directory entry.
  if (f.state === null) return keep('state unreadable — cannot tell what it holds, so it stays');

  /**
   * 2. PENDING CANDIDATES ARE IMMORTAL. Checked before age, deliberately.
   *
   * `state !== 'ok'` IS PART OF THE SAME GUARD, and leaving it out falsified the refusal this
   * module advertises as absolute. `queue.read()` returns
   * `pending: []` for BOTH a genuinely settled queue and one it could not read — `empty('corrupt')`
   * carries an empty pending list. So a transient EACCES/EBUSY on the queue file (an AV scanner,
   * EMFILE under concurrent hooks — the cases queue.mjs enumerates) coinciding with a reap made
   * `classifyQueue` correctly KEEP the queue while `classifyState` pruned the state file beside it.
   * The candidates survive and become permanently un-flushable, because `transcriptPath` — the only
   * way to locate their transcript — was in the file that went.
   *
   * The reasoning was already written eight lines up for `f.state`; it simply was not applied to
   * `f.queue.state`. Same rule, one field over.
   */
  if (f.queue && f.queue.state !== 'ok') {
    return keep(`queue is ${f.queue.state} — cannot tell whether it has pending candidates`);
  }
  if (f.queue && f.queue.pending.length) {
    return keep(`queue has ${f.queue.pending.length} pending candidate(s) — unrecovered learning`);
  }
  // 3. A LIVE CLAIM. Another session was handed this queue and may be settling it right now.
  if (f.queue && f.queue.handedAt && now - f.queue.handedAt < handedTtl) {
    return keep(`queue handed ${Math.round((now - f.queue.handedAt) / 60_000)}m ago — a live session may be settling it`);
  }

  /**
   * 4. THE TWO POPULATIONS. `lastStopAt` is present iff the session ever reached a Stop, so its
   *    ABSENCE is the phantom signature — not a stale value, an absent field. See the header for
   *    why keying on its recency alone would leave 94% of the corpus untouched forever.
   *
   * ⚠ AGE IS THE **NEWER** OF `lastStopAt` AND mtime, AND THAT IS NOT BELT-AND-BRACES — reading
   * `lastStopAt` alone deleted live sessions — confirmed against the
   * code.
   *
   * `lastStopAt` is NOT a liveness clock during a resume. It freezes at the previous session's
   * final turn and stays frozen until the resumed session reaches its own first Stop. Meanwhile
   * `readJsonSafe` spreads the parsed file OVER the defaults, so every other hook's write preserves
   * the old value while updating the file's mtime. So: resume a session idle 40 days, `orient.mjs`
   * writes state (mtime = now, `lastStopAt` = T-40d), any OTHER live session's Stop fires the
   * global reaper, and this branch computes 40d >= 30d and deletes a file written seconds ago.
   *
   * The loss is not recoverable state — it is `transcriptPath`, which `stop.mjs` is the only writer
   * of and which is the ONLY way the sweep can ever locate that session's tail again.
   *
   * This is precisely the defect `stop.mjs`'s header documents FIXING for the sweep ("a session
   * resumed after a day still read as 24h+ idle until its first NON-EMPTY Stop landed"),
   * reintroduced here — and unlike the sweep, whose mistake costs a wasted scan, this one deletes.
   * mtime is the file's own last write, so max() of the two is the real "when was this last
   * touched by anything".
   */
  const stoppedAt = stopClock(f.state.lastStopAt);
  if (stoppedAt !== null) {
    const age = now - Math.max(stoppedAt, f.mtimeMs);
    const settled = f.queue ? ' and its queue is settled' : ' (no queue was ever created for it)';
    return age >= stateAfter
      ? prune(`last touched ${days(age)}d ago (>= ${days(stateAfter)}d)${settled}`)
      : keep(`last touched ${days(age)}d ago (< ${days(stateAfter)}d)`);
  }

  // A phantom that nonetheless has a queue is not a phantom — something distilled from it. Hold it
  // to the longer window rather than the short one; the queue is evidence the session was real.
  if (f.queue) {
    const age = now - f.mtimeMs;
    return age >= stateAfter
      ? prune(`no Stop, but a settled queue exists; mtime ${days(age)}d ago (>= ${days(stateAfter)}d)`)
      : keep(`no Stop, but a settled queue exists; mtime ${days(age)}d ago (< ${days(stateAfter)}d)`);
  }

  const age = now - f.mtimeMs;
  return age >= phantomAfter
    ? prune(`never reached a Stop and has no queue; mtime ${days(age)}d ago (>= ${days(phantomAfter)}d)`)
    : keep(`never reached a Stop; mtime ${days(age)}d ago (< ${days(phantomAfter)}d)`);
}

/** Classify ONE queue file. Pure. Settled-ness is a precondition, not a tiebreak. */
export function classifyQueue(q, now, opts = {}) {
  const queueAfter = opts.queueAfterMs ?? REAP_QUEUE_AFTER_MS;
  const handedTtl = opts.handedTtlMs ?? HANDED_TTL_MS;
  const keep = (why) => ({ sid: q.sid, action: 'keep', why, bytes: q.size });

  /**
   * ANYTHING THAT IS NOT `ok`, not merely `corrupt`.
   *
   * `queue.read()` reports `corrupt` when it could not READ the file, and its own header explains
   * that answering 0 for the offset there is catastrophic; the same logic forbids deleting it.
   * But it also reports `fresh` for ENOENT — and `fresh` arriving here is *evidence of a bug*, not
   * a normal state: this record was built from a file `readdirSync` had just listed and `statSync`
   * had just sized. If the fold then says "no such file", the read path and the delete path
   * disagree about which file this row names — and the delete path is the one holding the unlink.
   *
   * Left as `=== 'corrupt'`, such a row got `pending: []` from `empty('fresh')`, passed every
   * guard, and was pruned by age: a queue judged entirely on a file that does not exist, then
   * really deleted. Guarding on `!== 'ok'` makes the disagreement a refusal instead.
   */
  if (q.state !== 'ok') return keep(`queue read returned '${q.state}' — its pending set is unknown, so it stays`);
  if (q.pending.length) return keep(`${q.pending.length} pending candidate(s) — never eligible at any age`);
  if (q.handedAt && now - q.handedAt < handedTtl) {
    return keep(`handed ${Math.round((now - q.handedAt) / 60_000)}m ago — a live session may be settling it`);
  }
  /**
   * `Math.max`, NOT `??` — this is the SAME defect already fixed on the state side, still live
   * over here where the loss is worse.
   *
   * `??` means a PRESENT `lastEventAt` masks the mtime entirely. And `lastEventAt` folds only
   * `swept`/`handed`: a `captured` append — the watermark, the most frequent event a live queue
   * gets — moves mtime and neither field. So a queue handed off 100 days ago, fully settled, whose
   * session is resumed today and captures, computes `age = 100d` and is pruned. `applyReap`'s
   * recheck does not save it: it aborts on `pending.length` or a bad read, and this queue has
   * neither.
   *
   * What goes is not history. It is the `captured` watermark AND the `disposed`/`superseded` sets —
   * so the delta gate rewinds to zero, re-reads the whole arc, and re-proposes every candidate an
   * agent already settled.
   *
   * The irony worth keeping: the comment on `lastEventAt` in `collect()` argues that neither
   * `sweptAt` nor `handedAt` dominates the other and that "only a max() over both is a clock" — and
   * then this line dropped mtime out of that max. A fixture pinning `lastEventAt: null` meant the
   * non-null-with-fresher-mtime branch was never exercised.
   */
  const age = now - Math.max(q.lastEventAt ?? 0, q.mtimeMs);
  return age >= queueAfter
    ? { sid: q.sid, action: 'prune', why: `fully settled and idle ${days(age)}d (>= ${days(queueAfter)}d)`, bytes: q.size }
    : keep(`fully settled but only idle ${days(age)}d (< ${days(queueAfter)}d)`);
}

const days = (ms) => Math.round(ms / 86_400_000);

/**
 * `lastStopAt` as epoch ms, or null if the session never reached a Stop.
 *
 * A BARE `typeof === 'number'` WAS A TRAPDOOR, not a type check. Any
 * other representation — most obviously an ISO string, which is exactly what `orientedAt` two
 * fields over already is — failed the test and SILENTLY demoted the session from the 30-day real
 * window to the 7-day phantom one. Nothing errors; the protection just quietly shortens to a
 * quarter. One refactor of `stop.mjs` writing `new Date().toISOString()` instead of `Date.now()`
 * and every real session becomes a phantom.
 *
 * So: accept both shapes, and treat a PRESENT-but-unparseable value as "this session did stop, I
 * just cannot tell when" — which takes the longer window via the mtime clock rather than the
 * shorter one. The fail-safe direction for a deleter is always the one that keeps the file.
 */
function stopClock(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0; // present but unparseable -> mtime wins the max() below
  }
  return null;
}

/**
 * Plan a reap over a listing. PURE — no IO, deletes nothing, and that is what makes the predicates
 * above testable without a mistake costing real files.
 *
 * THE CAP IS APPLIED HERE, not in the applier, so a plan is a complete and honest statement of what
 * a run would do: everything past `maxDeletes` is reported as DEFERRED rather than silently
 * dropped. A truncation nobody can see reads as "that was all of it".
 */
export function planReap({ states, queues, spools = [], now, ...opts }) {
  const max = opts.maxDeletes ?? REAP_MAX_DELETES_PER_RUN;
  const decisions = [
    ...states.map((s) => ({ kind: 'state', ...classifyState(s, now, opts) })),
    ...queues.map((q) => ({ kind: 'queue', ...classifyQueue(q, now, opts) })),
    // `spools` DEFAULTS to [] so a caller built before the spool existed still plans correctly
    // rather than throwing on `.map` — this function is called from a hook, where a TypeError is
    // a swallowed no-op and the reap silently stops happening.
    ...spools.map((s) => ({ kind: 'spool', ...classifySpool(s, now, opts) })),
  ];
  const prunable = decisions.filter((d) => d.action === 'prune');
  /**
   * INTERLEAVED, so the cap cannot STARVE one kind.
   *
   * A flat `prunable.slice(0, max)` over `[...states, ...queues]` takes states first, always.
   * With ~5,450 prunable phantoms against a 500/run cap and ~368 arriving per day, the net drain
   * is ~139/day — so queues would not have been reached for roughly forty days, and the receipt
   * would have said `DEFERRED N` without ever saying which kind. Alternating means both
   * populations make progress from the first run.
   */
  const byKind = {
    state: prunable.filter((d) => d.kind === 'state'),
    queue: prunable.filter((d) => d.kind === 'queue'),
    spool: prunable.filter((d) => d.kind === 'spool'),
  };
  const interleaved = [];
  // Round-robin across ALL kinds, smallest population effectively first. Adding a kind to the
  // decisions list without adding it here would let the cap starve it indefinitely — the exact
  // failure the queue side was fixed for, where states monopolised the budget for ~40 days.
  /**
   * `i <= prunable.length` IS A TERMINATION BOUND, not belt-and-braces — and it is here because
   * removing a kind from the body below HUNG this loop rather than starving it.
   *
   * The condition is `interleaved.length < prunable.length`: it assumes every prunable item is
   * reachable through one of the branches. Add a kind to `decisions` (and therefore to
   * `prunable`) but forget it here, and the count never converges — the loop spins forever, on
   * every Stop, inside a hook whose errors are swallowed by `main().catch`. Found by sabotaging
   * exactly that line while RED-proving the spool: the test did not fail, it never returned.
   *
   * With the bound, the same mistake degrades to the STARVATION this interleave exists to prevent
   * — visible in the receipt as a kind that never gets pruned, and survivable. A wrong plan beats
   * a hung hook.
   */
  for (let i = 0; interleaved.length < prunable.length && i <= prunable.length; i++) {
    if (byKind.queue[i]) interleaved.push(byKind.queue[i]);
    if (byKind.spool[i]) interleaved.push(byKind.spool[i]);
    if (byKind.state[i]) interleaved.push(byKind.state[i]);
  }
  const prune = interleaved.slice(0, max);
  const deferred = interleaved.slice(max);
  const kept = decisions.filter((d) => d.action === 'keep');
  return {
    prune,
    deferred,
    kept,
    stats: {
      scanned: decisions.length,
      prunable: prunable.length,
      pruning: prune.length,
      deferred: deferred.length,
      kept: kept.length,
      bytes: prune.reduce((n, d) => n + d.bytes, 0),
    },
  };
}

/**
 * Classify ONE spool file. Pure.
 *
 * A SPOOL THAT STILL OWES WRITES IS IMMORTAL, exactly as a queue with pending candidates is. The
 * spool exists so a proposal survives an outage; a reaper that deletes it during one destroys the
 * single thing it was protecting, and does so most eagerly in precisely the conditions the spool
 * was written for — the store unreachable, so nothing syncs, so nothing is marked, so the file
 * looks idle.
 *
 * PARKED entries do NOT keep it alive. They are over the retry budget and will never be attempted
 * again, so holding the file forever would make "parked" mean "immortal" — an unbounded leak with
 * the shape of a safety feature. They are still evidence, so they are retired WITH the session
 * (the same window a settled queue gets) rather than early.
 */
export function classifySpool(s, now, opts = {}) {
  // Same window as a settled queue: the two files share a session and a lifecycle, and giving the
  // spool its own knob would be a second thing to tune for one decision.
  const after = opts.queueAfterMs ?? REAP_QUEUE_AFTER_MS;
  const keep = (why) => ({ sid: s.sid, action: 'keep', why, bytes: s.size });
  const prune = (why) => ({ sid: s.sid, action: 'prune', why, bytes: s.size });

  // Not `ok` — same refusal as the queue side. An unreadable spool's owed set is UNKNOWN, and the
  // deleter must never resolve an unknown in favour of deleting.
  if (s.state !== 'ok') return keep(`spool read returned '${s.state}' — what it owes is unknown, so it stays`);
  if (s.owed.length) return keep(`${s.owed.length} unsynced proposal(s) — never eligible at any age`);
  const age = now - s.mtimeMs;
  return age >= after
    ? prune(`fully synced or parked; mtime ${days(age)}d ago (>= ${days(after)}d)`)
    : keep(`fully synced or parked; mtime ${days(age)}d ago (< ${days(after)}d)`);
}

/** Read the directories into the plain listing `planReap` consumes. */
export function collect({ stateD = stateDir(), queueD = queueDir(), spoolD = spoolDir() } = {}) {
  const queues = [];
  const byId = new Map();
  for (const f of safeReaddir(queueD).filter((f) => f.endsWith('.jsonl'))) {
    const sid = f.replace(/\.jsonl$/, '');
    const st = safeStat(path.join(queueD, f));
    if (!st) continue;
    const q = readQueue(sid);
    /**
     * THE NEWEST event, not the first non-null one.
     *
     * This was `q.sweptAt ?? q.handedAt ?? null`, which is a PRECEDENCE order dressed as a
     * recency one: a queue swept 100 days ago and handed to a live session three hours ago
     * resolved to the 100-day-old `sweptAt` and was eligible for deletion, even though the most
     * recent thing that happened to it was three hours ago. The two fields also have different
     * fold semantics — `sweptAt` is monotonic-max, `handedAt` is last-writer-wins — so neither
     * dominates the other and only a max() over both is a clock.
     */
    const stamps = [q.sweptAt, q.handedAt].filter((t) => typeof t === 'number' && Number.isFinite(t));
    const lastEventAt = stamps.length ? Math.max(...stamps) : null;
    const rec = {
      sid, size: st.size, mtimeMs: st.mtimeMs, state: q.state,
      pending: q.pending, handedAt: q.handedAt, lastEventAt,
    };
    queues.push(rec);
    byId.set(sid, rec);
  }
  const states = [];
  for (const f of safeReaddir(stateD).filter((f) => f.endsWith('.json'))) {
    const sid = f.replace(/\.json$/, '');
    const st = safeStat(path.join(stateD, f));
    if (!st) continue;
    /**
     * `readJsonSafe`, NOT a hand-rolled `JSON.parse` — `classifyState` CITES this function's
     * contract ("the read failed and the content is garbage are different facts") and the first
     * cut of this collector did not call it, so the citation was to a guarantee this code did not
     * have. The same discipline applies here, in the one component that deletes. Using it also buys
     * the measured Windows contention retry, which a bare read on a directory every hook is writing
     * plainly needs.
     *
     * `fresh` cannot occur here (readdir + stat just succeeded), so anything that is not `ok`
     * means the bytes are unknown -> `state: null` -> classifyState keeps it, loudly.
     */
    const r = readJsonSafe(path.join(stateD, f), null);
    states.push({
      sid, size: st.size, mtimeMs: st.mtimeMs,
      state: r.state === 'ok' ? r.value : null,
      readState: r.state,
      queue: byId.get(sid) || null,
    });
  }
  const spools = [];
  for (const f of safeReaddir(spoolD).filter((f) => f.endsWith('.jsonl'))) {
    const sid = f.replace(/\.jsonl$/, '');
    const st = safeStat(path.join(spoolD, f));
    if (!st) continue;
    const s = readSpool(sid, spoolD);
    spools.push({ sid, size: st.size, mtimeMs: st.mtimeMs, state: s.state, owed: s.owed, parked: s.parked });
  }
  return { states, queues, spools };
}

const safeReaddir = (d) => {
  try { return fs.readdirSync(d); }
  catch { /* silence-ok: an absent directory is the normal pre-first-run state, and an empty listing is the correct plan for it — nothing to prune. An unreadable one yields the same empty plan, which deletes nothing. */ return []; }
};
const safeStat = (p) => {
  try { return fs.statSync(p); }
  catch { /* silence-ok: the file vanished between readdir and stat (a concurrent hook, or a previous reap). Skipping it is exactly right — it is already gone. */ return null; }
};

/**
 * Execute a plan. The ONLY function here that deletes.
 *
 * `unlink` is injected so the test can exercise the full path — including a delete that FAILS —
 * without a real filesystem, and so a caller can dry-run against the real listing.
 */
export function applyReap(plan, { stateD = stateDir(), queueD = queueDir(), spoolD = spoolDir(), unlink = fs.unlinkSync, recheck = readQueue, recheckSpool = readSpool } = {}) {
  let deleted = 0;
  let bytes = 0;
  const failed = [];
  const aborted = [];
  for (const d of plan.prune) {
    /**
     * RE-CHECK THE QUEUE IMMEDIATELY BEFORE UNLINKING IT.
     *
     * `collect()` -> `planReap()` -> `applyReap()` are three passes over a directory that every
     * other live session is writing to, and the scan spans a `readdirSync` plus a read+fold of
     * every queue — measured elsewhere in this tree at ~1.7s for a smaller population. A session
     * that appends a `propose` inside that window had its queue judged settled by a snapshot and
     * deleted by a plan built from it.
     *
     * Without this, "a queue with pending candidates is immortal" is a property of a SNAPSHOT
     * rather than an invariant — and the module header states it as an invariant. One extra fold
     * per queue actually deleted (a handful per run at most) is what makes the sentence true.
     * State files are not re-checked: they are cheap to lose and the expensive guard is the queue.
     */
    if (d.kind === 'queue') {
      const fresh = recheck(d.sid);
      if (fresh.state !== 'ok' || fresh.pending.length) {
        aborted.push({ sid: d.sid, why: fresh.pending.length ? `gained ${fresh.pending.length} pending` : `became ${fresh.state}` });
        continue;
      }
    }
    /**
     * THE SPOOL GETS THE SAME RE-CHECK, and needs it MORE than the queue does.
     *
     * The window between plan and delete is one where the capture worker may have spooled a fresh
     * proposal — and unlike a queue candidate, which is also recorded in the store, an unsynced
     * spool entry exists NOWHERE ELSE. Deleting it is unrecoverable, so a snapshot is not good
     * enough to authorise it.
     */
    if (d.kind === 'spool') {
      const fresh = recheckSpool(d.sid, spoolD);
      if (fresh.state !== 'ok' || fresh.owed.length) {
        aborted.push({ sid: d.sid, why: fresh.owed.length ? `gained ${fresh.owed.length} unsynced` : `became ${fresh.state}` });
        continue;
      }
    }
    /**
     * SLUGGED **and** rooted in the caller's directories — both halves, and the second was missing.
     *
     * Fixing the slug asymmetry by routing through `stateFor`/`queueFor` (which slug
     * correctly and resolve against the PROCESS-GLOBAL root) silently broke the `stateD`/
     * `queueD` parameters: they stayed in the signature, defaulted, and were then read by nothing.
     * So `applyReap(plan, { stateD: '/tmp/probe/state' })` — the alternate-listing run this
     * module's own shape advertises — planned against the probe and UNLINKED THE SAME-NAMED FILES
     * OUT OF THE REAL RUNTIME, files it had never classified.
     *
     * That is verbatim the reader/deleter asymmetry the comment one paragraph up warns about,
     * reintroduced by the fix for it, in the only function here that deletes. `reap-test.mjs` never
     * passed either parameter, so the seam had no coverage at all.
     */
    // A LOOKUP, not a ternary chain. The two-kind ternary silently routed anything that was not
    // `state` into `queueD` — so a third kind would have deleted a spool-named file out of the
    // QUEUE directory, or (matching nothing) reported a phantom success via the ENOENT branch
    // below while the real file survived. An explicit map turns an unhandled kind into an
    // exception instead of a wrong path.
    const dirs = { state: stateD, queue: queueD, spool: spoolD };
    const dir = dirs[d.kind];
    if (!dir) { failed.push({ sid: d.sid, kind: d.kind, code: 'UNKNOWN_KIND' }); continue; }
    const p = path.join(dir, `${slug(d.sid)}.${d.kind === 'state' ? 'json' : 'jsonl'}`);
    try { unlink(p); deleted++; bytes += d.bytes; }
    catch (e) {
      // A delete that fails is not a delete that did not need to happen. It is reported, and the
      // run continues: one locked file must not strand the other 5,449.
      if (e?.code !== 'ENOENT') failed.push({ sid: d.sid, kind: d.kind, code: e?.code || 'error' });
      else { deleted++; bytes += d.bytes; } // already gone IS the goal state
    }
  }
  return { deleted, bytes, failed };
}

/**
 * THE RECEIPT. Counts alone cannot distinguish a healthy reap from one that deleted the wrong
 * files, so the refusals are reported too — grouped by reason, because 5,700 individual KEEP lines
 * is not a receipt either. `deferred` is named explicitly: a cap that truncates silently reads as
 * "that was everything".
 */
export function reapReceipt(plan, applied) {
  const reasons = new Map();
  for (const k of plan.kept) {
    const key = k.why.replace(/\d+/g, 'N'); // collapse the numbers so the shapes group
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  const top = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([why, n]) => `${n}x ${why}`).join('; ');
  // A DRY RUN REPORTS WHAT IT WOULD DO, not the zero it actually did. `deleted: 0` next to
  // `scanned: 5,837` reads as "found nothing", which is the opposite of what a dry run is for.
  const parts = applied.dryRun
    ? [`WOULD reap ${plan.stats.pruning} file(s), ${(plan.stats.bytes / 1024).toFixed(0)}KB`,
      `scanned ${plan.stats.scanned}`, `kept ${plan.stats.kept}`]
    : [`reaped ${applied.deleted} file(s), ${(applied.bytes / 1024).toFixed(0)}KB reclaimed`,
      `scanned ${plan.stats.scanned}`, `kept ${plan.stats.kept}`];
  if (plan.stats.deferred) parts.push(`DEFERRED ${plan.stats.deferred} past the per-run cap (they are not gone; the next run takes them)`);
  if (applied.failed.length) parts.push(`FAILED to delete ${applied.failed.length} (${applied.failed.slice(0, 3).map((f) => `${f.sid}:${f.code}`).join(', ')})`);
  if (top) parts.push(`refused: ${top}`);
  return parts.join(' — ');
}

/**
 * THE OFF SWITCH. Returns true when the reaper must not run at all.
 *
 * WHY IT EXISTS. An earlier pass decoupled the reaper from `WORKERS_OFF` for a
 * good reason — that switch is documented as the kill switch for billed INFERENCE, and the reaper
 * spawns none, so an operator stopping spend should not silently stop pruning. But decoupling left
 * the only IRREVERSIBLE component here with no off switch, while a comment in `capture.mjs` asserted
 * that `REAP_MAX_DELETES_PER_RUN` and the windows were one. They are not: that knob floors at 1, not
 * 0, and the windows cap at 365 days. An operator reading that comment at 2am cannot act on it.
 *
 * TWO CHANNELS, and both are needed. The FILE is for an operator: hooks are fresh processes that
 * read disk on every invocation, so `touch ~/.claude/vectros-memory/REAP_OFF` stops the next hook
 * with no restart. The ENV is for a spawned child that must not delete — `tests/smoke.mjs` runs the
 * REAL deployed hooks against the REAL runtime by design, and `capture.mjs` reaches the reaper on
 * the Stop it fires, so the documented post-deploy check was performing a live delete of up to
 * `REAP_MAX_DELETES_PER_RUN` files. A file would not help there; smoke must be able to say "not me"
 * without touching the operator's directory.
 */
export function reapDisabled() {
  const env = process.env.VECTROS_MEM_REAP_OFF;
  if (typeof env === 'string' && env.trim() && env.trim() !== '0') return 'VECTROS_MEM_REAP_OFF';
  try { return fs.existsSync(reapOffFile()) ? 'REAP_OFF file' : false; }
  catch { /* silence-ok: existsSync barely throws, and "not disabled" is the status quo — the windows and the per-run cap still bound what a run can do. Failing the other way would silently disable pruning on a directory that grows ~368 files/day. */ return false; }
}

/** Has enough time passed since the last reap? Same marker pattern as the sweep. */
export function reapDue(now = Date.now(), { marker = REAP_MARKER(), debounceMs = REAP_DEBOUNCE_MS } = {}) {
  try {
    /**
     * THE STAMP IN THE FILE FIRST, mtime only as a fallback — and both halves earn their place.
     *
     * mtime is the weakest clock available: it is not preserved by a backup restore, an `rsync -a`,
     * or a profile migration, all realistic for a directory under a Windows user profile, and any
     * of those would silently re-authorise a full ~5,800-file scan or suppress one for a day.
     * Reading the ISO stamp the marker already contained makes the clock a property of the DATA.
     *
     * It also makes the debounce testable at all: `markReaped` now stamps the CALLER'S clock, so a
     * test with an injected `now` no longer compares a fake timestamp against a real filesystem
     * mtime — a real trap (a fake clock racing a real mtime it doesn't control), hit here while
     * writing the test for this function.
     */
    const stamped = Date.parse(fs.readFileSync(marker, 'utf8').trim());
    const at = Number.isFinite(stamped) ? stamped : fs.statSync(marker).mtimeMs;
    return now - at >= debounceMs;
  }
  catch { /* silence-ok: no marker is the normal first-run state and "due" is the correct answer for it — the debounce is a rate limit, not a gate that has to be opened. */ return true; }
}

/**
 * Stamp the debounce marker with the CALLER'S clock. Best-effort: a missed stamp costs one extra
 * scan, bounded by the next run's own debounce, and never data.
 */
function markReaped(now = Date.now()) {
  try {
    const m = REAP_MARKER();
    fs.mkdirSync(path.dirname(m), { recursive: true });
    fs.writeFileSync(m, new Date(now).toISOString());
  } catch { /* silence-ok: the marker is a rate limit. Failing to stamp it means the next Stop scans again — wasted work, bounded by the debounce, and never a deletion that should not have happened. */ }
}

/**
 * The wired entry point: debounce, plan, apply, log the receipt. Returns the receipt object so a
 * caller (and the test) can assert on it rather than on a log line.
 *
 * `apply: false` is a real dry run — it plans everything and touches nothing.
 */
export function runReap({ now = Date.now(), apply = true, force = false, ...opts } = {}) {
  // THE KILL SWITCH IS CHECKED BEFORE `force`, deliberately. `force` exists so an operator or a test
  // can bypass the DEBOUNCE; it must not bypass "do not delete". Anything else makes the switch
  // advisory, which for the one irreversible component here is the same as not having one.
  const off = reapDisabled();
  if (off) return { skipped: `disabled (${off})` };
  if (!force && !reapDue(now, opts)) return { skipped: 'debounced' };
  const { states, queues, spools } = collect(opts);
  const plan = planReap({ states, queues, spools, now, ...opts });
  const applied = apply
    ? applyReap(plan, opts)
    : { deleted: 0, bytes: 0, failed: [], dryRun: true };
  if (apply) markReaped(now);
  // NOT logged here — the CALLER logs it, once, where the session id is known. Logging in both
  // places gave every reap two lines in hooks.log on the one component that deletes.
  const receipt = apply ? reapReceipt(plan, applied) : `DRY RUN — ${reapReceipt(plan, applied)}`;
  return { plan, applied, receipt };
}

// ── CLI. `node reap.mjs` reports; `node reap.mjs --apply` deletes.
//
// DRY RUN IS THE DEFAULT HERE and live is the default from the Stop path, which is not an
// inconsistency: an operator running this by hand is inspecting, and the one irreversible action in
// this tree should not be what happens when you type its name to see what it does.
//
// FOUND LIVE, against the real deployed build, not source (verified during a
// deployment cutover — `run-all.mjs` never catches this, it only ever imports src/ directly): this used to be
// `import.meta.url === pathToFileURL(process.argv[1]).href`, an `import.meta.url` self-identity
// check. `capture.mjs` imports `runReap` from this file, and — despite `bundle: false` — the
// build INLINES this file's entire source into `capture.mjs`'s own dist output (tsup.config.mjs's
// own "every relative import survives verbatim" comment is wrong; verified by grepping dist/
// directly, no `import ... from './reap.mjs'` survives, the whole module is copy-pasted in with a
// `// src/reap.mjs` marker comment). Once inlined, `import.meta.url` for this code IS
// `capture.mjs`'s own URL, so the check spuriously matched on EVERY real Stop-hook invocation of
// capture.mjs, not just a real standalone `node reap.mjs` run. `process.argv[1]`'s BASENAME
// survives inlining correctly — it reflects which script node was actually told to run, which
// bundling can't change — so that is what real entry-point detection has to compare against here.
//
// The second bug this crash actually surfaced (independent of the above — real even for a
// correctly-invoked standalone `reap.mjs`): `runReap()` can return `{skipped: '...'}` with no
// `.plan` at all (the kill switch is checked before `force`, deliberately — see its own header)
// and this block unconditionally read `r.plan.prune`, crashing on nothing more exotic than the
// reaper being disabled. Both fixed together.
if (process.argv[1] && path.basename(process.argv[1]) === 'reap.mjs') {
  const apply = process.argv.includes('--apply');
  const r = runReap({ apply, force: true });
  if (r.skipped) {
    console.log(`skipped: ${r.skipped}`);
  } else {
    console.log(`${apply ? '' : '[DRY RUN] '}${r.receipt}`);
    if (!apply) console.log('\nre-run with --apply to actually delete.');
    for (const d of r.plan.prune.slice(0, 20)) console.log(`  prune ${d.kind} ${d.sid} — ${d.why}`);
    if (r.plan.prune.length > 20) console.log(`  ... and ${r.plan.prune.length - 20} more`);
  }
}
