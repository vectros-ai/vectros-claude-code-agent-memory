#!/usr/bin/env node
/**
 * THE BOOTSTRAP CYCLE — `config.mjs` <-> `atomic.mjs` / `hooklog.mjs`, and the guard that makes it safe.
 *
 * WHAT IS AT STAKE. `config.mjs` imports `readJsonSafe` from `atomic.mjs` and `hlog` from
 * `hooklog.mjs` on purpose (this discipline: one corrupt-detector, one logger, not two). The moment those two
 * modules take THEIR tunables from the seam, the import graph is a cycle — and ESM's rule is that
 * reading a `const` from a module still evaluating is a `ReferenceError`, not `undefined`.
 * `config.mjs`'s resolution calls `readJsonSafe` as its first act, so a named
 * `import { RENAME_RETRIES }` in `atomic.mjs` would be read from inside the temporal dead zone.
 *
 * AND IT WOULD NOT HAVE FAILED IN TESTING. `readJsonSafe` touches the retry budget ONLY on the
 * contended-read branch: ENOENT returns before it, a clean read never reaches it. So every ordinary
 * startup works, and the throw arrives only under file contention — the one condition this whole
 * subsystem exists because of, on machines we do not own. A hook that dies at import cannot `hlog`,
 * so it would present as the failure `hooklog.mjs`'s header calls indistinguishable from success.
 * That is why this file exists: the defect it guards is invisible to every other kind of test.
 *
 * WHY THE MECHANISM IS PROVEN ON A FIXTURE PAIR (§1) AND NOT ON THE REAL GRAPH. Reaching the real
 * throw needs `readFileSync` to raise EPERM/EACCES/EBUSY on the config file at the exact instant of
 * bootstrap — a Windows sharing violation from a NON-Node holder (AV, indexer, backup) opening with
 * FILE_SHARE_NONE. `lock.mjs`'s header already documents that this is not reachable from `node:fs`:
 * libuv opens with FILE_SHARE_READ|WRITE|DELETE, so a harness built from `node:fs` can only ever
 * confirm the answer it assumes. A fixture pair reproduces the ESM SEMANTICS exactly — same cycle,
 * same TDZ rule, same interpreter — and states plainly that it models the graph rather than being
 * it. §2's census is what ties the model back to the real files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { blank } from './lintlib.mjs';
import './isolate.mjs';
import { tunables, SPEC } from '../config.mjs';

/**
 * The modules in the cycle with `config.mjs` — i.e. the ones whose exports are called during their
 * OWN module evaluation, so every binding those exports touch must be hoisted.
 *
 * Declared here rather than beside §2 because §1c uses it too, and putting it below §1c produced a
 * `ReferenceError: Cannot access 'IN_CYCLE' before initialization` — a temporal-dead-zone error
 * inside the temporal-dead-zone census. Kept as a note because it is the same mistake one level up:
 * a `const` is only available after the line that declares it, wherever you are.
 */
const IN_CYCLE = ['atomic.mjs', 'hooklog.mjs'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bootstrap-'));
const write = (name, body) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE MECHANISM. Two fixture pairs with the identical cycle: one reading a named export from
//    inside the dead zone (the shape BEFORE this change), one going through a guarded accessor
//    (the shape after). The first MUST throw; if it does not, this whole guard is cargo cult.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. the ESM cycle, with and without the guard ===');

/** `cfg` calls into `leaf` while still evaluating — exactly what resolveConfig->readJsonSafe does. */
function pair(dir, cfgBody, leafBody) {
  fs.mkdirSync(path.join(TMP, dir), { recursive: true });
  write(path.join(dir, 'leaf.mjs'), leafBody);
  write(path.join(dir, 'cfg.mjs'), cfgBody);
  return pathToFileURL(path.join(TMP, dir, 'cfg.mjs')).href;
}
/** The same fixture entered through the LEAF — the ordering every real hook produces. */
const leafEntry = (dir) => pathToFileURL(path.join(TMP, dir, 'leaf.mjs')).href;

/**
 * ⚠ THE ENTRY POINT IS THE **LEAF**, AND GETTING THAT WRONG HID A SHIPPED CRASH.
 *
 * This fixture has now been wrong twice, in two different ways, and both are worth keeping:
 *
 *   Draft 1 declared `RETRIES` BEFORE the call, so the binding was initialised and the "unguarded"
 *   cycle imported cleanly. The test reported that as a failure and was right to — a red-proof that
 *   cannot go red proves nothing.
 *
 *   Draft 2 fixed the statement order but entered through `cfg.mjs`. That makes CFG the first cycle
 *   member started, so `leaf`'s body is fully evaluated by the time cfg's body runs — and it is the
 *   ordering NO REAL ENTRY POINT PRODUCES. All nine hooks reach `atomic.mjs` (via `creds.mjs` or
 *   `hooklog.mjs`) BEFORE `config.mjs`, i.e. LEAF-FIRST. So the test proved a hazard that cannot
 *   occur while missing the one that does: `atomic.mjs`'s own `const CONTENDED` sitting in TDZ
 *   while config called `readJsonSafe`. Reproduced against the real modules — `recall.mjs` with an
 *   unreadable `config.json` died at import with no log line at all.
 *
 * The lesson generalises past this file: when you model a cycle, the ENTRY EDGE is the variable
 * that decides which member's bindings are dead, and picking it by convenience models the mirror
 * image of production — a fixture built to your assumption only validates the assumption, not the
 * code it is meant to model.
 */
const unguarded = pair('unguarded',
  `import { readIt } from './leaf.mjs';
   export const OUT = readIt();
   export const RETRIES = 12;`,
  `import { RETRIES } from './cfg.mjs';
   export function readIt() { return RETRIES; }`);

let unguardedErr = null;
try { await import(unguarded); } catch (e) { unguardedErr = e; }
check('RED-proof: the UNGUARDED cycle throws at import — the defect is real, not theoretical',
  unguardedErr !== null, 'the unguarded fixture imported cleanly; this test proves nothing');
check('RED-proof: and it throws ReferenceError specifically (a TDZ read, not some other error)',
  unguardedErr?.name === 'ReferenceError',
  `got ${unguardedErr?.name}: ${unguardedErr?.message}`);
check('RED-proof: naming the constant that could not be read',
  /RETRIES/.test(unguardedErr?.message || ''), unguardedErr?.message);

// GUARDED: leaf calls an accessor that answers with defaults while resolution is in flight.
// Same statement order as the unguarded pair — the call still precedes every value binding.
const guarded = pair('guarded',
  `import { readIt } from './leaf.mjs';
   const DEFAULTS = { RETRIES: 12 };
   let RESOLVED = null;
   let RESOLVING = false;
   export function tunables() {
     if (RESOLVED) return RESOLVED;
     if (RESOLVING) return DEFAULTS;
     RESOLVING = true;
     try { RESOLVED = { RETRIES: readIt() + 1 }; } finally { RESOLVING = false; }
     return RESOLVED;
   }
   export const OUT = tunables();
   export const RETRIES = OUT.RETRIES;`,
  `import { tunables } from './cfg.mjs';
   export function readIt() { return tunables().RETRIES; }`);

let guardedMod = null;
let guardedErr = null;
try { guardedMod = await import(guarded); } catch (e) { guardedErr = e; }
check('the GUARDED cycle imports cleanly', guardedErr === null, String(guardedErr));
eq('and the re-entrant call got the DEFAULT (12), so resolution completed on top of it',
  guardedMod?.OUT?.RETRIES, 13);

/**
 * ── THE PRODUCTION ORDERING. Entry is the LEAF, which is what all nine hooks do.
 *
 * `leaf` starts evaluating, hits its import of `cfg`, and hands control over; `cfg`'s body then
 * calls back into `leaf` — whose own body has not run. A `const` in leaf is therefore dead, and a
 * hoisted `function` is not. That is the entire difference between the crash and the fix, and
 * neither fixture above can express it because both enter through `cfg`.
 */
console.log('\n=== 1b. THE REAL ORDERING: entry is the LEAF, and the leaf\'s own consts are dead ===');
// The leaf imports a HOISTED FUNCTION from cfg (`tunables`), which is exactly the real edge:
// atomic.mjs does `import { tunables } from './config.mjs'`. Importing a cfg *value* here would
// introduce a second, different TDZ and stop the fixture from isolating the one under test.
pair('leafconst', // return value unused — only the fixture-file side effect matters; imported by name below
  `import { readIt } from './leaf.mjs';
   export function tunables() { return { R: 12 }; }
   export const OUT = readIt();`,
  `import { tunables } from './cfg.mjs';
   const CONTENDED = new Set(['EPERM']);
   export function readIt() { return CONTENDED.has('EPERM') && tunables().R === 12; }`);
let leafConstErr = null;
try { await import(leafEntry('leafconst')); } catch (e) { leafConstErr = e; }
check('RED-proof: a `const` in the leaf IS dead when cfg calls back into it — this is the shipped crash',
  leafConstErr?.name === 'ReferenceError' && /CONTENDED/.test(leafConstErr?.message || ''),
  `expected ReferenceError naming CONTENDED, got ${leafConstErr?.name}: ${leafConstErr?.message}`);

pair('leaffn', // return value unused — same as leafconst above
  `import { readIt } from './leaf.mjs';
   export function tunables() { return { R: 12 }; }
   export const OUT = readIt();`,
  `import { tunables } from './cfg.mjs';
   function isContended(c) { return c === 'EPERM'; }
   export function readIt() { return isContended('EPERM') && tunables().R === 12; }`);
let leafFnMod = null;
let leafFnErr = null;
try { leafFnMod = await import(leafEntry('leaffn')); } catch (e) { leafFnErr = e; }
// The namespace here is the LEAF's (that is the entry), so `OUT` lives in cfg and is not on it —
// assert through the leaf's own export instead, which also proves the callback path really ran.
check('and a hoisted `function` is NOT — which is why atomic.mjs uses declarations, not consts',
  leafFnErr === null && leafFnMod?.readIt() === true,
  leafFnErr ? String(leafFnErr) : `readIt() returned ${leafFnMod?.readIt?.()}`);

/**
 * THE CENSUS THAT KEEPS IT FIXED. `atomic.mjs`'s exports are called during its own dead zone, so
 * every binding they reach must be hoisted. A future "tidy-up" to `const isContended = (c) => …`
 * reads better, passes every other test in the suite, and restores a crash that only fires when
 * config.json exists and cannot be read — i.e. never here, only on an adopter's machine.
 */
console.log('\n=== 1c. census: atomic.mjs binds its bootstrap-reachable helpers as hoisted functions ===');
{
  const src = blank(fs.readFileSync(path.join(HOOKS, 'atomic.mjs'), 'utf8'), { strings: false });
  for (const name of ['isContended', 'sleepSync', 'retries', 'retryMs']) {
    check(`${name} is a hoisted function declaration, not a const/let`,
      new RegExp(`^function ${name}\\b`, 'm').test(src),
      `atomic.mjs binds ${name} as a const/arrow — it is reachable from readJsonSafe during config's bootstrap and would be in TDZ`);
  }
  check('RED-proof: the census can tell a const-arrow from a declaration',
    !/^function foo\b/m.test('const foo = () => 1;') && /^function foo\b/m.test('function foo() { return 1; }'));

  /**
   * ── AND WHAT THOSE BODIES *READ*, not only how they are declared. This is the gap that let the
   * real defect through.
   *
   * The check above enforces DECLARATION FORM. The rule this module's header actually states is
   * broader: *"ANY binding reachable from a function this module exports must be hoisted."* A
   * hoisted `function sleepSync()` whose body reads a module-scope `let _ia` satisfies the form
   * check and violates the rule — and that shipped. The throw landed in `sleepSync`'s own catch, so
   * the retry loop silently stopped sleeping and the measured 12 x 3ms contention budget became
   * twelve back-to-back attempts with zero delay, with no crash and no log line.
   *
   * `var` is the correct tool and the only one that is safe here: hoisted AND initialized to
   * `undefined`, so it has no dead zone. `let`/`const` at module scope both do.
   *
   * The census is deliberately narrow — any `let`/`const` at MODULE scope in an in-cycle module —
   * because that is the whole population that can be dead when the exports run. Function-local
   * `let`/`const` is fine and must not be flagged.
   */
  for (const f of IN_CYCLE) {
    const code = blank(fs.readFileSync(path.join(HOOKS, f), 'utf8'), { strings: false });
    const moduleScoped = [...code.matchAll(/^(?:export )?(let|const)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => `${m[1]} ${m[2]}`);
    if (moduleScoped.length) console.log(`  MODULE-SCOPE TDZ RISK  ${f}: ${moduleScoped.join(', ')}`);
    eq(`${f} has NO module-scope let/const — every binding its exports touch must be hoisted`,
      moduleScoped.length, 0);
  }
  check('RED-proof: the binding census catches a module-scope let, and ignores a function-local one',
    [...blank('let _ia = null;\nfunction f() { const local = 1; return local; }\n', { strings: false })
      .matchAll(/^(?:export )?(let|const)\s+([A-Za-z_$][\w$]*)/gm)].length === 1);
  check('RED-proof: ...and does not flag `var`, which is hoisted AND initialized',
    [...blank('var _ia;\n', { strings: false })
      .matchAll(/^(?:export )?(let|const)\s+([A-Za-z_$][\w$]*)/gm)].length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CENSUS — the durable countermeasure, and the only part of this file that watches the REAL
//    modules. §1 proves the mechanism; this proves the mechanism is still what ships.
//
//    The failure it prevents is a plausible "simplification": someone sees
//    `const retries = () => tunables().RENAME_RETRIES` and tidies it to
//    `import { RENAME_RETRIES } from './config.mjs'`, which reads better, passes every test in the
//    suite, and re-arms a landmine that only fires under contention on someone else's machine.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. census: the two in-cycle modules import ONLY `tunables` from config ===');
const violations = [];
for (const f of IN_CYCLE) {
  const code = blank(fs.readFileSync(path.join(HOOKS, f), 'utf8'), { strings: false });
  const m = code.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.mjs['"]/);
  if (!m) { violations.push(`${f}: imports nothing from config.mjs — it should import tunables`); continue; }
  const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
  for (const n of named) {
    if (n !== 'tunables') {
      violations.push(`${f}: imports \`${n}\` from config.mjs — a TDZ read at bootstrap; use tunables()`);
    }
  }
}
for (const v of violations) console.log(`  VIOLATION  ${v}`);
eq('neither in-cycle module imports a named config VALUE', violations.length, 0);

// The census must be able to see a violation, or it is decoration.
const SABOTAGE = "import { RENAME_RETRIES, tunables } from './config.mjs';";
const sabNamed = SABOTAGE.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.mjs['"]/)[1]
  .split(',').map((s) => s.trim()).filter((n) => n !== 'tunables');
check('RED-proof: the census CATCHES a named-value import alongside tunables',
  sabNamed.includes('RENAME_RETRIES'), JSON.stringify(sabNamed));

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE VALUES ACTUALLY REACH THEIR CONSUMERS. A seam that resolves correctly and is then ignored
//    by the module it configures is the failure `recall.mjs` shipped for a week.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. the migrated infra tunables are wired end to end ===');
for (const key of ['RENAME_RETRIES', 'RENAME_RETRY_MS', 'HOOKLOG_MAX_BYTES',
  'HOOKLOG_KEEP_GENERATIONS', 'LOCK_STALE_MS']) {
  check(`${key} is in SPEC with a default and provenance`,
    SPEC[key] && typeof SPEC[key].def === 'number' && typeof SPEC[key].note === 'string' && SPEC[key].note.length > 40,
    `SPEC.${key} = ${JSON.stringify(SPEC[key] && { def: SPEC[key].def, note: SPEC[key].note })}`);
  eq(`tunables() exposes ${key}`, typeof tunables()[key], 'number');
}

/**
 * `rollAtomic`'s keepGenerations now DEFAULTS to the seam rather than to a literal 5, so the two
 * copies of that number (one in atomic, one passed by hooklog) are gone. Proven through behaviour:
 * roll 4 generations under a config of 2 and count what survives.
 */
console.log('\n=== 4. rollAtomic honours HOOKLOG_KEEP_GENERATIONS from config (no literal default) ===');
{
  const cfg = write('keep2.json', JSON.stringify({ HOOKLOG_KEEP_GENERATIONS: 2 }));
  const dir = fs.mkdtempSync(path.join(TMP, 'roll-'));
  const target = path.join(dir, 'x.log');
  const probe = write('probe.mjs', `
    import fs from 'node:fs';
    import { rollAtomic } from ${JSON.stringify(pathToFileURL(path.join(HOOKS, 'atomic.mjs')).href)};
    const target = ${JSON.stringify(target)};
    for (const t of ['a', 'b', 'c', 'd']) { fs.writeFileSync(target, t); rollAtomic(target, { stamp: t }); }
    console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(dir)}).sort()));
  `);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [probe], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, VECTROS_MEMORY_CONFIG: cfg },
  });
  const survivors = JSON.parse((r.stdout || '[]').trim().split('\n').pop() || '[]');
  eq('a config of 2 keeps exactly 2 generations (the literal default was 5)', survivors.length, 2);
  check('and they are the NEWEST two', survivors.join(',') === 'x.log.c,x.log.d', survivors.join(','));
}

done();
