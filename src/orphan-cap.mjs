/**
 * ORPHAN CAP — auto-ignore a genuinely record-backed candidate that has been offered on too many
 * DISTINCT DAYS with nobody settling it. This header states the shape, not the full tradeoff
 * defense for the design (raw event count vs. distinct-session count vs. distinct-day count).
 *
 * WHAT THIS IS NOT. A separate, internal-only migration tool (not part of this package) handles a
 * DIFFERENT population — a candidate with ZERO backing record at all, which can never be settled
 * through any records-addressed path. This module handles the population that tool deliberately
 * leaves alone: a session that DOES have real records, where a real
 * candidate genuinely sits pending because nobody has done the work to settle it. That candidate
 * is not wrong to leave pending forever in principle (`nudge.mjs`: "cannot verify it? leave it
 * pending" is a correct outcome) — but `queue.mjs`'s `markHanded` deliberately re-offers an
 * orphaned queue forever rather than ever stranding it silently, and in practice nobody wants to
 * spend the work fully verifying a stranger's proposed candidate, so a few queues were measured
 * recirculating for over a week with no progress. This is the backstop: not a judgement that the
 * candidate is wrong, only that it has had a fair, bounded amount of real-calendar-time exposure
 * and nobody took it.
 *
 * WHY DISTINCT DAYS, NOT A RAW `handed`-EVENT COUNT OR A DISTINCT-SESSION COUNT. Measured live: one
 * session re-affirms its OWN claim on every prompt it submits while it holds it (`markHanded`
 * fires from `recall.mjs` on every render), so a raw count is exhausted by ONE reviewer glancing
 * at it repeatedly across a single sitting — the opposite of "a sustained, real-time signal that
 * nobody wants this". A distinct-SESSION count is closer but still fails on a busy day: several
 * short sessions rotating through in an afternoon would trip it in hours. Distinct CALENDAR DAYS
 * is the one measure that can only advance through elapsed wall-clock time: one session contributes
 * at most one day no matter how many prompts it fires, and one day contributes at most one no
 * matter how many sessions touch it.
 *
 * SHAPE MIRRORS reap.mjs DELIBERATELY: pure classify/plan (no IO beyond a local file read, testable
 * without a mistake writing a real disposition), a debounce marker, an off switch, a per-run cap —
 * the same disciplines earned the hard way on the other component here that acts without a human
 * approving each instance. The ACTUAL RECORD WRITE is NOT in this file — it needs network, and this
 * module's `collect`/`plan` functions run inline in capture.mjs's Stop path where a network round
 * trip is not allowed (the same reason capture-worker.mjs/recall-eval-worker.mjs are detached
 * children rather than awaited inline). `orphan-cap-worker.mjs` is the detached child that applies
 * a plan this module produced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inMemoryHome, orphanCapOffFile, queueDir, slug } from './paths.mjs';
import { read as readQueue } from './queue.mjs';
import { isReal } from './residual.mjs';
import { ORPHAN_CAP_DAYS, ORPHAN_CAP_DEBOUNCE_MS, ORPHAN_CAP_MAX_PER_RUN } from './config.mjs';

/** Marker file holding the last check time — same pattern as reap.mjs's REAP_MARKER/sweep's
 * last-swept, and a FUNCTION for the same reason: a memoized module constant only honours
 * `VECTROS_MEMORY_HOME` if it happened to be set before first import. */
export const ORPHAN_CAP_MARKER = () => inMemoryHome('last-orphan-cap-checked');

/**
 * THE OFF SWITCH. Same two channels as `reap.mjs`'s `reapDisabled`, and for the same reason: this
 * is the other component in the tree that acts on a candidate without a human approving that
 * specific instance (the write is reversible via `reopen`, but it is still a real, unattended
 * disposition). An operator gets `touch ~/.claude/vectros-memory/ORPHAN_CAP_OFF` for a standing
 * stop, or `VECTROS_MEM_ORPHAN_CAP_OFF=1` for a child (e.g. smoke.mjs) that must not act.
 */
export function orphanCapDisabled() {
  const env = process.env.VECTROS_MEM_ORPHAN_CAP_OFF;
  if (typeof env === 'string' && env.trim() && env.trim() !== '0') return 'VECTROS_MEM_ORPHAN_CAP_OFF';
  try { return fs.existsSync(orphanCapOffFile()) ? 'ORPHAN_CAP_OFF file' : false; }
  catch { /* silence-ok: existsSync barely throws, and "not disabled" is the status quo — failing the other way would silently stop a real backstop. */ return false; }
}

/** Has enough time passed since the last check? Same marker pattern as reap.mjs's reapDue. */
export function orphanCapDue(now = Date.now(), { marker = ORPHAN_CAP_MARKER(), debounceMs = ORPHAN_CAP_DEBOUNCE_MS } = {}) {
  try {
    const stamped = Date.parse(fs.readFileSync(marker, 'utf8').trim());
    const at = Number.isFinite(stamped) ? stamped : fs.statSync(marker).mtimeMs;
    return now - at >= debounceMs;
  }
  catch { /* silence-ok: no marker is the normal first-run state and "due" is correct for it. */ return true; }
}

/** Stamp the debounce marker with the CALLER's clock. Best-effort: a missed stamp costs one extra
 * (cheap, local) check next Stop, never a wrong write. */
export function markOrphanCapChecked(now = Date.now()) {
  try {
    const m = ORPHAN_CAP_MARKER();
    fs.mkdirSync(path.dirname(m), { recursive: true });
    fs.writeFileSync(m, new Date(now).toISOString());
  } catch { /* silence-ok: same reasoning as reap.mjs's markReaped. */ }
}

/**
 * The distinct calendar dates (`YYYY-MM-DD`, UTC — `at` is always an ISO timestamp `append()`
 * stamped) on which a `handed` event landed for this session's queue. A raw file read, not the
 * folded `read()` shape: `queue.mjs`'s fold keeps only the LAST `handed` event (the current
 * holder), which is exactly right for claim semantics and exactly wrong for counting exposure
 * over time — this needs the full history.
 *
 * SLUGGED, like every other per-session filename in this tree (`paths.mjs`'s own `stateFor`/
 * `queueFor`/`spoolFor`/`lockFor`) — not `queueFor(sid)` directly, because that always resolves
 * against the GLOBAL `queueDir()` with no way to honour this function's own `queueD` override,
 * which `collectOrphanCandidates` below relies on to keep both calls pointed at the same
 * directory. Every real session id today is already slug-safe (recovered from a directory
 * listing), so this was harmless in practice — `paths-test.mjs` exists specifically to hunt this
 * class of bug regardless of whether today's callers happen to trigger it.
 */
export function distinctHandedDates(sid, { queueD = queueDir() } = {}) {
  let lines;
  try { lines = fs.readFileSync(path.join(queueD, `${slug(sid)}.jsonl`), 'utf8').split('\n').filter(Boolean); }
  catch { /* silence-ok: no queue file — an ENOENT/EACCES here means "nothing to count", not "unbounded exposure"; classifyOrphanQueue treats an empty set as never-breaching. */ return new Set(); }
  const days = new Set();
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { /* silence-ok: one torn/malformed append must not strand the whole count — matches queue.mjs's own fold, which skips a bad line rather than failing the read. */ continue; }
    if (e.op !== 'handed') continue;
    const d = String(e.at || '').slice(0, 10); // 'YYYY-MM-DDTHH:...' -> 'YYYY-MM-DD'
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) days.add(d);
  }
  return days;
}

/**
 * Classify ONE queue. Pure — `handedDays` is passed in rather than read here, so the predicate is
 * exercisable over a synthetic Set without a real queue file (`tests/orphan-cap-test.mjs`).
 *
 * `pending` must be the REAL pending list (from `queue.mjs`'s `read()`), not a count — a caller
 * needs the externalIds to actually settle a breach, and passing a count here would force a
 * SECOND read later to recover them, the same "reader and actor must agree" trap `reap.mjs`'s own
 * re-check-before-unlink exists for.
 */
export function classifyOrphanQueue(q, opts = {}) {
  const capDays = opts.capDays ?? ORPHAN_CAP_DAYS;
  if (!q.pending.length) return { sid: q.sid, action: 'keep', why: 'nothing pending', pending: [] };
  if (q.handedDays.size < capDays) {
    return { sid: q.sid, action: 'keep', why: `offered on ${q.handedDays.size}/${capDays} distinct days`, pending: q.pending };
  }
  return {
    sid: q.sid, action: 'breach',
    why: `offered on ${q.handedDays.size} distinct days (>= ${capDays}) with ${q.pending.length} still pending`,
    pending: q.pending,
  };
}

/**
 * Read the directory into the plain listing `planOrphanCap` consumes — real sessions only
 * (`isReal`, the same allow-list `reap.mjs`/`report.mjs`/`backfill.mjs` all apply to this exact
 * directory), and only files that actually have SOMETHING pending (a settled queue can never
 * breach, so skipping it here is one less file this cheap, inline, per-Stop scan has to fold).
 */
export function collectOrphanCandidates({ queueD = queueDir() } = {}) {
  const queues = [];
  let files;
  try { files = fs.readdirSync(queueD).filter((f) => f.endsWith('.jsonl')); }
  catch { /* silence-ok: no queue dir yet is the normal pre-first-run state. */ return queues; }
  for (const f of files) {
    const sid = f.replace(/\.jsonl$/, '');
    if (!isReal(sid)) continue;
    const q = readQueue(sid);
    if (q.state !== 'ok' || !q.pending.length) continue; // unreadable or settled: never a breach
    queues.push({ sid, pending: q.pending, handedDays: distinctHandedDates(sid, { queueD }) });
  }
  return queues;
}

/**
 * Plan a cap enforcement pass. PURE — no IO, writes nothing, decides everything. `applyOrphanCap`
 * (the ONLY thing that writes, in `orphan-cap-worker.mjs`) re-derives its own plan immediately
 * before acting rather than trusting a stale one — same reasoning as `reap.mjs`'s re-check before
 * unlink: the gap between "cheap check in capture.mjs" and "worker actually runs" spans a process
 * spawn, and another session may have settled the candidate in between.
 *
 * THE CAP IS CANDIDATES, NOT QUEUES — `ORPHAN_CAP_MAX_PER_RUN` bounds how many auto-`ignored`
 * writes one run may make (the blast-radius rail a predicate bug costs), which is a statement
 * about writes, not about how many queues happen to produce them.
 *
 * ⚠ A SINGLE QUEUE MAY BE SPLIT ACROSS `breach`/`deferred` (review finding, 2026-08-14, CONFIRMED
 * live regression). The prior shape deferred a breaching queue WHOLE the instant its own pending
 * count exceeded the remaining budget — sound-looking ("never half-settle one queue's candidates
 * in a run"), but wrong in the direction that matters: `budget` never exceeds `max`, so any SINGLE
 * queue whose pending count exceeds `ORPHAN_CAP_MAX_PER_RUN` could never satisfy `pending.length
 * <= budget` on ANY run, ever — permanent starvation for exactly the worst-offending queues this
 * backstop exists to catch. Each candidate is an independent record write (unlike `reap.mjs`'s
 * atomic file delete, there is no partial-file state to worry about), so settling half a queue
 * this run and the rest next run is a perfectly coherent intermediate state, not a torn one.
 * Splitting is therefore the correct behaviour, not a compromise.
 */
export function planOrphanCap({ queues, opts = {} } = {}) {
  const max = opts.maxPerRun ?? ORPHAN_CAP_MAX_PER_RUN;
  const decisions = queues.map((q) => classifyOrphanQueue(q, opts));
  const breaching = decisions.filter((d) => d.action === 'breach');
  const breach = [];
  const deferred = [];
  let budget = max;
  for (const d of breaching) {
    if (budget <= 0) { deferred.push(d); continue; }
    if (d.pending.length <= budget) {
      breach.push(d);
      budget -= d.pending.length;
    } else {
      // PARTIAL: settle as many of this queue's candidates as the remaining budget allows now,
      // defer the rest — the queue reappears next run with a smaller pending set, so it makes
      // real forward progress instead of being deferred whole, forever, past this run's budget.
      breach.push({ ...d, pending: d.pending.slice(0, budget) });
      deferred.push({ ...d, pending: d.pending.slice(budget), why: `${d.why} (partial: ${budget} of ${d.pending.length} settled this run)` });
      budget = 0;
    }
  }
  return {
    breach, deferred,
    kept: decisions.filter((d) => d.action === 'keep'),
    stats: {
      scanned: decisions.length,
      breaching: breaching.length,
      candidatesToSettle: breach.reduce((n, d) => n + d.pending.length, 0),
      candidatesDeferred: deferred.reduce((n, d) => n + d.pending.length, 0),
    },
  };
}
