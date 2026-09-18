#!/usr/bin/env node
/**
 * THE RUNTIME ROOT — its default, its override, and the census that keeps the seam the only way in.
 *
 * Deliberately does NOT import `./isolate.mjs`. This is the one file whose subject is the
 * derivation itself, so it drives `VECTROS_MEMORY_HOME` by hand and restores it — and it must be
 * able to observe the UNSET default, which is precisely what isolation hides. That default is now
 * exercised nowhere else in the suite: every other test runs relocated, so without the check below
 * a regression in `~/.claude/vectros-memory` would ship green.
 *
 * THE CENSUS (§4) IS THE POINT, and the rest is scaffolding for it. Relocating the root is only
 * worth anything if it relocates ALL of it: one file that re-spells
 * `path.join(os.homedir(), '.claude', 'vectros-memory', …)` escapes isolation silently, writes into
 * the operator's live runtime from a test run, and — once the reaper exists — deletes from it.
 * That is not hypothetical: the literal was hand-rolled in 17 runtime files and 22 test files
 * before this seam, which is how `orient-boundary-test.mjs` case 2c came to fail against a real
 * other session's orphaned queue. A convention that has already been violated 39 times needs a
 * machine holding it, not a paragraph.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { blank } from './lintlib.mjs';
import * as P from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE);

/** Drive the env by hand and always put it back — this file is the one that must see both states. */
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'VECTROS_MEMORY_HOME');
  const prev = process.env.VECTROS_MEMORY_HOME;
  try {
    if (value === undefined) delete process.env.VECTROS_MEMORY_HOME;
    else process.env.VECTROS_MEMORY_HOME = value;
    return fn();
  } finally {
    if (had) process.env.VECTROS_MEMORY_HOME = prev;
    else delete process.env.VECTROS_MEMORY_HOME;
  }
}

// ── 1. THE DEFAULT. The only place in the suite that can still see it.
console.log('=== 1. the unset default ===');
withEnv(undefined, () => {
  eq('memoryHome() defaults to ~/.claude/vectros-memory',
    P.memoryHome(), path.join(os.homedir(), '.claude', 'vectros-memory'));
  eq('stateDir() defaults under it', P.stateDir(), path.join(os.homedir(), '.claude', 'vectros-memory', 'state'));
  eq('projectsDir() is Claude Code\'s own dir, NOT under our root — it is read, never written',
    P.projectsDir(), path.join(os.homedir(), '.claude', 'projects'));
});

// ── 2. THE OVERRIDE, and the reason these are functions rather than constants.
//
// This assertion is what a memoized module constant could not satisfy: `paths.mjs` was imported at
// the top of this file, long before `withEnv` ran. It answers correctly only because every export
// re-reads the environment per call — the lesson `hooklog.mjs`'s `logPath()` already paid for.
console.log('\n=== 2. the override, resolved per call (not memoized at import) ===');
const FAKE = path.join(os.tmpdir(), 'paths-test-root');
withEnv(FAKE, () => {
  eq('VECTROS_MEMORY_HOME relocates the root', P.memoryHome(), FAKE);
  eq('and every derived dir follows it', P.stateDir(), path.join(FAKE, 'state'));
  eq('and every derived file follows it', P.configFile(), path.join(FAKE, 'config.json'));
  eq('per-session paths follow it too', P.stateFor('abc'), path.join(FAKE, 'state', 'abc.json'));
});

// ── 3. EMPTY MEANS UNSET. `VECTROS_MEMORY_HOME=` in a profile or a CI job spells "leave it alone";
//      read as a literal empty path it would relocate the entire runtime to the process cwd.
console.log('\n=== 3. empty / whitespace means "not set" ===');
for (const blank of ['', '   ', '\t']) {
  withEnv(blank, () => {
    eq(`VECTROS_MEMORY_HOME=${JSON.stringify(blank)} falls back to the default`,
      P.memoryHome(), path.join(os.homedir(), '.claude', 'vectros-memory'));
  });
}
withEnv('  /tmp/trimmed  ', () => {
  eq('a set value is trimmed', P.memoryHome(), '/tmp/trimmed');
});

// ── 4. THE CENSUS. No runtime file may re-derive the root; the seam must be the only way in.
console.log('\n=== 4. census: the hardcoded root appears in NO runtime file ===');
/**
 * Matches the DERIVATION: `homedir()` and the `vectros-memory` segment on one expression.
 *
 * COMMENTS ARE STRIPPED FIRST, STRINGS ARE NOT — `blank(src, { strings: false })`. Both halves are
 * load-bearing and the first run proved it. Without stripping comments the census flagged
 * `config.mjs` for the comment explaining why the literal had just been REMOVED from `config.mjs`:
 * a lint whose own fix message trips it. And the default `blank()` cannot be used either, because
 * it erases string bodies — `'vectros-memory'` is a string literal, so the signal would vanish and
 * the census would report every file clean. This is the case `lintlib`'s new `strings` flag exists
 * for.
 */
const HARDCODED = /homedir\(\)[^;\n]*['"]vectros-memory['"]/;
const runtime = fs.readdirSync(HOOKS).filter((f) => f.endsWith('.mjs')).sort();
const offenders = [];
let scanned = 0;
for (const f of runtime) {
  if (f === 'paths.mjs') continue; // the seam IS the derivation
  scanned++;
  const code = blank(fs.readFileSync(path.join(HOOKS, f), 'utf8'), { strings: false });
  const line = code.split('\n').findIndex((l) => HARDCODED.test(l));
  if (line >= 0) offenders.push(`${f}:${line + 1}`);
}
/**
 * `tests/` IS CENSUSED TOO, and leaving it out was a hole in the exact place this file's own header
 * says the danger lives ("writes into the operator's live runtime FROM A TEST RUN"). The 22
 * hand-rolled literals that motivated the seam were in test files.
 */
const testFiles = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs')).sort();
for (const f of testFiles) {
  // THIS file is exempt and must be: §1 asserts the default layout, which means spelling it out.
  // A census cannot flag the one place whose job is to pin what it is censusing for.
  if (f === path.basename(fileURLToPath(import.meta.url))) continue;
  scanned++;
  const code = blank(fs.readFileSync(path.join(HERE, f), 'utf8'), { strings: false });
  const line = code.split('\n').findIndex((l) => HARDCODED.test(l));
  if (line >= 0) offenders.push(`tests/${f}:${line + 1}`);
}
for (const o of offenders) console.log(`  HARDCODED  ${o}`);
check('the census actually read the tree (a scan of nothing passes everything)',
  scanned >= 35, `only ${scanned} files scanned — runtime AND tests must both be covered`);
eq('no runtime OR test file derives the root itself — all of them go through paths.mjs', offenders.length, 0);

/**
 * ── ISOLATE-FIRST. Any test that reaches the runtime must relocate it, and the rule was carried by
 * a sentence in `isolate.mjs`'s header ("Import this FIRST in any test that touches runtime state")
 * that nothing enforced. Six files reached `config.mjs` transitively without it, so a standalone run
 * resolved `CONFIG_PATH` against the OPERATOR'S live config and wrote its import-time receipt into
 * the production `hooks.log` — the contamination `hooklog.mjs` was written to stop.
 *
 * `smoke.mjs` is the ONE deliberate exception and is listed by name with its reason: it is the
 * operator's post-`cp` deployment check and MUST hit the real runtime when run standalone.
 * `run-all.mjs` isolates it by inheritance.
 */
console.log('\n=== 4b. every test that reaches the runtime imports isolate.mjs first ===');
const EXEMPT = {
  'isolate.mjs': 'it IS the isolation',
  'paths-test.mjs': 'its subject is the derivation, so it must be able to observe the UNSET default',
  'smoke.mjs': 'the operator post-deploy check — must hit the REAL runtime standalone (per this package\'s own deployment/setup steps)',
  'assert.mjs': 'no runtime imports',
  'lintlib.mjs': 'no runtime imports',
  'run-all.mjs': 'imports isolate.mjs directly as the harness',
};
// Either the bare side-effect form (`import './isolate.mjs';`) or a NAMED import
// (`import { privateRoot } from './isolate.mjs';`) counts — a static import always fully
// evaluates the module regardless of what's destructured from it, so isolate.mjs's own
// module-body side effects (relocating VECTROS_MEMORY_HOME) fire either way. A file that needs
// `privateRoot` (isolate.mjs's own second-root helper) still gets isolated first by importing it.
const ISOLATE_IMPORT = /import\s+(?:['"]\.\/isolate\.mjs['"]|\{[^}]*\}\s*from\s*['"]\.\/isolate\.mjs['"])/;
const unisolated = [];
for (const f of testFiles) {
  if (f in EXEMPT) continue;
  const code = blank(fs.readFileSync(path.join(HERE, f), 'utf8'), { strings: false });
  // Does it reach the runtime at all? Any `../x.mjs` import counts.
  if (!/from\s+['"]\.\.\//.test(code)) continue;
  if (!ISOLATE_IMPORT.test(code)) unisolated.push(f);
}
for (const u of unisolated) console.log(`  UNISOLATED  tests/${u}`);
eq('no test reaches the runtime without isolating it first', unisolated.length, 0);
check('RED-proof: the isolate lint can see a missing import',
  !ISOLATE_IMPORT.test("import { x } from '../paths.mjs';")
  && ISOLATE_IMPORT.test("import './isolate.mjs';\nimport { x } from '../paths.mjs';"));
check('RED-proof: a NAMED import of isolate.mjs also counts — it isolates just as surely',
  ISOLATE_IMPORT.test("import { privateRoot } from './isolate.mjs';\nimport { x } from '../paths.mjs';"));

/**
 * RED-PROOF for the census, in-process. The sabotage is the literal that WAS in all 17 files, so a
 * scanner that cannot see this one could not have seen any of them.
 */
check('RED-proof: the pre-seam literal is CAUGHT',
  HARDCODED.test("const ROOT = path.join(os.homedir(), '.claude', 'vectros-memory');"));
check('RED-proof: a deeper join is CAUGHT too',
  HARDCODED.test("const S = path.join(os.homedir(), '.claude', 'vectros-memory', 'state');"));
check('RED-proof: PROSE naming the path is NOT flagged (or every module header is an offender)',
  !HARDCODED.test(" * state lives under ~/.claude/vectros-memory/state and is read by six hooks."));
check('RED-proof: the seam\'s own call is NOT flagged',
  !HARDCODED.test("const STATE_DIR = stateDir();"));
// The two blanking modes, pinned against each other — this census is only correct if BOTH hold.
check('RED-proof: a COMMENT quoting the literal is stripped before scanning',
  !HARDCODED.test(blank(" // was path.join(os.homedir(), '.claude', 'vectros-memory')\n", { strings: false })));
check('RED-proof: and the string body SURVIVES that stripping (default blank() would hide every offender)',
  HARDCODED.test(blank("const R = path.join(os.homedir(), '.claude', 'vectros-memory');\n", { strings: false }))
  && !HARDCODED.test(blank("const R = path.join(os.homedir(), '.claude', 'vectros-memory');\n")));

// ── 5. EVERY DERIVED PATH STAYS UNDER THE ROOT — so isolation cannot leak through a new subpath.
//
// The failure this catches: someone adds `export const foo = () => path.join(os.homedir(), …)` to
// paths.mjs itself, where §4's census deliberately does not look. Then one directory keeps pointing
// at the live runtime while everything else relocates, and a reaper test deletes real state.
console.log('\n=== 5. every runtime path stays under the root ===');
/**
 * THE PER-PATH OVERRIDES MUST BE CLEARED FIRST, and finding that out is why this check earns its
 * place. It passed standalone and FAILED under `run-all.mjs` — because `isolate.mjs` deliberately
 * pins `VECTROS_HOOK_CREDENTIALS` to the real credentials file before relocating the root (the
 * `*-real-test.mjs` files need a live key), so `credentialsFile()` correctly resolved OUTSIDE the
 * fake root and the assertion correctly objected.
 *
 * The invariant being tested is about the DERIVATION — "nothing is reachable except through the
 * root" — not about an operator override, which is a documented escape hatch and the whole reason
 * `isolate.mjs` works at all. So the overrides are cleared here, and asserted separately below.
 * Left as it was, this check would have been red for a legitimate reason on every suite run, and
 * the fix someone reached for under time pressure would have been to delete it.
 */
const PATH_OVERRIDES = ['VECTROS_MEMORY_CONFIG', 'VECTROS_HOOK_CREDENTIALS', 'VECTROS_HOOKLOG_PATH'];
const savedOverrides = PATH_OVERRIDES.map((k) => [k, process.env[k]]);
for (const k of PATH_OVERRIDES) delete process.env[k];
try {
  withEnv(FAKE, () => {
    // Excluded because they are deliberately NOT under our root, or are not paths at all:
    // `claudeHome`/`projectsDir` belong to Claude Code, `memoryHome` IS the root (not under it),
    // `inMemoryHome`/`slug` are helpers.
    const OUTSIDE = new Set(['claudeHome', 'projectsDir', 'memoryHome', 'inMemoryHome', 'slug']);
    const leaked = [];
    let checked = 0;
    for (const [name, fn] of Object.entries(P)) {
      if (typeof fn !== 'function' || OUTSIDE.has(name)) continue;
      // Per-session helpers need an argument; the rest take none. Both return a path.
      const got = fn.length ? fn('sid') : fn();
      if (typeof got !== 'string') continue;
      checked++;
      if (!got.startsWith(FAKE + path.sep)) leaked.push(`${name}() -> ${got}`);
    }
    for (const l of leaked) console.log(`  OUTSIDE ROOT  ${l}`);
    check('the sweep actually exercised the exports', checked >= 12, `only ${checked} path exports called`);
    eq('no runtime path escapes VECTROS_MEMORY_HOME by DERIVATION', leaked.length, 0);
  });

  // And the escape hatches themselves — the contract `isolate.mjs` and `config-test.mjs` rely on.
  withEnv(FAKE, () => {
    process.env.VECTROS_HOOK_CREDENTIALS = '/elsewhere/creds.json';
    process.env.VECTROS_MEMORY_CONFIG = '/elsewhere/cfg.json';
    eq('VECTROS_HOOK_CREDENTIALS overrides the derived path', P.credentialsFile(), '/elsewhere/creds.json');
    eq('VECTROS_MEMORY_CONFIG overrides the derived path', P.configFile(), '/elsewhere/cfg.json');
    delete process.env.VECTROS_HOOK_CREDENTIALS;
    delete process.env.VECTROS_MEMORY_CONFIG;
    eq('and clearing it falls back under the root', P.credentialsFile(), path.join(FAKE, 'credentials.json'));
  });
} finally {
  for (const [k, v] of savedOverrides) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ── 6. THE SLUG IS UNCHANGED — 5,779 state files in a real corpus are named by the old one.
//
// Five modules each carried their own copy of this regex before the seam. They agreed, which is the
// only reason consolidating them is safe; this pins that agreement so the shared copy can never
// drift away from the names already on disk. A changed slug does not error — it silently orphans
// every existing session's state and queue, and the first symptom is a re-orient on every resume.
console.log('\n=== 6. slug compatibility with state already on disk ===');
const legacy = (s) => String(s).replace(/[^\w.-]/g, '_');
for (const sid of ['abc123', '554ecd89-ccc4-4190-896b-8ac6c037deaf', 'orient-boundary-test-0001',
  'has space', 'has/slash', 'has:colon', 'dots.and-dashes', '']) {
  eq(`slug(${JSON.stringify(sid)}) matches the pre-seam regex`, P.slug(sid), legacy(sid));
}
check('slug coerces a non-string instead of throwing (four of the five old copies would have thrown)',
  P.slug(42) === '42' && P.slug(null) === 'null');

done();
