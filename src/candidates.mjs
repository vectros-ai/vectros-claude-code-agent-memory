/**
 * The candidate corpus, as Vectros records.
 *
 * A candidate is a memory the distiller PROPOSED and no agent has verified yet. Until it is
 * settled it must never be recalled as fact, which is why the `candidate` type is declared
 * `indexMode: NONE` — store-only, never indexed, unreachable by search under any query. That
 * separation is enforced by the platform, not by this file remembering to filter; verified
 * empirically against staging (design § 6.1).
 *
 * WHAT THIS MODULE IS. The transport and the contract — nothing else. It does not decide when to
 * propose, what is worth storing, or how a nudge reads. Those live in the callers, exactly as they
 * did when the corpus was a JSONL file, so this change is a storage swap and not a rewrite of the
 * loop.
 *
 * THREE CONTRACTS, all learned the hard way elsewhere in this tree:
 *
 *   1. `null` IS NOT `[]`. Every read returns `null` when it could not RUN and an array (possibly
 *      empty) when it did. `enumerate.mjs` documents why at length: a caller that cannot tell "no
 *      candidates" from "the API is down" will silently treat an outage as an empty queue, and the
 *      nudge — the ONLY thing that tells an agent candidates are waiting — simply never fires. No
 *      nudge looks exactly like no candidates. → this discipline's second half (missing is not the same as broken): missing is not broken.
 *
 *   2. A MISSING SCHEMA IS A CONFIGURATION STATE, NOT A FAULT. An adopter who has not provisioned
 *      the type, or this repo before the prod context is updated, gets `400 No schema found for
 *      type 'candidate'` on every single Stop. That is not an error to retry, it is an environment
 *      that cannot serve this feature yet, and the right response is to stop asking — quietly,
 *      cheaply, and self-healingly. See `schemaGap` below.
 *
 *   3. THE TWO ENDPOINTS DISAGREE ABOUT THEIR OWN FIELD NAMES, and one of them fails SILENTLY.
 *      `POST /v1/records` takes `typeName` + `payload` and IGNORES unknown keys; `POST
 *      /v1/records/lookup` takes `type` (not `typeName`) and REJECTS unknown keys with a 400.
 *      Sending `data` instead of `payload` therefore creates a record with an EMPTY payload and
 *      returns 200 — no error anywhere. That cost two full verification runs against staging: the
 *      records existed, the lookups returned nothing, and every "search cannot find it" assertion
 *      passed for the wrong reason. The shapes are centralised here so no caller can get them
 *      wrong twice.
 */
import fs from 'node:fs';
import { cred } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { candidateSchemaGapFile, verdictMutationsOffFile } from './paths.mjs';
import { CANDIDATE_TIMEOUT_MS, CANDIDATE_PAGE_LIMIT, CANDIDATE_MAX_PAGES, CANDIDATE_SCHEMA_RECHECK_MS } from './config.mjs';
// Imported from queue.mjs (and re-exported) rather than re-declared here — this file used to
// define its OWN `new Set(['stored','documented','ignored'])`,
// independently of queue.mjs's identical set. The two happened to agree, but nothing enforced it:
// a disposition value added to one without the other would let `dispose.mjs`'s CLI validation (via
// queue.mjs's set) silently diverge from `settle()`'s validation here against the actual record
// schema. One declaration, one place it can drift from. NOTE: `export { X } from './mod.mjs'` is a
// pure re-export — it does NOT bind `X` locally, so `settle()` below needs the real `import`.
import { DISPOSITIONS } from './queue.mjs';
export { DISPOSITIONS };

const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');

/** The record type. One spelling, so a typo cannot half-work. */
export const TYPE = 'candidate';

/**
 * THE SCHEMA GAP LATCH.
 *
 * Hooks are fresh processes, so this cannot be a module variable — it would be re-learned, and
 * re-paid, on every invocation. A file's mtime carries it across processes for the same reason
 * `creds.mjs` reads credentials from disk every time and `REAP_OFF` is a file rather than an env
 * var: the next hook is a new process and must see the state without a restart.
 *
 * Deliberately NOT permanent. Provisioning the schema must heal the loop on its own, without
 * anyone knowing there is a file to delete — so the marker expires and the next call after the TTL
 * simply tries again. Deleting it forces an immediate retry, which is the manual override.
 */
function schemaGapActive(now = Date.now()) {
  try {
    const age = now - fs.statSync(gapFile()).mtimeMs;
    /**
     * A NEGATIVE age counts as ACTIVE, and that is not defensive padding — it is the bug this
     * function shipped with.
     *
     * The guard was `age >= 0 && age < TTL`, on the reasoning that a future-dated marker is
     * nonsense. But `Date.now()` and a file's `mtimeMs` are two different clocks, and on Windows
     * the filesystem stamp can land AHEAD of the wall clock by a fraction of a millisecond:
     * measured `now - mtime = -0.234ms` on a file written on the line before. So the marker
     * written by `markSchemaGap` was read back as "not active" whenever that race went the wrong
     * way — SOMETIMES — and the latch silently failed to latch.
     *
     * The cost was exactly what the marker exists to prevent: an unprovisioned context paying a
     * failed round trip on every Stop (~2/min) instead of one an hour, flakily, so a
     * reproduction attempt would mostly show it working.
     *
     * Treating "ahead of the clock" as active is also the semantically right reading — a marker
     * stamped in the future is, if anything, MORE recent than one stamped now, and it expires on
     * its own regardless. Same family of bug as a fake clock racing a real mtime elsewhere in a
     * test harness — comparing a monotonic assumption against a wall-clock timestamp that isn't.
     */
    return age < CANDIDATE_SCHEMA_RECHECK_MS;
  } catch { /* silence-ok: no marker (ENOENT) is the normal case and means "go ahead". A stat that fails for any other reason must ALSO mean go ahead — failing closed here would disable the corpus on a transient FS error, which is the strictly worse direction. */ return false; }
}

/**
 * "Is the corpus currently unreachable because the type is not provisioned here?"
 *
 * Exported because the SPOOL must distinguish this from a per-entry failure. A missing schema is a
 * property of the ENVIRONMENT and applies to every write equally; charging it against an entry's
 * retry budget parks proposals for a reason that has nothing to do with them. → spool.mjs § flush.
 */
export const paused = () => schemaGapActive();

function markSchemaGap(detail) {
  try {
    fs.writeFileSync(gapFile(), `${new Date().toISOString()} ${detail}\n`);
  } catch { /* silence-ok: the marker is an OPTIMISATION (it bounds retry cost), not a correctness device. Failing to write it costs repeated 400s, which is what the un-marked path already does — it cannot cause a wrong answer. */ }
}

/**
 * THE LATCH IS PER-CONTEXT, keyed by the API base URL.
 *
 * It was one global file, which encodes "the type is missing" without recording WHERE it was
 * missing. Point the same runtime home at staging and then at production — which is exactly what
 * verifying a deploy involves — and one environment's gap silently disables the corpus for the
 * other for up to an hour, in a subsystem whose whole failure mode is being quiet.
 */
export const gapFile = () => {
  const base = candidateSchemaGapFile();
  // A short stable digest of the base URL, not the URL itself: it becomes a filename.
  let h = 0x811c9dc5;
  for (let i = 0; i < BASE.length; i++) { h ^= BASE.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${base}.${h.toString(16).padStart(8, '0')}`;
};

/** Does this look like "the type is not provisioned here", as opposed to a real failure? */
function isMissingSchema(status, bodyText) {
  return status === 400 && /no schema found for type/i.test(bodyText || '');
}

/**
 * One API call, with the receipt contract. Returns `{ ok, data }` on success and `null` on any
 * failure — never a half-answer.
 *
 * `fetchImpl` is injectable so the suite can exercise every branch (timeout, 400-missing-schema,
 * 5xx, malformed body) without a network or a provisioned schema. That matters more than usual
 * here: the type does not exist in production yet, so a test that needed the real store could not
 * run at all until a deploy that is itself gated on this code being right.
 */
/**
 * WHY A FAILURE HAPPENED, for the one caller that must not treat them alike.
 *
 * `null` stays the answer every caller sees — contract 1 is unchanged. But the SPOOL has to
 * decide whether to spend an entry's retry budget, and that decision is wrong unless it can tell
 * "this proposal is malformed" from "the store is unreachable". Flattening both to `null` is what
 * made a three-minute outage park a whole spool.
 *
 *   'rejected'      — the STORE refused THIS entry (validation, 4xx that is not auth or 429). Charge
 *                     it: the same bytes will be refused forever, which is exactly what a budget is
 *                     for.
 *   'auth'          — 401/403. A property of the CREDENTIAL, not the entry.
 *   'rate-limited'  — 429. A property of the WINDOW, not the entry — the same bytes would succeed a
 *                     minute later. Falling through to `rejected` here is what let a busy drain
 *                     (SPOOL_FLUSH_MAX_PER_RUN x SPOOL_DRAIN_MAX_SESSIONS, up to dozens of calls in
 *                     quick succession) permanently PARK real candidates after SPOOL_MAX_ATTEMPTS,
 *                     for a reason no proposal caused and no retry-of-the-same-bytes could fix.
 *   'schema-absent' — the type is not provisioned here. A property of the ENVIRONMENT.
 *   'unreachable'   — 5xx, timeout, DNS, offline. A property of the MOMENT.
 *   'no-key'        — no credential at all.
 *
 * Only `rejected` is chargeable. Everything else applies identically to every entry in the batch,
 * so charging it punishes proposals for something none of them did.
 */
export const CHARGEABLE = new Set(['rejected']);

async function call(path, body, { fetchImpl = fetch, what = 'call', method = 'POST', fail = null } = {}) {
  const why = (reason) => { if (fail) fail.reason = reason; return null; };
  const key = cred('VECTROS_API_KEY');
  // UNRUNNABLE, not empty — same reason enumerate.mjs refuses to answer `[]` without a key.
  if (!key) {
    /**
     * THIS WAS SILENT, and silence here is the worst case in the whole module: with no key every
     * write fails, the spool charged each one, and the entire corpus parked over a few hours with
     * NOTHING in the log naming the cause. A missing credential is the single most likely reason a
     * fresh machine or a partial deploy produces no candidates at all, so it says so.
     */
    hlog('candidates', `${what}: NO VECTROS_API_KEY — the candidate corpus is unreachable and nothing will sync `
      + '(this is a configuration state, not a failure of any proposal; no retry budget is spent)');
    return why('no-key');
  }
  if (schemaGapActive()) return why('schema-absent');

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CANDIDATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* silence-ok: the status is the receipt; an unreadable error body does not make it less true. */ }
      if (isMissingSchema(res.status, text)) {
        // NOT an error — an environment that cannot serve this yet. Log ONCE per TTL (the marker
        // suppresses the next attempt entirely), so an unprovisioned context costs one line an
        // hour instead of one per Stop. The wording says what to DO, because whoever reads this
        // line is the person who can fix it.
        markSchemaGap(`${what}: ${res.status}`);
        hlog('candidates',
          `type '${TYPE}' is NOT PROVISIONED in this context — candidate calls are paused for `
          + `${Math.round(CANDIDATE_SCHEMA_RECHECK_MS / 60_000)}min. Provision the '${TYPE}' and `
          + `'memory' record schemas in this store (or delete ${gapFile()} to retry now).`);
        return why('schema-absent');
      }
      let requestId = null;
      try { requestId = JSON.parse(text)?.requestId ?? null; } catch { /* silence-ok: not every error body is the JSON contract (a WAF block is HTML) */ }
      const cfId = typeof res.headers?.get === 'function' ? (res.headers.get('x-amz-cf-id') || '(none)') : '(none)';
      /**
       * THE CLASSIFICATION, and the 401/403/429 splits are the ones that were missing.
       *
       * A 4xx normally means the STORE looked at this body and refused it — the same bytes fail
       * forever, so the retry budget is exactly right. But 401/403 describe the CREDENTIAL (a
       * rotated or revoked key refuses every entry identically) and 429 describes the WINDOW (the
       * same bytes succeed once the limit resets) — neither is a property of this entry's bytes,
       * so charging either parks the whole corpus for a reason no proposal caused and no retry of
       * the same body could fix.
       */
      const reason = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate-limited'
        : (res.status >= 400 && res.status < 500) ? 'rejected'
        : 'unreachable';
      hlog('candidates',
        `${what} HTTP ${res.status} [${reason}] — UNRUNNABLE (returning null, not an empty set) `
        + `cfId=${cfId} requestId=${requestId ?? '(null)'}${text ? `: ${text.slice(0, 200)}` : ''}`);
      return why(reason);
    }
    let j = null;
    try { j = await res.json(); } catch {
      hlog('candidates', `${what} returned an unparseable body — UNRUNNABLE (returning null)`);
      // The write may well have LANDED — an unreadable response says nothing about the server's
      // state. Not chargeable: the externalId makes a retry an upsert, so retrying is free and
      // giving up would abandon a proposal that might already be stored.
      return why('unreachable');
    }
    return { ok: true, data: j };
  } catch (e) {
    const detail = e?.name === 'AbortError' ? `timeout after ${CANDIDATE_TIMEOUT_MS}ms` : (e?.code || e?.message || 'error');
    hlog('candidates', `${what} FAILED (${detail}) [unreachable] — UNRUNNABLE (returning null, not an empty set)`);
    return why('unreachable');
  } finally { clearTimeout(to); }
}

/**
 * Read a payload field defensively. Record shapes nest differently across endpoints (`payload` on
 * a create response, sometimes flattened on a lookup page), and a client that assumes one shape
 * reads `undefined` on the other — silently, since `undefined` is a legal value everywhere.
 */
export const field = (rec, name) =>
  rec?.payload?.[name] ?? rec?.data?.[name] ?? rec?.fields?.[name] ?? rec?.[name] ?? undefined;

/** Everything a caller needs to address a candidate again, normalised across response shapes. */
function normalise(rec) {
  return {
    id: rec?.id ?? rec?.recordId ?? null,
    // SERVER-ASSIGNED, millisecond precision, true creation order — the ordering key. Verified
    // present on every lookup row against staging; it is NOT a payload field, so `field()` would
    // not find it.
    createdAt: rec?.createdAt ?? null,
    externalId: rec?.externalId ?? field(rec, 'externalId') ?? null,
    title: field(rec, 'title') ?? '',
    body: field(rec, 'body') ?? '',
    kind: field(rec, 'kind') ?? null,
    sessionId: field(rec, 'sessionId') ?? null,
    proposedAt: field(rec, 'proposedAt') ?? null,
    disposition: field(rec, 'disposition') ?? null,
    ref: field(rec, 'ref') ?? null,
    resolved: field(rec, 'resolved') ?? null,
    origin: field(rec, 'origin') ?? null,
    // WRITTEN BY `reopen` AND, UNTIL RECENTLY, NEVER READ BACK. Verified against staging: the
    // platform stores it fine; this projection just did not list it, so the audit trail for undoing
    // a verdict was write-only and every consumer read `undefined` with no error anywhere. That is
    // the failure mode of a hand-maintained projection — see the census test in candidates-test.
    reopenedWhy: field(rec, 'reopenedWhy') ?? null,
    revises: field(rec, 'revises') ?? null,
    supersededBy: field(rec, 'supersededBy') ?? null,
    // The proposal's own metadata, carried through unchanged. `dest` and `sourceRef` are
    // RENDERED (the nudge line and `dispose --list`), so dropping them here would quietly
    // strip the review surface the moment reads flip to records; `area` and `tags` are the
    // fields a verified candidate is copied into a memory with. → the schema mirrors `memory`.
    dest: field(rec, 'dest') ?? null,
    area: field(rec, 'area') ?? null,
    tags: field(rec, 'tags') ?? [],
    sourceRef: field(rec, 'sourceRef') ?? null,
  };
}

/**
 * ORDER IS DERIVED, NEVER ALLOCATED — and that is a fix carried forward, not a preference.
 *
 * The file-backed queue numbered candidates by their ORDINAL in an append log, because the
 * previous scheme minted ids from a shared mutable count: two concurrent workers both computed
 * `c1` and the fold silently destroyed one of them. An `externalId`-keyed upsert would reintroduce
 * exactly that if the id were derived from a count of what already exists.
 *
 * So nothing allocates. The worker mints a uuid before its first write attempt (which is also what
 * makes a retry idempotent — the same externalId upserts instead of duplicating), and the display
 * ordinal is computed HERE by sorting.
 *
 * THE SORT KEY IS THE SERVER'S `createdAt`, and the first version of this was not stable — which
 * matters because an ordinal is an ADDRESS: `dispose.mjs <sessionId> c2=stored:…` is how an agent
 * acts on a nudge, one turn after reading it.
 *
 * It sorted on `proposedAt` (a `date` field — DAY-granular) with the random uuid as tiebreak. So
 * within a day the order was arbitrary, and a candidate proposed later could sort BEFORE an earlier
 * one, shifting every ordinal after it. MEASURED: A was `c2`, became `c3` when C arrived, and `c2`
 * again once B was settled. An agent settling `c2` a turn later settles a different candidate.
 *
 * `createdAt` is server-assigned at millisecond precision in true creation order — verified present
 * on every lookup row against staging. `proposedAt` cannot serve: the platform REJECTS a full ISO
 * timestamp in a `date` field (400, verified), and day granularity is the right shape for the range
 * query it exists for. The remaining tiebreaks only run for rows created in the same millisecond,
 * where both already exist, so the order is stable from then on.
 *
 * NUMBER OVER THE WHOLE SESSION, never a filtered subset — the second half of the same bug. The
 * queue numbered positionally over ALL propose/revise events, so a settled candidate KEPT its slot
 * and `c3` was `c3` for the life of the session. Numbering a filtered set renumbers everything
 * after each settle. That is why `bySession` (settled included) assigns ordinals and `pending`
 * does not.
 */
export function withOrdinals(recs) {
  return [...recs]
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
      || String(a.proposedAt ?? '').localeCompare(String(b.proposedAt ?? ''))
      || String(a.externalId ?? '').localeCompare(String(b.externalId ?? '')))
    .map((c, i) => ({ ...c, ordinal: `c${i + 1}` }));
}

/** A candidate's stable key. Minted BEFORE the first write so a retry upserts. */
export const mintExternalId = (sessionId, uuid) => `${sessionId}:${uuid}`;

/**
 * Create a proposal. `revises` (an externalId) marks it as a CORRECTION of an earlier claim.
 *
 * Returns the normalised record, or `null` if the write could not run. The caller checks — a
 * dropped proposal that nobody notices is a lost lesson, which is the whole failure this
 * subsystem exists to prevent.
 */
export async function propose(sessionId, c, opts = {}) {
  const payload = {
    title: c.title,
    body: c.body,
    kind: c.kind,
    sessionId,
    proposedAt: c.proposedAt || new Date().toISOString().slice(0, 10),
    disposition: 'pending',
    origin: c.origin || 'session',
  };
  if (c.revises) payload.revises = c.revises;
  /**
   * OMITTED WHEN ABSENT, never sent as `null`.
   *
   * The distiller emits `area`/`sourceRef` as "a string or null" and `dest` only sometimes,
   * so a straight copy would write explicit nulls into an upserted record. That is not the
   * same as leaving the field unset: this is an UPSERT, so a null overwrites whatever a
   * previous attempt stored, and a retry carrying a null would erase a good value the first
   * attempt landed. `tags` is dropped when empty for the same reason.
   */
  if (c.dest) payload.dest = c.dest;
  if (c.area) payload.area = c.area;
  if (c.sourceRef) payload.sourceRef = c.sourceRef;
  if (Array.isArray(c.tags) && c.tags.length) payload.tags = c.tags;
  // `typeName` + `payload` — see contract 3 in the header. `data` here returns 200 and stores
  // nothing.
  const r = await call('/v1/records?upsert=true',
    { typeName: TYPE, externalId: c.externalId, payload },
    { ...opts, what: 'propose' });
  return r ? normalise(r.data) : null;
}

/**
 * Partial update, by record ID. → `PATCH /v1/records/{id}` (RFC 7386 JSON Merge Patch).
 *
 * VERIFIED AGAINST STAGING, because every part of this was wrong when written from intuition:
 *   - the endpoint is `PATCH /v1/records/{id}`; there is no `/v1/records/update`;
 *   - the merge object is `payload`, and it DEEP-MERGES — keys omitted are left untouched, so a
 *     verdict update cannot erase the claim it is settling (the full-replacement `PUT` would);
 *   - `typeName` is IMMUTABLE and sending it is a hard `400 Field 'typeName' cannot be patched`,
 *     which is why — unlike every other call here — this one does not name the type.
 *
 * BY ID, NOT externalId, and that is a deliberate ergonomic trade. A lookup CAN resolve an
 * externalId (checked: `field: 'externalId'` returns the row), but every caller that settles
 * already holds the record it is settling — it came from `pending()` or `bySession()` — so taking
 * the id keeps the common path at one round trip instead of two.
 */
/**
 * Is a VERDICT MUTATION switched off here? `SPOOL_OFF`'s sibling for the other path that reaches
 * the live store with a real credential. `settle`/`reopen`/`markSuperseded` (every caller of
 * `patch()`, which is why the gate lives here and not duplicated three times) had no equivalent —
 * they relied entirely on every test remembering to inject its own transport, the exact
 * "incidentally safe, not structurally safe" shape `SPOOL_OFF` exists to replace elsewhere in this
 * tree (a real gap, closed here).
 */
function verdictMutationsDisabled() {
  if (process.env.VECTROS_MEM_VERDICT_MUTATIONS_OFF === '1') return 'VECTROS_MEM_VERDICT_MUTATIONS_OFF';
  try { return fs.existsSync(verdictMutationsOffFile()) ? 'VERDICT_MUTATIONS_OFF file' : false; }
  catch { /* silence-ok: an unreadable home cannot be read as "switched off" — fails open, matching spoolDisabled()'s own reasoning. */ return false; }
}

async function patch(id, payload, what, opts = {}) {
  const off = verdictMutationsDisabled();
  if (off) { hlog('candidates', `${what}: refusing — verdict mutations are switched off (${off})`); return null; }
  if (!id) { hlog('candidates', `${what}: refusing to patch without a record id`); return null; }
  const r = await call(`/v1/records/${encodeURIComponent(id)}`, { payload },
    { ...opts, what, method: 'PATCH' });
  return r ? normalise(r.data) : null;
}

/**
 * Settle a candidate: `stored` | `documented` | `ignored`, with the citation as TYPED (`ref`) and
 * what the gate actually VERIFIED (`resolved`) kept separately — a bad citation stays auditable
 * instead of being indistinguishable from a good one.
 */
export async function settle(id, disposition, { ref = null, resolved = null } = {}, opts = {}) {
  if (!DISPOSITIONS.has(disposition)) {
    // Refuse rather than write: an unknown disposition would pass schema validation only to make
    // the pending filter wrong forever, and a candidate stuck in an unrecognised state is worse
    // than one still pending.
    hlog('candidates', `refusing to settle ${id} with unknown disposition '${disposition}'`);
    return null;
  }
  /**
   * OMIT WHAT WAS NOT GIVEN — `propose` states this rule and `settle` broke it.
   *
   * This is a JSON Merge Patch: a member set to `null` is REMOVED, not ignored. Sending
   * `{ ref: null, resolved: null }` on every settle therefore deleted whatever a previous settle
   * (or a reopen-then-resettle) had stored, and `reopen` compounded it from the other side by
   * sending neither — so a reopened candidate kept the `ref` of the verdict just undone.
   */
  const verdict = { disposition };
  if (ref !== null && ref !== undefined) verdict.ref = ref;
  if (resolved !== null && resolved !== undefined) verdict.resolved = resolved;
  return patch(id, verdict, 'settle', opts);
}

/**
 * UNDO a settle — and only a settle.
 *
 * A SUPERSEDED candidate stays gone: its correction is already in the corpus, and resurrecting the
 * version a later run judged wrong is the one outcome nobody wants from an undo. That is why
 * supersession is a separate field rather than a disposition value — folding them into one enum
 * would make this refusal unrepresentable exactly when it matters. The refusal itself lives in the
 * caller, which is where a human is reading the output; this function is the mechanism.
 */
export async function reopen(id, why, opts = {}) {
  /**
   * `ref`/`resolved` are EXPLICITLY cleared — the one place a null is correct here.
   *
   * They describe the verdict being undone. Leaving them attached to a candidate that is pending
   * again presents a citation for a conclusion no longer held, which is worse than none: the next
   * reviewer reads it as evidence already gathered. Under merge-patch semantics `null` removes
   * the member, which is exactly the intent.
   */
  return patch(id, { disposition: 'pending', reopenedWhy: why || '', ref: null, resolved: null }, 'reopen', opts);
}

/**
 * `settle`/`reopen`, addressed by `externalId` instead of a record `id` — the reverse-lookup
 * shape `supersedeByExternalId` above already established for the same reason: `dispose.mjs`
 * knows a candidate's `externalId` (carried through from the queue event `capture-map.mjs`
 * stamped it into) but not its record `id`, and there is no reverse-reference read, so the id is
 * resolved by looking the externalId up first.
 *
 * WHY THIS EXISTS AT ALL — same shape of gap as `supersedeByExternalId`'s own header describes,
 * on the OTHER direction: `dispose.mjs` settles/reopens candidates in the local file queue and,
 * until now, NOTHING wrote the matching record's `disposition` — `settle()`/`reopen()` above were
 * fully built and tested and had zero production callers. A candidate settled via the file queue
 * stayed `disposition: 'pending'` in the record corpus forever, so any reader trusting records
 * would show it as still open indefinitely. Surfaced by exactly the
 * question this file's own `pendingForSession` comment poses ("when reads flip to records...").
 */
export async function settleByExternalId(externalId, disposition, verdict = {}, opts = {}) {
  if (!externalId) return null;
  const rows = await lookup({ field: 'externalId', value: externalId }, opts);
  if (rows === null) return null;                 // unrunnable — the caller retries
  if (!rows.length) return { missing: true };      // predates dual-write, or never synced — not an error
  return settle(rows[0].id, disposition, verdict, opts);
}

// No `reopenByExternalId` counterpart: every real reopen path (dispose.mjs's own `--reopen`) is
// driven by a human typing a `cN` ordinal, which resolves through `bySession`/`reopen(id, ...)`
// above — never through a bare externalId the way an automated settle-path caller (like
// orphan-cap-worker.mjs) does. Add it back, mirroring settleByExternalId exactly, if a real
// externalId-addressed reopen caller shows up.

/** Mark an older candidate as corrected by a newer one. */
export async function markSuperseded(id, bySupersedingExternalId, opts = {}) {
  return patch(id, { supersededBy: bySupersedingExternalId }, 'markSuperseded', opts);
}

/**
 * Mark the candidate with `targetExternalId` as corrected by `byExternalId`.
 *
 * WHY THIS EXISTS AT ALL — the reverse half of a correction was written by NOTHING in production.
 * `capture-map` writes the forward `revises` pointer on the NEW record; `pending()` filters on
 * `supersededBy` on the OLD one; and the only writer of that field was `markSuperseded`, whose
 * sole caller was a test. So the queue fold retired a corrected claim and the record corpus did
 * not — and at Phase B every candidate ever revised would have re-entered the review queue, with
 * the corpus already full of the un-marked backlog Phase A is busy accumulating. `--compare` is
 * structurally blind to it: both stores hold the same externalIds.
 *
 * TWO ROUND TRIPS, and the first one is why this is not folded into `patch`. The corrector knows
 * its target's `externalId`; `PATCH` addresses a record by `id`. There is no reverse-reference
 * read, which is precisely the reason the schema carries this field rather than deriving it — so
 * the id is resolved by looking the externalId up.
 */
export async function supersedeByExternalId(targetExternalId, byExternalId, opts = {}) {
  if (!targetExternalId || !byExternalId) return null;
  const rows = await lookup({ field: 'externalId', value: targetExternalId }, opts);
  if (rows === null) return null;                 // unrunnable — the caller retries
  // NOT an error, and not retryable either: the target predates the cutover (a historical-queue
  // backfill gives it a row) or was never synced. Reported as done so it stops occupying a retry budget.
  if (!rows.length) return { missing: true };
  return markSuperseded(rows[0].id, byExternalId, opts);
}

/**
 * Look up by ONE field.
 *
 * ⚠ THIS USED TO SAY "the only shape the store offers", AND THAT IS NO LONGER TRUE. The backend
 * has since added CONJUNCTIVE lookups: a schema can declare `{ fieldNames: ['a','b'] }`, the
 * identity travels as a scalar `field=a,b`, and the tuple rides an optional `values[]`.
 *
 * One field is still the only shape THIS CLIENT SENDS, and the first reason is structural rather
 * than a lag:
 *
 *   1. **A COMPOSITE MUST BE DECLARED AS ONE.** `values` works only against a lookup the SCHEMA
 *      declared over several fields together (`fieldNames: [...]`). You CANNOT combine two
 *      independently-declared single-field lookups by comma-joining `field` — and `candidate`
 *      declares `disposition` and `sessionId` separately. So there is no composite here to query,
 *      whatever the client can send.
 *   2. the declaration is migration-locked and costs one of `MAX_LOOKUP_FIELDS` (10) permanently,
 *      so adding one is a deliberate per-schema choice, not a free upgrade.
 *   3. as of writing, not every consumer in this ecosystem can even AUTHOR a composite
 *      declaration or emit the wire shape yet — treat this reason as expiring, unlike (1).
 *
 * Left as a single-field call on purpose. Recorded here because the CLAIM was load-bearing in
 * three places on this branch and the platform falsified it from outside while the branch sat —
 * nothing in this file would ever have re-checked it on its own. The lesson: an "impossible"
 * premise embedded in a design comment is never automatically re-verified when the platform it
 * describes changes out from under it — re-check it explicitly before trusting it again.
 *
 * `type`, NOT `typeName` (contract 3). This endpoint rejects unknown keys, so the wrong spelling
 * 400s loudly rather than silently — the opposite of the create path, and the reason both spellings
 * live in this file and nowhere else.
 */
async function lookup(body, opts) {
  /**
   * PAGINATED — because the page cap is BELOW the population this is meant to enumerate.
   *
   * `pending()` claims "every UNSETTLED candidate, across all sessions" and `bySession()` claims
   * "one session's candidates, settled ones included". Both read one page of at most
   * `CANDIDATE_PAGE_LIMIT` (100, the API maximum) and returned. Past 100 the review queue silently
   * dropped its tail — and worse, `withOrdinals` renumbered `c1…cN` over whichever subset came
   * back, so the ids an agent was nudged with addressed different candidates on the next run.
   * `--compare` would have called every candidate past page 1 `unspooled`, i.e. the counter it
   * labels "should be 0", turning the Phase A exit criterion into a false-alarm generator at
   * exactly the scale it exists to certify. Latent at today's ~62; not latent for long.
   */
  const out = [];
  let cursor;
  for (let page = 0; page < CANDIDATE_MAX_PAGES; page++) {
    const r = await call('/v1/records/lookup',
      // `includePayload` is passed EXPLICITLY even though this type's rows come back hydrated
      // today. A payload of 4KB or more is externalized to object storage, and a page that
      // silently returns the indexed projection instead would leave every payload field
      // `undefined` — a candidate with no body, which reads as an empty queue rather than an
      // error. Nothing caps a candidate body, so that is one long proposal away.
      //
      // The resume field is `startFrom`, NOT `cursor` — the guessable name a prior version of
      // this file sent. `/v1/records/lookup` rejects unknown keys (contract 3 above), so the
      // wrong spelling 400s, but only once a corpus exceeds one page: `cursor` is falsy and
      // omitted entirely on page 1, so the defect shipped invisibly until a real queue grew past
      // `CANDIDATE_PAGE_LIMIT`. ECHO the value the previous page handed back in `nextCursor` —
      // never derive one from a row — the cursor is opaque and authenticated server-side; a
      // fabricated one fails verification with its own 400.
      { type: TYPE, limit: CANDIDATE_PAGE_LIMIT, includePayload: true, ...body, ...(cursor ? { startFrom: cursor } : {}) },
      opts);
    if (!r) return null;
    const rows = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : null);
    // A non-array page is a malformed response, not an empty set. Same rule as enumerate.mjs.
    if (!rows) return null;
    out.push(...rows.map(normalise));
    cursor = r.data?.nextCursor ?? null;
    if (!cursor) return out;
  }
  /**
   * The bound was hit and a cursor remains, so this answer is INCOMPLETE — and an incomplete
   * enumeration must not be returned as if it were whole. `null` is the module's "could not run",
   * which every caller already handles by refusing to act rather than acting on a partial set.
   */
  hlog('candidates', `lookup exceeded ${CANDIDATE_MAX_PAGES} pages and a cursor remains — refusing to `
    + 'return a TRUNCATED enumeration (raise VECTROS_MEM_CANDIDATE_MAX_PAGES if the corpus is really this large)');
  return null;
}

/**
 * Every UNSETTLED candidate, across all sessions — the review queue in one indexed call.
 *
 * This is the flexibility the move buys. The file-backed version answered the same question by
 * listing the queue directory and folding all 62 files on EVERY prompt; here it is one lookup on
 * an indexed field.
 *
 * PENDING IS TWO CONDITIONS, and only one of them is a lookup. A candidate is open when its
 * disposition is `pending` AND nothing has superseded it, so the supersession half is filtered
 * client-side.
 *
 * ⚠ THE REASON THIS COMMENT USED TO GIVE — "a lookup matches a single field … the general gap is
 * tracked at the platform level" — IS DEAD. That gap has since been closed; conjunctive lookups
 * exist now. The client-side filter is still right, for a reason that does not expire:
 *
 *   `supersededBy` is an ABSENCE predicate. Every lookup leg — plain or composite — matches an
 *   exact PRESENT value: the composite wire form is a positional `values[]` of strings, and the
 *   backend rejects a sparse list with a 400 rather than treating a gap as a wildcard. A record
 *   missing a leg does get its own presence flag in the key, but the surface exposes no way to
 *   ASK for that group. So "disposition=pending AND supersededBy is unset" is not a conjunction
 *   the index can serve, however many legs it grows.
 *
 *   NOT probed — read off the documented wire contract. An earlier draft of this comment also
 *   cited a specific deployed tool's shape as evidence, which was true when written and false
 *   within hours: that tool shipped composite support shortly after. Deleted rather than
 *   corrected, because the deployed-tool-shape citation was never load-bearing and was always
 *   going to rot; the wire contract is the durable one — the platform's own state had moved
 *   during the session, underscoring the point above about never trusting an unrenewed
 *   "impossible" premise.
 *
 * The cheapness argument still holds independently: the pending set is small and `disposition` is
 * the selective leg.
 */
export async function pending(opts = {}) {
  const rows = await lookup({ field: 'disposition', value: 'pending' }, opts);
  if (rows === null) return null;
  /**
   * NO ORDINALS HERE, deliberately — and that is a correctness point, not a simplification.
   *
   * An ordinal is a SESSION-SCOPED address (`dispose.mjs <sessionId> c2=…`). This lookup spans
   * every session, so numbering it `c1…cN` produces labels that look like addresses and are not:
   * `c2` in a cross-session list is a different candidate from `c2` in its own session. A caller
   * that needs the address resolves it with `bySession`, which numbers the population the address
   * is defined over.
   *
   * Sorted, though, so the review queue still reads oldest-first.
   */
  return rows.filter((c) => !c.supersededBy)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
      || String(a.externalId ?? '').localeCompare(String(b.externalId ?? '')));
}

/** One session's candidates, settled ones included — what `--list` and a revise both need. */
export async function bySession(sessionId, opts = {}) {
  const rows = await lookup({ field: 'sessionId', value: sessionId }, opts);
  return rows === null ? null : withOrdinals(rows);
}

/**
 * ONE session's UNSETTLED candidates — the composite lookup, and the hottest read here.
 *
 * This is what the nudge asks on EVERY prompt: `recall.mjs` reads `readQueue(sessionId)` and
 * renders "MEMORY CANDIDATES (n pending) — from THIS session's transcript". Phase A answers it
 * from the queue file; when reads flip to records, this is the call that replaces it, and it is
 * the reason `candidate` spends a declaration on `{ fieldNames: ['sessionId','disposition'] }`.
 *
 * NOT `bySession(...).filter(...)`. The difference is not tidiness — the filtered-out rows are
 * every candidate the session ever SETTLED, which is unbounded in the session's lifetime while
 * the pending set is small. Paging the settled history on every prompt to discard it is exactly
 * the read the composite exists to avoid.
 *
 * ORDINALS ARE ASSIGNED, unlike `pending()`: this population IS one session, so `c1…cN` are real
 * addresses for `dispose.mjs <sessionId> cN=…`. But they are numbered over the UNSETTLED subset,
 * which is NOT the population `bySession` numbers — so an ordinal from here and an ordinal from
 * `--list` are different addresses for the same `cN`. Callers that print an address for a human
 * to type must use `bySession`; this one is for counting and rendering the queue.
 *
 * The `supersededBy` filter stays client-side and always will: it is an ABSENCE predicate, and no
 * lookup leg matches absence (see `lookup` above). That is why it is not a third leg.
 */
export async function pendingForSession(sessionId, opts = {}) {
  const rows = await lookup(
    { field: 'sessionId,disposition', values: [sessionId, 'pending'] },
    opts,
  );
  if (rows === null) return null;
  return withOrdinals(rows.filter((c) => !c.supersededBy));
}

/** Candidates proposed in a date window — the queue worked by AGE (oldest first). */
export async function proposedBetween(from, to, opts = {}) {
  const rows = await lookup({ field: 'proposedAt', from, to }, opts);
  return rows === null ? null : withOrdinals(rows);
}

/**
 * ONE session's pending candidates, with STABLE addresses — what `dispose.mjs` and the live nudge
 * both need since the full flip to records-driven addressing.
 *
 * Built on `bySession`, deliberately NOT `pendingForSession`. `pendingForSession`'s own header
 * already warns why: its ordinals are assigned over the UNSETTLED SUBSET, which shrinks as
 * candidates settle, shifting every ordinal after each one — "callers that print an address for a
 * human to type must use `bySession`; this one is not for addresses." `bySession` numbers ALL of a
 * session's candidates ever, settled included, so `c2` stays `c2` for the life of the session even
 * after `c1` settles — the exact guarantee the file-backed queue gave (`queue.mjs`'s own "NUMBER
 * OVER THE WHOLE SESSION, never a filtered subset" fix), now sourced from records.
 *
 * The cost is reading a session's full candidate history rather than `pendingForSession`'s narrow
 * composite lookup — but that is a like-for-like trade, not a new expense: the file-backed reader
 * this replaces (`readQueue(sessionId)`) already folds the WHOLE append log on every call.
 */
export async function addressablePending(sessionId, opts = {}) {
  const rows = await bySession(sessionId, opts);
  if (rows === null) return null;
  return rows.filter((c) => c.disposition === 'pending' && !c.supersededBy);
}
