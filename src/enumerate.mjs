/**
 * Bounded ENUMERATION for orientation — the pinned set, plus a resumed thread's own memory.
 *
 * Automatic enumeration is justified ONLY for a bounded, inherently-relevant facet — the
 * enumeration rule this file follows. Exactly two qualify, and neither needs inference:
 *
 *   1. The PINNED SET — `priority >= 10` memories, desc (10 pinned / 20 high / 30 critical).
 *      Bounded by the read query itself, which IS the cap enforcement.
 *   2. THREAD EPISODIC on resume — this session's own prior `observation`s, so a resumed session
 *      regains its working context.
 *
 * This lived inside orient.mjs (the SessionStart hook) and ran the moment a session PROCESS
 * existed. It now lives here, called from recall.mjs on the first real PROMPT instead — see
 * orient.mjs for the measurement that forced the move. Same queries, same rendering, later
 * trigger.
 */
import { cred } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { PINNED_LIMIT, PINNED_MIN_PRIORITY, THREAD_TOP_N, ENUMERATE_TIMEOUT_MS,
  ENUMERATE_BODY_MAX_CHARS } from './config.mjs';

const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');

/** POST /v1/records/lookup — the sensitive-safe lookup path (value never in the URL). */
/**
 * POST /v1/records/lookup — the sensitive-safe lookup path (value never in the URL).
 *
 * RETURNS `null` WHEN IT COULD NOT RUN; an ARRAY (possibly EMPTY) when it did.
 *
 * That distinction is the whole point and it was missing. This used to return `[]` for both
 * "the lookup failed" and "the tier is genuinely empty" — and a round-3 fix made the failure
 * *log* while still returning `[]`, which fixed the observability and left the CONTRACT
 * conflated. The caller still could not tell them apart, so `recall.mjs` read "no pinned
 * records" identically to "the API is down", and its orient boundary latched forever for
 * every user whose pinned tier is legitimately empty — i.e. every new user and every OSS
 * adopter, and never a machine with pinned records already — that shape structurally could
 * not surface it in local testing.
 *
 * `null` vs `[]` is `project.mjs`'s contract, three files away, for exactly this reason: it
 * refuses to project a failed read as "empty" because that would WIPE the pinned block out of
 * MEMORY.md. Same hazard, same answer. → this discipline's second half (missing is not the same as broken): missing is not the same as broken.
 */
async function lookup(body) {
  const key = cred('VECTROS_API_KEY');
  // Not "empty" — UNRUNNABLE. recall.mjs returns long before this on a missing key, so this is
  // belt-and-braces; answering `[]` here would be the same conflation one layer up.
  if (!key) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ENUMERATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/records/lookup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // The pinned set silently emptying is how "the always-load tier is gone" would look. It is
      // also exactly how a healthy brand-new tenant looks. An HTTP status tells them apart; `[]`
      // cannot — which is why this returns `null` and not `[]`. The previous version said this
      // sentence and then returned `[]` anyway: the receipt was added, the contract was not.
      //
      // WIDENED the same way recall.mjs's search-error receipt was widened:
      // requestId / x-amz-cf-id / a redacted body shape. An earlier "persistent shape/validation
      // 400 on {field:'threadId'}" hypothesis did NOT reproduce (verified — see the
      // header comment above `fetchOrientSet`), but a future transient failure on THIS lookup
      // deserves the same diagnosability the search path just got, not a narrower receipt because
      // this particular guess turned out wrong.
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* silence-ok: the status is the receipt; an unreadable error body does not weaken it. */ }
      const detail = bodyText.slice(0, 200);
      let requestId = null;
      try { requestId = JSON.parse(bodyText)?.requestId ?? null; } catch { /* silence-ok: not every error body is the JSON contract */ }
      const cfId = res.headers.get('x-amz-cf-id') || '(none)';
      const reqShape = res.status === 400 ? ` reqBody="${JSON.stringify(body).slice(0, 160)}"` : '';
      hlog('enumerate',
        `lookup HTTP ${res.status} — UNRUNNABLE (returning null, not an empty tier) `
        + `cfId=${cfId} requestId=${requestId ?? '(null)'}${reqShape}${detail ? `: ${detail}` : ''}`);
      return null;
    }
    const j = await res.json();
    // A non-array `data` is a malformed response, not an empty tier — null, per project.mjs.
    return Array.isArray(j.data) ? j.data : null;
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout after ${ENUMERATE_TIMEOUT_MS}ms` : (e?.code || e?.message || 'error');
    hlog('enumerate', `lookup FAILED (${why}) — UNRUNNABLE (returning null, not an empty tier)`);
    return null;
  } finally { clearTimeout(to); }
}

/** Records nest payload fields differently across shapes — read defensively. */
function field(rec, name) {
  return rec?.[name] ?? rec?.payload?.[name] ?? rec?.data?.[name] ?? rec?.fields?.[name] ?? undefined;
}

function line(rec) {
  const title = field(rec, 'title') || '(untitled)';
  const kind = field(rec, 'kind') || '';
  const area = field(rec, 'area') || '';
  const pri = field(rec, 'priority');
  let body = String(field(rec, 'body') ?? '').replace(/\s+/g, ' ').trim();
  if (body.length > ENUMERATE_BODY_MAX_CHARS) body = body.slice(0, ENUMERATE_BODY_MAX_CHARS) + '…';
  const tag = [kind, area, pri != null ? `p${pri}` : ''].filter(Boolean).join(', ');
  const id = rec?.id || rec?.recordId || field(rec, 'externalId') || '';
  return `- ${title}${tag ? ` (${tag})` : ''} — ${body}${id ? ` [${id}]` : ''}`;
}

/**
 * Fetch the orientation set. `source` is the SessionStart source recorded at the boundary
 * ('startup' | 'resume' | 'clear'); only a resume earns the thread lookup.
 */
/**
 * The enumerated orient set, WITH a receipt saying whether it actually ran.
 *
 * `ok` is the field that matters and the reason this returns an object rather than two arrays:
 * a caller consuming the arrays alone cannot tell "the tier is empty" (ok, pinned: []) from
 * "the lookup died" (not ok, pinned: []) — and `recall.mjs` consumes this to decide whether the
 * session's one orientation has been DELIVERED. Getting that wrong in the "empty" direction
 * latches the boundary forever; getting it wrong in the "failed" direction burns the
 * orientation on nothing. Both are silent.
 *
 * `ok` IS THE PINNED LOOKUP, AND ONLY THE PINNED LOOKUP. That is a deliberate narrowing, and the
 * reason is what the caller DOES with a false: it re-owes the whole orientation, which re-runs both
 * lookups and re-injects the whole pinned block on the next prompt. So `ok` must mean
 * *"a retry could plausibly help"*, not merely *"something went wrong"* — otherwise the flag is not
 * a re-owe, it is a loop.
 *
 * It used to read `pinned !== null && (!isResume || thread !== null)`. The thread lookup is a
 * resume-only SUPPLEMENT, and the realistic way it fails while pinned succeeds is a persistent
 * shape/validation 400 on `{field:'threadId'}` — the same class of bug that hid a 400 in
 * recall.mjs's search for a week (see the lookup comment above). The endpoint is demonstrably up
 * and the key demonstrably good, because pinned just came back. So the retry cannot succeed, and
 * every prompt for the life of the session re-injects the pinned block (~10.4K worst case against
 * a 9500c cap) and squeezes the real hits out of the budget — the exact harm the round-4 fix was
 * written to stop, reintroduced one field over.
 *
 * A failed thread lookup is therefore a DEGRADATION, not an unrunnable orientation: it is logged
 * below (this discipline's second half — say what you did when you fell back), and the thread's records stay in the
 * store where the ordinary search reaches them. Losing their ENUMERATION is a real cost; paying it
 * forever, plus the pinned block, is a bigger one.
 *
 * THE "PERSISTENT SHAPE/VALIDATION 400" HYPOTHESIS ABOVE DID NOT REPRODUCE (verified,
 * three independent checks): (1) `list_schemas` on the live `memory` type shows
 * `threadId` correctly declared in `lookupFields` (`rangeEnabled:false`), which is exactly the
 * `value:`-exact-match shape this file sends — not the `from`/`to` range shape that WOULD 400
 * against a non-range field. (2) Calling `fetchOrientSet(sid, 'resume')` directly against the live
 * API with a fabricated session id returned `{ok:true, thread:[]}` with no `enumerate` receipt at
 * all — a genuine empty match, not a swallowed failure (a failure DOES log, per the code just
 * below). (3) Every one of the 71 `thread lookup FAILED` lines across all five retained
 * `hooks.log` generations carries `stub:` in its accompanying detail — 100% traceable to
 * `orient-boundary-test.mjs`'s stub server (cases 2e/2f, which deliberately 500 the thread lookup
 * to test THIS degradation path), not a real API response. `--resume` was also independently
 * confirmed (Claude Code docs, via claude-code-guide) to preserve the SAME `session_id` across a
 * resume — ruling out a session-id-mismatch theory too. **Net: no evidence of a real, reproducible
 * production failure survived investigation; the original occurrence count came from a test
 * harness bug (no test-mode log redirect) counting test fixtures as incidents.** The DEGRADATION HANDLING
 * above stays — it is the right response to whatever failure mode a future transient 5xx or a
 * schema regression produces, which is exactly why the receipt below was widened (the same pattern
 * used elsewhere: requestId/x-amz-cf-id/a redacted request-body shape) rather than left as-is because this one
 * guess turned out wrong. Do not re-introduce a "fix" for the disproven 400 theory specifically.
 */
export async function fetchOrientSet(sessionId, source) {
  const isResume = source === 'resume';
  const [pinned, thread] = await Promise.all([
    lookup({ type: 'memory', field: 'priority', from: String(PINNED_MIN_PRIORITY), to: '999999', order: 'desc', limit: PINNED_LIMIT }),
    isResume
      ? lookup({ type: 'memory', field: 'threadId', value: sessionId, limit: THREAD_TOP_N })
      : Promise.resolve([]), // not attempted — vacuously fine, and must not fail `ok`
  ]);
  const ok = pinned !== null;
  if (!ok) hlog('enumerate', 'orient set UNRUNNABLE (pinned lookup FAILED) — the orientation is still owed');
  // The supplement's own receipt. NOT `ok`: it does not re-owe the orientation, but a resumed
  // session silently losing its own prior context is exactly the kind of quiet the branch is about.
  if (isResume && thread === null) {
    hlog('enumerate', 'thread lookup FAILED on a RESUME — orienting WITHOUT this session\'s prior context (the pinned set is unaffected; the boundary is NOT re-owed, because a retry would re-inject the pinned block and cannot fix a shape error)');
  }
  // Normalize to arrays for rendering; `ok` is the channel that carries the failure.
  //
  // Deliberately NO `threadOk` field. A first cut returned one and nothing consumed it — a value
  // shaped exactly like a receipt a caller could gate on, that no caller gates on. That is this
  // branch's own bug class (a receipt nobody reads is not a receipt), so the thread's degradation
  // is reported where it is actually read: the log line above. Add the field back when something
  // needs to BRANCH on it, not before.
  return { pinned: pinned || [], thread: thread || [], ok };
}

/**
 * Render the enumerated set as injectable lines. Returns [] when there is nothing to say.
 *
 * THE PINNED SET IS NO LONGER RENDERED HERE. `project.mjs` materializes the pinned
 * set into the harness-auto-loaded `MEMORY.md` — "the harness, not a hook, does the loading". So
 * injecting the pinned block here too was a DOUBLE-load: every hook-enabled session already had the
 * pins from MEMORY.md, and re-injecting them (~10K, pinned-first, never-dropped) ate the first
 * prompt's one orient budget that the semantic hits actually needed. The pinned LOOKUP in
 * `fetchOrientSet` is KEPT for the orient-liveness `ok` receipt (the boundary latch). It is NOT used
 * to suppress pins from arriving as search hits (recall.mjs deliberately does not dedup pinned ids):
 * recall cannot verify MEMORY.md's projection is fresh, so suppressing a pin would make a stale
 * MEMORY.md lossy. Only the resumed thread's own episodic memory, which MEMORY.md does not carry, is
 * injected. → recall.mjs § the orient branch.
 */
export function renderOrientBlock(thread) {
  if (!thread.length) return [];
  return ["This thread's earlier working memory (resumed session):", ...thread.map(line)];
}

/** Ids of everything enumerated, for the injected-set dedup. */
export const idsOf = (recs) => recs.map((r) => r?.id || r?.recordId || field(r, 'externalId')).filter(Boolean);
