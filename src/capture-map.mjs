/**
 * ONE distiller capture -> the two writes it becomes. Pure; no I/O, no clock, no randomness.
 *
 * WHY THIS IS ITS OWN FILE. The same proposal is written to two stores (queue file + spool ->
 * `candidate` record), and `report.mjs --compare` checks that those two AGREE. A mapping that
 * decides what each store gets is therefore the exact place a divergence would be born — and
 * inlined in `capture-worker.mjs` it would be unreachable by any test: the worker is a script whose
 * distiller cannot be faked on Windows (spawning a `.cmd`-shimmed binary there silently changes the
 * effective cwd out from under the fake, defeating the stub — see `drain-test.mjs`'s header).
 *
 * EVERYTHING VARIABLE IS AN ARGUMENT. `uuid` and `proposedAt` are injected rather than read from
 * `crypto`/`Date` here, so a test pins the output exactly instead of asserting around the parts
 * that move. The caller supplies the real ones. (`mintExternalId` is imported rather than
 * re-spelled: the key format has to match what the record client writes and looks up, and two
 * copies of a format string is one edit away from a corpus keyed two different ways.)
 */
import { mintExternalId } from './candidates.mjs';
// `kind` and `dest` are closed sets: the queue event and the record are normalised here, once, so they agree.
import { kindOf, destOf } from './candidate-fields.mjs';

/**
 * @param c          one entry from the distiller's `captures` array
 * @param sessionId  the proposing session
 * @param all        Map of ordinal (`c1`…) -> prior queue event, for resolving a REVISE target
 * @param offset     the transcript offset this window reached (recorded on the queue event)
 * @param uuid       the freshly minted uuid for this candidate
 * @param proposedAt YYYY-MM-DD, stamped NOW — see the note below
 */
export function mapCapture(c, { sessionId, all, offset, uuid, proposedAt, origin = 'session' }) {
  /**
   * A REVISE is only a revise if its target EXISTS. The distiller cites an ordinal it read from
   * the priors block, and a stale or hallucinated one would otherwise produce an event that
   * supersedes nothing while still being counted as a correction — the original claim would stay
   * pending forever with no visible reason. Unresolvable => it degrades to a plain proposal.
   */
  const isRevise = String(c.op || '').toUpperCase() === 'REVISE' && !!c.revises && all.has(c.revises);
  const externalId = mintExternalId(sessionId, uuid);

  /**
   * THE TWO STORES SPELL `revises` DIFFERENTLY, and translating between them is most of the reason
   * this function exists.
   *
   * The queue names candidates by their ORDINAL in its own append log (`c7`) — a number that means
   * nothing outside that one file. The record corpus keys on `externalId`, which is global. So the
   * queue event keeps the ordinal and the record gets the target's externalId, resolved here.
   *
   * NULL IS A REAL ANSWER, not a failure: a queue entry written before externalIds were minted has
   * no externalId, so a correction to it cannot cite a row that was never written. The correction
   * is still proposed — it just lands without the pointer, which is honest.
   */
  const revisesXid = isRevise ? (all.get(c.revises)?.externalId ?? null) : null;

  const ev = {
    op: isRevise ? 'revise' : 'propose',
    ...(isRevise ? { revises: c.revises } : {}),
    externalId,
    title: c.title, body: c.body, kind: kindOf(c.kind), area: c.area ?? null,
    tags: c.tags || [], sourceRef: c.sourceRef ?? null,
    dest: destOf(c.dest), // the distiller's SUGGESTION; the agent decides (it cannot write either tier)
    offset,
  };

  /**
   * `proposedAt` IS STAMPED AT SPOOL TIME, never at flush time — and the deploy gate guarantees
   * the difference will be days rather than seconds.
   *
   * `propose()` defaults the field to "today" when it is absent, which is right for a live write
   * and wrong for a recovered one: proposals made while the type was unprovisioned flush whenever
   * provisioning lands, so every one of them would be dated the day it SYNCED. That is the field
   * the review queue sorts on and range-queries by, so the whole backlog would land in one bogus
   * day, in the order it happened to drain.
   */
  const candidate = {
    title: c.title, body: c.body, kind: kindOf(c.kind),
    area: c.area ?? null, tags: c.tags || [], sourceRef: c.sourceRef ?? null,
    dest: destOf(c.dest),
    proposedAt,
    /**
     * WHICH PATH PROPOSED THIS: `origin: session|recovered` — a live session's own proposal versus
     * one recovered from a session that ended without settling.
     */
    origin,
    ...(revisesXid ? { revises: revisesXid } : {}),
  };

  return { isRevise, externalId, ev, candidate, digest: digestOf(candidate) };
}

/**
 * A stable fingerprint of the CLAIM — what `--compare` needs to verify content rather than presence.
 *
 * Comparing externalId sets proves a row exists; it cannot see a row that exists and is EMPTY. That
 * is not a hypothetical: `POST /v1/records` ignores unknown top-level keys, so sending `data`
 * instead of `payload` returns 200 and stores nothing, and the externalId — a top-level field —
 * lands regardless. A presence-only check would call that agreement.
 *
 * Only the fields that carry the claim: a reviewer's verdict (`disposition`, `ref`, `resolved`)
 * legitimately changes after the write, so including it would report every settled candidate as
 * divergent.
 */
export function digestOf(c) {
  const material = JSON.stringify([c.title ?? '', c.body ?? '', c.kind ?? '', c.sourceRef ?? '']);
  // FNV-1a — a few lines, no dependency, and collision resistance is not the property needed here:
  // this compares a value against ITSELF after a round trip, so any change to the bytes changes the
  // digest. A cryptographic hash would cost a `node:crypto` import for no additional guarantee.
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
