/**
 * Candidate queue — append-only, per session.
 *
 * The distiller PROPOSES here; the agent DISPOSES here. Two writers, one file, and no locking:
 * that only works because this is an append log, never a read-modify-write. State is a FOLD over
 * the events, so there is no lost update and nothing to tear. (`state.mjs`'s mutable file needed
 * atomic writes to stop 33.7% torn reads and still can't stop lost updates — see `atomic.mjs`.
 * That is why the capture OFFSET lives here and not there: a rewound offset re-reads the arc,
 * which is the exact failure the delta gate exists to prevent.)
 *
 * Appends are atomic in practice: a small write to a file opened O_APPEND is not interleaved.
 * CAVEAT, and it is an assumption rather than a guarantee — which is why `append()` below
 * enforces `QUEUE_BODY_MAX_CHARS` (config.mjs) on `body`/`title` before writing: capture-worker
 * appends the model's `body` verbatim and the distiller prompt sets no length bound of its own
 * (the 220/110-char cuts elsewhere are display-only, not a source-side cap). Measured max body
 * 1,605c across the live corpus; the 4,000-char default is a deliberately conservative ceiling
 * under the figure this header used to cite informally (borrowed from POSIX PIPE_BUF, which
 * governs pipes, not regular files — so it was never a real guarantee either way). Truncating,
 * not rejecting: a shortened memory is still useful, a silently dropped candidate is not.
 *
 * EVENTS
 *   { op:'captured', at, offset }               — watermark: transcript chars distilled so far.
 *                                                 Monotonic by construction; the gate reads it.
 *   { op:'propose',  at, id, ...candidate }     — a NEW candidate.
 *   { op:'revise',   at, id, revises, ... }     — supersedes `revises` with a corrected claim.
 *                                                 Retires the old, pends the new. This is how a
 *                                                 later run fixes an earlier wrong claim (Zep's
 *                                                 t_invalid / Copilot's corrected-memory model)
 *                                                 instead of proposing a near-duplicate.
 *   { op:'dispose',  at, id, disposition, ref, resolved } — 'stored'|'documented'|'ignored'.
 *                                                 `ref` is the citation as TYPED; `resolved` is the
 *                                                 gate's own description of what it verified —
 *                                                 a root-relative path for `documented:`, and a
 *                                                 short phrase for the others ("record <id> verified
 *                                                 (memory)", "covered by <path>"). Present only when
 *                                                 it differs from `ref`; free text, not a key. The
 *                                                 fold reads neither — audit trail, not state.
 *                                                 Leaves the queue; never re-offered unless reopened.
 *   { op:'reopen',   at, id, why }              — UNDO a dispose: the candidate is pending again.
 *                                                 Only a DISPOSE is undone — a candidate superseded
 *                                                 by a `revise` stays gone, because resurrecting it
 *                                                 would re-offer a claim a later run already
 *                                                 CORRECTED. The two were one `gone` set; they are
 *                                                 different facts and are now tracked separately.
 *   { op:'handed',   at, toSid }                — an orphaned queue was SURFACED to a live session
 *                                                 for disposal. The claim that stops one dead
 *                                                 session's candidates reaching N agents at once;
 *                                                 it EXPIRES (see `handedAt`) so a session that
 *                                                 never settles them cannot strand them forever.
 *   { op:'swept',    at, residual }             — the stale-queue sweep flushed this
 *                                                 session's tail. NOT a watermark (the worker still
 *                                                 writes its own `captured`) and NOT a disposition;
 *                                                 it records that an EXTERNAL session took
 *                                                 responsibility for a done session's residue.
 *                                                 Two readers depend on it: the sweep skips a
 *                                                 session already flushed since its last Stop, and
 *                                                 the cross-session nudge surfaces the pending of
 *                                                 FLUSHED stale sessions only. → sweep.mjs.
 */
import fs from 'node:fs';
import { hlog } from './hooklog.mjs';
import { queueDir, queueFor } from './paths.mjs';
import { QUEUE_BODY_MAX_CHARS } from './config.mjs';

export const queuePath = queueFor;
export const DISPOSITIONS = new Set(['stored', 'documented', 'ignored']);

/**
 * Enforce QUEUE_BODY_MAX_CHARS on the two model-authored free-text fields, in place, at the one
 * chokepoint every writer goes through — a caller cannot forget the cap because it never sees an
 * uncapped write succeed. Only `body`/`title` are bounded (the fields the atomicity assumption is
 * actually about); everything else on an event is either short by construction (ids, enums) or
 * already capped by its own caller (e.g. dispose's `why`/`ref`).
 */
function capBody(ev) {
  const capped = { ...ev };
  for (const k of ['body', 'title']) {
    if (typeof capped[k] === 'string' && capped[k].length > QUEUE_BODY_MAX_CHARS) {
      capped[k] = capped[k].slice(0, QUEUE_BODY_MAX_CHARS) + '…[truncated]';
    }
  }
  return capped;
}

/** Append one event. Atomic; never throws (a hook must not break a turn). */
export function append(sessionId, ev) {
  try {
    fs.mkdirSync(queueDir(), { recursive: true });
    fs.appendFileSync(queuePath(sessionId), JSON.stringify({ at: new Date().toISOString(), ...capBody(ev) }) + '\n');
    return true;
  } catch { /* silence-ok: the `false` return IS the receipt, and it is now CHECKED — capture-worker logs the dropped append, dispose surfaces it to the agent. Logging here too would fire twice per lost event. */ return false; }
}

/**
 * Fold the log into current state.
 *   offset  — chars of transcript already distilled (0 if never). The delta gate's watermark.
 *   pending — candidates neither superseded nor disposed, oldest first.
 *   all     — every candidate ever proposed, by id (so a REVISE can cite what it corrects).
 *   handedAt / handedTo — ms epoch and recipient sid of the LAST `handed` event, or null. The
 *             orphan nudge's cross-session claim. → sweep.mjs `orphanedPending`.
 *   sweptAt — ms epoch of the LAST `swept` event, or null. The stale-queue sweep's "somebody
 *             already flushed this session's tail" marker. Null is the normal case for every live session.
 *   disposed / superseded — the two Sets `pending` is filtered by, exposed because `--reopen` must
 *             tell them apart (it may undo the first and must refuse the second). Present on EVERY
 *             return, including `fresh` and `corrupt`, so the shape never depends on the branch.
 *
 * A malformed line is skipped, not fatal: one bad append must not strand the whole queue.
 */
export function read(sessionId) {
  let lines = [];
  try {
    lines = fs.readFileSync(queuePath(sessionId), 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    /**
     * ENOENT is a FRESH queue and `offset: 0` is correct. Anything else is "can't tell", and
     * `offset: 0` is then catastrophic — this reader would rewind the watermark to zero, which is
     * the exact failure this module exists to prevent (see the header: "a rewound offset re-reads
     * the arc"). The offset was moved OUT of state.mjs for precisely this reason and then the new
     * home shipped the same defect in its own reader.
     *
     * Consequence of getting it wrong: one transient EACCES/EBUSY (an AV scanner holding the file,
     * EMFILE under concurrent hooks) => delta = total - 0 => the gate opens => the drain
     * re-distills the whole arc, and with `pending` also empty there are no priors, so every
     * already-disposed candidate is re-proposed as new. Silent, and expensive.
     *
     * So: fail CLOSED. Report `corrupt` and let the caller refuse to capture.
     */
    // The SAME SHAPE on every path — `disposed`/`superseded` included. A return whose fields depend
    // on which branch produced it makes every consumer guard (`q.disposed?.has`), and one that
    // forgets is a silent wrong answer. Same rule the sweep's `blocked` field was fixed for.
    const empty = (state) => ({ offset: 0, pending: [], all: new Map(), events: 0, sweptAt: null, handedAt: null, handedTo: null, disposed: new Set(), superseded: new Set(), dispositions: new Map(), state });
    if (e.code === 'ENOENT') return empty('fresh');
    hlog('queue', `READ FAILED (${e.code}) — refusing to report an offset; capture will skip this tick`, sessionId);
    return empty('corrupt');
  }

  let offset = 0;
  let sweptAt = null;
  let handedAt = null;
  let handedTo = null;
  /**
   * DISPOSED and SUPERSEDED were ONE `gone` set. They are different facts, and conflating them made
   * `reopen` unimplementable: undoing a dispose is right (a wrong `ignored` destroyed a true
   * candidate), while "undoing" a supersede would resurrect a claim a LATER run already corrected —
   * re-offering the known-wrong version of a candidate whose fix is sitting in the same queue.
   */
  const disposed = new Set();
  const superseded = new Set();
  /**
   * WHICH disposition, not just whether one happened — `disposed`/`superseded` above answer "is it
   * gone", which is all the fold needed until now. `report.mjs --compare` needs the actual value to
   * check it against the record corpus's own `disposition` field (the settle-side dual-write gap
   * closed 2026-08-14), and re-reading the file per candidate the way `dispose.mjs`'s local
   * `lastDisposition()` does would make that an O(n²) scan across a session's full queue on every
   * `--compare` run. One extra Map, same single pass, same pattern as `disposed`/`superseded`.
   */
  const dispositions = new Map();
  const all = new Map();
  let events = 0;
  let ord = 0; // candidate ids are POSITIONAL — see the propose/revise arm below

  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); }
    catch { /* silence-ok: one malformed line must not strand the whole queue (module header). Bounded: the fold still sees every WELL-FORMED event, so a torn append costs its own record and never the watermark — the invariant this file exists to protect. */ continue; }
    events++;
    if (e.op === 'captured') {
      // Monotonic: an out-of-order append must never rewind the watermark.
      if (typeof e.offset === 'number' && e.offset > offset) offset = e.offset;
    } else if (e.op === 'propose' || e.op === 'revise') {
      /**
       * THE ID IS POSITIONAL, AND THAT IS THE FIX FOR THE DUPLICATE-WORKER RACE.
       *
       * This was `all.set(e.id, e)` with the id MINTED by the worker via `nextId(all)` — a
       * read-modify-write over this very fold. Two workers on one snapshot both computed `c1`, both
       * appended, and last-write-wins here silently DESTROYED the first one's candidate. So the
       * module header's claim — "an append log, never a read-modify-write ... no lost update" — was
       * true of the EVENTS and false of the ID ALLOCATION, and a duplicate worker cost CANDIDATES
       * rather than mere spend. `lock.mjs` was guarding a race whose damage lived here.
       *
       * Note where the data actually was: BOTH events reached the log intact. `O_APPEND` did its
       * job. Only the fold conflated them. So the fix is not a better lock, a wider mutex or a
       * retry — it is to stop allocating from a shared mutable count at all.
       *
       * An append-only log has a total order. Use it: a candidate's id is its ORDINAL among
       * propose/revise events. Two concurrent workers cannot collide, because the log serialized
       * them the moment they appended — no coordination, nothing to race. `nextId` is deleted
       * rather than fixed; there is no allocator left to get wrong.
       *
       * STABLE, because appends only ever add AFTER: nothing renumbers an existing candidate, so
       * `revises`/`dispose` references stay valid, and `c3` is `c3` for the life of the session.
       * BACKWARD-COMPATIBLE, because the old allocator produced exactly these ordinals on any queue
       * that never collided — and on one that did, this recovers the candidate the fold was eating.
       * `e.id` is deliberately ignored: a value the writer cannot allocate safely is not a source of
       * truth. Now a duplicate worker costs SPEND (two similar candidates, both visible, both
       * disposable) and never a lost claim.
       */
      const id = `c${++ord}`;
      all.set(id, { ...e, id });
      if (e.op === 'revise' && e.revises) superseded.add(e.revises);
    } else if (e.op === 'dispose') {
      disposed.add(e.id);
      dispositions.set(e.id, e.disposition ?? null);
    } else if (e.op === 'reopen') {
      /**
       * UNDO A DISPOSE — and ONLY a dispose. A superseded candidate stays gone (see the sets'
       * declaration): its correction is already in this queue, and re-offering the version a later
       * run judged WRONG is the one outcome nobody wants from an undo.
       *
       * Reopening something that was never disposed is a harmless no-op here (`delete` on an absent
       * key), which is the right shape for a fold — `dispose.mjs` is where a pointless reopen is
       * REFUSED with a diagnosis, because that is where a human is reading the output.
       */
      disposed.delete(e.id);
      dispositions.delete(e.id);
    } else if (e.op === 'handed') {
      // LAST writer wins, and unlike `sweptAt` this one is NOT monotonic-guarded: a re-hand to a
      // different session after the claim expires is a legitimate, expected event, and the fold
      // must reflect the CURRENT holder rather than the first one.
      const t = Date.parse(e.at);
      if (Number.isFinite(t)) { handedAt = t; handedTo = e.toSid ?? null; }
    } else if (e.op === 'swept') {
      /**
       * MONOTONIC, like the watermark above, and for the same reason: an out-of-order or
       * clock-skewed append must not RETRACT the fact that a sweep happened. `sweptAt` gates
       * spend (the sweep refuses a session it already flushed) — moving it backwards would
       * re-authorize a second billed drain of text already read.
       *
       * The timestamp is read from `at`, the field `append()` stamps on every event, rather than
       * from a second field the writer would have to remember to set. An unparseable `at` yields
       * NaN, which fails `> sweptAt` and is therefore ignored — the event still counts as having
       * happened for anything reading `events`, but it cannot poison the clock.
       */
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && (sweptAt === null || t > sweptAt)) sweptAt = t;
    }
  }
  const pending = [...all.values()].filter((c) => !disposed.has(c.id) && !superseded.has(c.id));
  return { offset, pending, all, events, sweptAt, handedAt, handedTo, disposed, superseded, dispositions, state: 'ok' };
}

/**
 * Record that the transcript is distilled up to `offset`. Call ONLY after a window succeeds, and
 * ONLY with the offset that window actually reached (`sliceSince`'s `to`) — never the transcript
 * total. The watermark's meaning is "everything below this is distilled"; passing anything a call
 * did not read makes it a lie and silently buries that stretch forever. → capture-worker.mjs.
 */
export function markCaptured(sessionId, offset) {
  return append(sessionId, { op: 'captured', offset });
}

/**
 * Record that the stale-queue sweep flushed this session's tail. Call at the moment the flush is
 * AUTHORIZED (the worker spawned), not when it succeeds — and that is deliberate, so read on.
 *
 * The worker is detached and fire-and-forget: nothing observes its exit, so "mark on success" is
 * not available without inventing a completion channel. Given that, the choice is between marking
 * on spawn and not marking at all, and the failure modes are asymmetric:
 *
 *   mark on spawn, worker dies  → this idle episode is not retried. The residual STAYS VISIBLE in
 *                                 report.mjs (the watermark did not move — a failed distill holds
 *                                 it honestly), so the loss is measured, not silent, and a resumed
 *                                 session becomes eligible again the moment it Stops.
 *   don't mark, worker dies     → every sweep for the rest of that session's life re-spawns a
 *                                 distiller that fails the same way. An unbounded billed retry
 *                                 loop on a permanently broken transcript, discovered by the bill.
 *
 * One flush attempt per idle episode, and the instrument that shows what it cost. → sweep.mjs.
 */
export function markSwept(sessionId, residual) {
  return append(sessionId, { op: 'swept', residual });
}

/**
 * Claim an orphaned queue for ONE live session. → sweep.mjs `orphanedPending`, nudge.mjs.
 *
 * THE HOLE THIS CLOSES. `orphanedPending` sorts deterministically, so every live session with
 * nothing of its own pending computed the SAME `orphans[0]` and rendered the same block. The
 * guard that existed covered a LIVE session's queue; it did not cover ONE DEAD session's queue
 * reaching N live agents. That falsifies the invariant this subsystem asserts in three places —
 * *"two agents settling one queue is how a candidate gets disposed twice on two different
 * judgements, and the second judgement silently loses"* — and `dispose.mjs`'s idempotence does not
 * help: it prevents a duplicate APPEND, not two agents doing the verification work and racing to
 * opposite conclusions on a disposition that is final.
 *
 * IT EXPIRES ON PURPOSE. A claim with no TTL trades double-settlement for permanent stranding: the
 * claiming session can end without settling anything (it usually will — these are not its
 * candidates), and nothing would ever offer them again. The TTL lives with the reader
 * (`orphanedPending`), so the log records only the fact and the holder.
 *
 * IT IS A LARGE IMPROVEMENT, NOT AN ABSOLUTE ONE — said plainly, because the rest of this file
 * holds itself to that standard. There is a read-then-write window: `recall.mjs` reads the orphan
 * set when it computes the block and appends the claim when it delivers it. Nothing `await`s in
 * between, so the window is a few milliseconds of synchronous work rather than a round trip — but
 * two `UserPromptSubmit` hooks overlapping inside it could both render and both claim. What this
 * removes is the DETERMINISTIC case, where every idle session computed the same `orphans[0]` and
 * every one of them was handed the same queue; what remains is a race that needs two prompts to
 * land within milliseconds of each other. Closing it properly needs the per-session lock the sweep
 * uses, which is a heavier mechanism than a nudge warrants today.
 */
export function markHanded(sessionId, toSid) {
  return append(sessionId, { op: 'handed', toSid });
}
