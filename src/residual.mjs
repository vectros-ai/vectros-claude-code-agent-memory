/**
 * RESIDUAL — `total - offset` at rest: transcript text that no capture ever read.
 *
 * WHY IT IS A MODULE, and this is the whole justification: it now has TWO consumers that must
 * agree about the same population. `report.mjs` MEASURES the residual; `sweep.mjs`
 * FLUSHES it. If the reporter and the flusher enumerate sessions differently — a
 * different staleness clock, a different refusal on an unreadable transcript, a different idea of
 * what a "real" session id looks like — then the ORPHANED tally stops being a statement about
 * what the sweep does, which is the only reason that tally exists.
 *
 * It was born inside report.mjs, where it was the right place for one consumer. Copying it into
 * the sweep would have been exactly the mistake this codebase already learned to avoid (the
 * instance in front of you is a SAMPLE — fix the census, do not re-wire one mechanism per site),
 * in the branch whose founding defect that is. So it moves here and BOTH import it. report.mjs re-exports
 * the same symbols, so `tests/residual-test.mjs` and any operator muscle memory keep working.
 *
 * Read-only WITH RESPECT TO DATA: reads state files, folds queues, stats transcripts, and writes
 * no state anywhere. It does emit ONE `hlog` line — the enumeration cap — and that is a
 * deliberate exception rather than a loosening. The module's own receipt channel is `blindSpots`,
 * but `sweep.mjs:337` already established that `blindSpots`'s only printer is `report.mjs`, so a
 * cap firing during a Stop-triggered sweep would land somewhere nobody reads — "silence with extra
 * steps". The one event that means "the numbers below are incomplete" has to be visible where the
 * scan actually runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hlog } from './hooklog.mjs';
import { read as readQueue } from './queue.mjs';
import { transcriptLength } from './transcript.mjs';
// Aliased: the function below binds a LOCAL `stateDir` from `deps`, and an unaliased import would
// be shadowed by it — `const stateDir = deps.stateDir || stateDir()` is a TDZ self-reference, not
// a fallback.
import { stateDir as defaultStateDir } from './paths.mjs';
import { SWEEP_MAX_ENUMERATE } from './config.mjs';


/**
 * Real sessions only, or the numbers are fiction — and this must be an ALLOW-list, not a deny-list.
 *
 * The first cut denied known test prefixes (`nudge-|queue-|drain-|…`). It rotted immediately: the
 * triage suite landed as `triage-test-0001` and sailed straight into the production stats, exactly
 * as the next suite would have. A deny-list of test names is a promise to remember every future
 * test — the same "rule that asks you to remember" this whole system exists to avoid.
 *
 * Claude Code session ids are UUIDs. Test sids are words. So: match the SHAPE of a real id and
 * everything else is excluded by construction. `hlog` truncates the sid to 8 chars, so accept
 * either the 8-hex prefix (log lines) or the full UUID (state/queue filenames).
 *
 * IT GUARDS SPEND NOW, NOT JUST STATS. When only report.mjs read this, a leaked test sid cost a
 * wrong number. `sweep.mjs` shares it, so the same predicate now decides whether a session may be
 * handed to a billed distiller — one more reason it is an allow-list.
 */
export const REAL_SID = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
export const isReal = (sid) => REAL_SID.test(String(sid || '').replace(/\.(json|jsonl)$/, ''));

/**
 * THE BLIND-SPOT LEDGER — every input this pass could not read.
 *
 * A pass that silently skips unreadable inputs produces numbers that LOOK complete and are not:
 * "0 failures" and "I could not read the file that records failures" render identically. This
 * project has already shipped that mistake twice with real consequences — a capture-failure rate
 * that counted its own test, and a "0 memory records" line that was a swallowed HTTP 400. So the
 * skips are counted and reported alongside the results — the discipline that a measurement must be
 * able to return the answer you do not want, and must say when it cannot answer at all.
 */
export const blindSpots = [];
export const noteSkip = (what, e) => blindSpots.push(`${what}: ${e?.code || e?.message || 'unreadable'}`);

/**
 * The one number that makes the tail loss visible: `total - offset` AT REST — new transcript text that no
 * capture ever read. Every other capture metric is about work that HAPPENED; this is the work that
 * DIDN'T, and until it is on the page the tail loss is assumed rather than measured.
 *
 * PURE and exported so it can be RED-proven (→ tests/residual-test.mjs). CLAMPED at 0: `total < offset`
 * (a momentary read behind the watermark) would make `total - offset` a large NEGATIVE that would
 * understate the residual and poison the sum. Residual is never negative. NOTE: a clamped 0 here is
 * ambiguous by design — it means "genuinely nothing owed" OR "could not read the transcript" — so
 * `residualBySession` distinguishes them BEFORE calling this (an unreadable transcript with an
 * advanced watermark is logged as a blind spot, not folded in as 0). This function does not, and
 * cannot, tell the two apart; that is the caller's job.
 */
export function residualFor({ total, offset, lastStopAtMs, nowMs }) {
  const residual = Math.max(0, (total || 0) - (offset || 0));
  return { residual, ageMs: ageOf(lastStopAtMs, nowMs) };
}

/**
 * Idle age, or null if the session never recorded a Stop. Clamped at 0 so clock skew (a
 * `lastStopAt` in the future) reads as "just active", never as a negative age that could sort or
 * compare strangely.
 *
 * SPLIT OUT OF `residualFor` because the enumerator must know a session's age BEFORE deciding
 * whether to pay for its residual — see `residualBySession`'s `minAgeMs`. One definition, two
 * callers; the alternative was re-deriving `now - lastStopAt` inline, which is how two clocks
 * drift apart.
 */
export function ageOf(lastStopAtMs, nowMs) {
  return lastStopAtMs ? Math.max(0, nowMs - lastStopAtMs) : null;
}

/** Stale = idle at least `staleMs`. Unknown age (never recorded a Stop) is NOT stale — fail safe. */
export function isStale(ageMs, staleMs) {
  return ageMs !== null && ageMs !== undefined && ageMs >= staleMs;
}

/**
 * Residual for every real session that has recorded a transcript path (a prerequisite, set by
 * stop.mjs). Sessions from before that field existed have no path and are skipped — nothing to
 * measure, not a blind spot.
 *
 * TWO refusals, both routed to the blind-spot ledger so a partial number never prints as a complete
 * one (the whole point of `blindSpots`):
 *   • an unreadable QUEUE (`state:'corrupt'`) — offset unknown; folding in offset 0 would overstate
 *     residual as the whole arc.
 *   • an unreadable/rotated/locked TRANSCRIPT — `transcriptLength` collapses "unreadable" and "0
 *     chars" into the same `0`, so a bare 0 cannot be trusted. But a transcript is APPEND-ONLY: once
 *     its watermark (`offset`) has advanced past 0, an honest read cannot come back 0. So
 *     `total === 0 && offset > 0` is exactly the "the file is gone or unreadable" signal, and it is
 *     logged as a blind spot rather than reported as `residual: 0`. This matters because it BIASES
 *     the headline number: stale (>24h) sessions are the ones most likely to have lost their
 *     transcript, i.e. the exact population the ORPHANED tally sizes — silently dropping them would
 *     undercount precisely what B exists to flush. (Cold-panel finding, both lenses, 2026-07-17.)
 *
 * BOTH REFUSALS ARE NOW ALSO SPEND DECISIONS. The sweep flushes what this returns, so a
 * row it declines to emit is a session no distiller is spawned for. That is the correct direction —
 * you cannot honestly distill a transcript you cannot read, and an unknown offset would re-read the
 * whole arc — but it means the blind-spot ledger is now the ONLY place a permanently unflushable
 * session appears. Do not quiet it.
 *
 * Rows carry what the SWEEP needs as well as what the report prints: `transcriptPath` (the worker
 * argument — the sweep cannot re-derive it, which is the entire reason stop.mjs persists it) and
 * `sweptAt` (whether this idle episode was already flushed). One enumeration, both consumers.
 *
 * Injectable seam (`deps`) so the enumerator itself is testable without the real `~/.claude` dirs —
 * `residualBySession` reads state, enumerates sessions, and refuses two ways, and NONE of that was
 * covered while the pure `residualFor` was. Only the DATA sources are injected; refusals always route
 * through this module's own `noteSkip` (the blind-spot ledger, and the one channel the receipt-lint
 * discipline recognizes) — the test observes them via the exported `blindSpots`.
 */
/**
 * What the last enumeration actually looked at. `report.mjs` prints it so an operator can see the
 * phantom-to-real ratio without reading the state directory by hand — the number that explains why
 * the directory is large, and why that is not by itself a fault.
 */
export let lastCensus = { measured: 0, phantoms: 0, capped: 0, files: 0 };

export function residualBySession(nowMs, deps = {}) {
  const stateDir = deps.stateDir || defaultStateDir();
  const readQ = deps.readQueue || readQueue;
  const tLen = deps.transcriptLength || transcriptLength;
  /**
   * `minAgeMs` — A COST GATE, and its history is worth keeping because the numbers are the argument.
   *
   * This function was briefly called from the BLOCKING PROMPT PATH (recall's orphan nudge). It no
   * longer is — that consumer was re-indexed onto the queue directory and does not call this at all;
   * today the callers are `runSweep` (on Stop) and `report.mjs` (an operator keystroke). The gate
   * stays because the Stop path still benefits and the cost is real:
   *
   * MEASURED 2026-07-20, before it existed: one call took **1818 ms** and returned zero rows.
   * `transcriptLength` is a full `readFileSync` + `split('\n')` + `JSON.parse` per line, and this
   * loop ran it for EVERY session carrying a transcript path — 18 sessions, **218 MB** of JSONL —
   * on every `UserPromptSubmit`, to answer a question that then discarded the number. The staleness
   * filter was applied by the CALLER, after the expensive part. (Found by review; the authoring
   * session had "measured" 5ms, which was the module IMPORT, not the call — a number that answered
   * a question nobody asked. → the `measurement taken in a configuration you do not ship` rule.)
   *
   *   minAgeMs  — skip a session younger than this BEFORE reading its queue or transcript.
   *               `lastStopAt` is already in hand from the state file, so the age test is free.
   *   skipSwept — skip a session already flushed in its current idle episode, BEFORE parsing its
   *               transcript. The `sweptAt` marker comes free with the queue fold; the transcript
   *               parse does not. This is the gate that took a due sweep from 1695 ms to ~10 ms.
   *
   * It DEFAULTS OFF, so `report.mjs` — which genuinely wants every session's residual, live ones
   * included — is unchanged and still pays the full cost, once, at an operator's keystroke.
   *
   * (A `withResidual: false` flag briefly lived here too, to skip the transcript read for the orphan
   * consumer. It is GONE: that consumer was then re-indexed onto the QUEUE directory and stopped
   * calling this function at all, which left a flag with no producer — and `selectFlushable` citing
   * it as the live justification for one of its gates. A knob nobody turns is a knob that will one
   * day be tuned by someone who believes it does something, which is exactly why `MIN_SESSION_CHARS`
   * was deleted rather than left in place.)
   */
  const minAgeMs = deps.minAgeMs ?? null;
  const maxEnumerate = deps.maxEnumerate ?? SWEEP_MAX_ENUMERATE;
  const out = [];
  let files = [];
  try { files = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')); }
  catch (e) { noteSkip('the ENTIRE state dir (RESIDUAL omitted for this reason, not because there is none)', e); return out; }
  /**
   * THE HARD ENUMERATION CAP (a second backstop), and it guards something no test can.
   *
   * The expensive path below is bounded today by `if (!s.transcriptPath) continue` — an invariant
   * that lives in ANOTHER FILE (`stop.mjs` is the only writer of that field, and it deliberately
   * withholds it on empty Stops). An independent review already caught one change that would
   * have stamped the path on every Stop, admitting all ~5,450 phantoms permanently: each then costs
   * a state parse + queue fold + full `transcriptLength` on EVERY sweep, forever, because a
   * below-floor residual means `markSwept` never fires so `skipSwept` never excludes it either.
   *
   * The original framing is the point: *"the sweep's cost is currently bounded by an invariant in a
   * different file that is one careless line away from inverting, with no backstop underneath it."*
   * This is the backstop. It does not prevent that regression — it makes it DEGRADE (a bounded scan
   * and a loud line) instead of COMPOUND (an unbounded one, silently, on the Stop hook).
   *
   * AND IT SAYS WHEN IT BITES. A cap that truncates quietly reads as "covered everything", which is
   * the exact failure this subsystem's receipts exist to prevent. Set far above the 56 real sessions
   * measured 2026-07-29, so in normal operation this line never fires.
   */
  /**
   * FILTER, THEN SORT, THEN SLICE — and the first cut did none of that (PM cold pass, 2026-07-30).
   *
   * It sliced raw `readdirSync` order before the `isReal` filter, which is wrong twice. Phantom and
   * test-shaped filenames consumed cap slots that real sessions needed; and `readdirSync` order is
   * stable, so once the population exceeded the cap the SAME sessions were excluded on every sweep,
   * forever — a permanent blind spot rather than a bounded one, which is the opposite of what a
   * degrade-not-compound backstop is for.
   *
   * Sorting by mtime DESCENDING makes the truncation meaningful: if the cap must bite, keep the most
   * recently touched sessions, which are the ones with a live transcript worth flushing.
   *
   * The TRIGGER below still compares FILE count to the cap, which now counts SESSIONS — deliberately,
   * and it is a heuristic rather than a mismatch: it means "this directory is big enough that the
   * budget could conceivably run out, so spend a stat per file to make the order meaningful". Since
   * the cap now bites on measured sessions, a large directory of phantoms no longer forces a
   * truncation — it only pays for a sort that then does not matter, which is the cheap direction to
   * be wrong in.
   */
  /**
   * ⚠ THE CAP COUNTS MEASURABLE SESSIONS, NOT FILES — and counting files was a real defect that
   * made this backstop fire permanently while accusing an innocent mechanism (fixed 2026-08-01).
   *
   * The cap used to be applied to the file list, HERE, one loop iteration before
   * `if (!s.transcriptPath) continue` discards a phantom for free. MEASURED on the owner's machine
   * that day: 4,633 state files, of which **98.7% were phantoms** — so 1,969 of the 2,000 cap slots
   * were spent on files the very next line throws away, and only **31 of 61** genuinely measurable
   * sessions got in. `report.mjs`'s residual was silently missing half its population, and the
   * sweep's view was truncated for a reason that had nothing to do with the sweep.
   *
   * It could never recover, either. The reaper deliberately keeps a phantom for
   * `REAP_PHANTOM_AFTER_MS` (7d) and the machine mints ~368/day, so the steady-state population is
   * ~2,600 — permanently above a 2,000 file cap. The line fired on every sweep, forever.
   *
   * AND IT BLAMED THE WRONG THING. Its text read *"the phantom exclusion in stop.mjs is no longer
   * holding"*. That exclusion was holding perfectly — the phantoms are exactly what it is SUPPOSED
   * to produce, and because the cap was counted before the exclusion ran, a perfectly-held
   * invariant could not have prevented this line. It accused the one mechanism it structurally
   * cannot observe, and prescribed `reap.mjs`, which was already running daily and already deleting
   * its per-run maximum. A reader who followed both instructions found nothing wrong and learned to
   * ignore the receipt — on a subsystem whose entire premise is that receipts mean something.
   *
   * SO THE CAP NOW BOUNDS WHAT IS ACTUALLY EXPENSIVE. A state parse is ~0.08ms; `transcriptLength`
   * is a full read + per-line `JSON.parse` of a multi-MB JSONL. Charging the cap for parses of
   * 90-byte phantoms protected the cheap thing and rationed the dear one. Phantoms are now skipped
   * for free and only MEASURABLE sessions consume the budget — at which point 61 fits inside 2,000
   * with 97% headroom and the line goes back to meaning what it claims.
   *
   * The scan is still bounded: the reaper bounds the directory, which is what did not exist
   * when this cap was written. MEASURED cost of the change on the sweep's own path — with its
   * `skipSwept`/`minAgeMs` gates, which is how it actually runs — 383ms before, 362ms after: inside
   * the noise. The cap was rationing something that was never the cost.
   */
  files = files.filter((f) => isReal(f));
  if (files.length > maxEnumerate) {
    /**
     * An unstatable file sorts FIRST (Infinity), not last, and the skip is RECORDED.
     *
     * Returning 0 on a failed stat — the first cut — pushed it to the end of a descending sort, so
     * the very files we could not measure became the first ones the cap excluded: a silent drop of
     * the population we know least about, which is the opposite of fail-safe. It was also a silent
     * catch, and `receipt-lint-test.mjs` caught it (`residual.mjs:216 { return 0; }`).
     *
     * Sorting it first means it survives the cap and reaches the loop below, where its unreadable
     * state is routed to `blindSpots` and printed — the module's own receipt channel. A session we
     * cannot measure should show up as a blind spot, never as an absence.
     */
    const stamp = (f) => {
      try { return fs.statSync(path.join(stateDir, f)).mtimeMs; }
      catch (e) { noteSkip(`state ${f} (mtime for the enumeration cap)`, e); return Infinity; }
    };
    files = files
      .map((f) => ({ f, m: stamp(f) }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.f);
  }
  let measured = 0;
  let phantoms = 0;
  let capped = 0;
  let folded = 0;
  for (const f of files) {
    // (already filtered above — kept as a cheap invariant, not a second gate)
    if (!isReal(f)) continue;
    /**
     * THE CAP BITES HERE, on the count of sessions actually MEASURED — and it counts the rest
     * rather than breaking, so the receipt can say how much it did not look at. Breaking would
     * report a number without the denominator that makes it readable.
     */
    if (measured >= maxEnumerate) { capped++; continue; }
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); }
    catch (e) { noteSkip(`state ${f} (residual)`, e); continue; }
    // A BARE `continue`, AND DELIBERATELY NOT A `noteSkip`. This is the phantom exclusion — a
    // session that never recorded a transcript path has nothing to measure BY CONSTRUCTION, not
    // because we failed to read something. It is also the biggest population here: ~2,500 of 2,548
    // state files when measured 2026-07-20, and the figure GROWS (2,816 the next day; nothing reaps
    // it until the reaper lands). Routing it to the blind-spot ledger would bury the handful of genuine
    // unreadables that ledger exists to surface. Absence of capability, not a fault.
    if (!s.transcriptPath) { phantoms++; continue; }
    const sid = f.replace(/\.json$/, '');
    // THE CHEAP GATE FIRST. Unknown age never passes a `minAgeMs` filter — same fail-safe direction
    // as `isStale`: a session we know nothing about is not assumed done.
    const age = ageOf(s.lastStopAt, nowMs);
    if (minAgeMs !== null && !(age !== null && age >= minAgeMs)) continue;
    /**
     * THE QUEUE FOLD IS THE SECOND EXPENSIVE LEG, and it needs the cap as much as the transcript
     * read does — a full JSONL read and per-line parse, per session.
     *
     * Charging the budget only at `tLen` left it unbounded in one specific case: if `stop.mjs`'s
     * phantom invariant ever inverts AND the cheap gates above do not fire (all sessions young, or
     * `skipSwept` off, which is how `report.mjs` calls this), every file reaches here and folds a
     * queue, forever, on every sweep. That is the compound-not-degrade shape `SWEEP_MAX_ENUMERATE`
     * was created to prevent, so it is charged here too.
     *
     * NOT bounded by a file-scan counter, which was the first attempt and was wrong: the list is
     * sorted mtime-DESCENDING, so a scan cap evicts the OLDEST entries — which are exactly the
     * idle sessions the sweep exists to flush. That is the defect this cap was just fixed for,
     * reintroduced one level up. Bound the work, never the walk.
     */
    if (folded >= maxEnumerate) { capped++; continue; }
    folded++;
    const q = readQ(sid);
    if (q.state === 'corrupt') { noteSkip(`queue ${sid} (residual — offset unknown, refused)`, { code: 'corrupt' }); continue; }
    const offset = q.offset || 0;
    /**
     * THE SECOND COST GATE, and it is the one that actually mattered.
     *
     * `minAgeMs` removes LIVE sessions — which were never the expensive population. The expensive
     * population is stale sessions with a big transcript, and every one of them was fully parsed
     * (`readFileSync` + per-line `JSON.parse`) so that `selectFlushable` could then discard it a
     * moment later for having been swept already. MEASURED on this machine, after the "fix" that
     * only added `minAgeMs`: **1695 ms and 155 MB per due sweep**, on the Stop hook, forever — the
     * cost does not fall away once the backlog drains, because an already-swept session stays
     * stale-with-a-path for the rest of time and is re-parsed to conclude nothing.
     *
     * `sweptAt` is already in hand from the fold two lines up, and `skipSwept` lets the caller say
     * "I am going to discard these anyway." Same lesson as the prompt path, one consumer later:
     * DO NOT PAY FOR A NUMBER YOU ARE ABOUT TO THROW AWAY. (Three separate comments in sweep.mjs
     * described this scan as "stats-only"; none of them were true.)
     */
    if (deps.skipSwept && q.sweptAt !== null && q.sweptAt !== undefined
        && (s.lastStopAt === null || s.lastStopAt === undefined || q.sweptAt >= s.lastStopAt)) {
      // COUNT WHAT WE DROP. This gate removes rows before `selectFlushable` can classify them, so
      // without a count the sweep's receipt cannot tell "nothing has been idle long enough" from
      // "everything stale was already flushed" — and it asserted the former, which is false the
      // moment the backlog drains. An optimisation that silently empties a tally is how the
      // `minAgeMs` version of this same shape produced a confidently wrong line. (PM cold, M2.)
      if (deps.stats) deps.stats.skippedSwept = (deps.stats.skippedSwept || 0) + 1;
      continue;
    }
    /**
     * THE BUDGET IS SPENT HERE, on the transcript read — the only expensive thing in this loop and
     * the reason a cap exists at all. Counting earlier (at the phantom test, where the old
     * file-cap effectively did) charges the budget for work that costs nothing: a session the
     * cheap gates above skip never touches its transcript, so it must not consume a slot that a
     * session which WILL touch its transcript needs.
     */
    measured++;
    const total = tLen(s.transcriptPath);
    if (total < offset) {
      // A transcript is APPEND-ONLY: once the watermark (`offset`) advanced, an honest read cannot
      // come back SHORTER. So `total < offset` — including the `total === 0` (gone/ENOENT) subcase and
      // the `0 < total < offset` (truncated/rotated/partial) one — means the file is unreadable, not
      // that nothing is owed. Route it to the blind-spot ledger; do NOT let residualFor clamp it to 0.
      noteSkip(`transcript for ${sid} reads ${Math.round(total / 1000)}K, BELOW its watermark ${Math.round(offset / 1000)}K — unreadable/rotated; residual UNKNOWN, not 0`, { code: 'transcript' });
      continue;
    }
    const { residual, ageMs } = residualFor({ total, offset, lastStopAtMs: s.lastStopAt, nowMs });
    out.push({
      sid, residual, ageMs, total, offset,
      transcriptPath: s.transcriptPath,
      lastStopAt: s.lastStopAt ?? null,
      sweptAt: q.sweptAt ?? null,
    });
  }
  /**
   * THE RECEIPT, and it now fires ONLY when the cap actually bound something.
   *
   * The line it replaces fired on every sweep for days, said the residual was INCOMPLETE (true),
   * blamed `stop.mjs` (false — see the cap block above), and prescribed a reap that was already
   * running at its maximum (useless). Three sentences, one of them right.
   *
   * This one states only what this function observed: how many transcript reads it refused, out of
   * how many sessions it could have read. No diagnosis of another file's invariant — that is
   * precisely the claim a receipt cannot support from here, and asserting it is what sent a reader
   * to audit a healthy mechanism.
   */
  if (capped) {
    /**
     * THE UNREAD REMAINDER IS DELIBERATELY NOT BROKEN DOWN, and that is the honest shape.
     *
     * `phantoms` counts what this run actually classified — and once the cap binds we stop parsing,
     * so that number becomes an artifact of where we stopped rather than a fact about the
     * directory. The first draft of this line reported it anyway and read "6 phantoms were skipped
     * for free" on a directory holding 4,564 of them: a true counter, a false sentence. The
     * remainder is unclassified, so it is reported as unclassified.
     */
    hlog('residual', `residual is INCOMPLETE — measured ${measured} session(s), the `
      + `${maxEnumerate}-session cap, and stopped with ${capped} state file(s) unread (a mix of `
      + 'phantoms and real sessions; this run stopped before classifying them). Raise '
      + 'VECTROS_MEM_SWEEP_MAX_ENUMERATE if that many sessions genuinely carry a transcriptPath — '
      + 'if they do not, something is stamping one where it should not.');
  }
  lastCensus = { measured, phantoms, capped, folded, files: files.length };
  return out;
}
