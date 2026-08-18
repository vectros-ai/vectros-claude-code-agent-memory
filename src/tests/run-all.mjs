#!/usr/bin/env node
/**
 * The suite. `node tests/run-all.mjs` — exits non-zero if anything failed.
 *
 * WHY A RUNNER EXISTS AT ALL. Before this, "the tests pass" meant a human ran eight files by hand
 * and read the prose. There was no runner and no `package.json`, so even the files that DID assert
 * depended on someone checking `$?`. A cold panel put it exactly: the suite was green by
 * construction, and `assert.mjs` — *the countermeasure to that very disease* — was wired into 2 of
 * 9 files. Its own header diagnosed the problem and it was then applied only where the problem was
 * found. That is the branch's systemic defect, reproduced inside the fix for it.
 *
 * SO THIS RUNNER ENFORCES THE CENSUS, not just the tests. A test file that does not import
 * `assert.mjs` and call `done()` FAILS THE RUN — because a file that cannot report failure is not
 * a test, and the next one added would silently inherit the old shape. The rule is now mechanical
 * instead of remembered, which is the entire thesis of this project applied to its own suite.
 *
 *   node run-all.mjs           # the deterministic suite
 *   node run-all.mjs --all     # + the *-real-test.mjs files (REAL Haiku calls, ~$0.30)
 *   VECTROS_MEM_TEST_ALL=1 node run-all.mjs   # same opt-in, for CI — see below
 *
 * THE ENV VAR EXISTS SO CI CAN OPT IN AT ALL. `--all` alone means only a human typing it
 * locally can ever exercise `*-real-test.mjs`: `package.json`'s `test` script is a fixed command
 * (`node src/tests/run-all.mjs`), and a CI job invokes it via `npm test`, not a hand-typed CLI —
 * there is no way to thread a `--all` flag through that without a SECOND script/job just for it.
 * Without this, the real-Haiku suite is invisible to CI FOREVER, silently, which is a coverage
 * hole wearing the shape of "safely skipped" (the exact defect this whole file's header is about).
 * The env var lets a scheduled/nightly CI job (cost-conscious — NOT every push) set it and
 * actually run these, while every ordinary `npm test` stays free. Deliberately does not decide
 * that CI SHOULD run them by default — that is a job-definition choice, made where the job is
 * defined, not smuggled into this runner as a silent default either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const withReal = process.argv.includes('--all') || process.env.VECTROS_MEM_TEST_ALL === '1';

/**
 * DEFAULT PROTECTION for the whole run: one isolated runtime root, one isolated log.
 *
 * Every test file below spawns hooks as child processes with `env: { ...process.env, … }` (a census
 * confirmed this — every spawn site spreads the parent env), so setting these ONCE here propagates
 * transitively through the entire tree without touching each of the ~13 files that spawn something.
 * `isolate.mjs` does the setting and explains why the root must move too, not just the log; the
 * short version is that a shared `~/.claude/vectros-memory` made `orient-boundary-test.mjs` case 2c
 * fail against a real other session's orphaned queue. Individual files import it as well, so a
 * standalone `node tests/sweep-test.mjs` outside this runner is isolated on its own terms.
 */
import { ISOLATED_ROOT } from './isolate.mjs';

console.log(`(isolated runtime root ${ISOLATED_ROOT} — the live ~/.claude/vectros-memory is untouched by this run)`);
console.log(`(test hooks.log redirected to ${process.env.VECTROS_HOOKLOG_PATH})`);

/**
 * DEFAULT PATH ISOLATION — no spawned test file can reach the real, machine-wide `vectros` CLI
 * unless explicitly opted in (the SAME `withReal` gate `*-real-test.mjs` already uses).
 *
 * Found live, 2026-08-17: a routine `npm test` (no opt-in) still let every spawned hook reach the
 * REAL `vectros` binary — `resolveCommandPath('vectros')`/`runKeyringHelper()` in `creds.mjs` walk
 * the inherited PATH with no isolation of their own, and until this fix no spawn site here ever
 * overrode it. `smoke.mjs` is IN this suite (not a `*-real-test.mjs`), and its own hook spawns
 * shelled straight out to `vectros keyring show --alias <the operator's real, live, pinned alias>`
 * as a side effect of an ordinary test run — the exact class of incident `creds-keyring-test.mjs`
 * case 4 already documents and fixed for the OAuth-token keychain path (a routine `npm test`
 * silently touching a real, machine-wide credential), just never closed for this one. It is not only
 * a blast-radius concern either: `packages/cli/src/keyring.ts` documents `keyring show` as a
 * lock-TAKING writer on the shared `~/.vectros/keyring.json` (migrate-on-use), so an unisolated test
 * run can race a real concurrent session's own credential resolution against that same cross-process
 * lock — plausibly what produced a transient TEST-tenant misread on a real invocation the same
 * session this fix was written in.
 *
 * SURGICAL, not a blanket blank. An earlier version of this fix set PATH to one bare empty
 * directory and broke two unrelated files: `dist-smoke-test.mjs` shells out to `npm run build`
 * (needs the real `npm`/`node` on PATH), and `cli-init-test.mjs`'s fake-`vectros` wrapper
 * (`runInitWithFakeVectros`) is a `.cmd` shim that itself re-invokes `node` by bare name — both
 * need a working PATH, just not one that resolves to the REAL `vectros`. So: keep every real PATH
 * entry, and drop only the director{y,ies} that actually contain a `vectros`/`vectros.exe`/
 * `vectros.cmd`/`vectros.bat`/`vectros.ps1` file — the fake-vectros test fixtures live under a
 * fresh `mkdtemp` dir named `vectros-mem-fakebin-*`, never a real npm global-bin dir, so they are
 * never the thing this filter removes.
 *
 * All three spellings: Windows env lookups are case-insensitive at the OS level but `process.env`
 * keys are not.
 *
 * Skipped entirely under `withReal`: `*-real-test.mjs` (and anything else opted into the real suite)
 * may legitimately need the real `vectros` binary reachable — leave PATH untouched in that mode, same
 * as `*-real-test.mjs`'s own credential checks already do.
 */
const VECTROS_BIN_NAMES = ['vectros', 'vectros.exe', 'vectros.cmd', 'vectros.bat', 'vectros.ps1'];
function pathWithoutRealVectros(rawPath) {
  const dirs = (rawPath || '').split(path.delimiter).filter(Boolean);
  const kept = dirs.filter((dir) => !VECTROS_BIN_NAMES.some((name) => {
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  }));
  return kept.join(path.delimiter);
}
const SPAWN_ENV = withReal ? undefined : (() => {
  const stripped = pathWithoutRealVectros(process.env.PATH || process.env.Path || process.env.path || '');
  return { ...process.env, PATH: stripped, Path: stripped, path: stripped };
})();
if (SPAWN_ENV) {
  console.log('(default run: PATH stripped of the real vectros CLI\'s directory — no spawned test can '
    + 'reach it; opt in with --all or VECTROS_MEM_TEST_ALL=1)');
}

const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('-test.mjs') || f === 'smoke.mjs')
  .filter((f) => withReal || !f.endsWith('-real-test.mjs'))
  .sort();

let failed = 0;
const skipped = [];

// ── 1. THE META-CHECK: every test must be able to report failure.
console.log('=== census: can each file report a failure at all? ===');
for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('-test.mjs') || x === 'smoke.mjs')) {
  const s = fs.readFileSync(path.join(HERE, f), 'utf8');
  const imports = /from '\.\/assert\.mjs'/.test(s);
  const finishes = /\bdone\(\)/.test(s);
  if (imports && finishes) { console.log(`  ok    ${f}`); continue; }
  failed++;
  console.log(`  FAIL  ${f} — ${!imports ? 'does not import assert.mjs' : 'never calls done()'}; it cannot fail, so it is not a test`);
}

/**
 * ── 1b. THE CREDENTIAL-LEAK CENSUS.
 *
 * `isolate.mjs` pins `VECTROS_HOOK_CREDENTIALS` to the REAL, LIVE `credentials.json` — deliberately,
 * so the `*-real-test.mjs` files can authenticate with genuine credentials. Every spawn site in this
 * suite spreads `process.env`, so that pin propagates to EVERY child this suite spawns, not just the
 * real-test files that want it. `cli.mjs`'s `init` (`pinKeyringAlias`) and `set-token` are the
 * only two verbs that WRITE to `credentialsFile()` — so a test that spawns `cli.mjs` with a bare
 * `...process.env` and never overrides `VECTROS_HOOK_CREDENTIALS` writes straight into the real,
 * live file, not its own isolated fixture. This happened TWICE: `cli-set-token-test.mjs` (documented
 * in its own header) and `cli-init-test.mjs`'s case 4 (this exact keyring-alias pin, found live
 * while authoring the very feature this census now guards). The rule is now mechanical
 * instead of remembered — same rationale as the failure-reporting census above.
 *
 * MATCHES OUTSIDE COMMENTS ONLY — found in review, not by a test. The first cut grepped the whole
 * file text for the literal string `VECTROS_HOOK_CREDENTIALS`, satisfied by a COMMENT mentioning
 * it (the explanatory comment right above the real override, for instance) just as readily as the
 * actual override — so deleting the one line that matters while leaving the comment above it
 * intact (a very plausible partial revert) would still print `ok`. Comments are stripped before
 * the check runs, so only a real, live occurrence of the name — the override itself — counts.
 */
console.log('\n=== census: does every cli.mjs-spawning test override VECTROS_HOOK_CREDENTIALS? ===');
/**
 * Strip line comments and block comments — good enough for a census that only needs to see LIVE
 * code, not a full parser.
 *
 * ONE REGEX, string literals and comments as ALTERNATIVES, not two sequential passes — found in
 * review (a real bug, not a hypothetical, and — worth naming since it is exactly the trap this
 * paragraph is about — a SECOND instance of it was written into THIS very docblock on the first
 * attempt at this fix, closing the comment early and syntax-erroring the whole file the moment it
 * ran; described here only in prose for that reason, never as the literal three-character
 * sequence, PRECISELY so a future edit of this comment cannot repeat it a third time).
 *
 * The original cut ran a block-comment pattern and a line-comment pattern as two separate
 * `.replace()` calls. The block-comment pass has no idea a `//` line comment exists at all —
 * dist-smoke-test.mjs's own header comment names its own filename glob inside a `//` line comment,
 * and that glob's text happens to contain a comment-OPENING pair of characters. The block-comment
 * pass treated that as a real opener and matched all the way through to the next unrelated
 * comment-CLOSING pair, dozens of lines later — silently deleting a huge swath of genuine code,
 * including this file's own real `VECTROS_HOOK_CREDENTIALS` override, and turning a real, safe
 * file into a false FAIL.
 *
 * A single alternation regex doesn't have this problem: once the line-comment branch starts
 * matching at a real `//`, it consumes to end-of-line as ONE match, so a comment-opener-shaped
 * substring inside that same line is never re-examined as a separate potential match start. String
 * literals are matched (and kept verbatim) for the same reason, so a comment-opening sequence
 * inside a string doesn't confuse the scan either. One caveat this function still carries,
 * documented rather than hidden: it does not handle a comment-opening sequence appearing OUTSIDE
 * any recognized string/comment form via some other exotic syntax (a regex literal containing one,
 * say) — not a shape any file in this suite's real overrides has needed.
 */
const stripComments = (s) => s.replace(
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\/\*[\s\S]*?\*\//gm,
  (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
);
for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('-test.mjs'))) {
  const s = fs.readFileSync(path.join(HERE, f), 'utf8');
  const spawnsCli = /cli\.mjs/.test(s);
  if (!spawnsCli) continue; // not in scope — doesn't touch the only two credential-write verbs
  const live = stripComments(s);
  const spreadsEnv = /\.\.\.process\.env/.test(live);
  const overridesCreds = /VECTROS_HOOK_CREDENTIALS/.test(live);
  if (!spreadsEnv || overridesCreds) { console.log(`  ok    ${f}`); continue; }
  failed++;
  console.log(`  FAIL  ${f} — spawns cli.mjs with ...process.env but never overrides `
    + 'VECTROS_HOOK_CREDENTIALS in live code (a comment mentioning it does not count); init/'
    + 'set-token WRITE to credentialsFile(), and without an override that write lands in the '
    + 'REAL, LIVE credentials.json (isolate.mjs pins it there for *-real-test.mjs\'s sake) — see '
    + 'cli-init-test.mjs\'s runInit()/runInitWithFakeVectros() for the fix shape.');
}

// ── 2. Run them.
console.log('\n=== run ===');
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    encoding: 'utf8', timeout: 900_000, ...(SPAWN_ENV ? { env: SPAWN_ENV } : {}),
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const out = (r.stdout || '') + (r.stderr || '');
  /**
   * A crash is not a failure report — surface it separately. But match STDERR ONLY, and require a
   * STACK FRAME, not the word.
   *
   * The first cut scanned stdout+stderr for /ReferenceError|TypeError|…/ and immediately flagged
   * `triage-test.mjs` as CRASH at exit 0 — because that test PRINTS the string "ReferenceError" in
   * its own passing message ("worker module loads without ReferenceError? yes"). A detector that
   * cannot tell a stack trace from a sentence about one is the same defect this whole suite exists
   * to catch — a signal must be able to observe the thing it claims. Node writes
   * uncaught errors to stderr with an `at …` frame; assertions in prose have neither.
   */
  const err = r.stderr || '';
  const crashed = /^\s*(ReferenceError|TypeError|SyntaxError|RangeError):/m.test(err)
    || /Cannot find (module|package)/.test(err)
    || /ERR_MODULE_NOT_FOUND/.test(err)
    || /Assertion failed:/.test(err)
    || r.status === null; // killed by the timeout
  if (r.status === 0 && !crashed) { console.log(`  PASS  ${f.padEnd(24)} ${secs}s`); continue; }
  failed++;
  console.log(`  FAIL  ${f.padEnd(24)} ${secs}s  exit=${r.status}${crashed ? ' CRASH' : ''}`);
  for (const l of out.split('\n').filter((l) => /FAIL|\*\*\*|Error/.test(l)).slice(0, 6)) {
    console.log(`          ${l.trim()}`);
  }
}

if (!withReal) {
  const real = fs.readdirSync(HERE).filter((f) => f.endsWith('-real-test.mjs'));
  if (real.length) skipped.push(`${real.length} *-real-test.mjs (real Haiku calls) — run with --all or VECTROS_MEM_TEST_ALL=1`);
}

console.log('');
for (const s of skipped) console.log(`  SKIPPED: ${s}`);
console.log(failed ? `\n*** ${failed} FAILED ***` : '\nall green');
process.exitCode = failed ? 1 : 0; // exitCode, not exit() — these files fetch (see assert.mjs)
