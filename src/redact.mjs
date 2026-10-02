/**
 * THE REDACTION GATE — the content-safety check every proposal passes through before it can leave
 * this machine. Called from `propose()` (candidates.mjs), the single choke point every write path
 * (live capture, recovery/backfill) funnels through, so nothing can reach the network by skipping
 * a step that isn't the actual POST.
 *
 * THREE CLASSES, TWO DISPOSITIONS:
 *
 *   - Secrets/credentials are SYNTACTIC — a known format (an AWS-shaped key, a PEM block, a bearer
 *     JWT, a `user:pass@host` connection string). Layer 1 (`scanSecrets`, pure, synchronous, zero
 *     network) finds the exact span and REDACTS IT IN PLACE — the candidate still transmits, minus
 *     the secret. This is the one class where "find the exact span" is a well-defined problem, and
 *     the residual risk of an under-matched regex is bounded to the installer's own tenant (the
 *     `candidate` record it lands in is `indexMode: NONE` — never searchable — reachable only by a
 *     direct lookup within that installer's own tenant), which is what makes automatic redaction an
 *     acceptable trade for the common case (a good lesson with one leaked key in it). This is a
 *     best-effort local scan of known formats, not a compliance-grade universal secret detector — a
 *     shape it does not recognize still transmits.
 *   - Customer/PII identifiers are SEMANTIC — no fixed shape reaches them ("customer Jane Doe at
 *     Acme Corp was double-billed" has no token to blank out). Layer 2 (`classify`, one small local
 *     model call per candidate, on the ALREADY-DISTILLED text only — never the raw transcript)
 *     makes a JUDGMENT call, not a token-shape check: does this describe a real, identifiable
 *     individual/org. That class is not redacted — the candidate is QUARANTINED (never
 *     transmitted). Security-related lessons and findings are deliberately NOT a class: the
 *     candidate lands in the installer's own tenant (store-only, never searchable), and
 *     withholding ordinary security engineering knowledge is a cost with no matching benefit.
 *
 * QUARANTINE IS NOT DELETION. `queue.mjs`/the JSONL review log already persist every candidate
 * locally BEFORE the network step runs today, regardless of this gate — quarantining only stops
 * the automatic network POST; nothing here deletes anything. ⚠️ IT IS ALSO NOT YET REVIEWABLE:
 * `dispose.mjs` reads the installer's live Vectros store (`bySession()`), and a quarantined
 * candidate never reaches that store — so it does not appear in `dispose.mjs --list` or any other
 * review surface today. The content survives only in this machine's own local files, not in
 * anything a human is expected to read. Closing that gap (surfacing a quarantined candidate
 * somewhere reviewable) is real follow-up work this change does not attempt.
 *
 * A QUARANTINE VERDICT IS TERMINAL, NEVER RE-JUDGED. `gate()`'s return value distinguishes a
 * DEFINITIVE verdict (a deterministic pattern match, or a classifier call that actually completed
 * and returned something) from the classifier being genuinely UNAVAILABLE (couldn't spawn, timed
 * out, no output at all) — see `reason`'s two prefixes below. Only the caller (`candidates.mjs`)
 * can make "definitive" actually mean "asked once, never asked again": a definitive quarantine
 * must be recorded as SETTLED on the very first attempt, not retried. The reason this matters more
 * here than for a deterministic regex: the classifier is a sampled model call, so re-asking the
 * SAME question on every spool retry is not "trying again", it is drawing again from a distribution
 * — and a spool that retries up to `SPOOL_MAX_ATTEMPTS` times would give a borderline candidate that
 * many independent chances for one lucky "clean" draw to undo a real flag. See candidates.mjs's
 * `propose()` and spool.mjs's `markQuarantined` for the terminal-settlement half of this contract;
 * this file only promises that its OWN verdict, once given, does not change meaning on replay against
 * the identical input (the pattern layer already doesn't; the classifier still WOULD, unless the
 * caller refuses to ask it twice — which is why settlement, not caution here, is what closes this).
 *
 * `reason` on the `send:false` path is one of two shapes:
 *   `quarantined:<class>` — a DEFINITIVE answer was reached (a pattern matched deterministically, a
 *     field couldn't be safely scanned, or the classifier ran and returned something). Chargeable
 *     and terminal — asked once, settled once, never retried.
 *   `unavailable:<what>`  — the classifier could not be asked at all (spawn failure, timeout, no
 *     prompt file). This is an ENVIRONMENT problem, not a content judgment — no verdict was reached,
 *     so nothing here is "asked and answered". The caller must treat this like any other network/
 *     environment failure (non-chargeable, halts the batch, free retry once the environment
 *     recovers) — NEVER as a quarantine, or a flaky machine permanently parks real candidates for a
 *     reason unrelated to what they contain.
 */
import { spawnSync as _spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './creds.mjs';
import { hlog } from './hooklog.mjs';
import { fence } from './transcript.mjs';
import { CLASSIFIER_TIMEOUT_MS } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFIER_PROMPT_FILE = path.join(HERE, 'prompts', 'candidate-classifier.md');

// ── Layer 1: pattern/entropy scan for secrets & credentials (redact-and-send eligible) ──────────
//
// Best-effort, known-shape formats only — see the module header. Not attempted: opaque `Bearer`
// tokens, generic `KEY=value`/`PASSWORD=` assignments, and any format not listed below. A shape
// this list doesn't recognize is a gap in Layer 1, not a gap in the gate as a whole — Layer 2 may
// still catch it if the surrounding sentence reads as identifying a real person or organization,
// but a bare unrecognized credential with no such context will transmit.
const SECRET_PATTERNS = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-temp-access-key-id', re: /\bASIA[0-9A-Z]{16}\b/g },
  // The AWS *secret* access key — the actual credential, not just the key id — only has a fixed
  // shape when labeled (a bare 40-char base64-ish string is indistinguishable from countless other
  // things and would flood this scan with false positives). Labeled assignment only, mirroring the
  // same scoped pattern this monorepo's own public-mirror scrub already uses for the identical risk.
  { name: 'aws-secret-access-key', re: /\baws_secret_access_key\s*[=:]\s*[0-9A-Za-z/+]{40}\b/gi },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  // Trailing `-`/`_` must be part of the CHARACTER CLASS, not left to `\b` — a token whose last
  // random character happens to be `-`/`_` has no word-boundary there (`-`/`_` isn't a `\w`
  // neighbour-breaker the way a space is), so anchoring with `\b` either fails to match at all or
  // silently drops that trailing character out of the redacted span. Anchor on look-arounds instead.
  { name: 'gitlab-pat', re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { name: 'slack-token', re: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm-token', re: /\bnpm_[0-9A-Za-z]{36}\b/g },
  // Base64url (the JWT segment alphabet) legally ends in `-`/`_`, so `\b` after that character
  // class has the same trailing-boundary bug as glpat/xox above — anchor with a lookahead instead.
  { name: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g },
  // This package's OWN partner-API key formats (`sk_live_`/`sk_test_`/`ssk_live_`/`ssk_test_`) —
  // the single most likely secret to appear in one of this package's own transcripts, since it's
  // exactly the credential this tool itself uses (VECTROS_API_KEY). Same pattern already vetted
  // and shipped in this monorepo's own public-mirror scrub for the identical risk.
  { name: 'vectros-api-key', re: /(?<![A-Za-z0-9_-])(sk|ssk)_(live|test)_[A-Za-z0-9_-]{28,}(?![A-Za-z0-9_-])/g },
  // scheme://user:pass@host — redact the whole match (scheme+host is convenience, not the risk).
  { name: 'connection-string-credential', re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]*:[^\s:@/]+@[^\s/]+/g },
];

// A PEM block is the one shape whose END marker can be MISSING (truncated by a field boundary, or
// by the distiller's own char cap) — a lone BEGIN with no matching END in the same scan is treated
// as "found a secret marker, cannot confidently bound it" -> unboundable, never a partial send.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_FULL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * Customer/PII identifiers with a CHECKSUMMABLE shape (an SSN's digit grouping, a Luhn-valid card
 * number) are still syntactically detectable, same as a secret — but they are NOT eligible for
 * redact-and-send. They belong to the customer-identifier CLASS, not the secrets/credentials
 * class: unlike a leaked API key, where blanking the one token removes the entire risk, a real
 * customer's SSN sitting in a sentence usually means the SURROUNDING sentence (who, what happened
 * to them) is itself the disclosure — blanking the digits alone would not make automatic
 * transmission safe.
 */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const REDACT_PLACEHOLDER = '[REDACTED]';

/**
 * Checked for scanning eligibility: a non-string title/body/sourceRef/area, or a non-string tag,
 * means Layer 1 CANNOT scan it at all — silently skipping it would ship whatever it contains
 * untouched. The caller (`gate()`) treats any `nonString` hit as unboundable, the same fail-closed
 * answer as a secret it can't confidently locate.
 *
 * `fields` ITSELF IS RETURNED UNCHANGED (a shallow copy, not rebuilt field-by-field) when nothing is
 * flagged — an earlier version forced every absent field to `null`, which `propose()` then sent as
 * an explicit `null` in the UPSERT payload where the original code would have left the key out
 * entirely (an absent/`undefined` value is dropped by `JSON.stringify`, a `null` is not). Under
 * merge-patch/upsert semantics a `null` can ERASE a value a previous attempt already stored — the
 * exact hazard `propose()`'s own "OMITTED WHEN ABSENT" comment describes for `area`/`sourceRef`/
 * `dest`/`tags`. Since a flagged (`nonString`) result is never read past the early `quarantined:
 * malformed-field` return in `gate()`, there is no need to canonicalise `out` at all — only the
 * BOOLEAN matters there, and the clean path must reproduce the input exactly.
 */
function normaliseFields(fields) {
  let nonString = false;
  for (const key of ['title', 'body', 'sourceRef', 'area']) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') nonString = true;
  }
  if (fields.tags !== undefined && fields.tags !== null) {
    if (!Array.isArray(fields.tags)) nonString = true;
    else {
      for (const t of fields.tags) {
        if (t !== undefined && t !== null && typeof t !== 'string') nonString = true;
      }
    }
  }
  return { fields: { ...fields }, nonString };
}

/** Concatenate the scanned fields into one string, tracking each field's [start,end) range, so a
 *  match found in the combined text can be mapped back to (and safely bounded within) ONE field. */
/**
 * KNOWN RESIDUAL GAP, disclosed rather than silently accepted: only the PEM pattern can match
 * ACROSS the `\n` separator this function joins fields with (its `[\s\S]*?` body is the one pattern
 * here that spans newlines at all), so only a PEM block gets the boundary-crossing protection below.
 * A single-line secret (an AKIA key, a JWT, a token) split exactly across two fields — e.g. the
 * first half at the very end of `title`, the second half at the very start of `body` — would not be
 * recognized as one match by either field's own scan and would transmit whole. Considered low-
 * likelihood (it requires an exact split at a field boundary, not just truncation) and accepted
 * rather than joining fields WITHOUT a separator (which would risk merging two adjacent, unrelated
 * clean tokens into a false match instead).
 */
function buildCombined(fields) {
  const parts = [];
  const layout = [];
  let offset = 0;
  for (const key of ['title', 'body', 'sourceRef', 'area']) {
    const v = fields[key];
    if (typeof v !== 'string' || !v) continue;
    layout.push({ field: key, start: offset, end: offset + v.length });
    parts.push(v);
    offset += v.length + 1; // +1 for the joining separator, which is why matches spanning it are caught as boundary-crossing
  }
  if (Array.isArray(fields.tags)) {
    fields.tags.forEach((t, i) => {
      if (typeof t !== 'string' || !t) return;
      layout.push({ field: 'tags', index: i, start: offset, end: offset + t.length });
      parts.push(t);
      offset += t.length + 1;
    });
  }
  return { combined: parts.join('\n'), layout };
}

/** Merge overlapping/adjacent spans (several patterns can match the same or overlapping text) and
 *  sort ascending, so `applyRedactions` never double-counts or crosses a boundary mid-replacement. */
function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

function applyRedactions(text, spans) {
  if (!spans.length) return text;
  let out = '';
  let cursor = 0;
  for (const s of mergeSpans(spans)) {
    out += text.slice(cursor, s.start) + REDACT_PLACEHOLDER;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/**
 * Scan `fields` (`{title, body, sourceRef, area, tags}`, already run through `normaliseFields`) for
 * known-shape secrets.
 *
 * Returns `{ matched, unboundable, redacted }`. `redacted` is the field set to actually transmit —
 * unchanged (`=== fields`) when nothing matched. `unboundable: true` means a match was found that
 * this function refuses to redact with confidence (a PEM marker with no matching end in scope, or a
 * match whose span crosses two fields) — the caller must quarantine, never send `redacted` in that
 * case.
 */
export function scanSecrets(fields) {
  const { combined, layout } = buildCombined(fields);
  if (!combined) return { matched: false, unboundable: false, redacted: fields };

  const found = [];
  let unboundable = false;

  for (const m of combined.matchAll(PEM_FULL)) found.push({ start: m.index, end: m.index + m[0].length });
  for (const m of combined.matchAll(PEM_BEGIN)) {
    const covered = found.some((f) => m.index >= f.start && m.index < f.end);
    if (!covered) unboundable = true; // a BEGIN with no matching END in scope — could be split across a field boundary or simply truncated
  }
  for (const { re } of SECRET_PATTERNS) {
    for (const m of combined.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length });
  }

  if (!found.length && !unboundable) return { matched: false, unboundable: false, redacted: fields };

  const byField = new Map(); // 'title'|'body'|'sourceRef'|'area'|`tags:${i}` -> local spans
  for (const f of found) {
    const containing = layout.find((l) => l.start <= f.start && f.end <= l.end);
    if (!containing) { unboundable = true; continue; } // spans two fields (or a separator) — cannot safely excise from one string
    const key = containing.field === 'tags' ? `tags:${containing.index}` : containing.field;
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key).push({ start: f.start - containing.start, end: f.end - containing.start });
  }

  if (unboundable) return { matched: true, unboundable: true, redacted: fields };

  const redacted = { ...fields };
  for (const key of ['title', 'body', 'sourceRef', 'area']) {
    const spans = byField.get(key);
    if (spans) redacted[key] = applyRedactions(fields[key], spans);
  }
  if (Array.isArray(fields.tags)) {
    redacted.tags = fields.tags.map((t, i) => {
      const spans = byField.get(`tags:${i}`);
      return spans && typeof t === 'string' ? applyRedactions(t, spans) : t;
    });
  }
  return { matched: true, unboundable: false, redacted };
}

/** Does `fields` contain a checksummable customer/PII shape (SSN, a Luhn-valid card number)? These
 *  quarantine on sight — see the header comment on why they are never redact-and-send eligible. */
export function scanPii(fields) {
  const { combined } = buildCombined(fields);
  if (!combined) return false;
  if (SSN_RE.test(combined)) return true;
  for (const m of combined.matchAll(CC_CANDIDATE_RE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

// ── Layer 2: the identifiability classifier ─────────────────────────────────────────────────────

const VERDICTS = new Set(['clean', 'customer_identifier']);

const CLASSIFIER_MODEL = process.env.VECTROS_MEM_CLASSIFIER_MODEL || process.env.VECTROS_CAPTURE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_BIN =
  process.env.CLAUDE_CODE_BIN ||
  (process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude');

/**
 * Judge whether `fields` (already past the secret scan) describes a real, identifiable individual
 * or organization. Security-related content is deliberately NOT a class: a lesson about a
 * vulnerability, an auth flow or a hardening fix is ordinary engineering knowledge and transmits.
 *
 * ⚠️ KNOWN GAP, disclosed rather than silently accepted: this function's PLUMBING (spawn, timeout,
 * exit-code/`is_error` handling, JSON extraction, fail-closed on any non-clean/unparseable outcome)
 * is fully unit-tested with a fake `spawnImpl` (redact-test.mjs). The classifier's actual JUDGMENT
 * QUALITY — does it correctly tell a real, identifiable customer from a benign name-mention from an
 * idiomatic placeholder ("Jane Doe", "Acme Corp") — is verified only by reading the prompt, never by
 * a real model call. A `redact-real-test.mjs` exercising the three fixture shapes against the real
 * classifier (mirroring this package's existing `drain-real-test.mjs`/`triage-real-test.mjs`
 * convention, gated behind `--all`/`VECTROS_MEM_TEST_ALL=1`) is real follow-up work, explicitly
 * approved to ship without one rather than silently skipped — not fixed here.
 *
 * Returns `{ ok: true, verdict }` when the classifier actually RAN and produced a syntactically
 * valid answer (`verdict` is one of `VERDICTS`, or `'uncertain'` for a well-formed-but-unrecognised
 * reply) — this is a DEFINITIVE outcome, safe to settle and never re-ask.
 *
 * Returns `{ ok: false }` when the classifier could not be asked at all — the prompt file is
 * missing, the spawn threw, the process exited non-zero, was killed by the timeout, or produced no
 * output. This is an AVAILABILITY failure, not a verdict: nothing was judged, so the caller must
 * NOT treat it as a quarantine (that would punish a candidate for its own content when the actual
 * cause was a broken/offline classifier) — see the module header's `unavailable:` reason shape.
 *
 * `spawnImpl` is injectable, mirroring `candidates.mjs`'s `fetchImpl` seam — the suite exercises
 * every branch (timeout, non-zero exit, garbage output) without a real `claude` binary.
 */
export async function classify(fields, { spawnImpl = _spawnSync } = {}) {
  let sys = '';
  try { sys = fs.readFileSync(CLASSIFIER_PROMPT_FILE, 'utf8'); }
  catch (e) {
    // The prompt ships beside this module, so any failure here is structural (a broken install),
    // not a per-candidate content problem — this candidate was never actually judged.
    hlog('redact', `classifier prompt UNREADABLE (${e.code}) at ${CLASSIFIER_PROMPT_FILE} — classifier UNAVAILABLE`);
    return { ok: false };
  }

  const args = [
    '-p',
    '--model', CLASSIFIER_MODEL,
    '--system-prompt', sys,
    '--output-format', 'json',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
    // Same no-tool, single-turn posture as capture-worker.mjs's distiller call, for the same
    // reason: this is a judgment pass over already-produced text, never an agentic loop.
    '--disallowed-tools',
    'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,' +
      'TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode,AskUserQuestion,' +
      'Skill,ToolSearch,Monitor,SendMessage,TaskCreate,TaskUpdate,TaskOutput,TaskStop,TaskList,' +
      'TaskGet,EnterWorktree,ExitWorktree,EnterPlanMode,Artifact,Workflow,CronCreate,CronList,' +
      'CronDelete,RemoteTrigger,PushNotification,ListMcpResourcesTool,ReadMcpResourceTool',
    '--max-turns', '1',
  ];

  // Only title/body/sourceRef are handed to the model — area/tags are short structured metadata,
  // not prose, and are not part of what this classifier judges (identifiability
  // reasoning needs a sentence to read, which area/tags don't provide).
  const body = JSON.stringify({ title: fields.title || '', body: fields.body || '', sourceRef: fields.sourceRef || '' });
  let res;
  try {
    res = spawnImpl(CLAUDE_BIN, args, {
      input: `<candidate>\n${fence(body)}\n</candidate>`,
      encoding: 'utf8', timeout: CLASSIFIER_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024, env: childEnv(), windowsHide: true,
    });
  } catch (e) {
    hlog('redact', `classifier spawn THREW (${e?.code || e?.message || 'error'}) — classifier UNAVAILABLE`);
    return { ok: false };
  }
  // status === null happens on a timeout kill (spawnSync sets status to null and signal to the kill
  // signal) — an availability failure, not a verdict, same as a non-zero exit or empty stdout.
  if (!res || res.status !== 0 || !res.stdout) {
    hlog('redact', `classifier exit ${res?.status ?? '(no result)'} — classifier UNAVAILABLE`);
    return { ok: false };
  }
  /**
   * `claude -p --output-format json` CAN EXIT 0 WHILE REPORTING ITS OWN FAILURE — a usage-limit hit,
   * an API error mid-call, or hitting `--max-turns` all surface as `is_error: true` in the envelope,
   * not as a non-zero exit. Checked here, BEFORE the exit-0 status above is trusted as "the model
   * answered": without this, that shape fell through to the generic "ran but said something odd"
   * path below and became a DEFINITIVE 'uncertain' verdict — i.e. a real outage disguised as a
   * content judgment, TERMINALLY quarantining a candidate nothing ever actually classified. A
   * malformed envelope here (this parse fails) falls through unchanged to the existing extraction
   * below, which has its own fallback — this check only ever SUBTRACTS a false verdict, never adds one.
   */
  try {
    const envelope = JSON.parse(res.stdout);
    if (envelope && envelope.is_error === true) {
      hlog('redact', `classifier call itself errored (subtype=${envelope.subtype ?? 'unknown'}) — classifier UNAVAILABLE, not a verdict`);
      return { ok: false };
    }
  } catch { /* silence-ok: an unparseable envelope is exactly what the modelText fallback right below already handles — nothing new to report here. */ }
  // From here on, the process DID run and did NOT report is_error — a bad/garbled/off-contract
  // reply from here is the model having answered badly, not the classifier being unavailable, so
  // every remaining failure is a DEFINITIVE 'uncertain' verdict, not an availability failure.
  let modelText;
  try { modelText = JSON.parse(res.stdout).result; }
  catch { /* silence-ok: `--output-format json` is requested but not guaranteed — same fallback as capture-worker.mjs's distill(); raw stdout is the documented alternative, and the checks below still catch real garbage. */ modelText = res.stdout; }
  if (typeof modelText !== 'string') return { ok: true, verdict: 'uncertain' };
  const m = modelText.match(/\{[\s\S]*\}/);
  if (!m) return { ok: true, verdict: 'uncertain' };
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { /* silence-ok: an unparseable reply is exactly the "uncertain" verdict this function exists to fail closed on — the return value IS the receipt, so no separate log line adds information. */ return { ok: true, verdict: 'uncertain' }; }
  return { ok: true, verdict: VERDICTS.has(parsed?.verdict) ? parsed.verdict : 'uncertain' };
}

/**
 * The combined gate. `fields` is what `propose()` is about to transmit; returns either
 * `{ send: true, fields }` (possibly with secrets redacted) or `{ send: false, reason }` — the
 * caller must not transmit anything at all on the `send: false` path. See the module header for
 * what the two `reason` prefixes (`quarantined:`/`unavailable:`) mean to the caller.
 */
export async function gate(fields, opts = {}) {
  const { fields: norm, nonString } = normaliseFields(fields);
  // A field this gate cannot even read as text cannot be scanned by Layer 1 at all — shipping it
  // unscanned would defeat the whole gate for whatever content lives in it. Deterministic (the
  // shape of the distiller's own output, not a sampled judgment), so this is a definitive verdict.
  if (nonString) return { send: false, reason: 'quarantined:malformed-field' };

  // PII shapes quarantine before spending a classifier call — they are never redact-and-send
  // eligible regardless of what the classifier would say about the surrounding sentence.
  if (scanPii(norm)) return { send: false, reason: 'quarantined:customer_identifier' };

  const secretScan = scanSecrets(norm);
  if (secretScan.unboundable) return { send: false, reason: 'quarantined:secret-unboundable' };

  // Classify the ALREADY-REDACTED text (if a secret was found) — the classifier never needs to see
  // a raw secret to judge identifiability, and there is no reason to hand it
  // one when Layer 1 has already excised it.
  const toClassify = secretScan.matched ? secretScan.redacted : norm;
  const result = await classify(toClassify, opts);
  if (!result.ok) return { send: false, reason: 'unavailable:classifier' };
  if (result.verdict !== 'clean') return { send: false, reason: `quarantined:${result.verdict}` };
  return { send: true, fields: toClassify };
}
