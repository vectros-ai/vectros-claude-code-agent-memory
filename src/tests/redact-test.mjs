#!/usr/bin/env node
/**
 * THE REDACTION GATE — Layer 1 (pattern scan), Layer 2 (classifier plumbing), and the combined
 * `gate()` orchestration, each with a FAKE transport so nothing here spawns a real process.
 * `propose()`'s WIRING of a gate verdict (does it actually send the redacted fields, does a
 * quarantine reach zero network calls, does an UNAVAILABLE classifier map to the right non-
 * chargeable reason) is tested separately in candidates-test.mjs §14 — this file is redact.mjs's
 * own logic in isolation.
 *
 * THE LOAD-BEARING CASES are the boundary-straddling ones (§1c/§1d below): a secret whose span
 * crosses two fields, or whose END marker never arrives, must quarantine rather than ship a
 * partially-scrubbed payload — a test that only checked "was something replaced with [REDACTED]"
 * would pass on a redactor that silently drops the un-terminated half of a private key. §3's
 * ok/verdict split is equally load-bearing: conflating "the classifier ran and said something" with
 * "the classifier could not be asked at all" is what let a flaky machine permanently park real
 * candidates in an earlier version of this gate (see candidates.mjs's CHARGEABLE comment).
 */
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { check, eq, done } from './assert.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSecrets, scanPii, classify, gate } from '../redact.mjs';

// ── 1. LAYER 1: scanSecrets ──────────────────────────────────────────────────────────────────────
console.log('=== 1. scanSecrets — redact-in-place for known-shape secrets ===');
{
  // 1a. A clean candidate is untouched, and `redacted` is the SAME object — a caller doing
  // `secretScan.matched ? secretScan.redacted : fields` must not allocate on the common (clean) path.
  const fields = { title: 'a normal lesson', body: 'nothing sensitive here', sourceRef: null, area: 'auth', tags: ['x'] };
  const r = scanSecrets(fields);
  check('no match, no false positive', !r.matched && !r.unboundable);
  check('the clean path returns the SAME object, not a copy', r.redacted === fields);
}
{
  // 1b. A single, cleanly-bounded secret mid-sentence: redacted, the rest of the lesson survives.
  const fields = { title: 'AWS key AKIAIOSFODNN7EXAMPLE was hardcoded, moved to Secrets Manager', body: 'b' };
  const r = scanSecrets(fields);
  check('matched, and boundable', r.matched && !r.unboundable);
  check('the key itself is gone', !r.redacted.title.includes('AKIAIOSFODNN7EXAMPLE'), r.redacted.title);
  check('the surrounding lesson survives', r.redacted.title.includes('was hardcoded, moved to Secrets Manager'), r.redacted.title);
}
{
  // The AWS *secret* access key — the actual credential, not just the key id — only matches when
  // labeled, since a bare 40-char string has no shape of its own to key off.
  const fields = { title: 't', body: 'found in config.yml: aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, rotated it' };
  const r = scanSecrets(fields);
  check('a labeled AWS secret access key is matched', r.matched && !r.unboundable, JSON.stringify(r));
  check('the secret value is gone', !r.redacted.body.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), r.redacted.body);
}
{
  // This package's OWN partner-API key format (sk_/ssk_ + live/test + 28+ chars) — the credential
  // this tool itself uses, and the single most likely secret to appear in one of its own transcripts.
  const fields = { title: 't', body: 'VECTROS_API_KEY was ssk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6' + ', rotated' };
  const r = scanSecrets(fields);
  check('this package\'s own ssk_live_ key format is matched', r.matched && !r.unboundable, JSON.stringify(r));
  check('the key value is gone', !r.redacted.body.includes('a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'), r.redacted.body);
}
{
  // A GitLab PAT whose last random character happens to be `-` — the trailing-boundary case: an
  // earlier version of this pattern anchored with `\b`, which either failed to match at all or
  // silently left the trailing `-` in the "redacted" output (not actually byte-for-byte clean).
  const fields = { title: 't', body: 'token glpat-abcdefghijklmnopqrst- leaked in a log line' };
  const r = scanSecrets(fields);
  check('a GitLab PAT ending in `-` is matched at all', r.matched && !r.unboundable, JSON.stringify(r));
  check('the trailing `-` is part of the redacted span, not left behind', !r.redacted.body.includes('qrst-'), r.redacted.body);
}
{
  // A connection-string credential — the assertion is on the whole match, not just the password,
  // since the fix redacts the whole `scheme://user:pass@host` span (see redact.mjs's header note).
  // Host deliberately has no dot after it (`dbhost`, not `db.internal`) — a dotted host right
  // after `@` is indistinguishable from an email address to a generic PII scanner, which is a
  // fixture-authoring trap this codebase's own public-mirror scrub would otherwise flag.
  const fields = { title: 't', body: 'leaked: postgres://svcuser:hunter2@dbhost:5432/prod, fix shipped' };
  const r = scanSecrets(fields);
  check('connection-string credential matched', r.matched && !r.unboundable);
  check('neither the user nor the password survive', !r.redacted.body.includes('svcuser') && !r.redacted.body.includes('hunter2'), r.redacted.body);
  check('the surrounding lesson survives', r.redacted.body.includes('fix shipped'), r.redacted.body);
}
{
  // A full PEM block, contained in ONE field — cleanly bounded, redacted.
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END RSA PRIVATE KEY-----';
  const fields = { title: 't', body: `found this checked in: ${pem} — rotated it` };
  const r = scanSecrets(fields);
  check('a full PEM block is matched and bounded', r.matched && !r.unboundable);
  check('the key material is gone', !r.redacted.body.includes('MIIBOgIBAAJBAKj34GkxFhD9'), r.redacted.body);
  check('the surrounding lesson survives', r.redacted.body.includes('rotated it'), r.redacted.body);
}
{
  // 1c. LOAD-BEARING: a PEM block whose BEGIN and END markers land in DIFFERENT fields. Neither
  // field's own text contains a complete block, so a per-field scan would see (at best) a lone
  // BEGIN in `title` and a lone END in `body` — this must quarantine, never ship the half that
  // happens to look clean on its own.
  const fields = {
    title: 'rotated this key: -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9',
    body: '-----END RSA PRIVATE KEY----- after finding it in a log',
  };
  const r = scanSecrets(fields);
  check('a secret split across a field boundary is UNBOUNDABLE, not silently missed or partially redacted',
    r.unboundable, JSON.stringify(r));
}
{
  // 1d. LOAD-BEARING: a BEGIN marker with no END anywhere at all (truncated, e.g. by an upstream
  // char cap) — must quarantine, not redact only the marker and ship the key body that follows it.
  const fields = { title: 't', body: 'found: -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj (truncated)' };
  const r = scanSecrets(fields);
  check('a BEGIN marker with no matching END is UNBOUNDABLE', r.unboundable);
}
{
  // TWO matches in the same field, at different positions — both must be redacted, and the second
  // match's position must still be found correctly after the first replacement shifts the string
  // (the bug `mergeSpans`/`applyRedactions` exists to prevent: redacting left-to-right over the
  // ORIGINAL string's offsets, never the string-so-far, so an earlier replacement's length change
  // cannot throw off a later span).
  const fields = { title: 't', body: 'old key AKIAIOSFODNN7EXAMPLE, replacement key also AKIAIOSFODNN7EXAMPLE for now' };
  const r = scanSecrets(fields);
  check('both occurrences in one field are matched', r.matched && !r.unboundable);
  check('neither occurrence of the key survives', !r.redacted.body.includes('AKIAIOSFODNN7EXAMPLE'), r.redacted.body);
  check('both were actually replaced (two placeholders, not one)', (r.redacted.body.match(/\[REDACTED\]/g) || []).length === 2, r.redacted.body);
}
{
  // tags/area are scanned too — a secret hiding in a tag must redact.
  const fields = { title: 't', body: 'b', area: null, tags: ['AKIAIOSFODNN7EXAMPLE', 'ok-tag'] };
  const r = scanSecrets(fields);
  check('a secret inside a TAG is matched and redacted', r.matched && !r.unboundable);
  check('the clean sibling tag is untouched', r.redacted.tags[1] === 'ok-tag', JSON.stringify(r.redacted.tags));
  check('the tag carrying the secret no longer does', !r.redacted.tags[0].includes('AKIAIOSFODNN7EXAMPLE'), r.redacted.tags[0]);
}

// ── 2. LAYER 1: scanPii — checksummable customer/PII shapes (quarantine-only, never redact-and-send)
console.log('\n=== 2. scanPii — SSN/credit-card shapes are QUARANTINE-only, not redact-eligible ===');
{
  check('a clean body has no PII shape', !scanPii({ title: 't', body: 'nothing sensitive' }));
  check('an SSN-shaped number is detected', scanPii({ title: 't', body: 'their SSN was 123-45-6789 on file' }));
  // 4111111111111111 is a well-known Luhn-valid test card number.
  check('a Luhn-VALID card number is detected', scanPii({ title: 't', body: 'card 4111111111111111 charged twice' }));
  // One digit off a valid Luhn number — must NOT false-positive on every 13-19 digit run.
  check('a Luhn-INVALID same-length digit run is NOT flagged', !scanPii({ title: 't', body: 'ticket number 4111111111111112 filed' }));
}

// ── 3. LAYER 2: classify — DEFINITIVE verdict vs. UNAVAILABLE, and never confuse the two ─────────
console.log('\n=== 3. classify — {ok, verdict} for a real answer, {ok:false} for "could not ask" ===');
function fakeSpawn(stdout, status = 0) {
  const calls = [];
  const impl = (bin, args, opts) => { calls.push({ bin, args, opts }); return { status, stdout }; };
  return { impl, calls };
}
const reply = (verdict) => JSON.stringify({ result: JSON.stringify({ verdict }) });

// -- DEFINITIVE: the process ran and returned something, however good or bad. --
{
  const f = fakeSpawn(reply('clean'));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('an explicit clean verdict is definitive (ok:true)', r.ok === true && r.verdict === 'clean', JSON.stringify(r));
  check('the classifier sees the title/body/sourceRef, fenced as untrusted data', f.calls[0].opts.input.includes('<candidate>'));
}
{
  const f = fakeSpawn(reply('customer_identifier'));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('customer_identifier is definitive', r.ok === true && r.verdict === 'customer_identifier', JSON.stringify(r));
}
{
  // Security-related content is deliberately NOT a quarantine class. A model that answers with the
  // retired class name is off-contract, so it is fail-closed as an unrecognised verdict rather than
  // passed through as a definitive one.
  const f = fakeSpawn(reply('security_finding'));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('the retired security_finding class is not a recognised verdict', r.ok === true && r.verdict === 'uncertain', JSON.stringify(r));
}
{
  // The shipped prompt is what actually decides this. It must not ask the model to flag security
  // content, and must say outright that security content is not a reason to flag.
  const prompt = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'candidate-classifier.md'), 'utf8');
  check('the prompt does not define a security_finding verdict', !/security_finding/.test(prompt));
  check('the prompt does not ask whether something is a vulnerability', !/live, unpatched/i.test(prompt));
  check('the output contract is exactly clean | customer_identifier', prompt.includes('{"verdict": "clean" | "customer_identifier"}'));
  check('the prompt states security content is never a reason to flag', /never\*\* a reason to flag/.test(prompt));
}
{
  // The process RAN (status 0) but the reply is off-contract — this is the model answering badly,
  // a DEFINITIVE 'uncertain' verdict (terminal, quarantined), not an availability failure.
  const f = fakeSpawn(reply('not_a_real_verdict'));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('an unrecognised verdict string is a definitive "uncertain", not passed through', r.ok === true && r.verdict === 'uncertain', JSON.stringify(r));
}
{
  const f = fakeSpawn(JSON.stringify({ result: 'no JSON object anywhere in this reply' }));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('a reply with no JSON object at all is a definitive "uncertain"', r.ok === true && r.verdict === 'uncertain', JSON.stringify(r));
}
{
  const f = fakeSpawn(JSON.stringify({ result: '{"verdict": clean}' })); // unquoted -> invalid JSON once matched
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('a matched-but-unparseable JSON object is a definitive "uncertain"', r.ok === true && r.verdict === 'uncertain', JSON.stringify(r));
}
{
  // The documented fallback: `--output-format json` is requested, not guaranteed (same contract
  // as capture-worker.mjs's distill()) — raw, non-JSON-wrapped stdout containing the verdict object
  // must still be read, and read as DEFINITIVE.
  const f = fakeSpawn(`not json at all ${JSON.stringify({ verdict: 'clean' })} trailing`);
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('raw (non-JSON-wrapped) stdout falls back to matching the object directly', r.ok === true && r.verdict === 'clean', JSON.stringify(r));
}

// -- UNAVAILABLE: the process never actually answered — must be `{ok:false}`, never a verdict. --
{
  // LOAD-BEARING: `claude -p --output-format json` can exit 0 while reporting `is_error: true` in
  // its own envelope (a usage-limit hit, an API error mid-call, hitting --max-turns) — a call that
  // never reached a judgment at all. Before this check existed, this exact shape fell through to
  // the "ran but said something odd" path and became a DEFINITIVE 'uncertain' verdict — an outage
  // disguised as a content judgment, which would have TERMINALLY quarantined a candidate nothing
  // ever actually classified.
  const f = fakeSpawn(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null }));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check("exit 0 with is_error:true in the envelope is UNAVAILABLE, never a definitive verdict", r.ok === false, JSON.stringify(r));
}
{
  // The control: exit 0 with is_error:false (or absent) and a real result is unaffected by the
  // check above — it must still reach a definitive verdict exactly as before.
  const f = fakeSpawn(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ verdict: 'clean' }) }));
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('exit 0 with is_error:false still reaches a definitive verdict', r.ok === true && r.verdict === 'clean', JSON.stringify(r));
}
{
  const f = fakeSpawn('', 1);
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('a non-zero exit is UNAVAILABLE, not a verdict', r.ok === false, JSON.stringify(r));
}
{
  // spawnSync sets status:null (with a signal) on a timeout kill — must be treated the same as any
  // other "did not complete" exit, never as a content verdict.
  const f = fakeSpawn(null, null);
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: f.impl });
  check('a timeout (status:null) is UNAVAILABLE, not a verdict', r.ok === false, JSON.stringify(r));
}
{
  const impl = () => { throw new Error('ENOENT'); };
  const r = await classify({ title: 't', body: 'b' }, { spawnImpl: impl });
  check('a spawn that throws is UNAVAILABLE, not a verdict', r.ok === false, JSON.stringify(r));
}

// ── 4. THE COMBINED GATE — orchestration between the two layers ─────────────────────────────────
console.log('\n=== 4. gate — orchestration: PII/malformed short-circuit, classify judges the rest, unavailable != quarantine ===');
{
  const f = fakeSpawn(reply('clean')); // must NOT be called — PII quarantines before spending a classifier call
  const v = await gate({ title: 't', body: 'their SSN was 123-45-6789 on file' }, { spawnImpl: f.impl });
  check('a PII match quarantines', v.send === false && v.reason === 'quarantined:customer_identifier', JSON.stringify(v));
  check('PII quarantine never spends a classifier call', f.calls.length === 0);
}
{
  const f = fakeSpawn(reply('clean')); // must NOT be called — unboundable quarantines before classifying
  const v = await gate({ title: 'rotated: -----BEGIN RSA PRIVATE KEY-----\nabc', body: '-----END RSA PRIVATE KEY----- ok now' }, { spawnImpl: f.impl });
  check('an unboundable secret quarantines', v.send === false && v.reason === 'quarantined:secret-unboundable', JSON.stringify(v));
  check('an unboundable secret never reaches the classifier either', f.calls.length === 0);
}
{
  // A non-string field (e.g. a malformed/prompt-injected distiller reply) cannot be scanned by
  // Layer 1 at all — shipping it unscanned would defeat the gate for whatever it contains. Must
  // quarantine before even reaching the classifier, same as the other deterministic short-circuits.
  const f = fakeSpawn(reply('clean'));
  const v = await gate({ title: 't', body: ['AKIAIOSFODNN7EXAMPLE'] }, { spawnImpl: f.impl });
  check('a non-string body quarantines rather than shipping unscanned', v.send === false && v.reason === 'quarantined:malformed-field', JSON.stringify(v));
  check('a malformed field never reaches the classifier either', f.calls.length === 0);
}
{
  const f = fakeSpawn(reply('clean'));
  const v = await gate({ title: 't', body: 'b', tags: [{ not: 'a string' }] }, { spawnImpl: f.impl });
  check('a non-string TAG also quarantines rather than shipping unscanned', v.send === false && v.reason === 'quarantined:malformed-field', JSON.stringify(v));
}
{
  // A cleanly-redactable secret AND a clean classifier verdict -> send the REDACTED fields.
  const f = fakeSpawn(reply('clean'));
  const v = await gate({ title: 'AWS key AKIAIOSFODNN7EXAMPLE rotated', body: 'lesson body' }, { spawnImpl: f.impl });
  check('send:true once redacted and classified clean', v.send === true, JSON.stringify(v));
  check('the SENT title has the secret redacted', !v.fields.title.includes('AKIAIOSFODNN7EXAMPLE'), v.fields.title);
  check('the classifier was handed the REDACTED text, never the raw secret',
    !f.calls[0].opts.input.includes('AKIAIOSFODNN7EXAMPLE'), f.calls[0].opts.input);
}
{
  // A security lesson that names no real person or organization transmits: the gate acts on the
  // classifier's verdict, and the verdict for this content is clean.
  const f = fakeSpawn(reply('clean'));
  const v = await gate({ title: 'Upload handler had an unauthenticated RCE', body: 'fixed by requiring a signed URL; verify auth on every handler' }, { spawnImpl: f.impl });
  check('a security-related lesson is sent, not quarantined', v.send === true, JSON.stringify(v));
}
{
  // LOAD-BEARING (F2): the classifier being UNAVAILABLE must produce a DIFFERENT reason shape from
  // a definitive quarantine, so the caller (propose()) can map it to a non-chargeable, batch-
  // halting failure instead of a terminal quarantine. Conflating the two is exactly the bug that
  // let an offline/rate-capped machine permanently park real, never-judged candidates.
  const f = fakeSpawn('', 1); // non-zero exit -> classifier could not be asked at all
  const v = await gate({ title: 't', body: 'an ordinary lesson' }, { spawnImpl: f.impl });
  check("classifier unavailable produces reason 'unavailable:classifier', NOT a 'quarantined:' reason",
    v.send === false && v.reason === 'unavailable:classifier', JSON.stringify(v));
}
{
  const f = fakeSpawn(reply('clean'));
  const v = await gate({ title: 'an ordinary lesson', body: 'nothing sensitive' }, { spawnImpl: f.impl });
  check('a clean pass through both layers sends', v.send === true && v.fields.title === 'an ordinary lesson', JSON.stringify(v));
}

done();
