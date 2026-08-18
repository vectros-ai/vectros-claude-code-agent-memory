/**
 * Hook TUNABLES — one place, one loader, fail-open.
 *
 * WHY THIS EXISTS. ~42 `const NAME = <literal>` are scattered across 13 hook files; only three
 * (`CLAUDE_CODE_BIN`, `VECTROS_CAPTURE_MODEL`, `VECTROS_RECALL_MODEL`) can be changed without
 * editing source and re-`cp`-ing to the runtime. Two consequences follow: once tsup
 * bundles the hooks for the OSS package a source `const` is unreachable to an adopter, and the two
 * numbers that MOST need tuning are guesses (`DELTA_GATE_CHARS` n=1, `NUDGE_THRESHOLD` n=3) that
 * today cost a source edit to move. This module is the seam that fixes both.
 *
 * HOW IT GREW. `CONTEXT_CAP` shipped first and alone — the duplicated one (`recall.mjs` AND
 * `evaluate.mjs` each carried `const CONTEXT_CAP = 9500`, two copies of one number that MUST agree,
 * the 10K `additionalContext` ceiling) — because it was the smallest change that proved the seam
 * end to end: one source of truth, a fail-open loader, config<env precedence, a RED-proven test.
 * The rest of the census then migrated in groups, each with its own test, never in bulk.
 *
 * THE TWO LOWEST MODULES COULD NOT MIGRATE AT ALL until `tunables()` existed. This file imports
 * `readJsonSafe` and `hlog`, so `atomic.mjs` and `hooklog.mjs` sit in an import CYCLE with it, and
 * a named import of a config value from either would be a temporal-dead-zone `ReferenceError` — on
 * the contended-read path only, i.e. never in testing and only on somebody else's machine. That is
 * what the re-entrancy guard at the bottom of this file is for, and it is proven (both directions)
 * in `tests/config-bootstrap-test.mjs`.
 *
 * THE CONTRACT — and every clause is a lesson this branch already paid for:
 *   • FAIL-OPEN, and LOUD-vs-QUIET. A hook must NEVER break a turn because config didn't parse.
 *     A config file is read-only (never written back), so every failure resolves to "use the
 *     default" — but the loader must still SAY WHICH, and a MISSING file is quiet (the normal case)
 *     while a MALFORMED one is loud. Reuses `readJsonSafe`; does not hand-roll a
 *     second corrupt-detector (one mechanism, not one wired per site it is found).
 *   • PRECEDENCE: default < file < env. Every existing env escape hatch keeps working; the generic
 *     per-tunable override is `VECTROS_MEM_<KEY>`, and env wins over the file.
 *   • VALIDATION IS PART OF FAIL-OPEN. A value that parses to the wrong shape (non-integer, out of
 *     range) is REJECTED loudly and falls back to the default — a config that could set
 *     `CONTEXT_CAP` past the 10K ceiling would silently truncate every injection.
 *   • PROVENANCE TRAVELS WITH THE DEFAULT. `SPEC[key].note` records whether a number is MEASURED or
 *     a guess, so an adopter reading the defaults learns which knobs are calibrated — and nobody
 *     "tidies" a measured constant away.
 *   • NOT EVERYTHING IS A TUNABLE. Protocol literals (e.g. `project.mjs`'s BEGIN/END markers that
 *     frame the generated MEMORY.md block) are NOT config and never enter `SPEC`.
 *
 * `resolveConfig` is a PURE function of its `{ file, env }` inputs — no globals, no IO beyond the
 * one `readJsonSafe` — so it is deterministic and trivially RED-provable (→ tests/config-test.mjs).
 * Import-time wiring calls it once against the real path/env and emits the receipt through `hlog`.
 */
import { readJsonSafe } from './atomic.mjs';
import { hlog } from './hooklog.mjs';
import { configFile } from './paths.mjs';

/**
 * Where the config file lives — resolved through `paths.mjs`, which owns every runtime path.
 *
 * It used to spell `path.join(os.homedir(), '.claude', 'vectros-memory', 'config.json')` here, and
 * that was the LAST hardcoded root in the tree: `tests/paths-test.mjs`'s census found it on the
 * first run after the seam landed. It mattered more than the other sixteen — a config path that
 * does not relocate with `VECTROS_MEMORY_HOME` means an isolated test run silently reads the
 * OPERATOR'S live tunables, so every threshold under test is whatever that machine happens to be
 * configured with. `VECTROS_MEMORY_CONFIG` still overrides it directly (see `paths.mjs`).
 *
 * Snapshotted as a const, unlike the per-call helpers in `paths.mjs`, because the resolution below
 * reads this file exactly ONCE per process by design — the value and the read must agree, and a
 * path that could change between them would be worse than one that cannot.
 *
 * NOTE (owner decision, surfaced not settled): the adopter-facing NAME and LOCATION of this file
 * are finalized as part of OSS packaging. `config.json` here is the dogfood default; nothing public
 * consumes it yet, so it is safe to move.
 */
export const CONFIG_PATH = configFile();

/**
 * A positive integer within [min, max]. Env values arrive as strings; JSON as numbers — both ok.
 *
 * THE BOUNDS ARE ATTACHED TO THE RETURNED FUNCTION, not merely closed over. They used to be
 * captured in the closure and unreachable, which meant NO TEST COULD ASSERT A RELATIONSHIP BETWEEN
 * TWO KNOBS — and this file states three such relationships in prose. A rail nobody can read is a
 * rail nobody can check. → `CONSTRAINTS` below.
 */
const posInt = (min, max) => {
  const parse = (raw) => {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isInteger(n)) return { ok: false, why: `not an integer (${JSON.stringify(raw)})` };
    if (n < min || n > max) return { ok: false, why: `${n} is outside [${min}, ${max}]` };
    return { ok: true, value: n };
  };
  parse.min = min;
  parse.max = max;
  return parse;
};

/**
 * The tunable census. Each entry: the shipped default, its env override name, a parse+validate fn,
 * and provenance. Grows one migrated `const` at a time; today it holds the one that proves the seam.
 */
export const SPEC = {
  /**
   * ── INFRA. The three lowest modules in the stack, and the ones a source `const` served WORST:
   * `atomic.mjs` and `hooklog.mjs` are imported BY this file, so before `tunables()`'s re-entrancy
   * guard they could not be configured at all without a temporal-dead-zone `ReferenceError` on the
   * contended-read path. → `tunables()`.
   *
   * Two of these five are MEASURED, and the measurement is the reason they must not be "tidied":
   * 12 retries x 3ms took Windows write loss from 56% to 0.03% on a 4-proc x 4000-cycle harness.
   * An adopter who lowers them is not saving milliseconds, they are re-opening a data-loss bug.
   */
  RENAME_RETRIES: {
    def: 12,
    env: 'VECTROS_MEM_RENAME_RETRIES',
    // Floor 1, not 0: 0 disables the retry entirely while still type-checking, and the retry IS the
    // fix (plain temp+rename lost 56% of writes). Same "a rail must exclude the dangerous region"
    // rule as CONTEXT_CAP's 9999 and STALE_SESSION_MS's 4h floor.
    parse: posInt(1, 1_000),
    note: 'MEASURED 2026-07-16, 4 procs x 4000 cycles on one file. Windows MoveFileEx REFUSES to '
      + 'replace a file another process holds open: plain temp+rename lost 9055/16000 writes (56%); '
      + 'with this retry, 5/16000 (0.03%). Retries x RENAME_RETRY_MS is the whole contention budget. '
      + 'Also bounds the READ path\'s contention spin in readJsonSafe. Do not lower it to "tidy".',
  },
  RENAME_RETRY_MS: {
    def: 3,
    env: 'VECTROS_MEM_RENAME_RETRY_MS',
    // Ceiling 1000: this is a SYNCHRONOUS sleep on a hook that runs on every prompt and every Stop,
    // so retries x this is added latency on the user's turn. 12 x 1000 = 12s is already past what
    // any hook should ever block for; anything larger is a hang, not a configuration.
    parse: posInt(1, 1_000),
    note: 'MEASURED with RENAME_RETRIES (see it). A real synchronous sleep (Atomics.wait), not a '
      + 'spin — the reader\'s open window is sub-millisecond, so the product 12 x 3ms = 36ms is the '
      + 'worst case added to a contended write. Raising it adds latency to EVERY contended hook.',
  },
  HOOKLOG_MAX_BYTES: {
    def: 512 * 1024,
    env: 'VECTROS_MEM_HOOKLOG_MAX_BYTES',
    // Floor 64K: the log is the only instrument that says whether any hook works, and it is rolled
    // (not trimmed) at this size with HOOKLOG_KEEP_GENERATIONS kept. A tiny cap would roll so often
    // that the retained history spans minutes.
    parse: posInt(64 * 1024, 512 * 1024 * 1024),
    note: 'n=0 for the value — the log had never reached it when the roll was written, so nothing '
      + 'measured argues 512K over 256K or 1M. What IS known: this file is appended by every hook '
      + 'in every session (~2/min of session churn alone), and it is ROLLED ASIDE rather than '
      + 'trimmed, so the bytes are kept, not discarded. → atomic.mjs § rollAtomic.',
  },
  HOOKLOG_KEEP_GENERATIONS: {
    def: 5,
    env: 'VECTROS_MEM_HOOKLOG_KEEP_GENERATIONS',
    // Floor 1: 0 would delete the archive the roll just created, turning "roll aside, keep the
    // history" back into the discard the roll replaced.
    parse: posInt(1, 1_000),
    note: 'how many rolled generations of hooks.log survive pruning; ~this many x HOOKLOG_MAX_BYTES '
      + 'of history, spannable via logGenerations(). Its predecessor DISCARDED everything past the '
      + 'last 2000 lines — on the one instrument that answers "is recall firing?" — which is why '
      + 'the floor excludes 0.',
  },
  LOCK_STALE_MS: {
    def: 60 * 60_000,
    env: 'VECTROS_MEM_LOCK_STALE_MS',
    /**
     * FLOOR 30 MIN, AND IT IS A SAFETY GATE. This threshold declares a worker DEAD and clears its
     * lock. The worst-case legitimate drain is MAX_WINDOWS_PER_RUN x CAPTURE_CLAUDE_TIMEOUT_MS =
     * 8 x 180s = 24 minutes of pure MODEL time, before spawn, HTTP, parse and append overhead —
     * and `capture-worker.mjs` never refreshes the mtime, so the clock starts at claim time and
     * runs through all of it. Set below that and the sweep unlinks a LIVE worker's lock and spawns
     * a duplicate distiller against the same session: the exact race the lock exists to prevent,
     * arriving through the code that checks it. 30 min is the documented worst case with no margin,
     * so it is the floor rather than a sensible setting; the default keeps the 2.5x margin.
     */
    parse: posInt(30 * 60_000, 24 * 60 * 60_000),
    note: 'n=1 for the raise (30 -> 60 min, 2026-07-20) and the reasoning is in lock.mjs: ONE '
      + 'threshold above the real worst case for BOTH callers, because hardening one side of a '
      + 'shared resource just moves the race to the other side. Live log evidence: the only genuine '
      + 'stale-lock clear observed was 6901s old (a truly dead worker); the other 26 were the lock '
      + 'test harness. If you raise MAX_WINDOWS_PER_RUN or CAPTURE_CLAUDE_TIMEOUT_MS, raise this too.',
  },

  CONTEXT_CAP: {
    def: 9500,
    env: 'VECTROS_MEM_CONTEXT_CAP',
    // Max is 9999, not 10_000: the note (and recall.mjs/evaluate.mjs) say the budget MUST stay
    // *under* the 10K additionalContext ceiling the platform enforces, so the ceiling value itself
    // is out of range. `posInt(1, 10_000)` accepted exactly 10000 — the one value the bound exists
    // to exclude. (Cold-panel finding, both lenses, 2026-07-17.)
    parse: posInt(1, 9999),
    note: 'injected additionalContext budget; MUST stay UNDER the 10K ceiling the platform enforces '
      + '(so 9999 is the max accepted). Default 9500 leaves headroom. Was duplicated in recall.mjs + evaluate.mjs.',
  },

  /**
   * ── The stale-queue sweep. FOUR tunables, and their provenance is the POINT — including
   * the one that is still a guess. `HANDED_TTL_MS` joined this block later and carries `n=0`; the
   * seam's contract is that provenance travels with the default, which means saying "guess" out
   * loud, not quietly counting it among the measured three.
   *
   * An earlier design note shipped the first three as `n=0 — GUESS` and said so:
   * that is WHY a residual-measurement approach landed first. It made residual measurable; these are now set from what it
   * measured, on 2026-07-20, over 13 real sessions carrying a transcript path:
   *
   *   total residual at rest ....... 850K chars
   *   orphaned (idle > 24h) ........ 617K across 9 sessions
   *   per-session residual ......... 10K .. 108K — and NOTHING between 0 and 10K
   *
   * That last fact is the one that sets the floor, and it is the kind of thing a guess cannot know.
   */
  STALE_SESSION_MS: {
    def: 24 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_STALE_SESSION_MS',
    /**
     * FLOOR 4h, AND THE FLOOR IS A SAFETY GATE — not a convenience for tests.
     *
     * It was 60_000, justified as "so a test can drive it". That was wrong twice. First, no test
     * needs it: `selectFlushable` and `orphanedPending` both take `staleMs` as a PARAMETER, and the
     * suite drives it that way — the low floor bought nothing and only widened what an operator
     * could set. Second, and this is the real cost, `VECTROS_MEM_STALE_SESSION_MS=60000` was an
     * ACCEPTED value that makes every session idle one minute "done", which (a) spawns billed
     * distillers against LIVE sessions and (b) hands a live session's pending candidates to another
     * agent — the double-disposition failure `nudge.mjs` exists to prevent, where a disposition is
     * final and the second judgement silently loses.
     *
     * This is `CONTEXT_CAP`'s lesson, six entries up, not applied at authoring time: its bound was
     * tightened to 9999 precisely because `posInt(1, 10_000)` accepted the one value the bound
     * existed to exclude. A rail must exclude the dangerous region, not merely bound the type.
     *
     * 4h still lets an operator shorten the window meaningfully (a machine that genuinely finishes
     * sessions faster) while staying well clear of a lunch break. Ceiling 30 days.
     */
    parse: posInt(4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    note: 'n=13 (2026-07-20) — how long a session must be QUIET before its residual counts as '
      + 'orphaned and the sweep may flush it. OWNER-SET at 24h and CONFIRMED by the data: the 9 '
      + 'sessions past it were genuinely done (36-47h idle), the 4 under it were live or same-day. '
      + 'A long threshold is what makes paused-vs-done moot.',
  },
  RESIDUAL_FLOOR_CHARS: {
    def: 2_000,
    env: 'VECTROS_MEM_RESIDUAL_FLOOR_CHARS',
    // Floor 500, not 1: the value of this knob is that it EXCLUDES phantom sessions, and a floor of
    // 1 disables that guard entirely while still type-checking — the same "accepted the one value
    // the bound exists to exclude" shape as CONTEXT_CAP's old 10_000. The design's own range was
    // "a few hundred–2K", so 500 is its bottom, not a new opinion.
    parse: posInt(500, 1_000_000),
    note: 'n=13 (2026-07-20) — the smallest tail worth a Haiku call. MEASURED: every session with '
      + 'any residual had >=10K, and none had 1-10K, so 2K cuts NOTHING observed. It is therefore a '
      + 'phantom guard (a session that produced almost nothing must never be billed), not a '
      + 'coverage decision. If a future census shows real tails under it, that is a reason to lower '
      + 'it — the number is a rail, and the population it excludes is empty today.',
  },
  HANDED_TTL_MS: {
    def: 2 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_HANDED_TTL_MS',
    // Floor 1 min (a test can drive it, and no realistic operator wants less); ceiling 7 days.
    parse: posInt(60_000, 7 * 24 * 60 * 60 * 1000),
    note: 'n=0 — how long ONE live session holds a claim on an orphaned queue before another may be '
      + 'offered it. Both directions are real costs, which is why it is a knob: too '
      + 'SHORT and two agents verify the same candidates and race to opposite judgements on a '
      + 'disposition that is final; too LONG and an abandoned claim strands a dead session\'s '
      + 'candidates for that whole window. 2h is a guess sized to "one working session", and it is '
      + 'the number to turn when a stranded queue is observed.',
  },
  SWEEP_DEBOUNCE_MS: {
    def: 600_000,
    env: 'VECTROS_MEM_SWEEP_DEBOUNCE_MS',
    parse: posInt(1_000, 24 * 60 * 60 * 1000),
    note: 'n=0 for the VALUE (nothing measured argues for 10 min over 5 or 15; it matches the '
      + 'projection clock already in capture.mjs) — but the COST it governs IS measured, and this '
      + 'is the string to read before lowering it. The scan spawns no inference, but it is NOT '
      + 'free: it reads and JSON-parses the transcript of every stale session not yet swept. '
      + 'MEASURED 2026-07-20: ~1.7s and 155MB against a 10-session backlog, falling to ~10ms once '
      + 'those carry a `swept` marker. It runs on Stop (off the reply path), at most once per this '
      + 'interval. Lowering it multiplies that scan, not a stat.',
  },

  /**
   * `recall.mjs` built its outbound `/v1/search` query from `input.prompt` UNCAPPED — the
   * rolling tail (`ROLLING_TAIL_CHARS=600`) and the kickoff-doc facets (`FACET_MAX=1200`) were both
   * already bounded, but the whole-prompt facet and the steady-state `${prompt}\n${tail}` query were
   * not. A big pasted diff/log/review-note pushes the request body past the Vectros API's own
   * request-body-size cap on `/v1/search` — so the request 413s and `search()`'s existing fail-open
   * turns that into a silent 0 hits, indistinguishable from "nothing relevant". (Measured recurring
   * in production, trending up.)
   */
  RECALL_QUERY_MAX_CHARS: {
    def: 4_000,
    env: 'VECTROS_MEM_RECALL_QUERY_MAX_CHARS',
    // Ceiling 8000, not 8192: the SAME lesson CONTEXT_CAP's own note already paid for — a bound must
    // EXCLUDE the dangerous region, not merely equal it. 8192 bytes is around where the API's own
    // request-body-size cap sits. This CHAR ceiling alone does NOT guarantee the byte ceiling — a
    // review finding caught that a char-only cap is false advertising against a byte-count limit
    // for multi-byte-heavy text (CJK/emoji/Cyrillic can be several bytes per char), so `clampQuery`
    // below ALSO enforces a byte backstop (`QUERY_MAX_BYTES`) on top of this one. This value stays
    // the primary, operator-facing knob (first N chars carry the intent, matching every sibling
    // char-cap in this file); the byte enforcement is what actually delivers the "stays under the
    // request-size cap" guarantee for non-ASCII content.
    parse: posInt(200, 8_000),
    note: 'the outbound-query boundary; first N chars carry the intent, the tail of an oversized '
      + 'paste is noise for a similarity query. Precedent: FACET_MAX=1200 (recall.mjs) bounds ONE of '
      + 'several parallel doc-derived facets; this bounds the PRIMARY query (whole prompt, or the '
      + 'mid-run evaluator\'s model-derived query), so it gets a larger budget. n=0 — not yet tuned '
      + 'against real query-length data; revisit once this fix has run long enough to have some.',
  },
  RECALL_QUERY_MAX_BYTES: {
    def: 7_500,
    env: 'VECTROS_MEM_RECALL_QUERY_MAX_BYTES',
    // Ceiling 8191: the request-body-size cap sits around 8192, and a bound must EXCLUDE the
    // dangerous region — a body sized exactly at the cap leaves nothing for the surrounding JSON.
    // Floor 500 keeps it above any sane char cap's byte equivalent.
    parse: posInt(500, 8_191),
    note: 'the BYTE backstop under RECALL_QUERY_MAX_CHARS, and it is not redundant with it: '
      + 'MEASURED, a 4000-char all-CJK query encodes to 12039 bytes and sails through a char-only '
      + 'clamp into the exact 413 the clamp exists to prevent. Default 7500 leaves headroom under '
      + 'the request-body-size cap for the surrounding JSON envelope (~35-40 bytes) plus margin.',
  },

  /**
   * ── CAPTURE. What the distiller reads, how much of it, and how long it may take.
   *
   * `DELTA_GATE_CHARS` is singled out as a guess (n=1 — arithmetic on a single
   * session) and it is the most consequential number in this block: it decides how often a billed
   * Haiku call happens at all. It is here so that tuning it stops costing a deploy, which was the
   * whole point of moving it into this seam.
   *
   * ⚠ THREE OF THESE MULTIPLY INTO `LOCK_STALE_MS`. The worst-case drain is
   * MAX_WINDOWS_PER_RUN x CAPTURE_CLAUDE_TIMEOUT_MS of pure model time, and the lock clock starts
   * at claim time and never refreshes. Raise either without raising LOCK_STALE_MS and the sweep
   * will declare a LIVE worker dead, clear its lock, and spawn a duplicate distiller against the
   * same session — the race the lock exists to prevent, arriving through the code that checks it.
   */
  DELTA_GATE_CHARS: {
    def: 100_000,
    env: 'VECTROS_MEM_DELTA_GATE_CHARS',
    // Floor 5_000: this gates SPEND. A tiny gate opens on almost every Stop, and Desktop fires
    // 1-2 Stops/min on an idle machine — so a low value here is an unbounded billed retry loop
    // with a plausible-looking number in front of it.
    parse: posInt(5_000, 100_000_000),
    note: 'n=1 — GUESS, and this note says so plainly. New transcript chars required since the last '
      + 'capture before the distiller runs. It replaced a 90s TIME debounce, which was uncorrelated '
      + 'with what the session actually produced and therefore wrong in both directions at once. '
      + 'The value came from arithmetic on ONE session; the SHAPE (content, not time) is the part '
      + 'that is settled. Lowering it spends more and captures sooner; raising it batches.',
  },
  DELTA_MAX_CHARS: {
    def: 400_000,
    env: 'VECTROS_MEM_DELTA_MAX_CHARS',
    parse: posInt(10_000, 100_000_000),
    note: 'n=0 — the largest single slice of transcript handed to one distiller window. A ceiling '
      + 'on the PROMPT, so it tracks the model\'s context budget rather than anything measured here.',
  },
  MAX_WINDOWS_PER_RUN: {
    def: 8,
    env: 'VECTROS_MEM_MAX_WINDOWS_PER_RUN',
    // Ceiling 24 bounds SPEND (24 windows is already a very large adoption drain). It does NOT
    // bound the lock relationship — see the note, and `CONSTRAINTS` below, which is what actually
    // checks that.
    parse: posInt(1, 24),
    note: 'n=0 for the value — how many transcript windows one drain may distill before stopping. '
      + 'Bounds the cost of adopting a large backlog. ⚠ MULTIPLIES with CAPTURE_CLAUDE_TIMEOUT_MS '
      + 'against LOCK_STALE_MS: exceed it and the sweep clears a LIVE worker\'s lock and spawns a '
      + 'duplicate billed distiller. The RAILS CANNOT ENFORCE THAT — 24 x the 180s default is 72 '
      + 'minutes against a 60-minute lock, and tightening the ceiling far enough to make it static '
      + 'would put it below the shipped default. So it is a resolve-time CONSTRAINT with a loud '
      + 'receipt instead (an earlier version of this note claimed the ceiling handled it; it did '
      + 'not, and nothing checked).',
  },
  CAPTURE_CLAUDE_TIMEOUT_MS: {
    def: 180_000,
    env: 'VECTROS_MEM_CAPTURE_CLAUDE_TIMEOUT_MS',
    parse: posInt(10_000, 30 * 60_000),
    note: 'n=0 — how long one distiller window may take. Off the reply path (the worker is '
      + 'detached), so this is a spend/liveness bound rather than a latency one. Multiplies with '
      + 'MAX_WINDOWS_PER_RUN against LOCK_STALE_MS — see the block header.',
  },
  PROJECT_DEBOUNCE_MS: {
    def: 600_000,
    env: 'VECTROS_MEM_PROJECT_DEBOUNCE_MS',
    parse: posInt(1_000, 24 * 60 * 60_000),
    note: 'n=0 — how often the pinned set is re-projected into MEMORY.md. Runs DETACHED off the '
      + 'Stop path, so the cost is one records lookup, not latency. It is the clock '
      + 'SWEEP_DEBOUNCE_MS was matched to.',
  },
  MAX_FLUSH_PER_SWEEP: {
    def: 1,
    env: 'VECTROS_MEM_MAX_FLUSH_PER_SWEEP',
    // Ceiling 10: each flush spawns a BILLED distiller. One sweep authorising an unbounded fan-out
    // of them is the failure mode; the default of 1 is deliberately the most conservative setting.
    parse: posInt(1, 10),
    note: 'n=0 — how many orphaned sessions ONE sweep may flush. Each flush spawns a billed '
      + 'distiller, so this is the fan-out rail on a path that runs unattended. Default 1 drains a '
      + 'backlog one session per sweep interval rather than all at once.',
  },

  /**
   * ── RECALL (the per-prompt hook). Everything here is on the USER'S TURN, so a timeout is latency
   * the operator feels, not just a bound. The 30s hook ceiling is the hard wall above all of it.
   */
  RECALL_TIMEOUT_MS: {
    def: 5_000,
    env: 'VECTROS_MEM_RECALL_TIMEOUT_MS',
    // Ceiling 25s, under the platform's 30s hook ceiling: a value above that cannot be honoured —
    // the hook is killed first — so accepting it would be advertising a guarantee we cannot make.
    parse: posInt(500, 25_000),
    note: 'n=0 — per-search budget on the prompt path. Headroom for a cold-start search while '
      + 'staying well under the 30s hook ceiling. On timeout recall fails OPEN (0 hits) and says so, '
      + 'so raising this trades turn latency for recall coverage on a slow link.',
  },
  RECALL_TOP_K: {
    def: 5,
    env: 'VECTROS_MEM_RECALL_TOP_K',
    parse: posInt(1, 50),
    note: 'n=0 — hits injected per query in STEADY STATE. Bounded in practice by CONTEXT_CAP, not '
      + 'by this: past the budget the fit loop drops lines, so raising it without raising the cap '
      + 'buys nothing.',
  },
  RECALL_TOP_K_FIRST: {
    def: 12,
    env: 'VECTROS_MEM_RECALL_TOP_K_FIRST',
    parse: posInt(1, 50),
    note: 'n=0 — the ORIENT (first prompt) fused set, deliberately larger than RECALL_TOP_K: the '
      + 'kickoff prompt is the one turn where breadth beats precision, and it is paid once.',
  },
  RECALL_MAX_FACETS: {
    def: 5,
    env: 'VECTROS_MEM_RECALL_MAX_FACETS',
    parse: posInt(1, 20),
    note: 'n=0 — parallel queries on the orient path: 1 (whole prompt) + up to 4 kickoff-doc '
      + 'sections. Each is a round trip, so this multiplies the orient\'s wall-clock, not its cap.',
  },
  RECALL_FACET_MAX_CHARS: {
    def: 1_200,
    env: 'VECTROS_MEM_RECALL_FACET_MAX_CHARS',
    parse: posInt(100, 8_000),
    note: 'n=0 — per-facet query length. Distinct from RECALL_QUERY_MAX_CHARS, which bounds the '
      + 'PRIMARY query; this bounds ONE of several parallel doc-derived facets and so gets less.',
  },
  KICKOFF_DOC_MAX_CHARS: {
    def: 8_000,
    env: 'VECTROS_MEM_KICKOFF_DOC_MAX_CHARS',
    parse: posInt(500, 1_000_000),
    note: 'n=0 — how much of a kickoff/handoff doc found in the cwd is read to derive orient '
      + 'facets. A read bound, not a request bound: the facets it produces are separately capped by '
      + 'RECALL_FACET_MAX_CHARS before anything goes on the wire.',
  },
  ROLLING_TAIL_CHARS: {
    def: 600,
    env: 'VECTROS_MEM_ROLLING_TAIL_CHARS',
    parse: posInt(50, 20_000),
    note: 'n=0 — how much of the PRIOR assistant turn conditions the steady-state query, so a '
      + 'follow-up prompt like "why?" still retrieves against what it is about. MUST NOT EXCEED '
      + 'STASH_CHARS, which is what stop.mjs actually persists — see that entry.',
  },
  STASH_CHARS: {
    def: 1_200,
    env: 'VECTROS_MEM_STASH_CHARS',
    parse: posInt(50, 40_000),
    note: 'n=0 — how much of the assistant turn stop.mjs persists for the next prompt to slice. '
      + 'DELIBERATELY LARGER THAN ROLLING_TAIL_CHARS (2x by default): recall takes the TAIL of this, '
      + 'so if the stash were the smaller of the two the "tail" would silently be the whole stash '
      + 'and the tail bound would stop meaning anything. The two are a PAIR — an operator raising '
      + 'ROLLING_TAIL_CHARS past this gets a shorter tail than they asked for, quietly.',
  },

  /**
   * ── MID-RUN EVALUATION (`PostToolUse`, R2). Off the reply path — it stages a result for the NEXT
   * prompt rather than blocking this one — so these are spend and freshness bounds, not latency.
   */
  EVAL_DEBOUNCE_MS: {
    def: 180_000,
    env: 'VECTROS_MEM_EVAL_DEBOUNCE_MS',
    // Floor 10s: this gates a detached BILLED `claude -p` per tool call. The debounce failing open
    // is precisely the unbounded-spend failure `state.mjs`'s damaged-read note describes, so a
    // near-zero value here is that same bug, configured rather than crashed into.
    parse: posInt(10_000, 24 * 60 * 60_000),
    note: 'n=0 — minimum gap between mid-run evaluations. It gates a detached billed Haiku call on '
      + 'a hook that fires on EVERY tool use, so the floor is a spend rail: with the debounce open, '
      + 'this is one billed call per tool call, unbounded.',
  },
  EVAL_TRANSCRIPT_TAIL_CHARS: {
    def: 4_500,
    env: 'VECTROS_MEM_EVAL_TRANSCRIPT_TAIL_CHARS',
    parse: posInt(200, 200_000),
    note: 'n=0 — how much recent conversation the mid-run evaluator sees. Paired with '
      + 'EVAL_TRANSCRIPT_TAIL_MSGS: whichever bound bites first wins, so a long single message and '
      + 'thirty short ones both stay bounded.',
  },
  EVAL_TRANSCRIPT_TAIL_MSGS: {
    def: 30,
    env: 'VECTROS_MEM_EVAL_TRANSCRIPT_TAIL_MSGS',
    parse: posInt(1, 500),
    note: 'n=0 — message-count companion to EVAL_TRANSCRIPT_TAIL_CHARS; see it.',
  },
  EVAL_TOP_K: {
    def: 5,
    env: 'VECTROS_MEM_EVAL_TOP_K',
    parse: posInt(1, 50),
    note: 'n=0 — hits the mid-run evaluator retrieves for its own judgement. Separate from '
      + 'RECALL_TOP_K on purpose: this feeds a MODEL deciding what is worth staging, not the '
      + 'agent\'s context, so the two have no reason to move together.',
  },
  EVAL_SEARCH_TIMEOUT_MS: {
    def: 6_000,
    env: 'VECTROS_MEM_EVAL_SEARCH_TIMEOUT_MS',
    parse: posInt(500, 60_000),
    note: 'n=0 — search budget inside the mid-run worker. Larger than RECALL_TIMEOUT_MS\'s ceiling '
      + 'is permitted here precisely because this one is NOT on the user\'s turn.',
  },
  EVAL_CLAUDE_TIMEOUT_MS: {
    def: 120_000,
    env: 'VECTROS_MEM_EVAL_CLAUDE_TIMEOUT_MS',
    parse: posInt(10_000, 30 * 60_000),
    note: 'n=0 — cold start plus one Haiku turn for the mid-run evaluator; off the hot path.',
  },
  EVAL_CONTRADICTION_MAX_CHARS: {
    def: 300,
    env: 'VECTROS_MEM_EVAL_CONTRADICTION_MAX_CHARS',
    parse: posInt(40, 4_000),
    note: 'n=0 — cap on the model-authored contradiction notice injected into the next prompt. A '
      + 'DISPLAY bound on UNTRUSTED text (the evaluator\'s own words), so it is a safety cap as much '
      + 'as a budget one.',
  },

  /**
   * ── THE PINNED SET. `PINNED_LIMIT` and `PINNED_MIN_PRIORITY` were each spelled TWICE — in
   * `enumerate.mjs` and in `project.mjs` — and the two call sites issue a BYTE-IDENTICAL lookup
   * (`{type:'memory', field:'priority', from, to:'999999', order:'desc', limit}`). Exactly the
   * `CONTEXT_CAP` shape: two copies of one number that must agree.
   *
   * WHY AGREEMENT MATTERS HERE. `project.mjs` writes the pinned set into MEMORY.md, which is what
   * the agent actually reads; `enumerate.mjs` fetches the same set to decide whether the
   * orientation SUCCEEDED. Let the two limits drift and the hook is reasoning about a set the file
   * does not contain — a disagreement with no error and no symptom except worse recall.
   */
  PINNED_LIMIT: {
    def: 12,
    env: 'VECTROS_MEM_PINNED_LIMIT',
    // Ceiling 50: the pinned tier is ALWAYS loaded, into every session, so it is a standing tax on
    // every context window. "Small by design" is the point of the tier, not an implementation
    // detail — a large value here silently converts always-load into most-of-the-corpus.
    parse: posInt(1, 50),
    note: 'n=0 — size of the always-load pinned tier. Small BY DESIGN: every entry is paid in every '
      + 'session\'s context, and adding a 13th demotes another. Was PINNED_TOP_X (enumerate.mjs) and '
      + 'PINNED_MAX (project.mjs) — one number, two names, two files.',
  },
  PINNED_MIN_PRIORITY: {
    def: 10,
    env: 'VECTROS_MEM_PINNED_MIN_PRIORITY',
    // A BAND, not a free integer: 0 normal / 10 pinned / 20 high / 30 critical. Bounded to the band
    // range; a floor of 0 would pin the entire corpus.
    parse: posInt(1, 30),
    note: 'the priority band floor for the always-load tier (0 normal / 10 pinned / 20 high / '
      + '30 critical). A NUMBER here and stringified at the two call sites, which is what the '
      + 'lookup range API takes. Floor excludes 0: at 0 every memory is pinned, which is the one '
      + 'value that makes the tier meaningless. Was duplicated in enumerate.mjs + project.mjs.',
  },
  THREAD_TOP_N: {
    def: 8,
    env: 'VECTROS_MEM_THREAD_TOP_N',
    parse: posInt(1, 50),
    note: 'n=0 — how many of THIS thread\'s earlier memories are fetched on a RESUME. The only '
      + 'block the orient still injects (the pinned set moved to MEMORY.md), so it is the one that '
      + 'competes directly with hits for CONTEXT_CAP.',
  },
  ENUMERATE_BODY_MAX_CHARS: {
    def: 400,
    env: 'VECTROS_MEM_ENUMERATE_BODY_MAX_CHARS',
    parse: posInt(40, 4_000),
    note: 'n=0 — per-entry body cap in the injected orient block. A DISPLAY bound on store-authored '
      + 'text; the fit loop against CONTEXT_CAP is what actually decides how many survive.',
  },
  ENUMERATE_TIMEOUT_MS: {
    def: 6_000,
    env: 'VECTROS_MEM_ENUMERATE_TIMEOUT_MS',
    // Ceiling 25s for the same reason as RECALL_TIMEOUT_MS: the orient runs on the first PROMPT.
    parse: posInt(500, 25_000),
    note: 'n=0 — lookup budget for the orient set. On the user\'s first turn, so it is real latency; '
      + 'the 25s ceiling keeps it under the platform\'s 30s hook wall.',
  },
  PROJECT_TIMEOUT_MS: {
    def: 6_000,
    env: 'VECTROS_MEM_PROJECT_TIMEOUT_MS',
    // Ceiling 5 min, not 25s: unlike its twin above, the projector runs DETACHED off the Stop path,
    // so nobody is waiting. Same default, different rail, because the risk is different.
    parse: posInt(500, 5 * 60_000),
    note: 'n=0 — lookup budget for the MEMORY.md projection. Same default as ENUMERATE_TIMEOUT_MS '
      + 'and deliberately NOT the same knob: this one runs detached, so a generous value costs '
      + 'nothing a user can feel.',
  },
  PROJECT_HOOK_MAX_CHARS: {
    def: 150,
    env: 'VECTROS_MEM_PROJECT_HOOK_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — per-entry chars in the generated MEMORY.md block. That block is a POINTER INDEX, '
      + 'one line per entry, not a copy of the memories — raising this turns an index into a '
      + 'duplicate of the corpus, in a file loaded into every session.',
  },

  /**
   * ── THE CANDIDATE CORPUS (record-backed). → candidates.mjs.
   */
  CANDIDATE_TIMEOUT_MS: {
    def: 6_000,
    env: 'VECTROS_MEM_CANDIDATE_TIMEOUT_MS',
    // Same 25s ceiling as the other prompt-path budgets: the PENDING lookup runs inside
    // recall.mjs on the user's turn, so it is latency the user feels, under a 30s hook wall.
    // The WRITES happen in the detached worker and could afford more, but they share this knob
    // rather than owning a second one — one budget is easier to reason about than two, and the
    // writes are small.
    parse: posInt(500, 25_000),
    note: 'n=0 — per-call budget for the candidate record client (lookups + writes).',
  },
  CANDIDATE_PAGE_LIMIT: {
    def: 100,
    env: 'VECTROS_MEM_CANDIDATE_PAGE_LIMIT',
    // 100 is the API's own documented per-page maximum, so this is a ceiling the server
    // enforces anyway; the knob exists to go SMALLER, not larger.
    parse: posInt(1, 100),
    note: 'n=0 — page size for candidate lookups. 100 is the API maximum; lower it only to '
      + 'reduce payload, never expecting more.',
  },
  CANDIDATE_MAX_PAGES: {
    def: 20,
    env: 'VECTROS_MEM_CANDIDATE_MAX_PAGES',
    parse: posInt(1, 500),
    note: 'n=0 — how many pages a candidate lookup will follow before refusing to answer. At the '
      + '100-row page maximum this is 2,000 candidates, far past any real review queue. It is a '
      + 'RUNAWAY bound, not a coverage limit: hitting it returns null (the "could not run" answer '
      + 'every caller already refuses to act on) rather than a silently truncated enumeration, '
      + 'because a partial review queue is indistinguishable from a short one.',
  },
  QUEUE_BODY_MAX_CHARS: {
    def: 4_000,
    env: 'VECTROS_MEM_QUEUE_BODY_MAX_CHARS',
    parse: posInt(500, 50_000),
    note: 'n=1 — the append-atomicity `queue.mjs` rests on ("a small write to a file opened '
      + 'O_APPEND is not interleaved") is an assumption bounded by an unenforced body size, not a '
      + "guarantee. Measured max body 1,605c across the live corpus; typical ~200-600c. 4,000 is the "
      + "figure the module's own header already cited as the informal ceiling (borrowed from POSIX "
      + 'PIPE_BUF, which governs pipes not regular files — so this is a deliberately conservative '
      + 'cap under it, not a derivation from it). Enforced by truncating `body`/`title` at append, '
      + 'not by rejecting the candidate: a truncated memory is still useful, a silently dropped one '
      + 'is not.',
  },
  SPOOL_MAX_ATTEMPTS: {
    def: 5,
    env: 'VECTROS_MEM_SPOOL_MAX_ATTEMPTS',
    parse: posInt(1, 100),
    note: 'n=0 — how many times a spooled proposal is retried before it is parked. A retry only '
      + 'helps a TRANSIENT failure; a malformed body fails identically forever, and retrying it '
      + 'every Stop is unbounded cost for a write that cannot land. Parked, not deleted — '
      + 'report.mjs surfaces the count, so the loss is measured rather than silent.',
  },
  SPOOL_FLUSH_MAX_PER_RUN: {
    def: 20,
    env: 'VECTROS_MEM_SPOOL_FLUSH_MAX_PER_RUN',
    parse: posInt(1, 500),
    note: 'n=0 — cap on spooled writes attempted per flush. After a long outage the backlog can '
      + 'be large, and draining it all in one Stop would turn a hook into a batch job; the '
      + 'remainder rides the next one.',
  },
  SPOOL_DRAIN_MAX_SESSIONS: {
    def: 3,
    env: 'VECTROS_MEM_SPOOL_DRAIN_MAX_SESSIONS',
    parse: posInt(1, 100),
    note: 'n=0 — how many sessions one drain flushes, own session included. A spool that still '
      + 'owes writes is never reaped, so SOMETHING has to flush the spools of sessions that have '
      + 'ENDED (nothing else ever will) — that is what this bounds. ⚠ It MULTIPLIES with '
      + 'SPOOL_FLUSH_MAX_PER_RUN: the worst case per drain is the product, not either number.',
  },
  CANDIDATE_SCHEMA_RECHECK_MS: {
    def: 60 * 60_000,
    env: 'VECTROS_MEM_CANDIDATE_SCHEMA_RECHECK_MS',
    parse: posInt(60_000, 24 * 60 * 60_000),
    note: 'n=0 — how long to stop attempting candidate calls after the store says the type does '
      + 'not exist. A hook is a FRESH PROCESS every invocation, so an in-memory latch would not '
      + 'survive; the marker is a file, and this is its TTL. Long enough that an unprovisioned '
      + 'context costs ~1 failed call/hour instead of ~2/minute, short enough that provisioning '
      + 'the schema heals the loop without anyone clearing a file.',
  },

  /**
   * ── HIT RENDERING. Display bounds on STORE-AUTHORED text, which is why they are caps at all:
   * every one of these strings is interpolated into an injected line, and a cap plus a newline
   * collapse is what stops one from escaping its bullet. → hit.mjs.
   */
  HIT_CLAIM_MAX_CHARS: {
    def: 200,
    env: 'VECTROS_MEM_HIT_CLAIM_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — `metadata.summary` is a curated one-liner, so this is a guard against a bad one, '
      + 'not a squeeze on a good one.',
  },
  HIT_PASSAGE_MAX_CHARS: {
    def: 180,
    env: 'VECTROS_MEM_HIT_PASSAGE_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — the matched chunk: enough to show WHY a hit matched, not enough to be the answer.',
  },
  HIT_RECORD_MAX_CHARS: {
    def: 260,
    env: 'VECTROS_MEM_HIT_RECORD_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — larger than HIT_PASSAGE_MAX_CHARS on purpose: records carry no curated summary, so '
      + 'the chunk IS the payload and has to stand alone.',
  },
  HIT_LABEL_MAX_CHARS: {
    def: 200,
    env: 'VECTROS_MEM_HIT_LABEL_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: "n=0 — hit.mjs's `label` (the record/document facet string) is built from "
      + '`metadata.recordType`/`kind`/`area`/`status`/`priority` — schema-defined but VALUE-free-text,'
      + ' i.e. store-authored, not platform-controlled. claim/text/passage were already capped; label '
      + 'was not. Found during an OSS-readiness pass alongside NUDGE_FIELD_MAX_CHARS, the same '
      + 'gap in the sibling injection path.',
  },

  /**
   * ── THE NUDGE. The pending-candidate block, and the one place where a MODEL-AUTHORED string is
   * rendered into the agent's context — so the three char caps are untrusted-input hardening, not
   * formatting. → nudge.mjs.
   */
  NUDGE_THRESHOLD: {
    def: 5,
    env: 'VECTROS_MEM_NUDGE_THRESHOLD',
    parse: posInt(1, 100),
    note: 'n=3 — GUESS, noted as such alongside DELTA_GATE_CHARS. Pending candidates '
      + 'required before the block is offered at all. The first real queues held 8/5/8, and the '
      + 'threshold was set from those three. It is a FLOOR only; NUDGE_MAX is the ceiling.',
  },
  NUDGE_MAX: {
    def: 12,
    env: 'VECTROS_MEM_NUDGE_MAX',
    parse: posInt(1, 100),
    note: 'MEASURED headroom, 2026-07-17: the worst live session held 12 pending rendering to '
      + '3673c against a 9500c CONTEXT_CAP. TWO NUMBERS, DIFFERENT THINGS (nudge.mjs carries the pair '
      + 'too): WORST CASE ~315c/candidate with every field at its cap, which is what this cap must be '
      + 'safe against. OBSERVED, re-measured 2026-07-29 over all 35 real pending '
      + 'candidates: min 192c, median 220c, MEAN 223c, max 261c — an observed cliff at ~42 against '
      + 'a worst-case cliff at ~26. This cap keeps the block clear of both — past the cliff '
      + 'recall drops the WHOLE block every prompt and the only escape is disposal, which only the '
      + 'dropped block advertises.',
  },
  NUDGE_ORPHAN_MAX: {
    def: 6,
    env: 'VECTROS_MEM_NUDGE_ORPHAN_MAX',
    parse: posInt(1, 100),
    note: 'n=0 — candidates shown from an ORPHANED session\'s queue. Smaller than NUDGE_MAX because '
      + 'these are someone else\'s candidates, offered to a session that did not live through them: '
      + 'the ask is heavier per item, so the batch is lighter.',
  },
  NUDGE_BODY_MAX_CHARS: {
    def: 110,
    env: 'VECTROS_MEM_NUDGE_BODY_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — enough to judge "do I need to look closer"; `--list` has the full text. Capped AND '
      + 'newline-collapsed: the text is MODEL-AUTHORED, and a newline would escape the bullet.',
  },
  NUDGE_TITLE_MAX_CHARS: {
    def: 120,
    env: 'VECTROS_MEM_NUDGE_TITLE_MAX_CHARS',
    parse: posInt(20, 2_000),
    note: 'n=0 — same untrusted-input rule as NUDGE_BODY_MAX_CHARS; see it.',
  },
  NUDGE_FIELD_MAX_CHARS: {
    def: 40,
    env: 'VECTROS_MEM_NUDGE_FIELD_MAX_CHARS',
    parse: posInt(8, 500),
    note: 'n=0 — `kind`/`dest`/`revises`. These are ENUM-SHAPED in the distiller prompt and '
      + 'validated nowhere, so the cap is the only thing standing between a malformed model output '
      + 'and the injected line. 114/114 live candidates held the declared enums; that is an upper '
      + 'bound on the deviation rate, not a guarantee.',
  },

  /**
   * ── DISPOSE (the operator CLI). Not a hook: it runs when a human or agent invokes it, so a
   * generous timeout costs nobody a turn.
   */
  DISPOSE_TIMEOUT_MS: {
    def: 8_000,
    env: 'VECTROS_MEM_DISPOSE_TIMEOUT_MS',
    parse: posInt(500, 5 * 60_000),
    note: 'n=0 — per-request budget when verifying a `stored:` claim against the store. Off any '
      + 'hook path, so the ceiling is generous.',
  },
  DISPOSE_STORED_RECENCY_MIN: {
    def: 120,
    env: 'VECTROS_MEM_DISPOSE_STORED_RECENCY_MIN',
    parse: posInt(1, 30 * 24 * 60),
    note: 'n=0 — how recently a record must have been created for a `stored:<id>` claim to be '
      + 'accepted as THIS session\'s work. The gate exists so an agent cannot settle a candidate by '
      + 'citing a record someone else wrote months ago; too tight and a slow verification pass '
      + 'fails honest claims, too loose and the check stops meaning anything.',
  },

  /**
   * ── CREDS. The `vectros keyring show` credential-helper subprocess VECTROS_API_KEY
   * delegates to — see creds.mjs's module header for the full precedence story.
   */
  CREDS_HELPER_TIMEOUT_MS: {
    def: 10_000,
    env: 'VECTROS_MEM_CREDS_HELPER_TIMEOUT_MS',
    parse: posInt(1_000, 60_000),
    note: 'n=0 — how long the `vectros keyring show` helper may run before this hook gives up on '
      + 'it. On the RECALL path (UserPromptSubmit), so a wedged CLI must not hang a turn; the '
      + 'default leaves headroom under the 30s hook ceiling for the search call that follows.',
  },
  CREDS_HELPER_MAX_BUFFER: {
    def: 64 * 1024,
    env: 'VECTROS_MEM_CREDS_HELPER_MAX_BUFFER',
    parse: posInt(4 * 1024, 8 * 1024 * 1024),
    note: 'n=0 — the helper\'s stdout is a single short secret line, never a wall of text, so this '
      + 'is a defensive ceiling (a hostile/broken CLI build printing something enormous) rather '
      + 'than a size any real key approaches.',
  },
  CREDS_DETAIL_MAX_CHARS: {
    def: 200,
    env: 'VECTROS_MEM_CREDS_DETAIL_MAX_CHARS',
    parse: posInt(40, 2_000),
    note: 'n=0 — cap on a credential-helper failure detail before it reaches hlog. The helper is a '
      + 'separately-versioned binary whose stderr this module does not control, so it is capped '
      + 'the same way every other untrusted-string render site in this tree is (→ HIT_LABEL_MAX_CHARS).',
  },

  /**
   * ── THE REAPER. `state/` and `queue/` grow without bound and nothing prunes them.
   *
   * MEASURED on the dogfood machine 2026-07-29 (a re-census, not the original numbers — the earlier
   * pass measured 2,548 on 2026-07-20, so the population had more than doubled in nine days):
   *
   *   state/ ......... 5,779 files, 0.8 MB, corpus only 15.7 days old  (~368/day)
   *   of which ....... 5,450 hold EXACTLY {orientPending, orientSource, orientedAt}
   *   carry lastStopAt  56
   *   queue/ ......... 58 files, 694 KB — 12 with pending, 46 fully settled
   *
   * ⚠ THAT 5,450 CORRECTS THE ORIGINAL DIAGNOSIS, AND THE CORRECTION IS THE WHOLE DESIGN. The
   * original diagnosis was "Desktop spawns ~1-2 empty Stops per minute, each of which creates a
   * state file." It is not Stop.
   * `{orientPending, orientSource, orientedAt}` is byte-for-byte what `orient.mjs` writes at
   * SessionStart, and `stop.mjs` is the ONLY writer of `lastStopAt` — so the phantoms never reached
   * a Stop at all. They have no `lastStopAt` and never will.
   *
   * Which means a retention window keyed on `lastStopAt` recency — exactly what the issue proposes
   * — would match NOTHING in 94% of the population and the reaper would quietly do almost nothing
   * while reporting success. The fallback clock is the file's own mtime, and for a phantom that is
   * its creation time.
   *
   * TWO WINDOWS, because there are two populations with different costs of being wrong. Losing a
   * phantom's state costs nothing (a session that never took a prompt). Losing a REAL session's
   * state costs its orientation and injected-id set on resume — rebuildable, but not free.
   * Losing a QUEUE costs candidates AND the capture watermark, which sends the delta gate back to
   * re-read the whole arc and re-propose everything already disposed. So queues get the longest
   * window and the strictest guard, and nothing with pending candidates is ever eligible.
   */
  REAP_PHANTOM_AFTER_MS: {
    def: 7 * 24 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_REAP_PHANTOM_AFTER_MS',
    // Floor 24h — and it is a safety gate, not a convenience. A phantom is identified by the
    // ABSENCE of a Stop, and a live session that has taken a prompt but not yet finished a turn
    // looks exactly like one. A day is comfortably longer than any session that is still going.
    parse: posInt(24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000),
    note: 'MEASURED 2026-07-29 — how long a state file that NEVER reached a Stop and has no queue '
      + 'survives, aged by mtime (it has no lastStopAt to age by; see the block header). 5,450 of '
      + '5,779 files are this shape, so this is the knob that does ~94% of the work. Such a file '
      + 'holds only {orientPending, orientSource, orientedAt} for a session that never took a '
      + 'prompt: nothing can ever want it except a resume of that exact session.',
  },
  REAP_STATE_AFTER_MS: {
    def: 30 * 24 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_REAP_STATE_AFTER_MS',
    // Floor 7 days: this population is REAL sessions, and Claude Code can resume one long after
    // its last turn. Below a week the reaper starts costing resumed sessions their orientation.
    parse: posInt(7 * 24 * 60 * 60 * 1000, 3650 * 24 * 60 * 60 * 1000),
    note: 'n=0 for the value — how long the state of a session that DID reach a Stop survives, aged '
      + 'by lastStopAt. Deliberately much longer than REAP_PHANTOM_AFTER_MS: these files carry '
      + 'transcriptPath and lastStopAt, which are the ONLY way the sweep can locate and flush a done '
      + 'session\'s residual, and they are what a resume re-orients from. 56 files today.',
  },
  REAP_QUEUE_AFTER_MS: {
    def: 90 * 24 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_REAP_QUEUE_AFTER_MS',
    // Floor 30 days. A queue is the most valuable thing in the runtime: candidates are unrecovered
    // learning and the `captured` watermark is the only thing standing between the delta gate and
    // re-distilling an entire session arc. Nothing here should be reachable by a nervous operator.
    parse: posInt(30 * 24 * 60 * 60 * 1000, 3650 * 24 * 60 * 60 * 1000),
    note: 'n=0 — how long a FULLY SETTLED queue survives. Settled is a hard precondition, not a '
      + 'tiebreak: a queue with pending candidates is never eligible at any age (report.mjs\'s '
      + 'PENDING tally is the check). Longest window in the file because the loss is the '
      + 'worst: candidates AND the watermark, and a lost watermark re-reads and re-proposes the '
      + 'whole arc.',
  },
  REAP_MAX_DELETES_PER_RUN: {
    def: 500,
    env: 'VECTROS_MEM_REAP_MAX_DELETES_PER_RUN',
    parse: posInt(1, 100_000),
    note: 'n=0 — a BLAST-RADIUS rail, not a performance one. This is the only component here that '
      + 'deletes, so a predicate bug is unbounded by construction; capping one run means a mistake '
      + 'costs 500 files and a receipt rather than the whole directory. At ~368 files/day the '
      + 'default still drains a backlog faster than it accumulates.',
  },
  REAP_DEBOUNCE_MS: {
    def: 24 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_REAP_DEBOUNCE_MS',
    parse: posInt(60 * 1000, 30 * 24 * 60 * 60 * 1000),
    note: 'n=0 — minimum gap between reaps. Growth is ~368 files/day and the windows are 7-90 days, '
      + 'so there is nothing a more frequent run could catch; it would only re-pay the directory '
      + 'scan. Daily is already far more often than the shortest window needs.',
  },
  ORPHAN_CAP_DAYS: {
    def: 7,
    env: 'VECTROS_MEM_ORPHAN_CAP_DAYS',
    // Floor 1 day (a test can drive it); ceiling 90 (past that the knob stops meaning "give up",
    // it just means "never" with extra steps — REAP_QUEUE_AFTER_MS's own floor is 30 days).
    parse: posInt(1, 90),
    note: 'n=0 — how many DISTINCT CALENDAR DAYS a genuinely record-backed orphan queue may be '
      + 'offered before its still-pending candidates are auto-ignored. Deliberately NOT a '
      + 'raw `handed`-event count or a distinct-session count: measured live, one session '
      + 're-affirming an already-held claim on every prompt racked up 20 `handed` events in what '
      + 'reads as a single workday, and a raw-count cap would be exhausted by ONE reviewer '
      + 'glancing at it repeatedly — the opposite of "nobody has settled this across real time". '
      + 'Distinct-day counting is the one measure a single session or a single busy day cannot '
      + 'inflate on its own. 7 is a guess sized to "a realistic work week"; the number to turn if '
      + 'a genuinely-hard candidate is being written off before anyone with the right context sees it.',
  },
  ORPHAN_CAP_MAX_PER_RUN: {
    def: 50,
    env: 'VECTROS_MEM_ORPHAN_CAP_MAX_PER_RUN',
    parse: posInt(1, 10_000),
    note: 'n=0 — a blast-radius rail on the one component that auto-disposes candidates without a '
      + 'human in the loop, same reasoning as REAP_MAX_DELETES_PER_RUN: a predicate bug here costs '
      + '50 wrong `ignored`s and a receipt (all reversible via `reopen`), never the whole corpus.',
  },
  ORPHAN_CAP_DEBOUNCE_MS: {
    def: 6 * 60 * 60 * 1000,
    env: 'VECTROS_MEM_ORPHAN_CAP_DEBOUNCE_MS',
    parse: posInt(60 * 1000, 24 * 60 * 60 * 1000),
    note: 'n=0 — minimum gap between orphan-cap worker spawns. Shorter than REAP_DEBOUNCE_MS '
      + '(daily) on purpose: unlike the reaper, a missed window here is not "re-pay a directory '
      + 'scan", it is "a capped candidate keeps nagging for up to one more debounce interval" — '
      + 'worth checking more often. Still measured in hours, not minutes: the underlying cap is '
      + 'measured in DAYS, so nothing is lost by not catching a breach the instant it happens.',
  },
  SWEEP_MAX_ENUMERATE: {
    def: 2_000,
    env: 'VECTROS_MEM_SWEEP_MAX_ENUMERATE',
    // Floor 100: below that the cap starts hiding real sessions rather than bounding a regression.
    parse: posInt(100, 1_000_000),
    note: 'A SECOND BACKSTOP alongside the reaper above, and it exists because the sweep\'s cost bound '
      + 'currently rests on an invariant in ANOTHER file — residual.mjs\'s `if (!s.transcriptPath) '
      + 'continue`, which an independent review caught one change away from inverting. If that '
      + 'guard ever flips, every phantom enters the expensive path permanently (state parse + queue '
      + 'fold + full transcriptLength, every sweep, forever, because a below-floor residual means '
      + 'markSwept never fires so skipSwept never excludes it). This cap makes that regression '
      + 'DEGRADE rather than COMPOUND. It is deliberately far above the 56 real sessions measured '
      + '2026-07-29, so it never bites in normal operation — and the sweep SAYS when it truncates, '
      + 'because a silent cap reads as "covered everything".',
  },
};

/**
 * CROSS-KNOB CONSTRAINTS — relationships between tunables that no per-key rail can express.
 *
 * WHY THIS EXISTS. Three relationships were stated in SPEC notes and enforced by NOTHING, and one
 * of the notes asserted an enforcement that did not exist. `resolveConfig` validates each key in
 * isolation, so every one of these could be violated with every individual value in range and no
 * output at all.
 *
 * WHY NOT JUST TIGHTEN THE RAILS. For the lock relationship it is arithmetically impossible: making
 * `MAX_WINDOWS_PER_RUN.max x CAPTURE_CLAUDE_TIMEOUT_MS.max <= LOCK_STALE_MS.min` hold statically
 * needs a timeout ceiling of 75s, which is below the shipped 180s default. A rail that excludes the
 * default is not a rail. So these are checked after resolution, where the actual chosen values are
 * known.
 *
 * TWO KINDS, and the difference is whether there is a SAFE DIRECTION:
 *   · `clamp` — one value is meaningless past another, and clamping it is what the operator meant.
 *     `ROLLING_TAIL_CHARS` cannot exceed `STASH_CHARS`, because you cannot slice a longer tail than
 *     you stored; the excess silently did nothing. Clamped, and SAID.
 *   · `warn` — both values are legitimate and only their combination is hazardous. Overriding
 *     either would mask a real configuration error, so it is reported loudly and applied.
 *
 * Each entry is `{ name, holds(v), why(v) }`. Pure, and exported so the test can drive it — the
 * whole point is that a relationship nobody can read is a relationship nobody can check.
 */
export const CONSTRAINTS = [
  {
    name: 'ROLLING_TAIL_CHARS <= STASH_CHARS',
    kind: 'clamp',
    holds: (v) => v.ROLLING_TAIL_CHARS <= v.STASH_CHARS,
    why: (v) => `ROLLING_TAIL_CHARS=${v.ROLLING_TAIL_CHARS} exceeds STASH_CHARS=${v.STASH_CHARS}, and `
      + 'recall takes the TAIL of what stop.mjs stashed — so the extra was silently doing nothing. '
      + `Clamped to ${v.STASH_CHARS}; raise STASH_CHARS if you want a longer tail.`,
    clamp: (v) => { v.ROLLING_TAIL_CHARS = v.STASH_CHARS; },
  },
  {
    name: 'MAX_WINDOWS_PER_RUN x CAPTURE_CLAUDE_TIMEOUT_MS <= LOCK_STALE_MS',
    kind: 'warn',
    holds: (v) => v.MAX_WINDOWS_PER_RUN * v.CAPTURE_CLAUDE_TIMEOUT_MS <= v.LOCK_STALE_MS,
    why: (v) => `a worst-case drain is ${v.MAX_WINDOWS_PER_RUN} x ${Math.round(v.CAPTURE_CLAUDE_TIMEOUT_MS / 1000)}s = `
      + `${Math.round((v.MAX_WINDOWS_PER_RUN * v.CAPTURE_CLAUDE_TIMEOUT_MS) / 60_000)} min of MODEL time, but LOCK_STALE_MS is `
      + `${Math.round(v.LOCK_STALE_MS / 60_000)} min. capture-worker never refreshes the lock mtime, so the sweep will `
      + 'declare a LIVE worker dead, clear its lock, and spawn a DUPLICATE BILLED distiller against the same session. '
      + 'Raise LOCK_STALE_MS above the product, or lower the drain.',
  },
  {
    name: 'REAP_PHANTOM_AFTER_MS <= REAP_STATE_AFTER_MS <= REAP_QUEUE_AFTER_MS',
    kind: 'warn',
    holds: (v) => v.REAP_PHANTOM_AFTER_MS <= v.REAP_STATE_AFTER_MS && v.REAP_STATE_AFTER_MS <= v.REAP_QUEUE_AFTER_MS,
    why: (v) => `reap windows are out of order (phantom ${days(v.REAP_PHANTOM_AFTER_MS)}d, state `
      + `${days(v.REAP_STATE_AFTER_MS)}d, queue ${days(v.REAP_QUEUE_AFTER_MS)}d). The ordering is the design: a `
      + 'phantom is worth least and a queue most (it holds candidates AND the capture watermark). Inverted, the '
      + 'reaper deletes the valuable population before the worthless one.',
  },
  {
    /**
     * CLAMPED, not warned — the PM cold pass was right that this one is different in kind. Its own
     * message says the consequence is "permanently unflushable", i.e. DATA LOSS, and then the value
     * was applied anyway. A `warn` is correct where both settings are legitimate and only the
     * combination is hazardous; here one of them is simply wrong, and there is an unambiguous safe
     * direction: keep state at least as long as the sweep might still need it. Clamping UP costs
     * disk; not clamping costs a session's tail forever.
     */
    name: 'REAP_STATE_AFTER_MS >= STALE_SESSION_MS',
    kind: 'clamp',
    clamp: (v) => { v.REAP_STATE_AFTER_MS = v.STALE_SESSION_MS; },
    holds: (v) => v.REAP_STATE_AFTER_MS >= v.STALE_SESSION_MS,
    why: (v) => `state is reaped at ${days(v.REAP_STATE_AFTER_MS)}d but the sweep only considers a session `
      + `flushable at ${days(v.STALE_SESSION_MS)}d — so a session's state file (which carries the transcriptPath the `
      + 'sweep needs) can be deleted BEFORE the sweep is ever allowed to use it, making its residual permanently '
      + 'unflushable and telling nobody.',
  },
];

const days = (ms) => Math.round(ms / 86_400_000);

/**
 * Apply the constraints to a resolved value map. MUTATES `values` for `clamp` entries; returns the
 * violations so the caller can report them. Pure apart from that mutation, and exported for tests.
 */
export function applyConstraints(values) {
  const violations = [];
  for (const c of CONSTRAINTS) {
    if (c.holds(values)) continue;
    const why = c.why(values);
    if (c.kind === 'clamp') c.clamp(values);
    violations.push({ name: c.name, kind: c.kind, why });
  }
  return violations;
}

/**
 * Resolve every tunable from `{ file, env }`. PURE — the only IO is the single `readJsonSafe(file)`.
 *
 * @param {{file: string, env: object}} opts
 * @returns {{
 *   values: object,                              // KEY -> resolved value (always a valid default at worst)
 *   state: 'fresh'|'ok'|'unreadable'|'damaged',  // the config FILE's read state (readJsonSafe's receipt)
 *   why?: string,
 *   overrides: Array<{key, source: 'file'|'env', value}>,  // knobs sourced from file/env (may equal the default), with origin
 *   rejected: Array<{key, source: 'file'|'env', raw, why}>,  // present-but-invalid values (the value used is in `values`)
 * }}
 */
export function resolveConfig({ file, env }) {
  const raw = readJsonSafe(file, {});
  const { state, why } = raw;
  /**
   * A NON-OBJECT JSON ROOT IS MALFORMED, NOT CLEAN. `readJsonSafe` returns
   * `{...defaults, ...JSON.parse(raw)}` with no root-type check, so `null`, `42`, `"hello"` and
   * `[{...}]` all came back `state:'ok'` with zero usable keys and NOTHING logged — every knob
   * silently at its default, in the module whose contract is "the loader must SAY WHICH". Spreading
   * an array is the nastiest of them: it yields `{"0":…}`, which looks like a populated config.
   *
   * `[{"CONTEXT_CAP": 8000}]` is a plausible slip and produced total silence. Malformed must be loud.
   */
  const fileCfg = state === 'ok' ? raw.value : {};
  const values = {};
  const overrides = [];
  const rejected = [];
  /**
   * UNKNOWN KEYS ARE REPORTED, not silently dropped. The loop below iterates SPEC and only ever
   * asks whether the file has that key — so a typo (`CONTEXT_CAP_`, `contextCap`), a knob renamed
   * between versions, or a stale key from an older config was read by nobody and mentioned by
   * nobody. The operator concludes the value applied and debugs the wrong thing.
   */
  const unknown = Object.keys(fileCfg).filter((k) => !Object.prototype.hasOwnProperty.call(SPEC, k));

  for (const [key, spec] of Object.entries(SPEC)) {
    // TRUE LAYERING, highest-precedence FIRST: env, then file, then default. A candidate that is
    // present-but-INVALID does not win AND does not skip to the default — it is rejected loudly and
    // the NEXT source down gets its turn. So a garbage `VECTROS_MEM_*` still lets a valid file value
    // apply, rather than silently forcing the default past a config the operator wrote.
    //
    // An env var set to empty/whitespace means "not set" (otherwise `VAR=` parses to a rejected 0
    // and logs loud on every hook process — a footgun, not a config).
    let envRaw = spec.env ? env[spec.env] : undefined;
    if (typeof envRaw === 'string' && envRaw.trim() === '') envRaw = undefined;
    const fileRaw = Object.prototype.hasOwnProperty.call(fileCfg, key) ? fileCfg[key] : undefined;

    const candidates = [{ source: 'env', raw: envRaw }, { source: 'file', raw: fileRaw }]
      .filter((c) => c.raw !== undefined);

    let resolved = false;
    for (const c of candidates) {
      const parsed = spec.parse(c.raw);
      if (parsed.ok) {
        values[key] = parsed.value;
        overrides.push({ key, source: c.source, value: parsed.value });
        resolved = true;
        break;
      }
      rejected.push({ key, source: c.source, raw: c.raw, why: parsed.why });
    }
    if (!resolved) values[key] = spec.def;
  }

  // Cross-knob relationships, applied AFTER every key has its final value — they are functions of
  // the resolved set, not of any single candidate. → CONSTRAINTS.
  const violations = applyConstraints(values);

  return { values, state, why, overrides, rejected, unknown, violations };
}

/**
 * Emit the receipt for a resolution. Missing/clean is quiet, malformed/invalid is loud.
 * Separated from `resolveConfig` so that function stays pure; `log` is injectable for testing.
 *
 * THE FILE-STATE LINE MUST NOT CLAIM "using defaults" UNCONDITIONALLY. A malformed/unreadable file
 * does NOT force defaults for a key that an env var overrides — env is resolved independently of the
 * file (precedence: default < file < env). So a damaged `config.json` + a valid `VECTROS_MEM_*`
 * yields the ENV value in use, not the default. The old wording said "does not parse; using defaults"
 * and then SUPPRESSED the "applied" line whenever state wasn't ok/fresh — a receipt that lied about
 * the value actually used, in the exact module whose contract is "say which value you used." So: the
 * file-state line reports the FILE is unusable (true) without asserting the outcome, and the applied
 * line fires whenever any override took effect, REGARDLESS of file state. (Cold-panel finding, 2026-07-17.)
 */
export function reportConfig(r, file, log = hlog) {
  if (r.state === 'unreadable') {
    log('config', `config UNREADABLE (${r.why}) at ${file} — its bytes are unknown; file-sourced keys fall back (env overrides still apply).`);
  } else if (r.state === 'damaged') {
    log('config', `config MALFORMED (${r.why}) at ${file} — does not parse; file-sourced keys fall back (env overrides still apply). Fix or remove it.`);
  }
  for (const j of r.rejected) {
    log('config', `config ${j.key} from ${j.source} rejected (${j.why}) — trying the next source down / default.`);
  }
  // LOUD: a key the operator wrote that this build does not know about. Silence here means they
  // believe a knob applied when nothing read it.
  if (r.unknown?.length) {
    log('config', `config UNKNOWN key(s) ignored: ${r.unknown.join(', ')} — not in this build's SPEC. `
      + 'Check spelling/case, or the knob was renamed. Nothing read them.');
  }
  // LOUD: a cross-knob relationship the per-key rails cannot express. → CONSTRAINTS.
  for (const v of r.violations || []) {
    log('config', `config CONSTRAINT ${v.kind === 'clamp' ? 'CLAMPED' : 'VIOLATED'} (${v.name}) — ${v.why}`);
  }
  if (r.overrides.length) {
    log('config', `config applied: ${r.overrides.map((o) => `${o.key}=${o.value}(${o.source})`).join(', ')}`);
  }
}

/**
 * Defaults alone — no file, no env. What a BOOTSTRAP RE-ENTRANT caller gets; see `tunables()`.
 * Frozen because handing out the fallback map by reference to a caller that might mutate it would
 * corrupt every later fallback.
 */
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s.def])));

// Declared BEFORE the resolution below, and that ordering is load-bearing — see `tunables()`.
let RESOLVED = null;
let RESOLVING = false;

/**
 * The tunables, resolved once per process. THE RE-ENTRANCY GUARD IS THE WHOLE REASON THIS IS A
 * FUNCTION, and without it the two lowest modules in the stack could not be configured at all.
 *
 * THE CYCLE. `config.mjs` imports `readJsonSafe` from `atomic.mjs` and `hlog` from `hooklog.mjs`
 * (deliberately — do not hand-roll a second corrupt-detector or a second logger). So the
 * moment `atomic.mjs` takes ITS tunables (`RENAME_RETRIES`, `RENAME_RETRY_MS`) from here, the
 * import graph is a cycle. ESM tolerates cycles; what it does not tolerate is READING a `const`
 * from a module still evaluating. And this resolution's own first act is to call `readJsonSafe` —
 * so `atomic.mjs` would ask for `RENAME_RETRIES` at the exact instant it is in the temporal dead
 * zone, and get a `ReferenceError`.
 *
 * WHY THAT WOULD HAVE BEEN A LANDMINE RATHER THAN A CRASH, which is the part worth the paragraph:
 * `readJsonSafe` touches `RENAME_RETRIES` ONLY on the contended-read path. A missing config file
 * (ENOENT) returns before it; a clean read never reaches it. So every ordinary startup on every
 * machine would work perfectly, and the throw would arrive only under file contention — the one
 * condition this whole module exists because of, and the one no test naturally reproduces. A hook
 * that dies at import cannot log, so it would present as the failure `hooklog.mjs`'s header calls
 * indistinguishable from success.
 *
 * THE GUARD. While the resolution is in flight, `tunables()` hands back `DEFAULTS`. That is not a
 * degradation to apologise for — it is the correct answer: the only caller that can arrive during
 * the window is the config read itself, and the value it wants (12 retries x 3ms) is the MEASURED
 * default that took Windows write loss from 56% to 0.03%. A config file cannot be read using the
 * settings inside that same config file; something has to bottom out, and bottoming out on the
 * measured default is the right floor.
 *
 * `RESOLVED` is assigned BEFORE `reportConfig` runs, so the receipt — which goes through `hlog`,
 * which itself now asks for `HOOKLOG_MAX_BYTES` — sees real values rather than defaults. Getting
 * that backwards would make the config receipt the one line written under the wrong config.
 */
export function tunables() {
  if (RESOLVED) return RESOLVED.values;
  if (RESOLVING) return DEFAULTS;
  RESOLVING = true;
  let r;
  try {
    r = resolveConfig({ file: CONFIG_PATH, env: process.env });
  } finally {
    RESOLVING = false; // `finally`, so a throw cannot wedge every later call on the defaults
  }
  RESOLVED = r;
  reportConfig(r, CONFIG_PATH);
  return r.values;
}

// ── Import-time wiring: resolve once against the real path/env, log the receipt, export the values.
//
// Eager rather than lazy so the receipt lands at startup, where an operator reading `hooks.log`
// top-down sees which knobs were in force BEFORE the lines that depended on them. The named exports
// below are snapshots, which is what every consumer already assumes.
const V = tunables();

/**
 * ── INFRA. `LOCK_STALE_MS` is a NAMED export because `lock.mjs` is a plain consumer — nothing here
 * imports it, so there is no cycle and a snapshot is safe.
 *
 * `atomic.mjs` and `hooklog.mjs` are the opposite case and MUST NOT import these names: this module
 * imports THEM, so a named export would be in its temporal dead zone exactly when they need it.
 * They call `tunables()` at USE time instead. The distinction is structural, not stylistic — see
 * `tunables()` for what the alternative actually does (throws only under file contention, on
 * machines you do not own, at import, where nothing can log it).
 */
export const LOCK_STALE_MS = V.LOCK_STALE_MS;

/** The 10K-ceiling `additionalContext` budget, single-sourced (was duplicated in two hooks). */
export const CONTEXT_CAP = V.CONTEXT_CAP;

/**
 * `STALE_SESSION_MS` is single-sourced here for the same reason `CONTEXT_CAP` was: it now
 * has THREE consumers that MUST agree — the sweep's flush gate, the cross-session nudge's
 * orphan gate, and `report.mjs`'s ORPHANED tally (which held the original local copy). A report
 * that counts a different population than the sweep flushes is a report about a different system.
 */
export const STALE_SESSION_MS = V.STALE_SESSION_MS;
export const RESIDUAL_FLOOR_CHARS = V.RESIDUAL_FLOOR_CHARS;
export const SWEEP_DEBOUNCE_MS = V.SWEEP_DEBOUNCE_MS;
export const HANDED_TTL_MS = V.HANDED_TTL_MS;
export const RECALL_QUERY_MAX_CHARS = V.RECALL_QUERY_MAX_CHARS;

// ── The rest of the census. Named exports, snapshotted once — every consumer below is a
//    plain leaf of the import graph, so none of them has the cycle problem atomic/hooklog have.
export const DELTA_GATE_CHARS = V.DELTA_GATE_CHARS;
export const DELTA_MAX_CHARS = V.DELTA_MAX_CHARS;
export const MAX_WINDOWS_PER_RUN = V.MAX_WINDOWS_PER_RUN;
export const CAPTURE_CLAUDE_TIMEOUT_MS = V.CAPTURE_CLAUDE_TIMEOUT_MS;
export const PROJECT_DEBOUNCE_MS = V.PROJECT_DEBOUNCE_MS;
export const MAX_FLUSH_PER_SWEEP = V.MAX_FLUSH_PER_SWEEP;

export const RECALL_TIMEOUT_MS = V.RECALL_TIMEOUT_MS;
export const RECALL_TOP_K = V.RECALL_TOP_K;
export const RECALL_TOP_K_FIRST = V.RECALL_TOP_K_FIRST;
export const RECALL_MAX_FACETS = V.RECALL_MAX_FACETS;
export const RECALL_FACET_MAX_CHARS = V.RECALL_FACET_MAX_CHARS;
export const KICKOFF_DOC_MAX_CHARS = V.KICKOFF_DOC_MAX_CHARS;
export const ROLLING_TAIL_CHARS = V.ROLLING_TAIL_CHARS;
export const STASH_CHARS = V.STASH_CHARS;

export const EVAL_DEBOUNCE_MS = V.EVAL_DEBOUNCE_MS;
export const EVAL_TRANSCRIPT_TAIL_CHARS = V.EVAL_TRANSCRIPT_TAIL_CHARS;
export const EVAL_TRANSCRIPT_TAIL_MSGS = V.EVAL_TRANSCRIPT_TAIL_MSGS;
export const EVAL_TOP_K = V.EVAL_TOP_K;
export const EVAL_SEARCH_TIMEOUT_MS = V.EVAL_SEARCH_TIMEOUT_MS;
export const EVAL_CLAUDE_TIMEOUT_MS = V.EVAL_CLAUDE_TIMEOUT_MS;
export const EVAL_CONTRADICTION_MAX_CHARS = V.EVAL_CONTRADICTION_MAX_CHARS;

/** Single-sourced: enumerate.mjs and project.mjs issue a byte-identical lookup. → SPEC. */
export const PINNED_LIMIT = V.PINNED_LIMIT;
/** A NUMBER here; both call sites stringify it, which is what the range-lookup API takes. */
export const PINNED_MIN_PRIORITY = V.PINNED_MIN_PRIORITY;
export const THREAD_TOP_N = V.THREAD_TOP_N;
export const ENUMERATE_BODY_MAX_CHARS = V.ENUMERATE_BODY_MAX_CHARS;
export const ENUMERATE_TIMEOUT_MS = V.ENUMERATE_TIMEOUT_MS;
export const PROJECT_TIMEOUT_MS = V.PROJECT_TIMEOUT_MS;
export const PROJECT_HOOK_MAX_CHARS = V.PROJECT_HOOK_MAX_CHARS;
export const CANDIDATE_TIMEOUT_MS = V.CANDIDATE_TIMEOUT_MS;
export const CANDIDATE_PAGE_LIMIT = V.CANDIDATE_PAGE_LIMIT;
export const CANDIDATE_MAX_PAGES = V.CANDIDATE_MAX_PAGES;
export const QUEUE_BODY_MAX_CHARS = V.QUEUE_BODY_MAX_CHARS;
export const CANDIDATE_SCHEMA_RECHECK_MS = V.CANDIDATE_SCHEMA_RECHECK_MS;
export const SPOOL_MAX_ATTEMPTS = V.SPOOL_MAX_ATTEMPTS;
export const SPOOL_FLUSH_MAX_PER_RUN = V.SPOOL_FLUSH_MAX_PER_RUN;
export const SPOOL_DRAIN_MAX_SESSIONS = V.SPOOL_DRAIN_MAX_SESSIONS;

export const HIT_CLAIM_MAX_CHARS = V.HIT_CLAIM_MAX_CHARS;
export const HIT_PASSAGE_MAX_CHARS = V.HIT_PASSAGE_MAX_CHARS;
export const HIT_RECORD_MAX_CHARS = V.HIT_RECORD_MAX_CHARS;
export const HIT_LABEL_MAX_CHARS = V.HIT_LABEL_MAX_CHARS;

export const NUDGE_THRESHOLD = V.NUDGE_THRESHOLD;
export const NUDGE_MAX = V.NUDGE_MAX;
export const NUDGE_ORPHAN_MAX = V.NUDGE_ORPHAN_MAX;
export const NUDGE_BODY_MAX_CHARS = V.NUDGE_BODY_MAX_CHARS;
export const NUDGE_TITLE_MAX_CHARS = V.NUDGE_TITLE_MAX_CHARS;
export const NUDGE_FIELD_MAX_CHARS = V.NUDGE_FIELD_MAX_CHARS;

export const DISPOSE_TIMEOUT_MS = V.DISPOSE_TIMEOUT_MS;
export const DISPOSE_STORED_RECENCY_MIN = V.DISPOSE_STORED_RECENCY_MIN;

export const CREDS_HELPER_TIMEOUT_MS = V.CREDS_HELPER_TIMEOUT_MS;
export const CREDS_HELPER_MAX_BUFFER = V.CREDS_HELPER_MAX_BUFFER;
export const CREDS_DETAIL_MAX_CHARS = V.CREDS_DETAIL_MAX_CHARS;

// ── The reaper and the sweep's enumeration backstop.
export const REAP_PHANTOM_AFTER_MS = V.REAP_PHANTOM_AFTER_MS;
export const REAP_STATE_AFTER_MS = V.REAP_STATE_AFTER_MS;
export const REAP_QUEUE_AFTER_MS = V.REAP_QUEUE_AFTER_MS;
export const REAP_MAX_DELETES_PER_RUN = V.REAP_MAX_DELETES_PER_RUN;
export const REAP_DEBOUNCE_MS = V.REAP_DEBOUNCE_MS;
export const ORPHAN_CAP_DAYS = V.ORPHAN_CAP_DAYS;
export const ORPHAN_CAP_MAX_PER_RUN = V.ORPHAN_CAP_MAX_PER_RUN;
export const ORPHAN_CAP_DEBOUNCE_MS = V.ORPHAN_CAP_DEBOUNCE_MS;
export const SWEEP_MAX_ENUMERATE = V.SWEEP_MAX_ENUMERATE;

/**
 * THE shared outbound-request boundary. Every site that builds a Vectros search query from
 * text whose length this module does not otherwise control (a raw user prompt, a model-emitted
 * query) MUST route it through this before it reaches `JSON.stringify({query, ...})` — recall.mjs's
 * `search()` and recall-eval-worker.mjs's `search()` both do. One function, one constant: a future
 * third caller inherits the bound by calling this, not by remembering to re-derive the number.
 *
 * TWO BOUNDS, not one — a review finding on the first cut caught the gap. A char-count cap alone
 * is FALSE ADVERTISING against a BYTE-count server-side threshold: `RECALL_QUERY_MAX_CHARS` chars
 * of CJK/emoji/Cyrillic clamp cleanly by the char rule and can still be 2-4x that many BYTES —
 * MEASURED, a 4000-char all-CJK query produced a 12039-byte body against an 8192-byte request-size
 * cap, the exact 413 this function exists to prevent, sailing straight through the char clamp. So:
 * clamp by chars first (the fast, common-case
 * path — every existing sibling cap in this file, `FACET_MAX`/`ROLLING_TAIL_CHARS`/etc., is a char
 * count, and this stays consistent with that for the ASCII-dominant case this bound was measured
 * against), THEN verify the JSON-ENCODED byte size — what's actually on the wire, quotes and
 * escaping included, since a body full of newlines/quotes/backslashes inflates on encode — and only
 * pay the codepoint-safe binary search if that second check fails.
 *
 * THREE bounds now, not two. `/v1/search`'s body is deliberately NOT exempt from the
 * fronting WAF's CRS content-inspection rules (CrossSiteScripting_Body/GenericLFI_Body/
 * GenericRFI_Body/EC2MetaDataSSRF_Body stay in Block mode there — unlike /v1/records and
 * /v1/documents — because /v1/search feeds a real Lucene query_string sink, a genuine past
 * injection class on this codebase; see platform/api-services/gateway-edge-partner.yaml). Both
 * `search()` callers build their query from `state.lastAssistant` (stop.mjs stashes the last
 * assistant message VERBATIM, no sanitization), and Claude Code's own hook-payload markup
 * (`<task-notification>…</task-notification>`, `<tool-use-id>…</tool-use-id>`) legitimately
 * appears inside real assistant-visible content. MEASURED live, 2026-08-18: 13 `search HTTP 403`s
 * in a 48-hour window, every one with tag-shaped content in its logged `shape=` excerpt —
 * `waf-receipt-test.mjs` widened the DIAGNOSTIC receipt for this exact shape a while back but
 * never addressed the cause; this closes it.
 */
// Was a bare literal here; migrated to SPEC so the byte backstop is tunable alongside the
// char cap it backs. Its note carries the CJK measurement that proves the two are not redundant.
const QUERY_MAX_BYTES = V.RECALL_QUERY_MAX_BYTES;

/**
 * Strip harness-shaped tag markup (`<task-notification>`, `</tool-use-id>`, …) before it can
 * become part of an outbound search query — see clampQuery's own docstring for why this exists.
 *
 * SCOPED to lowercase-initial tag names on purpose, not a blanket `<[^>]*>`: this codebase's own
 * content is full of genuinely angle-bracketed, non-tag text this must NOT corrupt — Java/TS
 * generics (`List<String>`, `Map<K, V>`) use UPPERCASE/PascalCase type-parameter names by
 * convention, and a plain comparison (`x < y`) never has a bare word immediately after `<`. Every
 * harness tag observed in this hook's own payloads (`task-notification`, `tool-use-id`,
 * `system-reminder`, …) is lowercase/kebab-case — the one shape a generic type parameter cannot
 * take (`-` isn't a valid identifier character in a Java or TS type parameter). So requiring a
 * lowercase first letter right after `<` or `</` is a cheap, precise-enough disambiguator: it
 * catches every harness-tag shape actually observed, without eating `<T>`/`<String>`/`x < y`.
 *
 * Strips the tag DELIMITERS only, not the content between them — a plain, minimal transformation
 * that removes the specific shape the WAF has actually been observed flagging, without guessing at
 * the rest of the CRS surface (`../`, IP-literal patterns, etc.) with no observed evidence of
 * tripping this yet. Whitespace is then collapsed so a removed tag doesn't jam
 * adjacent words together — recall.mjs's own tail already does the same `\s+` -> ' ' normalization
 * separately; collapsing again here is idempotent, not a behavior change for text that never had a
 * tag in it (confirmed by recall-query-cap-test.mjs's existing byte-for-byte assertions).
 */
const HARNESS_TAG_RE = /<\/?[a-z][a-z0-9_-]*(?:\s[^<>]*)?>/g;
function stripHarnessMarkup(s) {
  return s.replace(HARNESS_TAG_RE, ' ').replace(/[ \t]+/g, ' ');
}

export function clampQuery(s) {
  const str = stripHarnessMarkup(String(s ?? ''));
  const charClamped = str.length > RECALL_QUERY_MAX_CHARS ? str.slice(0, RECALL_QUERY_MAX_CHARS) : str;
  if (Buffer.byteLength(JSON.stringify(charClamped), 'utf8') <= QUERY_MAX_BYTES) return charClamped; // fast path

  // BYTE-HEAVY CONTENT. Binary-search the largest prefix (by CODEPOINT — `Array.from` splits on
  // codepoints, never inside a surrogate pair, unlike a UTF-16 `.slice`) whose JSON-encoded form
  // fits the byte budget. O(n log n) worst case against at most RECALL_QUERY_MAX_CHARS codepoints —
  // fine at this size, and this path is rare (the fast path above covers ordinary ASCII-ish text).
  const cps = Array.from(charClamped);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = cps.slice(0, mid).join('');
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= QUERY_MAX_BYTES) lo = mid; else hi = mid - 1;
  }
  return cps.slice(0, lo).join('');
}
