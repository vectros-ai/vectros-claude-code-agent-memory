#!/usr/bin/env node
/**
 * THE STRICT-MODE ReferenceError CENSUS — an UPPER_SNAKE constant used but never bound.
 *
 * WHY THIS EXISTS. `recall-eval-worker.mjs` referenced `TIMEOUT_MS`. It declares
 * `CLAUDE_TIMEOUT_MS` and `SEARCH_TIMEOUT_MS`; it has no bare `TIMEOUT_MS`, and none of its ten
 * imports supplies one. The line had been swept in from `recall.mjs`, which does declare it —
 * the copied line landed in the one file that named the constant differently.
 *
 * `.mjs` is strict mode, so that is a **ReferenceError, not `undefined`**. And the path it sat on
 * is the cruelest possible one:
 *
 *     search exceeds 6s -> ctrl.abort() -> catch -> e.name === 'AbortError'
 *       -> `timeout after ${TIMEOUT_MS}ms` THROWS
 *       -> unwinds out of search(), out of main(), into `main().catch(() => {})`
 *       -> SWALLOWED, silently, forever
 *
 * So the line whose entire job is to distinguish *a timeout* from *an empty index* was the line
 * that crashed whenever a timeout happened — and reported nothing at all. this discipline's founding failure,
 * living inside the receipt written to prevent it.
 *
 * WHY NOTHING CAUGHT IT, and why this file is a LINT rather than a test:
 *   - `node --check` parses; it does not resolve bindings. It blesses this happily (a trap
 *     `capture.mjs` already warns about in prose).
 *   - `run-all.mjs`'s crash detector scans **stderr** — which `main().catch(() => {})` guarantees
 *     it never reaches.
 *   - A unit test would have to force a 6s network abort in a detached worker to walk the path.
 *     One test, one path, one instance.
 * The census is "an identifier that cannot resolve at runtime", and only a machine can hold it —
 * fix the census, and TEST the census.
 *
 * SCOPE, stated rather than implied: UPPER_SNAKE_CASE names only. That is where this class of bug
 * actually lives (module constants are what get copied between files, and they are cheap to
 * resolve without real scope analysis), and it is honest about what it does not cover: locals,
 * camelCase, and dynamic access. A narrow check that runs beats a general one that doesn't exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { codeWithInterps } from './lintlib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE);

/** Node/web globals that are legitimately UPPER_SNAKE-ish or otherwise always bound. */
const GLOBALS = new Set(['NaN', 'Infinity', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set', 'Array',
  'Object', 'String', 'Number', 'Boolean', 'Error', 'TypeError', 'RangeError', 'AbortController',
  'SharedArrayBuffer', 'Int32Array', 'Atomics', 'URL', 'TextEncoder', 'TextDecoder', 'Buffer']);

/**
 * THE CENSUS IS UPPER_SNAKE ONLY, AND THAT IS A KNOWN HOLE — do not read a green run here as "no
 * unresolvable identifiers in this tree."
 *
 * MEASURED 2026-07-20: `sweep.mjs` shipped `const _isHeld = d.isHeld || isHeld;` with `isHeld` never
 * imported. `runSweep` threw ReferenceError on every real Stop — the sweep was dead in production —
 * and this lint did not see it, because `isHeld` is camelCase. A second instance of this file's own
 * founding bug, landing just outside its scope.
 *
 * WHY IT IS NOT SIMPLY WIDENED. Extending the pattern to all identifiers needs a real parser: this
 * runs as a bare .mjs with no dependencies, and `codeWithInterps` blanks strings and comments but
 * not property accesses, object keys, shorthand methods or arrow params — so a general identifier
 * sweep is mostly false positives, and a lint that cries wolf is one nobody reads. Narrowing to CALL
 * sites (`foo(`) would be precise, and would STILL have missed this one: the bad reference is a bare
 * operand in `d.isHeld || isHeld`, not a callee. A census that cannot cover the case in front of it
 * should say so plainly rather than be widened until it is noisy enough to be ignored.
 *
 * THE COUNTERMEASURE IS A TEST THAT RUNS THE CODE, not a smarter scanner: `tests/sweep-test.mjs`
 * § "runSweep END-TO-END" exercises the real module graph with only `spawn` stubbed, and it is
 * RED-proven against exactly this defect (remove the import and the suite reports CRASH). The
 * general rule this instance argues for, and it is worth carrying elsewhere: **any function whose
 * impure edges are all injectable needs one test that injects NOTHING** — otherwise the seam that
 * makes it testable is also the thing that hides its wiring.
 */
const UPPER = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;   // FOO_BAR — at least one underscore

/** Names this module binds: const/let/var, imports (named, default, namespace), params, catch. */
function bound(code) {
  const b = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  // destructured declarations + named imports: { A, B as C }
  for (const m of code.matchAll(/\b(?:const|let|var|import)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (nm) b.add(nm);
    }
  }
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) b.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) b.add(m[1]);
    for (const p of (m[2] || '').split(',')) { const nm = p.trim().split('=')[0].replace(/[{}[\].\s]/g, ''); if (nm) b.add(nm); }
  }
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  return b;
}

const files = fs.readdirSync(HOOKS).filter((f) => f.endsWith('.mjs')).sort();
console.log(`=== undeclared UPPER_SNAKE census — ${files.length} runtime hook files ===\n`);

const violations = [];
let scanned = 0;
let refs = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
  // Interpolations kept as CODE: `${TIMEOUT_MS}` is a real reference, and is precisely where the
  // bug lived. blank() alone would erase it and the lint would report the file clean.
  const code = codeWithInterps(src);
  const b = bound(code);
  scanned++;
  const seen = new Set();
  for (const m of code.matchAll(UPPER)) {
    const name = m[1];
    refs++;
    if (b.has(name) || GLOBALS.has(name) || seen.has(name)) continue;
    // Property access (`x.FOO_BAR`) and object keys (`{ FOO_BAR: 1 }`) bind nothing at module scope.
    const before = code.slice(Math.max(0, m.index - 1), m.index);
    const after = code.slice(m.index + name.length, m.index + name.length + 1);
    if (before === '.' || after === ':') continue;
    seen.add(name);
    violations.push({ f, line: code.slice(0, m.index).split('\n').length, name });
  }
}

for (const v of violations) console.log(`  UNBOUND  ${v.f}:${v.line}  ${v.name}`);
console.log(`\n  ${scanned} files, ${refs} UPPER_SNAKE references, ${violations.length} unbound\n`);

check('the scan actually resolved references (a lint that reads nothing passes everything)',
  refs > 100, `only ${refs} references seen — the scanner is broken`);
eq('no UPPER_SNAKE identifier is referenced without a binding', violations.length, 0);

/**
 * RED-PROOF, in-process. The sabotage is the REAL bug, verbatim, including its template literal —
 * because that is the construct `blank()` erases and `codeWithInterps()` exists to preserve. A
 * version of this lint built on `blank()` alone would report this sample clean.
 */
const SABOTAGE = `
const SEARCH_TIMEOUT_MS = 6000;
async function search() {
  try { await go(); } catch (e) {
    const why = e?.name === 'AbortError' ? \`timeout after \${TIMEOUT_MS}ms\` : 'x';
    hlog('recall-eval', why);
  }
}
`;
const sabCode = codeWithInterps(SABOTAGE);
const sabBound = bound(sabCode);
const sabHits = [...sabCode.matchAll(UPPER)].map((m) => m[1]).filter((n) => !sabBound.has(n) && !GLOBALS.has(n));
check('RED-proof: the real bug (TIMEOUT_MS inside a template literal) is CAUGHT',
  sabHits.includes('TIMEOUT_MS'), `unbound found: ${JSON.stringify(sabHits)}`);
check('RED-proof: the DECLARED sibling in the same sample is NOT flagged',
  !sabHits.includes('SEARCH_TIMEOUT_MS'));
/**
 * THE INTERPOLATION must survive `blank()`, and this check has to observe the INTERPOLATION —
 * not the identifier's letters.
 *
 * It was `/TIMEOUT_MS/.test(sabCode)`. `SEARCH_TIMEOUT_MS` CONTAINS `TIMEOUT_MS`, and the declared
 * sibling sits in plain code that `blank()` never touches — so this passed whether or not the
 * template literal was erased, i.e. byte-identical under the bug it names and under the fix. The
 * red-proof of a signal, unable to fail.
 *
 * That is the same substring defect as `call`-inside-`recallable` in the §N scorer, fixed one file
 * away in this same branch, and shipped here in the check that was supposed to prove a fix. Anchor
 * on the `${...}` form: it exists ONLY inside the template literal, so it is gone precisely when
 * the bug is present.
 */
check('a template literal is not erased before scanning (blank() alone would hide the bug)',
  /\$\{TIMEOUT_MS\}/.test(sabCode),
  'the ${TIMEOUT_MS} interpolation is gone from the sample — blank() erased it, and the scan below proves nothing');

// Binding forms must all be honoured, or the lint cries wolf and gets deleted.
check('const declarations bind', !bound(codeWithInterps('const FOO_BAR = 1;')).has('X') && bound(codeWithInterps('const FOO_BAR = 1;')).has('FOO_BAR'));
check('named imports bind', bound(codeWithInterps("import { FOO_BAR } from './x.mjs';")).has('FOO_BAR'));
check('aliased imports bind the LOCAL name', bound(codeWithInterps("import { A as FOO_BAR } from './x.mjs';")).has('FOO_BAR'));

done();
