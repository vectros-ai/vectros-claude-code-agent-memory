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
 * That distinction is the whole point. Returning `[]` for both "the lookup failed" and "the tier
 * is genuinely empty" — even while logging the failure, which fixes the observability and leaves
 * the CONTRACT conflated — leaves the caller unable to tell them apart, so `recall.mjs` would read
 * "no pinned records" identically to "the API is down", and its orient boundary would latch forever
 * for every user whose pinned tier is legitimately empty — i.e. every new user and every OSS
 * adopter, and never a machine with pinned records already — a shape that structurally cannot
 * surface in local testing.
 *
 * `null` vs `[]` is `project.mjs`'s contract, three files away, for exactly this reason: it
 * refuses to project a failed read as "empty" because that would WIPE the pinned block out of
 * MEMORY.md. Same hazard, same answer: missing is not the same as broken.
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
      // cannot — which is why this returns `null` and not `[]`.
      //
      // The receipt carries the same diagnostics as recall.mjs's search-error receipt:
      // requestId / x-amz-cf-id / a redacted body shape, so a transient failure on THIS lookup is
      // diagnosable.
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
 * reason is what the caller DOES with a false: it re-owes the whole orientation, which re-runs the
 * lookups (both, on a resume) and re-injects the thread block on the next prompt. So `ok` must mean
 * *"a retry could plausibly help"*, not merely *"something went wrong"* — otherwise the flag is not
 * a re-owe, it is a loop.
 *
 * Gating `ok` on the thread too (`pinned !== null && (!isResume || thread !== null)`) would be
 * wrong. The thread lookup is a resume-only SUPPLEMENT, and a failure of it while pinned succeeds
 * (a persistent 400, say) is unretriable: the endpoint is demonstrably up and the key demonstrably
 * good, because pinned just came back. So the retry cannot succeed, and every prompt for the life
 * of the session would, on a resume, re-run both lookups and re-inject the thread block,
 * squeezing the real hits out of the budget. No such 400 has been observed (`threadId` is declared
 * in the `memory` type's `lookupFields`, and this file sends the exact-match `value:` shape). The
 * degradation path itself is exercised by `orient-boundary-test.mjs` case 2e, which stubs a 500 for
 * the thread lookup. Do not add a special-case fix for a shape-400 on this lookup.
 *
 * A failed thread lookup is therefore a DEGRADATION, not an unrunnable orientation: it is logged
 * below (say what you did when you fell back), and the thread's records stay in the store where the
 * ordinary search reaches them. Losing their ENUMERATION is a real cost; paying a re-run of both
 * lookups on every prompt, forever, is a bigger one.
 *
 * The degradation handling is the right response to whatever failure mode a transient 5xx or a
 * schema regression produces, which is why the lookup's receipt carries requestId / x-amz-cf-id / a
 * redacted request-body shape.
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
  // session silently losing its own prior context is exactly the kind of quiet this package exists
  // to make loud.
  if (isResume && thread === null) {
    hlog('enumerate', 'thread lookup FAILED on a RESUME — orienting WITHOUT this session\'s prior context (the pinned set is unaffected; the boundary is NOT re-owed, because a retry would only re-run both lookups and re-inject the thread block, and cannot fix a shape error)');
  }
  // Normalize to arrays for rendering; `ok` is the channel that carries the failure.
  //
  // Deliberately NO `threadOk` field: a value shaped exactly like a receipt a caller could gate
  // on, that no caller gates on, is a receipt nobody reads. The thread's degradation is reported
  // where it is actually read: the log line above. Add the field when something needs to BRANCH on
  // it, not before.
  return { pinned: pinned || [], thread: thread || [], ok };
}

/**
 * Render the enumerated set as injectable lines. Returns [] when there is nothing to say.
 *
 * THE PINNED SET IS NOT RENDERED HERE. `project.mjs` materializes the pinned
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
