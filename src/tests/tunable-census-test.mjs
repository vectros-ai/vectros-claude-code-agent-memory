#!/usr/bin/env node
/**
 * THE TUNABLE CENSUS — no numeric knob may live as a source `const` again.
 *
 * WHY A MACHINE HOLDS THIS AND NOT A PARAGRAPH. The whole argument is that after the build bundles
 * the source, a `const` in a hook file is **unreachable to an adopter** — there is no
 * supported way for them to change it at all. So the cost of one missed extraction is not untidy
 * code, it is a knob that becomes un-turnable at publish and whose later extraction is a change to
 * a public config surface (the owner's 2026-07-20 ruling: doing it after publication is materially
 * more expensive than before).
 *
 * The census started at 42 across 13 files. A number that large was never going to be held by
 * remembering, and the earlier hand-written list of every knob is itself the evidence: it is a
 * snapshot that began going stale the moment it was written. This runs.
 *
 * FOUR CHECKS, AND THEY FAIL IN OPPOSITE DIRECTIONS, which is the point:
 *   §1  nothing is left BEHIND     — a numeric const still in a hook file
 *   §2  nothing is left DANGLING   — a SPEC key no module actually reads (dead config is worse
 *                                    than a literal: it advertises a knob that turns nothing)
 *   §3  every entry is USABLE      — default, env name, validator, and real provenance
 *   §4  every entry is GUARDED     — a validator that rejects something, so "fail-open" is not
 *                                    "accept anything"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { blank } from './lintlib.mjs';
import './isolate.mjs';
import { SPEC } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE);
const RUNTIME = fs.readdirSync(HOOKS).filter((f) => f.endsWith('.mjs')).sort();
const src = (f) => fs.readFileSync(path.join(HOOKS, f), 'utf8');

console.log(`=== tunable census — ${Object.keys(SPEC).length} in SPEC, ${RUNTIME.length} runtime files ===\n`);

// ─────────────────────────────────────────────────────────────────────────────
// 1. NOTHING LEFT BEHIND. A module-scope `const NAME = <number>` is a tunable that did not migrate.
//
//    `blank()` at its DEFAULT here (comments AND string bodies erased) — the opposite of what
//    paths-test.mjs §4 needs, and correct for the opposite reason: this hunts NUMERIC literals,
//    which blank() leaves intact, while a version string inside quotes is not a knob.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. no numeric tunable is still a source const ===');
/**
 * ALLOWLIST — protocol constants and derived values, NOT knobs. Each entry states why, because an
 * unexplained allowlist is how a census dies: the next person adds a line rather than a reason.
 * It is EMPTY of numbers today, and that is the finding, not an accident.
 */
const NOT_A_TUNABLE = {
  // paths.mjs — a PROTOCOL constant shared by every module that truncates a session id for
  // display (hooklog.mjs, nudge.mjs, recall.mjs, report.mjs, sweep.mjs) AND by dispose.mjs's
  // prefix-resolution, which depends on it matching every one of those exactly. Making it a
  // VECTROS_MEM_* override would let an adopter set a value that does nothing (none of those
  // `.slice(0, N)` call sites read an env var) — exactly the "dead config" failure mode §2 below
  // exists to catch, just in the opposite direction. `sid-display-len-test.mjs` is the automated
  // check that every call site actually imports and uses this constant rather than re-hardcoding
  // the number — this allowlist entry says only "not tunable", not "unchecked".
  SID_DISPLAY_LEN: 'a shared display-truncation length, not independently tunable — see sid-display-len-test.mjs',
};
const DECL = /^(?:export )?const ([A-Z][A-Z0-9_]*) = (-?[0-9][0-9_]*(?:\.[0-9]+)?(?:\s*[*+]\s*[0-9][0-9_]*)*)\s*;/gm;
const left = [];
let filesScanned = 0;
for (const f of RUNTIME) {
  if (f === 'config.mjs') continue; // SPEC's own `def:` values are the point, not a violation
  filesScanned++;
  const code = blank(src(f));
  for (const m of code.matchAll(DECL)) {
    if (m[1] in NOT_A_TUNABLE) continue;
    left.push(`${f}:${code.slice(0, m.index).split('\n').length}  ${m[1]} = ${m[2].trim()}`);
  }
}
for (const l of left) console.log(`  NOT MIGRATED  ${l}`);
check('the census actually read the tree', filesScanned >= 15, `only ${filesScanned} files scanned`);
eq('every numeric tunable lives in SPEC, not in a hook file', left.length, 0);

// It has to be able to see one, or it is decoration. Both a plain literal and a computed one.
check('RED-proof: a plain numeric const IS caught',
  [...blank('const NUDGE_THRESHOLD = 5;\n').matchAll(DECL)].length === 1);
check('RED-proof: a COMPUTED one is caught too (the form half the census used: 60 * 60_000)',
  [...blank('const STALE_MS = 60 * 60_000;\n').matchAll(DECL)].length === 1);
check('RED-proof: a derived value is NOT caught (it is not a literal knob)',
  [...blank('const STATE_DIR = stateDir();\n').matchAll(DECL)].length === 0);
check('RED-proof: a protocol STRING literal is NOT caught (BEGIN/END markers are not config)',
  [...blank("const BEGIN = '<!-- VECTROS-PINNED:BEGIN';\n").matchAll(DECL)].length === 0);

// ─────────────────────────────────────────────────────────────────────────────
// 2. NOTHING LEFT DANGLING. A SPEC key nothing reads is a knob that turns nothing — a worse
//    failure than a literal, because a literal is at least honest about being unreachable.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. every SPEC key is actually consumed by a module ===');
const consumers = RUNTIME.filter((f) => f !== 'config.mjs').map((f) => [f, blank(src(f))]);
const configCode = blank(src('config.mjs'));
const orphans = [];
for (const key of Object.keys(SPEC)) {
  const used = consumers.some(([, code]) => new RegExp(`\\b${key}\\b`).test(code))
    // `RECALL_QUERY_MAX_CHARS` / `RECALL_QUERY_MAX_BYTES` are consumed by `clampQuery`, which lives
    // in config.mjs itself — the shared outbound-request boundary. Consumed, not dangling.
    || new RegExp(`\\b${key}\\b[\\s\\S]*clampQuery|clampQuery[\\s\\S]*\\b${key}\\b`).test(configCode.slice(configCode.indexOf('export function clampQuery') - 4000));
  if (!used) orphans.push(key);
}
for (const o of orphans) console.log(`  DANGLING  ${o} — in SPEC, read by nothing`);
eq('no SPEC key is dead config', orphans.length, 0);
check('RED-proof: the consumer scan can distinguish used from unused',
  consumers.some(([, code]) => /\bCONTEXT_CAP\b/.test(code))
  && !consumers.some(([, code]) => /\bDEFINITELY_NOT_A_REAL_KEY\b/.test(code)));

// ─────────────────────────────────────────────────────────────────────────────
// 3. EVERY ENTRY IS USABLE BY AN ADOPTER. The seam's contract, mechanised.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. every SPEC entry ships a default, an env name, a validator and provenance ===');
const bad = [];
for (const [key, s] of Object.entries(SPEC)) {
  if (typeof s.def !== 'number') bad.push(`${key}: def is ${typeof s.def}, expected number`);
  if (s.env !== `VECTROS_MEM_${key}`) bad.push(`${key}: env is ${s.env}, expected VECTROS_MEM_${key}`);
  if (typeof s.parse !== 'function') bad.push(`${key}: no parse/validate function`);
  // PROVENANCE IS NOT OPTIONAL — the seam's stated contract is that it travels with the default, so
  // an adopter reading the shipped config learns which numbers are calibrated and which are guesses.
  // The length floor is crude but it is what stops `note: 'the timeout'` passing as provenance.
  if (typeof s.note !== 'string' || s.note.length < 60) bad.push(`${key}: note is missing or too thin to be provenance`);
}
for (const b of bad) console.log(`  INCOMPLETE  ${b}`);
eq('every SPEC entry is complete', bad.length, 0);

/**
 * EVERY DEFAULT MUST SATISFY ITS OWN VALIDATOR. Sounds tautological; it is not. The rails were
 * tightened several times after the defaults were chosen (CONTEXT_CAP 10_000 -> 9999,
 * STALE_SESSION_MS's floor 60s -> 4h, RENAME_RETRIES' floor 0 -> 1), and a rail tightened past its
 * own default would make the shipped value permanently rejected — the hook would fall back to that
 * same default while logging a rejection on every single process start.
 */
console.log('\n=== 3b. every shipped default passes its own validator ===');
const selfRejecting = [];
for (const [key, s] of Object.entries(SPEC)) {
  const r = s.parse(s.def);
  if (!r.ok || r.value !== s.def) selfRejecting.push(`${key}: def ${s.def} rejected by its own rail (${r.why || 'value changed'})`);
}
for (const s of selfRejecting) console.log(`  SELF-REJECTING  ${s}`);
eq('no default is rejected by its own validator', selfRejecting.length, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 4. EVERY ENTRY IS GUARDED. "Fail-open" must not degrade into "accept anything": a validator that
//    accepts every input is the same as no validator, and this seam's own history is a list of
//    rails that were too loose (posInt(1, 10_000) accepting the one value the bound existed to
//    exclude). Nonsense that MUST be refused by every knob, whatever its range.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. every validator rejects nonsense ===');
const NONSENSE = ['not-a-number', '', {}, [], null, undefined, NaN, 1.5, -1, Infinity];
const permissive = [];
for (const [key, s] of Object.entries(SPEC)) {
  const accepted = NONSENSE.filter((v) => s.parse(v).ok);
  if (accepted.length) permissive.push(`${key}: accepted ${JSON.stringify(accepted.map(String))}`);
}
for (const p of permissive) console.log(`  PERMISSIVE  ${p}`);
eq('no validator accepts non-integer or negative input', permissive.length, 0);

/**
 * AND THE RAILS ARE NOT MERELY TYPE BOUNDS. At least one value on each side must be REFUSED, or
 * `posInt(1, Number.MAX_SAFE_INTEGER)` would pass §4 above while bounding nothing — which is the
 * exact shape of the finding that tightened CONTEXT_CAP.
 */
console.log('\n=== 4b. every rail actually excludes a region (not just a type) ===');
const unbounded = [];
for (const [key, s] of Object.entries(SPEC)) {
  if (s.parse(1).ok && s.parse(Number.MAX_SAFE_INTEGER).ok) unbounded.push(key);
}
for (const u of unbounded) console.log(`  UNBOUNDED  ${u} — accepts both 1 and MAX_SAFE_INTEGER`);
eq('every knob has a real floor or ceiling', unbounded.length, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE RESOLVED SET MATCHES THE SPEC — one shape, no key that exists in one and not the other.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. tunables() exposes exactly SPEC\'s keys, and the NAMED exports match ===');
/**
 * WHAT THIS CHECKS, and what it deliberately no longer does.
 *
 * A key-set equality between `tunables()` and `SPEC` was here and has been REMOVED rather than
 * annotated: `resolveConfig` assigns `values[key]` for every SPEC key on both branches, so it could
 * not fail by construction. It was kept once with a comment saying so, which is worse than deleting
 * it — a reader counts it as coverage, and an assertion that cannot fail is noise on the one file
 * whose job is to be believable. (PM cold pass, 2026-07-30.)
 *
 * What replaces it is reachability, which CAN fail: every SPEC key must be readable by a consumer,
 * as a named export or — for the in-cycle modules — via `tunables()`. A key that is settable and
 * unreadable is a knob that turns nothing.
 */
/**
 * FIVE KEYS ARE DELIBERATELY NOT NAMED EXPORTS, each listed with its reason. Four are the in-cycle
 * infra knobs: `atomic.mjs`/`hooklog.mjs` MUST read them through `tunables()`, and a named export
 * for them is exactly what `config-bootstrap-test.mjs` §2 forbids. The fifth is consumed by
 * `clampQuery` inside `config.mjs` itself, so it has no external consumer to export to.
 */
const NOT_NAMED_EXPORTS = {
  RENAME_RETRIES: 'in-cycle: atomic.mjs reads it via tunables() — a named import would be a TDZ read',
  RENAME_RETRY_MS: 'in-cycle: same as RENAME_RETRIES',
  HOOKLOG_MAX_BYTES: 'in-cycle: hooklog.mjs reads it via tunables()',
  HOOKLOG_KEEP_GENERATIONS: 'in-cycle: rollAtomic defaults to it via tunables()',
  RECALL_QUERY_MAX_BYTES: 'consumed by clampQuery INSIDE config.mjs — no external consumer',
};
const mod = await import('../config.mjs');
const unexported = Object.keys(SPEC).filter((k) => mod[k] === undefined && !(k in NOT_NAMED_EXPORTS));
for (const u of unexported) console.log(`  NOT EXPORTED  ${u} — settable but unreadable by any consumer`);
eq('every SPEC key is reachable as a named export, or exempt with a stated reason', unexported.length, 0);
// The exemptions must stay HONEST: an exempt key that later gains a named export is a contradiction
// with the bootstrap census, and should be caught here rather than by whichever breaks first.
const staleExempt = Object.keys(NOT_NAMED_EXPORTS).filter((k) => mod[k] !== undefined);
for (const s of staleExempt) console.log(`  STALE EXEMPTION  ${s} — now IS exported; drop it from the list`);
eq('no exemption is stale', staleExempt.length, 0);
check('RED-proof: the export check can see a missing one',
  mod.DEFINITELY_NOT_A_REAL_KEY === undefined && mod.CONTEXT_CAP !== undefined);
console.log(`\n  ${Object.keys(SPEC).length} tunables, all migrated, all consumed, all guarded\n`);

done();
