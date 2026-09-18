#!/usr/bin/env node
/**
 * UserPromptSubmit hook — L1 involuntary recall.
 *
 * The heuristic distinctive-term GATE is gone. The field
 * (mem0, Zep, Cline) always-retrieves and conditions the query on a ROLLING WINDOW
 * of recent conversation — not the bare user turn — which is the standard fix for
 * terse follow-ups ("go do it") and non-identifier domain phrases ("QW v6→v7") that
 * an input heuristic silently misses.
 *
 * So: build the query from `user_prompt` + the last X chars of the previous assistant
 * message (stashed by the Stop hook into the session state), run one HYBRID search
 * over the caller's tenant (curated KB + own private memory, per-row isolated), and
 * inject a bounded top-5 snippet+id block. State-driven dedup downgrades an
 * already-injected record to a bare pointer (working-memory promotion). Fail-open:
 * any error/timeout/empty → inject nothing, never block the turn. Self-contained.
 *
 * Config source: VECTROS_API_KEY (+ optional VECTROS_API_BASE_URL) from the hook env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cred } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { readState, writeState } from './state.mjs';
import { reshape, renderLine, renderBackRef, AUTHORITY } from './hit.mjs';
import { fetchOrientSet, renderOrientBlock, idsOf } from './enumerate.mjs';
import { markHanded } from './queue.mjs';
import { addressablePending } from './candidates.mjs';
import { renderNudge, pendingSig, renderOrphanNudge, orphanSig } from './nudge.mjs';
import { orphanedPending, planClaimRenewals } from './sweep.mjs';
import { CONTEXT_CAP, STALE_SESSION_MS, HANDED_TTL_MS, clampQuery,
  RECALL_TIMEOUT_MS, RECALL_TOP_K, RECALL_TOP_K_FIRST, RECALL_MAX_FACETS,
  RECALL_FACET_MAX_CHARS, KICKOFF_DOC_MAX_CHARS, ROLLING_TAIL_CHARS } from './config.mjs';
import { SID_DISPLAY_LEN } from './paths.mjs';

// Re-entrance guard: no-op inside the mid-run evaluator's own nested `claude -p`
// (which sets VECTROS_RECALL_EVAL=1), so it never re-fires the recall loop.
if (process.env.VECTROS_RECALL_EVAL === '1') process.exit(0);

const API_KEY = cred('VECTROS_API_KEY');
const BASE = (cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai').replace(/\/+$/, '');
// (snippet/claim budgets live in hit.mjs — the injected LINE FORMAT is one concern, in one place)
// CONTEXT_CAP now comes from ./config.mjs — single-sourced with evaluate.mjs (both must agree on
// the 10K additionalContext ceiling). This was the first duplicated const the config seam removed.

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

/** Read stdin fully (async — a sync fd-0 read trips a libuv assert on Windows pipes). */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/**
 * THIS is where the state reset came from. The old body was:
 *
 *   try  { return { injectedIds: [], lastAssistant: '', promptCount: 0, ...JSON.parse(read(p)) }; }
 *   catch { return { injectedIds: [], lastAssistant: '', promptCount: 0 }; }
 *
 * Nothing decrements promptCount — a torn read hit that `catch`, handed back promptCount: 0, and
 * the next line counted it up from 1. Live session, observed: 37 -> 9. The catch also silently
 * dropped `injectedIds` (so recall re-injects memories it already showed) and `orientPending`.
 * Six processes were racing this file with truncating writes; 33.7% of reads tore. → `state.mjs`.
 */
function loadState(sessionId) {
  // Returns the RECEIPT too — a corrupt (usually TORN) read must not be published back over a
  // file that is probably fine. → state.mjs.
  return readState(sessionId, { injectedIds: [], lastAssistant: '', promptCount: 0 });
}

/**
 * One HYBRID search. Fail-open: any error/timeout -> [] — but never quietly.
 *
 * THE EMPTY ARRAY IS THE WHOLE PROBLEM. "The search failed" and "there is nothing to recall" are
 * the same value here, and the second is a completely normal answer — so a total failure of recall
 * renders as a perfectly healthy quiet session. This is the founding story behind this discipline (a recall hook read the
 * wrong field name and did nothing, in every session, for a week) and it has ALREADY recurred in
 * this exact function: `limit: 200` exceeded the API's max of 100, every call 400'd, `!res.ok`
 * swallowed it, and the loop reported "0 memory records" for as long as nobody thought to ask.
 * A 400 is not an empty result set. Say which one happened.
 *
 * CLAMP HERE, not at every caller. `query` arrives as the raw whole-prompt facet (the first
 * entry `facetsFrom` always adds, uncapped by `RECALL_FACET_MAX_CHARS`) and as the steady-state
 * `${prompt}\n${tail}` composite — both ultimately traceable to `input.prompt`, which this hook
 * always read uncapped. A big pasted diff/log/review-note pushed the request body past the API's
 * 8KB request-body-size cap on `/v1/search` → 413 → the `!res.ok` branch below already
 * turns that into a logged-but-silent 0 hits. Clamping HERE, at the one function that actually
 * builds the outbound body, bounds every current and future caller without relying on each of them
 * remembering to.
 */
async function search(query, limit) {
  const clamped = clampQuery(query);
  if (clamped.length !== String(query ?? '').length) {
    hlog('recall', `query clamped ${String(query ?? '').length}c -> ${clamped.length}c (RECALL_QUERY_MAX_CHARS) — avoiding a body-size 413`);
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), RECALL_TIMEOUT_MS);
    const res = await fetch(`${BASE}/v1/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: clamped, mode: 'HYBRID', limit }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!res.ok) {
      /**
       * WIDEN THE RECEIPT. The old line (status + 200 chars of body) was enough to see a 413
       * but not enough to DIAGNOSE a 403: a gateway-level block's own error contract puts
       * `requestId: null` in the static block body — the edge never had one to give — so the real
       * correlator is the `x-amz-cf-id` CloudFront RESPONSE HEADER, which this line never captured,
       * alongside the outgoing query's BYTE length (not char length — UTF-8 inflation is exactly
       * what could tip a near-cap query over a byte threshold that a char count looks safe against)
       * and, on a 403 specifically, a REDACTED shape of what was sent (first/last ~80 chars — enough
       * to eyeball whether it looks like a request-firewall false-positive without logging the
       * whole prompt into a receipt file). If you operate your own WAF/CDN in front of the Vectros
       * API, the captured `x-amz-cf-id` is what you'd cross-reference against its own sampled-request
       * logs to diagnose a spurious 403.
       */
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* silence-ok: the status line below is the receipt; a body we cannot read does not make the status less true. */ }
      const detail = bodyText.slice(0, 200);
      let requestId = null;
      try { requestId = JSON.parse(bodyText)?.requestId ?? null; } catch { /* silence-ok: not every error body is the JSON contract (e.g. the WAF's default HTML page on a non-authored block) */ }
      const cfId = res.headers.get('x-amz-cf-id') || '(none)';
      const byteLen = Buffer.byteLength(clamped, 'utf8');
      const shape = res.status === 403
        ? ` shape="${clamped.slice(0, 80)}"…"${clamped.slice(-80)}"`
        : '';
      hlog('recall',
        `search HTTP ${res.status} — returning 0 hits (this is an ERROR, not an empty index) `
        + `queryBytes=${byteLen} cfId=${cfId} requestId=${requestId ?? '(null)'}${shape}${detail ? `: ${detail}` : ''}`);
      return [];
    }
    const j = await res.json();
    return Array.isArray(j.results) ? j.results : [];
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout after ${RECALL_TIMEOUT_MS}ms` : (e?.code || e?.message || 'error');
    hlog('recall', `search FAILED (${why}) — returning 0 hits (this is an ERROR, not an empty index)`);
    return [];
  }
}

/**
 * Find the session's kickoff/handoff doc, DETERMINISTICALLY (no tools, no inference).
 *
 * The alternative — giving the evaluator a Read tool — is structurally incompatible with
 * `--max-turns 1` (a tool call burns the turn, so it needs >=3 turns, reopening the
 * agentic-loop blowup) and risks a headless permission denial we'd never see. The hook
 * reads the file itself: zero tokens, zero turns, hard size cap, no permission surface.
 *
 * Matches a `_*kickoff*.md` / `_*handoff*.md`-style file at the worktree root — an opt-in
 * convention some repos keep for a git-excluded scratch handoff doc between sessions, not a
 * requirement this package imposes. Most-recently-modified wins.
 */
function readKickoffDoc(cwd) {
  if (!cwd) return '';
  try {
    const cands = fs.readdirSync(cwd)
      .filter((f) => /^_.*(kickoff|handoff).*\.md$/i.test(f))
      .map((f) => { const p = path.join(cwd, f); return { p, mtime: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    if (!cands.length) return '';
    return fs.readFileSync(cands[0].p, 'utf8').slice(0, KICKOFF_DOC_MAX_CHARS);
  } catch (e) {
    // "No kickoff doc here" is the common, correct answer and returns '' above without entering
    // this catch at all. Landing HERE means readdir/stat/read failed on a cwd we could see — which
    // degrades every orient facet derived from the doc, and looks exactly like a repo that has none.
    if (e.code !== 'ENOENT') hlog('recall', `kickoff-doc scan FAILED (${e.code}) — orienting without its facets`);
    return '';
  }
}

/**
 * Deterministic multi-query facets for the ORIENT recall. A single long query blends every
 * facet into one embedding and washes them out; distinct facet queries each rank on their own.
 * Facets = the whole prompt + the kickoff doc's sections (heading + lede), longest-first.
 */
function facetsFrom(prompt, doc) {
  const facets = [prompt];
  if (doc) {
    const sections = doc
      .split(/\n(?=#{1,4}\s)/)            // split on markdown headings
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 80);
    const chosen = (sections.length ? sections : doc.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 120))
      .sort((a, b) => b.length - a.length)
      .slice(0, RECALL_MAX_FACETS - 1)
      .map((s) => s.slice(0, RECALL_FACET_MAX_CHARS));
    facets.push(...chosen);
  }
  return facets.filter(Boolean);
}

/** Round-robin fuse across facet result lists. Scores are NOT comparable across different
 *  queries, so interleave by RANK (standard multi-query fusion) rather than by score. */
function fuse(lists, topN) {
  const seen = new Set();
  const outHits = [];
  const depth = Math.max(...lists.map((l) => l.length), 0);
  for (let rank = 0; rank < depth && outHits.length < topN; rank++) {
    for (const list of lists) {
      if (outHits.length >= topN) break;
      const h = list[rank];
      if (!h) continue;
      const r = reshape(h);
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      outHits.push(r);
    }
  }
  return outHits;
}

async function main() {
  let raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { hlog('recall', 'skip: unparseable stdin'); return; }

  // FIELD NAME — read defensively and LOG the shape. A silent fail-open hook makes
  // "never fired", "fired and no-op'd" and "fired and errored" indistinguishable; this hook
  // read `user_prompt` and every test fed it synthetic stdin containing `user_prompt`, so the
  // tests validated the assumption instead of the contract. It never ran once in a real session.
  const prompt = (input.prompt ?? input.user_prompt ?? '').toString().trim();
  /**
   * `realSid` vs `sessionId`: the fallback id is fine for LOCAL bookkeeping (state, logs) and is
   * disqualifying for anything CROSS-SESSION.
   *
   * `'nosession'` is not an identity — it is the same string in every process that reaches it. The
   * orphan claim is a mutual-exclusion token keyed on exactly that identity, so under the fallback
   * every such session computes "I already hold this" about a claim any of them may have written,
   * and each renews it. That turned a BOUNDED degradation (a shared claim that expired after
   * `HANDED_TTL_MS`) into an unbounded one: a claim that never expires while any id-less session
   * runs, while all of them are still offered the queue. A fix that makes a pre-existing bounded
   * problem unbounded is worse than no fix — so the cross-session path is skipped entirely here,
   * rather than made to look like it works.
   */
  const realSid = typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id.trim() : null;
  const sessionId = realSid || 'nosession';
  if (!prompt) { hlog('recall', `skip: no prompt field — payload keys=[${Object.keys(input).join(',')}]`); return; }
  if (!API_KEY) { hlog('recall', 'skip: no VECTROS_API_KEY'); return; }
  if (prompt.length < 2) { hlog('recall', 'skip: prompt too short'); return; }

  const { value: state, state: stState } = loadState(sessionId);
  /**
   * Is this an ORIENTATION moment (spend the multi-query) or steady state (single top-5)?
   *
   * `!promptCount` was a PROXY for "this is the kickoff" and it is wrong in BOTH directions
   * (measured):
   *  - FALSE POSITIVE: recall that fails-open early and recovers later makes an ordinary
   *    mid-session prompt look like prompt #1. (Deploying the field-name fix did exactly this
   *    to every running session.)
   *  - FALSE NEGATIVE, the costly one: a COMPACT keeps the same session_id, so promptCount is
   *    already high — and the post-compact kickoff, the single richest orient signal there is,
   *    would get steady-state top-5. `SessionStart` does NOT rescue this: every observed
   *    invocation is `source=startup`; it never fired for a compact.
   *
   * So orientation is an explicit BOUNDARY, marked by whoever actually knows one happened:
   * orient.mjs (SessionStart) and capture.mjs (PreCompact — the boundary SessionStart misses).
   * If recall then fails-open, the flag simply stays set and the next healthy prompt orients —
   * we still owe an orientation, so that is the correct behavior rather than a lost one.
   */
  const isFirstPrompt =
    state.orientPending === true ||
    (state.orientPending === undefined && !state.promptCount); // pre-flag sessions
  state.promptCount = (state.promptCount || 0) + 1;
  // NOTE: `orientPending` is NOT consumed here. It is decided at the single commit site at the
  // bottom, on the receipt that says the enumeration RAN — read that comment before touching this.
  //
  // It used to be cleared on ENTRY, which made the comment above false in the one case it
  // describes: `search()` and `fetchOrientSet()` both failed OPEN to `[]`, so a network blip or an
  // expired key produced hits=[] and orientLines=[], fell into the then-existing nothing-to-inject
  // guard — whose body was `writeState` — and persisted `orientPending: false`. The boundary was
  // consumed, the orientation never re-owed, and that session ran its whole life with no pinned set
  // and no multi-query. It failed precisely on the "brand-new or offline-ish session" that guard's
  // own comment called out as when standing context matters most.
  //
  // That guard is gone — it was the same bug's other face, and it caused two of them. Both are in
  // the commit-site comment; this one is here because THIS is the line you reach for first.

  let hits = [];
  let header;
  let orientLines = []; // the INJECTED enumeration (resumed-thread episodic only) — first prompt only
  let orientIds = [];   // THREAD ids, marked served only once the block is really delivered
  /**
   * Did the enumeration actually RUN? Not "did it produce lines" — an empty pinned tier is a
   * SUCCESSFUL orient with nothing to say, and it is the normal state of every new user and
   * every OSS adopter. Only a lookup that could not run leaves the orientation owed.
   * `false` until proven otherwise: an orient we never attempted has not delivered.
   */
  let orientOk = false;

  if (isFirstPrompt) {
    // ── ORIENT: the first prompt IS the kickoff/handoff — the richest query source a
    // session ever gets. Spend here (multi-query, higher limit) so mid-run recall can be a
    // sparse drift-catcher rather than the primary mechanism. No inference: N cheap
    // parallel searches stay far inside the 30s UserPromptSubmit budget.
    //
    // The ENUMERATION rides here too, rather than in the SessionStart hook where it used to live.
    // Claude Desktop starts a session PROCESS about once a minute that never receives a prompt;
    // enumerating at process start spent ~1400 REST calls/day orienting sessions that did nothing.
    // The first prompt is the first work, so it is the honest place to pay. See orient.mjs.
    //
    // What the enumeration INJECTS is now only the resumed thread's episodic memory. The pinned set
    // is materialized into the harness-auto-loaded MEMORY.md by project.mjs, so re-injecting it here
    // was a double-load that ate this budget; the pinned LOOKUP is retained (in fetchOrientSet) only
    // for the orient-liveness `ok` receipt and the dedup ids. → enumerate.mjs § renderOrientBlock.
    const doc = readKickoffDoc(input.cwd);
    const facets = facetsFrom(prompt, doc);
    // Ask each facet for RECALL_TOP_K_FIRST, not RECALL_TOP_K. Otherwise the injected count is accidentally
    // coupled to whether a kickoff DOC happened to be found: with a doc you get ~5 facets ×5 =
    // plenty to fuse to 12, but with only the prompt as a facet you'd cap at 5 and the ORIENT
    // path would silently degenerate to steady-state size — on the one prompt that matters most.
    // Over-fetching is free here: searches are parallel and the surplus never reaches a model.
    //
    // Enumeration and search are INDEPENDENT reads: run them together, not in series. The
    // 30s UserPromptSubmit budget is generous but this is the user's very first keystroke-to-
    // response, and every hook pays a cold TLS handshake (~1.3s) it cannot amortize.
    const [lists, orientSet] = await Promise.all([
      Promise.all(facets.map((f) => search(f, RECALL_TOP_K_FIRST))),
      fetchOrientSet(sessionId, state.orientSource || 'startup'),
    ]);
    hits = fuse(lists, RECALL_TOP_K_FIRST);
    orientOk = orientSet.ok === true; // the receipt, not the line count — see the flag gate below
    orientLines = renderOrientBlock(orientSet.thread); // pinned is in MEMORY.md now, not injected here
    // ONLY the resumed-thread ids are deduped (commit-on-delivery: a thread line dropped for budget
    // was not shown, so it stays eligible to arrive later as a hit). Pinned ids are deliberately NOT
    // deduped: a pin lives in MEMORY.md, but recall cannot verify that projection is fresh
    // (`project.mjs` runs detached + fail-open, and is not its own hook), so SUPPRESSING a pin from
    // arriving as a hit would make a stale MEMORY.md LOSSY — the pin invisible in BOTH channels, the
    // the "missing indistinguishable from broken" trap on the one tier where it matters most. A
    // relevant pin surfacing as a hit is at worst redundant with a fresh MEMORY.md, never invisible.
    orientIds = idsOf(orientSet.thread);
    header =
      'Session orientation — recalled from your Vectros memory + curated KB by matching this ' +
      `session's kickoff${doc ? ' (plus the kickoff/handoff doc found in the working tree)' : ''} ` +
      'across several facets. NOTE these facets come from the kickoff, so they inherit its ' +
      'framing: if the kickoff mis-frames the problem, this list inherits the blind spot. ' +
      AUTHORITY;
  } else {
    // ── Steady state: rolling-window single query (prompt + prior assistant tail).
    const tail = (state.lastAssistant || '').slice(-ROLLING_TAIL_CHARS).replace(/\s+/g, ' ').trim();
    hits = (await search(tail ? `${prompt}\n${tail}` : prompt, RECALL_TOP_K)).map(reshape);
    header = 'Relevant prior knowledge recalled from your Vectros memory + curated KB. ' + AUTHORITY;
  }

  /**
   * The candidate nudge — capture's other half. Read the RECORD corpus (addressing lives in
   * records now, not the local file fold) and surface unsettled candidates
   * when the set has CHANGED since we last said so. → nudge.mjs for why the trigger is candidate
   * pressure and why it must not repeat; → candidates.mjs `addressablePending` for why this reads
   * `bySession`-derived stable ordinals rather than the faster-but-unstable `pendingForSession`.
   *
   * `nudgedSig` is only advanced where the block is actually INJECTED (below), never here. If the
   * nudge is computed but then dropped for budget, marking it shown would retire it forever: the
   * set only changes when a new capture lands, so a silently-dropped nudge would not return until
   * then, and might never. Compute here, commit on delivery.
   */
  let nudgeLines = [];
  let nudgeSig = '';
  let nudgeCount = 0; // candidates, NOT rendered lines — the log must not depend on the block's shape
  /**
   * OWN UNSETTLED COUNT — the orphan gate reads THIS, not `nudgeLines.length`. `null` means "could
   * not tell" (records unreachable, or a throw), which the orphan gate treats as "do not surface".
   * See the orphan compute site for why the distinction is load-bearing.
   */
  let ownPending = null;
  try {
    const pending = await addressablePending(sessionId);
    // HONOUR THE null RECEIPT (this discipline; queue census 3 of 4, now against the record
    // store). `[]` on an unreachable store is indistinguishable from "nothing to settle", so the
    // nudge simply never fires — and the nudge is the ONLY thing that tells the agent candidates
    // are waiting. The failure is therefore invisible by construction: no nudge looks exactly like
    // no candidates. Quiet is still right (a nudge must never break a turn), but silent is not.
    if (pending === null) {
      hlog('recall', 'RECORDS UNREACHABLE — no nudge this turn; pending candidates cannot be seen', sessionId);
    } else {
      ownPending = pending.length;
      nudgeSig = pendingSig(pending);
      if (nudgeSig && nudgeSig !== state.nudgedSig) {
        nudgeLines = renderNudge(pending, sessionId);
        if (nudgeLines.length) nudgeCount = pending.length;
      }
    }
  } catch (e) {
    // The nudge is an optimization, never a reason to break a turn — but say so. A throw here is
    // unexpected (addressablePending is itself fail-soft, returning null rather than throwing on
    // any transport failure), which is exactly why it must not be swallowed.
    hlog('recall', `nudge SKIPPED (unexpected ${e?.code || e?.name || 'error'}) — ${e?.message || e}`, sessionId);
  }

  /**
   * THE ORPHAN NUDGE — candidates from sessions the stale-queue sweep flushed (see nudge.mjs,
   * sweep.mjs).
   *
   * ONLY WHEN THIS SESSION HAS NOTHING OF ITS OWN TO SETTLE. Own work first, always: an agent
   * looking at its own session's candidates has the context to judge them, and interleaving a
   * foreign queue would compete for the same attention and the same 9500c budget with strictly
   * worse material.
   *
   * THE PREDICATE IS `ownPending === 0`, NOT `!nudgeLines.length` — and the difference is the whole
   * rule. `nudgeLines` is empty in THREE situations, and only one of them means "nothing to
   * settle": (a) genuinely nothing pending; (b) pending exists but the signature is unchanged since
   * we last showed it — i.e. the agent has been sitting on its own unsettled candidates, which is
   * the STEADY STATE; (c) the queue could not be read. Gating on the rendered block therefore did
   * the exact opposite of what it claimed: an agent with 12 of its own candidates outstanding would
   * be handed a foreign session's queue the moment its own nudge went quiet.
   *
   * `null` (unknown — an unreadable queue or a throw) does NOT pass. If we cannot tell whether this
   * session owes work, we do not hand it somebody else's.
   *
   * This surfaced by falsifying the comment that used to sit here, which asserted the
   * two blocks were "mutually exclusive by construction". They were not. The assertion was written
   * before the predicate, and the predicate was chosen to be convenient rather than true.
   *
   * ONE ORPHAN SESSION PER TURN, and only its own block. Nine backlogged sessions arriving at once
   * is not a nudge, it is a wall, and the all-or-nothing budget rule would drop the lot anyway.
   *
   * SAME NAG CONTRACT as the ordinary nudge: fires when the signature CHANGES, commits on delivery,
   * never on a computed-then-dropped block. `orphanSig` includes the sid, so finishing one orphan
   * session's queue and moving to the next is a change and correctly re-fires.
   *
   * COST, and this number is why the implementation looks the way it does. `orphanedPending` is a
   * QUEUE-dir readdir (9 files on this machine, against 2,337 state files), one fold per queue, and
   * a single state read per survivor: MEASURED 6ms. The first version enumerated the STATE dir and
   * parsed every session's transcript — 218 MB — for a `residual` it then discarded: **1818 ms on
   * this synchronous path, on every prompt.** If you change what this reads, RE-MEASURE it here; a
   * hook on the prompt path is the one place a lazy enumeration is not merely wasteful. It is
   * guarded by the same try/catch discipline: a throw must not cost the turn its recall hits.
   */
  let orphanLines = [];
  let orphanSignature = '';
  let orphanPick = null;
  let heldOrphans = [];
  /**
   * SCAN UNCONDITIONALLY, RENDER ONLY WHEN `ownPending === 0` — and the split is the fix for a
   * regression this branch introduced. Renewal was folded into the render path, so it inherited the
   * render path's gate and covered only `orphans[0]`. Two holes of the same shape:
   *
   *   · a holder that acquires ANY candidate of its own stops scanning, so it stops renewing — and
   *     a session working through a foreign queue is precisely one likely to produce candidates.
   *     The queue it is mid-verification on reopens to a second agent at exactly the TTL.
   *   · `orphanedPending` sorts most-pending-first, so a holder of a 2-candidate queue that later
   *     sees a 5-candidate orphan gets the new one as `orphans[0]` and silently stops renewing the
   *     one it actually holds.
   *
   * Holding is a fact about this session, not about whether we happen to be rendering a block this
   * turn. So: scan always (6ms, see COST above), renew EVERY queue we hold, and let `ownPending`
   * gate only the rendering — which is what "own work first" was ever about.
   */
  if (realSid) {
    try {
      const orphans = orphanedPending(Date.now(), { staleMs: STALE_SESSION_MS, forSid: sessionId });
      heldOrphans = orphans.filter((o) => o.handedTo === sessionId);
      if (ownPending === 0) orphanPick = orphans[0] || null;
      if (orphanPick) {
        orphanSignature = orphanSig(orphanPick);
        if (orphanSignature !== state.orphanSig) {
          orphanLines = renderOrphanNudge(orphanPick, (orphanPick.ageMs / 3600_000).toFixed(0));
        }
      }
    } catch (e) {
      // Somebody else's orphaned queue is the lowest-priority thing this hook does; it must never
      // cost the live turn. But a silently dead orphan nudge means swept candidates accumulate
      // unsettled forever with no signal — the exact failure the orphan-nudge feature exists to close — so it is loud.
      hlog('recall', `orphan nudge SKIPPED (unexpected ${e?.code || e?.name || 'error'}) — swept candidates are NOT being surfaced: ${e?.message || e}`, sessionId);
    }
  } else {
    // This discipline's receipt rule: a fail-open path must say it ran and what it fell back to. This one is rare and
    // its absence would otherwise be indistinguishable from "no orphans exist".
    hlog('recall', `orphan nudge SKIPPED — this turn carries no session_id, and a cross-session claim keyed on the shared 'nosession' fallback cannot be held or released by anyone in particular; swept candidates stay queued for a session that has an identity`, sessionId);
  }

  // THERE IS NO EARLY RETURN HERE, AND THAT IS THE FIX — see the commit block at the bottom.
  //
  // A "nothing to inject" guard used to live on this line, and its body was `writeState`. That made
  // it a SECOND, PARTIAL state-commit site: it wrote `promptCount` and silently skipped every other
  // field, because "nothing to say" was read as "nothing to record". Those are different questions,
  // and conflating them cost FOUR rounds of one bug (both directions — see the flag's own comment).
  //
  // Everything below is a no-op on empty inputs: the budget loops iterate empty arrays, `ctx`
  // assembles to '', and the commit block marks nothing served. So falling through costs nothing
  // and buys the one thing the guard destroyed — a single place where state is decided.

  /**
   * Build the lines WITH their ids — do not mark anything served yet.
   *
   * This used to `injected.add(r.id)` here and `writeState` immediately, ~35 lines ABOVE the
   * budget loop that drops lines. So a hit dropped for budget was recorded as SERVED: on a later
   * prompt it rendered as `[recalled earlier: … ]` — a back-reference asserting the agent had seen
   * a claim it was never shown, exactly the failure mode `hit.mjs`'s own header describes at
   * length, with a false receipt attached. The identical rule was derived and written down 20
   * lines earlier for the NUDGE ("Compute here, commit on delivery") and not applied to the common
   * path in the same function — fix the census, not the instance.
   */
  const served = new Set(state.injectedIds);
  const seen = new Set(); // ids already emitted in THIS block — a pinned record must not print twice
  const lines = [];
  for (const r of hits) {
    // A pinned record enumerated moments ago in THIS same block is already above — don't print
    // it twice, and don't back-reference it either ("[recalled earlier]" about a line 3 rows up
    // reads as a bug).
    if (r.id && (served.has(r.id) || seen.has(r.id))) {
      // renderBackRef carries the same record/doc + tool marker as renderLine — this line
      // used to drop `isRecord` entirely and was the actual cause (two sessions called
      // `record_get` on a document id after seeing only this compressed line).
      if (!isFirstPrompt) lines.push({ text: renderBackRef(r), id: null });
      continue;
    }
    lines.push({ text: renderLine(r), id: r.id || null });
    if (r.id) seen.add(r.id);
  }

  // Enumerated standing context FIRST, then the query-matched hits under their own header.
  //
  // BUDGET — assemble to FIT, never `slice(0, CAP)` the finished string. Folding the enumeration
  // into this hook merged two injections that each used to own a full 9500c budget into one that
  // owns a single 9500c. MEASURED right after the merge: a real first prompt produced 9626c, so
  // a blind tail-slice would have silently eaten the last recall hits AND cut a line mid-word —
  // the enumeration would look fine while recall quietly lost its tail.
  //
  // Priority is deliberate: the orient enumeration (now the resumed-thread episodic block only —
  // pinned lives in MEMORY.md) goes in first, then recall hits. Hits are ranked, so dropping from
  // the tail drops the weakest — a real cost, but the honest one, and it is now LOGGED not silent.
  /**
   * FIT the orient block too — it was subtracted from the budget but never capped.
   *
   * `budget = CONTEXT_CAP - orientPart.length` and then `orientPart` was concatenated
   * unconditionally, so if the enumeration alone exceeded the cap, budget went negative, every hit
   * and the nudge dropped, and `ctx` still shipped OVER the 10K additionalContext ceiling. Worst
   * case shrank sharply once the pinned block moved to MEMORY.md (the enumeration is now ≤8 thread
   * lines, not 12 pinned + 8 thread ≈ 10.4K), but the FIT loop stays: an uncapped title on a long
   * resumed thread can still overflow, and `report.mjs` still ships the `*** assemble-to-fit is
   * broken ***` detector for this exact condition — a monitor for a bug the code simply must not have.
   */
  const orientPart = [];
  let budget = CONTEXT_CAP;
  let orientDropped = 0;
  for (const l of orientLines) {
    if (budget - (l.length + 1) < 0) { orientDropped++; continue; }
    budget -= l.length + 1;
    orientPart.push(l);
  }
  if (orientPart.length) { orientPart.push(''); budget -= 1; }

  // The nudge is ALL-OR-NOTHING, and sits above recall hits in priority.
  //
  // All-or-nothing because it is one actionable unit: a list truncated mid-way would invite the
  // agent to settle the candidates it can see and leave the rest looking handled. Hits are ranked,
  // so dropping their tail drops the weakest and is the honest cost; a half-list is not.
  //
  // Above hits because it is rare (only on a changed set) and it is the only thing here the agent
  // must ACT on — hits are context, this is work. It is still below the pinned set, which is the
  // always-load tier and is bounded by discipline.
  const nudgePart = [];
  if (nudgeLines.length) {
    const cost = nudgeLines.join('\n').length + 1;
    if (cost <= budget) { nudgePart.push(...nudgeLines, ''); budget -= cost + 1; }
    else {
      /**
       * SAY THAT IT VANISHED. Dropping whole is correct (a half-list reads as complete) and
       * `nudgedSig` is deliberately not advanced so it returns — but the drop was SILENT, and the
       * injection log line simply omits the NUDGE segment, which is byte-identical to "signature
       * unchanged" and to "nothing pending". Candidates going unsurfaced for budget is exactly the
       * condition an operator needs to see, because the remedy (a smaller block, a lower NUDGE_MAX)
       * is theirs to apply and they will never think to look for it.
       */
      hlog('recall', `NUDGE DROPPED for budget (${cost}c needed, ${budget}c left) — ${nudgeCount} candidate(s) NOT surfaced this turn; the signature is not advanced, so it returns next turn`, sessionId);
      nudgeLines = []; // dropped -> do NOT mark it shown; it must return next time
    }
  }
  // The orphan block, on the same all-or-nothing terms and BELOW the session's own nudge. The two
  // are mutually exclusive TODAY (`ownPending === 0` at the compute site), but the ordering is
  // explicit rather than assumed: if that gate is ever relaxed, own-work-first must still hold, and
  // it should be the code saying so, not a comment somewhere upstream. (The previous version of
  // this comment asserted the exclusion was "by construction" while the predicate did not actually
  // deliver it — an assertion is not a guarantee, which is why the order is written down here.)
  if (orphanLines.length) {
    const cost = orphanLines.join('\n').length + 1;
    if (cost <= budget) { nudgePart.push(...orphanLines, ''); budget -= cost + 1; }
    else {
      // Same reasoning as the nudge drop above — and worse here, because an orphaned session has no
      // agent of its own to notice the silence.
      hlog('recall', `ORPHAN NUDGE DROPPED for budget (${cost}c needed, ${budget}c left) — ${orphanPick.pending.length} orphaned candidate(s) from ${orphanPick.sid.slice(0, SID_DISPLAY_LEN)} NOT surfaced; it returns next turn`, sessionId);
      orphanLines = []; // dropped -> not marked shown; it returns next turn
    }
  }

  const kept = [];
  if (lines.length) {
    budget -= header.length + 1;
    for (const l of lines) {
      if (budget - (l.text.length + 1) < 0) break;
      budget -= l.text.length + 1;
      kept.push(l);
    }
  }
  const dropped = lines.length - kept.length;
  const ctx = [...orientPart, ...nudgePart, ...(kept.length ? [header, ...kept.map((l) => l.text)] : [])].join('\n');

  /**
   * COMMIT ON DELIVERY — everything that is now really in `ctx`, and nothing else.
   *
   * Only the ids of KEPT lines become served. A hit dropped for budget stays unserved, so the next
   * prompt can offer it again instead of back-referencing something the agent never saw.
   */
  for (const l of kept) if (l.id) served.add(l.id);
  // (Pinned ids are deliberately NOT marked served — see the orient branch: suppressing a pin from
  // arriving as a hit would make a stale MEMORY.md lossy. A relevant pin is allowed to surface as a
  // hit, and then deduped by the ordinary served-set on subsequent prompts like any other hit.)
  // The THREAD enumeration counts as served only if ALL of it fit. If any line dropped we cannot tell
  // WHICH record was lost (renderOrientBlock returns prose, not ids), so mark none of them and let
  // them arrive as hits later — over-offering is recoverable, a false receipt is not.
  if (!orientDropped) for (const id of orientIds) served.add(id);
  /**
   * The orientation boundary is CONSUMED here, and only here — and only if an orientation was
   * REALLY DELIVERED. This is the same test as the line above it, applied to the flag.
   *
   * ONE BUG, FIXED TWICE ALREADY AND STILL LIVE. It was cleared on ENTRY (a network blip consumed the boundary and the
   * session ran its whole life unoriented); that was fixed by moving the clear HERE, to "delivery".
   * But "delivery" was read as *"we reached the delivery code"* — and the guard above only returns
   * when hits AND orientLines AND nudge are ALL empty. So the interesting failure walks straight
   * past it: enumeration fails (`orientLines = []`) while the search SUCCEEDS (`hits > 0`), nothing
   * orientational is in `ctx`, and the flag cleared anyway. Never re-owed.
   *
   * `orientPart.length` (not `orientLines.length`) because a block computed and then dropped for
   * budget was not delivered either; `!orientDropped` because a PARTIAL block means a resumed-thread
   * record the agent needed may be the piece that fell off (pinned now lives in MEMORY.md and is
   * deduped unconditionally above). The rule was already written four lines
   * up for the enumerated ids — *"over-offering is recoverable, a false receipt is not"* — and
   * `orientPending: false` with no orientation delivered is a false receipt about the most
   * expensive thing this hook does.
   *
   * No runaway risk: a session with no credential returns long before this, and a failed
   * enumeration now says so in the log (`enumerate lookup HTTP …`). The flag simply stays set and
   * the next healthy prompt orients — which is precisely what the flag means.
   *
   * AN EARLIER FIX'S gate was `orientPart.length && !orientDropped` — which
   * LATCHED FOREVER for anyone whose pinned tier is legitimately EMPTY. HTTP 200 `{data:[]}` →
   * `renderOrientBlock([], [])` → no lines → no `orientPart` → flag never cleared → `isFirstPrompt`
   * true on every prompt, for the life of the session. Which is to say: **every new user and every
   * OSS adopter, and never a machine with pinned records already**, which was
   * structurally incapable of surfacing this. It cost ~6x the REST calls, and worse, it silently killed
   * the rolling-window tail (stop.mjs's entire output, still being stashed for nobody), dropped
   * already-served hits without their `[recalled earlier]` line, and told the 50th prompt of the
   * session it was "matching this session's kickoff".
   *
   * The cause was the `[]`-conflation — "produced nothing because it FAILED" read as "produced
   * nothing because it's EMPTY" — which is the founding story behind this discipline, inside the fix for it. Fixed at
   * the SOURCE (enumerate.mjs now returns null vs [], per project.mjs's contract) rather than
   * here, because a gate can only be as honest as the value it reads.
   *
   * So gate on DID THE ORIENT RUN, not on whether it had anything to say, and not on whether all
   * of it fit. An empty tier consumes the boundary, correctly: we owed an orientation and gave one.
   *
   * RE-OWE ONLY WHAT A RETRY COULD PLAUSIBLY FIX — this is the rule the flag actually needs, the
   * one every earlier fix missed: *"still owed" is a retry claim — gate it on retryability, or bound it*.
   * This line is the worked example.
   *
   * The gate was `orientOk && !orientDropped`; MEASURED, that predicate
   * re-owed the orientation on three conditions and a retry could only help with ONE of them:
   *
   *   pinned lookup failed (blip/500/timeout) — TRANSIENT. Retry helps. RE-OWE.      <- kept
   *   thread lookup failed on a resume        — persistent shape-400; the retry re-injects the
   *                                             pinned block and cannot fix it. → enumerate.mjs
   *   the block OVERFLOWED the budget         — DETERMINISTIC. Proven with a stub: 12 pinned with
   *                                             uncapped titles injects 9306c, drops the rest, and
   *                                             prompt #2 re-injects BYTE-IDENTICAL output with the
   *                                             flag still set. Forever. `!orientDropped` was
   *                                             re-owing an orientation whose retry is a copy of
   *                                             itself — a loop, not a re-owe.
   *
   * A partial block IS a real cost, and it is already paid correctly four lines up: on a drop we
   * mark NOTHING served, so every dropped record stays eligible and arrives later as an ordinary
   * search hit with its full text. That is the recovery path. Re-running the orient is not — it
   * re-renders the same block, drops the same lines, and eats the budget the hits needed.
   *
   * THE PREDICATE WAS ALSO UNREACHABLE. `orientOk` itself is correct; what makes it usable here is
   * that a `return` no longer sits 150 lines above it.
   *
   * The nothing-to-inject guard's body was `writeState`, which made it a second, partial commit
   * site: `promptCount` written, these three fields skipped. That is accidentally correct for the
   * two below — nothing delivered means nothing newly served and no nudge to retire — and WRONG
   * here, because the three are not the same kind of receipt:
   *
   *   injectedIds / nudgedSig  — "did the agent SEE this content?"  → gate on DELIVERY
   *   orientPending            — "did we DO the orientation?"       → gate on the ACTION
   *
   * An orient that ran and had nothing to say is a COMPLETED orientation with no content. A
   * content-gated commit site cannot see it — so every earlier placement of this line within the
   * content model answered the wrong question, in both directions (one cleared it when nothing
   * ran; another kept it when nothing was there to run on).
   *
   * Hence: COMMIT, then decide whether to SPEAK. State is settled at exactly one site, and
   * "nothing to inject" is what it always was — an OUTPUT decision, made below, after this.
   */
  /**
   * THE FIRST FIX AT THIS SITE THAT LATCHES OFF — i.e. the unrecoverable direction.
   *
   * This was `if (isFirstPrompt && orientOk) state.orientPending = false`, so recall could only ever
   * WRITE false. It never re-owed anything; the flag survived a failure only by not being touched.
   * That works when the flag is already `true` — and silently loses the orientation when it is
   * `undefined`, which is the PRE-FLAG path two lines up (`orientPending === undefined &&
   * !promptCount`). Trace it: prompt #1 of a pre-flag session, orient FAILS → nothing writes the
   * flag → but `promptCount` just became 1 → `!state.promptCount` is now false → `isFirstPrompt` is
   * false FOREVER. The session never orients, and no other code path can rescue it, because this is
   * the only line in the file that touches the flag.
   *
   * MEASURED before the fix: pre-flag state, enumeration 500, search up — prompt #1 orientPending
   * `undefined`, prompt #2 `undefined`, no orientation either time. Gone.
   *
   * Every earlier fix at this site latched ON: over-offering, which this file's own rule calls
   * recoverable ("over-offering is recoverable, a false receipt is not"). This one is the false
   * receipt — the boundary consumed by a failure, the exact failure mode that rule exists to
   * prevent, resurfacing through the one state value the fix never wrote.
   *
   * So WRITE THE VERDICT, both ways. `!orientOk` is the whole rule: the orient ran → consumed;
   * it did not → still owed, and now recorded as `true` so the pre-flag path never has to infer it
   * from a counter that has already moved. A flag that can only be cleared is not a flag, it is a
   * default with extra steps.
   */
  if (isFirstPrompt) state.orientPending = !orientOk;
  state.injectedIds = [...served].slice(-200);
  // The nudge signature commits here for the same reason. See the compute site.
  if (nudgeLines.length) state.nudgedSig = nudgeSig;
  // Same rule, same reason, for the orphan block: committed only if it was really DELIVERED. An
  // orphan nudge computed and then dropped for budget must return — the set changes only when
  // another sweep lands, so retiring it here would strand a done session's candidates for good.
  if (orphanLines.length) state.orphanSig = orphanSignature;
  /**
   * WRITE THE CLAIMS THIS TURN DECIDED ON. The decision — first claim vs renewal, who is eligible,
   * how often — is `planClaimRenewals` in sweep.mjs, where it can be tested; three stacked comment
   * blocks used to sit here restating rules the code beneath them no longer implemented on its own.
   *
   * What is local to this call site, and only this: the append goes to the ORPHAN's queue, not
   * ours. It is a fact about that queue's disposal and it must be visible to every other session's
   * `orphanedPending`, which reads exactly there.
   */
  const toStamp = planClaimRenewals({
    orphans: heldOrphans,
    pick: orphanPick,
    delivered: orphanLines.length > 0,
    sessionId: realSid,
    nowMs: Date.now(),
    renewEveryMs: HANDED_TTL_MS / 4,
  });
  for (const { sid, why } of toStamp) {
    if (!markHanded(sid, sessionId)) {
      hlog('recall', `orphan claim NOT ${why === 'renewed' ? 'renewed' : 'recorded'} for ${String(sid).slice(0, SID_DISPLAY_LEN)} (queue append failed) — another session may be offered the same queue; settle or ignore promptly`, sessionId);
    }
  }
  // THE ONLY state commit in this hook — keep it that way.
  //
  // Refuse ONLY when the bytes are UNKNOWN. `unreadable` means `state` is DEFAULTS, so this write
  // would erase promptCount, injectedIds, orientPending and lastAssistant — and a torn read is
  // transient (33.7% of reads tore under concurrency; the bytes are usually fine a millisecond
  // later). Publishing defaults converts a self-healing read failure into permanent loss. Skipping
  // costs this turn's bookkeeping; writing costs the session. → state.mjs.
  if (stState === 'unreadable') {
    hlog('recall', `state read UNREADABLE — NOT writing back (would publish defaults over a torn read); this turn's promptCount/served-ids are not recorded`, sessionId);
  } else {
    writeState(sessionId, state);
  }

  // Nothing to say. State is already committed above, so this is purely about not emitting an
  // empty block. (It also catches a case the old guard missed: an orient block computed and then
  // dropped whole for budget left `orientLines.length > 0`, walked past the guard, and shipped
  // `additionalContext: ''`.)
  if (!ctx) {
    hlog('recall', `no hits (prompt #${state.promptCount}${isFirstPrompt ? ', ORIENT' : ''})`, sessionId);
    return;
  }
  hlog(
    'recall',
    `injected ${orientLines.length ? `${orientLines.length} orient + ` : ''}` +
      `${nudgeLines.length ? `NUDGE(${nudgeCount} candidates) + ` : ''}` +
      `${orphanLines.length ? `ORPHAN-NUDGE(${orphanPick.pending.length} from ${orphanPick.sid.slice(0, SID_DISPLAY_LEN)}) + ` : ''}${kept.length} hits` +
      `${dropped ? ` (${dropped} DROPPED for budget)` : ''}, ${ctx.length}c ` +
      `(prompt #${state.promptCount}${isFirstPrompt ? ', ORIENT multi-query' : ''})`,
    sessionId,
  );
  return out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } });
}

/**
 * THE WIDEST FAIL-OPEN SURFACE IN THIS HOOK — and it was the silent one.
 *
 * This was `main().catch(() => {})`. ANY throw anywhere in main() lands here, so a hook that dies
 * on line one and a hook that ran perfectly and had nothing to say produced the SAME observable:
 * nothing. That is the founding story behind this discipline (a recall hook read the wrong field name and no-op'd for a
 * week) sitting on the outermost line of six different hooks — including, pointedly,
 * `recall-eval-worker.mjs`, whose own comment names a bug this construct swallowed.
 *
 * It was also invisible to this discipline's own ENFORCER: `receipt-lint-test.mjs` matched only `catch (e) {` and
 * consumed `(() => {})` as the optional binding, landing on `;` where it wanted `{`, and skipping
 * the block entirely. Six swallows, zero findings, green build. The lint reads arrow handlers now.
 *
 * Exit stays 0 and nothing rethrows: a hook must never break the user's turn. The log is the whole
 * remedy — it makes "dead" distinguishable from "quiet", which is all this discipline ever asks.
 */
main().catch((e) => {
  try { hlog('recall', `hook CRASHED (${e?.code || e?.name || 'error'}) — this invocation did NOTHING: ${e?.message || e}`); }
  catch { /* silence-ok: the log IS the last resort; if it throws too there is nowhere left to report, and breaking the turn over a logging failure would be worse than the silence. */ }
});
