/**
 * The smallest thing that makes this directory a test suite instead of a demo.
 *
 * WHY THIS EXISTS. Every test here was written as `console.log` with the expectation as PROSE
 * beside the value:
 *
 *     console.log(`  pending=${q.pending.length}  (expect 2: c1,c2)`);
 *
 * If `read()` returned zero, that prints `pending=0  (expect 2: c1,c2)` and **exits 0**. Nine of
 * ten files had no assertion of any kind; the tenth gated on a stderr regex for errors the code
 * under test swallows by design (`main().catch(() => {})`). The whole suite turned out to be
 * green by construction — and, before that, every file was dead on line 9 with a ReferenceError
 * that went unnoticed because the output was read instead of the exit code.
 *
 * That is the exact failure this project keeps documenting and re-committing: a signal that cannot
 * observe the thing it claims. `recall.mjs` shipped wired-and-dead because its tests fed it
 * `user_prompt` and confirmed the assumption rather than the contract. A lexical metric scored a
 * doc 97% novel while its heading carried the phrase. A capture-failure metric counted its own
 * drain test. This file is the countermeasure: an expectation that cannot be satisfied by being
 * printed.
 *
 * Usage:
 *     import { check, eq, done } from './assert.mjs';
 *     eq('watermark is monotonic', q.offset, 9000);
 *     check('a refused claim stays pending', pending.includes('c1'));
 *     done();   // exits 1 if anything failed — CALL IT, or the process exits 0 on failure
 */
let failures = 0;
let checks = 0;

const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** Assert `cond`. `detail` is printed only on failure, where it is the whole value. */
export function check(what, cond, detail) {
  checks++;
  if (cond) { console.log(`  PASS  ${what}`); return true; }
  failures++;
  console.log(`  FAIL  ${what}${detail !== undefined ? `\n          ${detail}` : ''}`);
  return false;
}

/** Assert deep-ish equality. Prints BOTH sides on failure — the pair is the diagnostic. */
export function eq(what, actual, expected) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const e = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  return check(what, a === e, `expected ${fmt(e)}\n          actual   ${fmt(a)}`);
}

/** Assert a number is within an inclusive range (for budgets and caps). */
export function within(what, actual, min, max) {
  return check(what, actual >= min && actual <= max, `expected ${min}..${max}, actual ${actual}`);
}

/**
 * Print the tally and SET A NON-ZERO EXIT CODE on failure.
 *
 * `process.exitCode`, never `process.exit()`: a test that has `fetch`ed would otherwise trip a
 * known Node/libuv issue on Windows and die with a native assert (0xC0000409) — which a CI runner
 * reads as "crashed", not "failed".
 */
export function done() {
  console.log(`\n  ${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`  *** ${failures} FAILED ***`);
    process.exitCode = 1;
  }
  return failures === 0;
}
