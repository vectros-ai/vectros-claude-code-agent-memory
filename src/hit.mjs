/**
 * Search-hit → injected line. SHARED by recall.mjs (prompt-time recall/orient) and
 * recall-eval-worker.mjs (mid-run recall).
 *
 * It used to live as a byte-for-byte copy in both ("Same reshape as recall.mjs — see its
 * comment"), which is a drift bug waiting to happen: every fix here had to be made twice, and the
 * injection format IS the product. One module, one format.
 *
 * ── WHAT AN INJECTED LINE IS FOR ────────────────────────────────────────────────────────
 * The line is not a search result. It is a PITCH: its only job is to make the agent either
 * (a) act on the claim, or (b) decide to spend a `record_get`/`document_get` opening it.
 * A line that proves a document EXISTS but gives no reason to open it is worse than useless —
 * it costs tokens and buys nothing.
 *
 * MEASURED FAILURE (a real session, the reason this file exists): a highly relevant decision doc
 * was surfaced mid-task at the exact right moment, went UNREAD, and the session re-derived its
 * content from source code instead. The loop worked end-to-end and still changed nothing, because
 * the payload could not compete with a comment already sitting in the code. The title plus one
 * truncated line proved the doc existed but gave no reason to open it.
 *
 * The budget it was spent on, per that hit:
 *     label  = `0042-some-internal-decision.md`   <- metadata.title is the FILENAME
 *     text   = `<!-- ingest marker --> # Some Internal Decision — a summary of what changed and
 *               why, followed by the actual payoff clause **Status:**…`
 * ...truncated one clause after the payoff. The payoff clause WAS the answer that session needed.
 * The budget was spent on a filename, an ingest marker, and a duplicate of the title, then cut
 * off right before the payoff.
 *
 * ── SO: LEAD WITH THE CLAIM ─────────────────────────────────────────────────────────────
 * `metadata.summary` already holds a curated one-line claim — present on every curated doc, and
 * NEVER read until now. It is strictly better than the filename and than the head-chunk prose,
 * per char. Use it; fall back to the title.
 *
 * `metadata.status` rides along at ~8 chars and is load-bearing: a `superseded` doc that surfaces
 * as an authoritative-looking hit is an ACTIVE hazard (search can surface a stale passage without
 * its deprecation banner attached). The reader must see it on the line, not after opening the doc.
 *
 * The matched passage still ships — it says WHY this hit matched, which the summary cannot — but
 * it is now the supporting act, and it is dropped entirely when it merely restates the summary
 * (the head-chunk case above, where it is pure duplication).
 */

/**
 * The authority clause every injection carries. Shared so prompt-time recall, orient, and
 * mid-run recall cannot drift apart.
 *
 * It used to read, flatly: "Treat a hit as authoritative over re-derivation." That is RIGHT for
 * *has this been decided* and WRONG for *does this behave* — and the difference showed up in a
 * real session: recall's own authority clause argued for trusting it over re-derivation, but
 * re-deriving from code there was correct and necessary. The doc said the design was decided; only
 * the code and the tests could say it works.
 *
 * Both halves matter. Drop the authority and we are back to recall-as-suggestion, which this rule
 * exists to overrule — a real hit DID correctly outrank re-derivation on a separate, earlier case.
 * Overstate it and we license trusting a design doc about runtime behavior — the exact mistake the
 * standing rule "verify against the code, not memory" already forbids. Say both.
 */
import { HIT_CLAIM_MAX_CHARS, HIT_PASSAGE_MAX_CHARS, HIT_RECORD_MAX_CHARS, HIT_LABEL_MAX_CHARS } from './config.mjs';

export const AUTHORITY =
  'A hit is AUTHORITATIVE for what was DECIDED (and whether it still stands) — do not re-derive ' +
  'a settled decision from code. It is NOT evidence of what the code DOES: verify behavior ' +
  'against the code and its tests. Check `status` on the line — a superseded doc still ranks. ' +
  'Pull full content with record_get/document_get when a claim is not enough to act on.';


/** Ingest boilerplate that carries zero signal to a reader but eats the budget. */
function clean(s) {
  return String(s ?? '')
    // Strips ingest-pipeline boilerplate (HTML comments used as document markers by the search
    // backend's ingest process) and any other comment — this is text meant for a retrieval
    // index, not prose a person reads directly.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Compare on words alone — punctuation, case, and em-dash-vs-colon must not defeat a match. */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A broad query ranks a document's HEAD chunk, whose first sentence is the title — i.e. the
 * same words as `metadata.summary`. Printing both spends the budget twice on one sentence, which
 * is precisely how a real hit's actual content got truncated away in production. Drop the echo,
 * keep the rest.
 *
 * Compares NORMALIZED words, not raw prefixes: the first cut compared 24 raw chars and missed
 * this exact case, because the chunk reads `# 0042-some-internal-decision: A Decision Title…`
 * while the claim reads `A Decision Title…` — the numbered-doc prefix alone defeated it.
 * (Verified against live hits; a fixture would have "passed".)
 */
function dropEchoedTitle(text, claim) {
  const t = text
    .replace(/^#{1,6}\s*/, '')                      // markdown heading marker
    .replace(/^(ADR|RFC)[-\s]?\d+\s*[:—–-]\s*/i, '') // a numbered-decision-doc prefix — in the doc, not in the claim
    .trim();
  const firstSentence = (t.match(/^[^.\n]{0,300}/) || [''])[0];
  const nFirst = norm(firstSentence);
  const probe = nFirst.slice(0, 60);
  if (probe.length >= 20 && norm(claim).includes(probe)) {
    const rest = t.slice(firstSentence.length).replace(/^[.\s]+/, '').trim();
    return rest.length > 60 ? rest : ''; // nothing substantive left -> drop the passage entirely
  }
  return t;
}

/**
 * Normalize a hit for injection.
 *
 * DOCUMENTS and RECORDS carry different metadata, BY DESIGN — not a platform gap: the contract
 * is `searchable` fields -> the indexed TEXT; `filterable` fields -> METADATA.
 *   - A document is inherently a titled thing, so `title`/`summary`/`status` are projected.
 *   - A record is an arbitrary schema (`patient`, `clinical_note`, `memory`) with no generic
 *     title, so NONE is projected. For `memory`, `title` is searchable-not-filterable, which
 *     puts it at the FRONT of `chunkText` (chunk = title + body). The projected keys are exactly
 *     the filterable set: kind · area · priority · status · tags.
 * So for records we must NOT fabricate a title (an earlier cut fell through to `recordType` and
 * labelled every memory "memory"). Emit the real facets + the chunk, which leads with the title.
 *
 * NOTE `h.snippet` is ALWAYS null on this API today (verified across every hit shape) — the
 * `h.snippet || h.chunkText` fallback has silently been carrying every call. Kept, in that
 * order, so a future server-side snippet wins automatically; it is not load-bearing today.
 */
export function reshape(h) {
  const meta = h.metadata && typeof h.metadata === 'object' ? h.metadata : {};
  const id = h.documentId || h.recordId || h.id || h.externalId || '';
  const raw = clean(h.snippet || h.chunkText || '');

  // metadata.* facets below are schema-defined but store-authored VALUES — a record's kind/area
  // etc. traces back to whatever created it (a candidate's own kind/area, once promoted), so they
  // are untrusted the same way a search hit's chunk text is. claim/text/passage were already
  // clean()+cut(); label was not (found during this package's public-readiness pass) — every
  // facet now goes through clean() before joining, and the assembled label is capped like
  // everything else.
  if (h.sourceType === 'GenericRecord') {
    const facets = [meta.recordType, meta.kind, meta.area, meta.priority ? `p${meta.priority}` : '']
      .map(clean).filter(Boolean).join(' · ');
    return { id, label: cut(facets, HIT_LABEL_MAX_CHARS) || 'record', claim: '', text: cut(raw, HIT_RECORD_MAX_CHARS), isRecord: true };
  }

  // Prefer the curated claim over the filename. `title` is the file name on every curated doc
  // (verified across the corpus) — a locator, not information.
  const file = clean(meta.title || h.title || '');
  const claim = cut(clean(meta.summary || ''), HIT_CLAIM_MAX_CHARS);
  // De-dup: `reference.md` of recordType `reference` renders "reference, reference, …".
  const facets = [...new Set([
    file.replace(/\.(md|txt|pdf)$/i, ''),          // `0042-some-internal-decision`
    clean(meta.recordType || h.typeName || ''),
    clean(meta.area || ''),
    clean(meta.status || ''),                       // superseded/deprecated MUST be visible here
  ].filter(Boolean))].join(', ');

  const passage = claim ? dropEchoedTitle(raw, claim) : raw;
  return { id, label: cut(facets, HIT_LABEL_MAX_CHARS) || file || '(untitled)', claim, text: cut(passage, HIT_PASSAGE_MAX_CHARS), isRecord: false };
}

/**
 * Which retrieval tool resolves a hit's id, named explicitly — never left for the reader to infer
 * from punctuation. MEASURED: two independent sessions both called `record_get` on a real
 * DOCUMENT id and got a misleading 404, because the only signal distinguishing the two was an
 * implicit separator convention (records join facets with `·`; documents with `,` + a `¦`
 * divider). That convention was never a contract — it was load-bearing punctuation nobody chose
 * on purpose. Say the tool.
 */
function kindFor(r) { return r.isRecord ? 'record' : 'doc'; }
function toolFor(r) { return r.isRecord ? 'record_get' : 'document_get'; }

/**
 * One injected bullet.
 *   record : `- [record · memory · feedback · repo · p30] <chunk> \`id\` (record_get)`
 *   doc    : `- [doc · 0042-…, decision, data-model, accepted] <claim> ¦ <why it matched> \`id\` (document_get)`
 * The `¦` separates the curated claim from the matched passage so the reader can tell which is
 * the document's own thesis and which is just the text that happened to rank. The leading
 * `record ·`/`doc ·` marker and the trailing `(record_get)`/`(document_get)` are the fix for the
 * ambiguity above: both the retrieval tool AND the entity kind are stated on the line itself, not
 * implied by which separator the facets happen to use.
 */
export function renderLine(r) {
  const kind = kindFor(r);
  const tool = toolFor(r);
  if (r.isRecord) return `- [${kind} · ${r.label}] ${r.text}${r.id ? ` \`${r.id}\` (${tool})` : ''}`;
  const body = [r.claim, r.text].filter(Boolean).join(' ¦ ');
  return `- [${kind} · ${r.label}] ${body}${r.id ? ` \`${r.id}\` (${tool})` : ''}`;
}

/**
 * The compressed re-mention of a hit already shown earlier this session (recall.mjs's
 * dedup-to-pointer path). The actual root cause this fixes: this line used to drop `isRecord`
 * entirely — `[recalled earlier: ${label} · ${id}]` — so a back-referenced document looked
 * identical to a back-referenced record, and by the time a hit reaches this path the reader has
 * no other line to cross-check against (the full render is gone, evicted by dedup). Carry the
 * same kind/tool marker as `renderLine` so the two paths cannot drift apart on the one property
 * that matters.
 */
export function renderBackRef(r) {
  return `- [recalled earlier: ${kindFor(r)} · ${r.label} · \`${r.id}\` (${toolFor(r)})]`;
}
