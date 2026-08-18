// Exercise config.mjs — the tunable loader. The whole point of this module is what it does
// when config is ABSENT or BROKEN, so those are the cases with teeth: a loader that only gets
// tested on a well-formed file is not known to fail open. Every case here can go RED — the values
// and the receipt (`state`/`overrides`/`rejected`) are compared, never printed-and-hoped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log. config.mjs's own `reportConfig` calls hlog on every damaged/rejected case
// this file deliberately forces.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-log-')), 'hooks.log');

const HOOKS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const { resolveConfig, reportConfig, SPEC } = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href);

const DEF = SPEC.CONTEXT_CAP.def; // 9500 — assert against the spec, not a copied literal
const ENVK = SPEC.CONTEXT_CAP.env; // 'VECTROS_MEM_CONTEXT_CAP'

const TMP = path.join(os.tmpdir(), `cfg-test-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
const write = (name, s) => { const p = path.join(TMP, name); fs.writeFileSync(p, s); return p; };
const rej = (r) => r.rejected.filter((j) => j.key === 'CONTEXT_CAP');
const ovr = (r) => r.overrides.filter((o) => o.key === 'CONTEXT_CAP');

try {
  console.log('=== 1. MISSING file → defaults, QUIET (missing is quiet) ===');
  const r1 = resolveConfig({ file: path.join(TMP, 'does-not-exist.json'), env: {} });
  eq('missing → CONTEXT_CAP is the default', r1.values.CONTEXT_CAP, DEF);
  eq('missing → state is fresh (the quiet case)', r1.state, 'fresh');
  check('missing → nothing rejected', rej(r1).length === 0, JSON.stringify(r1.rejected));
  check('missing → nothing overridden', ovr(r1).length === 0);

  console.log('\n=== 2. DAMAGED file → defaults, LOUD (corrupt is loud) ===');
  const r2 = resolveConfig({ file: write('damaged.json', '{ this is not json '), env: {} });
  eq('damaged → CONTEXT_CAP is the default', r2.values.CONTEXT_CAP, DEF);
  eq('damaged → state is damaged (the loud case)', r2.state, 'damaged');

  console.log('\n=== 3. UNREADABLE (a directory sits at the path) → defaults, distinct state ===');
  const dir = path.join(TMP, 'isdir.json'); fs.mkdirSync(dir, { recursive: true });
  const r3 = resolveConfig({ file: dir, env: {} });
  eq('unreadable → CONTEXT_CAP is the default', r3.values.CONTEXT_CAP, DEF);
  eq('unreadable → state is unreadable, NOT conflated with damaged', r3.state, 'unreadable');

  console.log('\n=== 4. a valid FILE value overrides the default ===');
  const good = write('good.json', JSON.stringify({ CONTEXT_CAP: 8000 }));
  const r4 = resolveConfig({ file: good, env: {} });
  eq('file override applied', r4.values.CONTEXT_CAP, 8000);
  check('file override recorded with source=file', ovr(r4).some((o) => o.source === 'file' && o.value === 8000), JSON.stringify(r4.overrides));

  console.log('\n=== 5. ENV beats FILE (precedence: default < file < env) ===');
  const r5 = resolveConfig({ file: good, env: { [ENVK]: '7000' } });
  eq('env beats file', r5.values.CONTEXT_CAP, 7000);
  check('override recorded with source=env', ovr(r5).some((o) => o.source === 'env'), JSON.stringify(r5.overrides));

  console.log('\n=== 6. an out-of-range FILE value is REJECTED and falls back ===');
  const r6 = resolveConfig({ file: write('oor.json', JSON.stringify({ CONTEXT_CAP: 999999 })), env: {} });
  eq('out-of-range (>10K ceiling) → default, not the bad value', r6.values.CONTEXT_CAP, DEF);
  check('out-of-range → rejected loudly', rej(r6).some((j) => j.source === 'file'), JSON.stringify(r6.rejected));

  console.log('\n=== 7. non-integer / fractional FILE values are rejected ===');
  eq('non-integer string → default', resolveConfig({ file: write('nan.json', JSON.stringify({ CONTEXT_CAP: 'lots' })), env: {} }).values.CONTEXT_CAP, DEF);
  eq('fractional → default', resolveConfig({ file: write('frac.json', JSON.stringify({ CONTEXT_CAP: 3.5 })), env: {} }).values.CONTEXT_CAP, DEF);
  eq('zero → default (min is 1)', resolveConfig({ file: write('zero.json', JSON.stringify({ CONTEXT_CAP: 0 })), env: {} }).values.CONTEXT_CAP, DEF);

  console.log('\n=== 7c. the 10K-ceiling BOUNDARY: 9999 accepted, 10000 rejected, 1 accepted ===');
  // The budget MUST stay UNDER the 10K additionalContext ceiling, so the ceiling value itself is out.
  eq('9999 accepted (max)', resolveConfig({ file: write('b1.json', JSON.stringify({ CONTEXT_CAP: 9999 })), env: {} }).values.CONTEXT_CAP, 9999);
  eq('10000 REJECTED → default (it is the ceiling, not under it)', resolveConfig({ file: write('b2.json', JSON.stringify({ CONTEXT_CAP: 10000 })), env: {} }).values.CONTEXT_CAP, DEF);
  eq('1 accepted (min)', resolveConfig({ file: write('b3.json', JSON.stringify({ CONTEXT_CAP: 1 })), env: {} }).values.CONTEXT_CAP, 1);

  console.log('\n=== 8. an invalid ENV value FALLS THROUGH to a valid file value (true layering) ===');
  const r8 = resolveConfig({ file: good, env: { [ENVK]: '50000' } });
  eq('invalid env → falls through to the valid file value', r8.values.CONTEXT_CAP, 8000);
  check('invalid env recorded as rejected(env)', rej(r8).some((j) => j.source === 'env'));
  check('...and the file value then applied', ovr(r8).some((o) => o.source === 'file'));

  console.log('\n=== 8b. env invalid AND file invalid → the default, with BOTH rejections logged ===');
  const r8b = resolveConfig({ file: write('badfile.json', JSON.stringify({ CONTEXT_CAP: -3 })), env: { [ENVK]: 'nope' } });
  eq('both invalid → default', r8b.values.CONTEXT_CAP, DEF);
  eq('both invalid → two rejections recorded', rej(r8b).length, 2);

  console.log('\n=== 9. an empty/whitespace ENV var means "unset" — file wins, no rejection ===');
  const r9 = resolveConfig({ file: good, env: { [ENVK]: '   ' } });
  eq('empty env is unset → file value wins', r9.values.CONTEXT_CAP, 8000);
  check('empty env produced NO spurious rejection', rej(r9).length === 0, JSON.stringify(r9.rejected));

  console.log('\n=== 9b. reportConfig receipt (loud/quiet) — inject a log sink, assert what it says ===');
  const cap = () => { const logs = []; return { logs, sink: (_tag, msg) => logs.push(msg) }; };
  {
    // fresh (missing) + no override → QUIET
    const c = cap(); reportConfig(resolveConfig({ file: path.join(TMP, 'none.json'), env: {} }), 'f', c.sink);
    check('fresh + no override → silent', c.logs.length === 0, JSON.stringify(c.logs));
  }
  {
    // ok (parses) + no override → QUIET
    const c = cap(); reportConfig(resolveConfig({ file: write('empty.json', '{}'), env: {} }), 'f', c.sink);
    check('ok + no override → silent', c.logs.length === 0, JSON.stringify(c.logs));
  }
  {
    // damaged, no override → LOUD, and NOT an "applied" line
    const c = cap(); reportConfig(resolveConfig({ file: write('dmg2.json', '{ nope'), env: {} }), 'f', c.sink);
    check('damaged → a loud MALFORMED line', c.logs.some((m) => /MALFORMED/.test(m)), JSON.stringify(c.logs));
    check('damaged → no "applied" line when nothing applied', !c.logs.some((m) => /applied/.test(m)));
  }
  {
    // valid override → an "applied" receipt fires
    const c = cap(); reportConfig(resolveConfig({ file: good, env: {} }), 'f', c.sink);
    check('override → an "applied" receipt', c.logs.some((m) => /applied:.*CONTEXT_CAP=8000\(file\)/.test(m)), JSON.stringify(c.logs));
  }
  {
    // THE F2 FIX: damaged file + valid ENV override → the malformed line must NOT claim the default
    // is in use, AND the applied receipt for the env value must still fire.
    const c = cap(); reportConfig(resolveConfig({ file: write('dmg3.json', '{ bad'), env: { [ENVK]: '8000' } }), 'f', c.sink);
    check('damaged+env: applied receipt still fires', c.logs.some((m) => /applied:.*CONTEXT_CAP=8000\(env\)/.test(m)), JSON.stringify(c.logs));
    check('damaged+env: malformed line does NOT claim "using defaults"', !c.logs.some((m) => /using defaults/.test(m)), JSON.stringify(c.logs));
    check('damaged+env: malformed line says env overrides still apply', c.logs.some((m) => /env overrides still apply/.test(m)));
  }
  {
    // UNREADABLE (a directory at the path → EISDIR) + valid env: the UNREADABLE line must not claim
    // the default is used, and the applied(env) receipt must still fire — the F2 fix's other branch.
    const dir2 = path.join(TMP, 'cfgdir'); fs.mkdirSync(dir2, { recursive: true });
    const c = cap(); reportConfig(resolveConfig({ file: dir2, env: { [ENVK]: '8000' } }), 'f', c.sink);
    check('unreadable+env: an UNREADABLE line fires', c.logs.some((m) => /UNREADABLE/.test(m)), JSON.stringify(c.logs));
    check('unreadable+env: says env overrides still apply (not "using defaults")', c.logs.some((m) => /env overrides still apply/.test(m)) && !c.logs.some((m) => /using defaults/.test(m)));
    check('unreadable+env: the applied(env) receipt still fires', c.logs.some((m) => /applied:.*CONTEXT_CAP=8000\(env\)/.test(m)));
  }

  console.log('\n=== 10. CONTRACT: the NAMED export resolves via CONFIG_PATH (what recall/evaluate import) ===');
  // This is the consumer contract, not a proxy for it: prove the import-time wiring turns a config
  // file at CONFIG_PATH into the `CONTEXT_CAP` value the two hooks actually receive. (validate
  // the contract the real caller sees, not just the internal helper.)
  const prevCfg = process.env.VECTROS_MEMORY_CONFIG;
  const prevEnvK = process.env[ENVK];
  delete process.env[ENVK]; // ensure the file value, not a stray env, is what gets read
  process.env.VECTROS_MEMORY_CONFIG = write('wire.json', JSON.stringify({ CONTEXT_CAP: 8500 }));
  const wired = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href + '?wire=1'); // fresh module eval
  eq('named CONTEXT_CAP export reflects the file at CONFIG_PATH', wired.CONTEXT_CAP, 8500);
  if (prevCfg === undefined) delete process.env.VECTROS_MEMORY_CONFIG; else process.env.VECTROS_MEMORY_CONFIG = prevCfg;
  if (prevEnvK !== undefined) process.env[ENVK] = prevEnvK;

  console.log('\n=== 11B. the four sweep tunables (a test EACH, per the SPEC contract) ===');
  // "The remaining tunables migrate into SPEC the same way; do NOT bulk them in without a test
  // each." These three decide when a billed distiller is spawned for somebody else's session, so
  // the rails matter more than usual: a bad value must be REJECTED and fall to a default that is
  // known-safe, never silently accepted.
  {
    const defs = resolveConfig({ file: path.join(TMP, 'nope.json'), env: {} }).values;
    eq('STALE_SESSION_MS defaults to 24h (owner-set, n=13 confirmed)', defs.STALE_SESSION_MS, 24 * 60 * 60 * 1000);
    eq('RESIDUAL_FLOOR_CHARS defaults to 2000 (n=13: cuts nothing observed)', defs.RESIDUAL_FLOOR_CHARS, 2_000);
    eq('SWEEP_DEBOUNCE_MS defaults to 10 min', defs.SWEEP_DEBOUNCE_MS, 600_000);
  }
  {
    const r = resolveConfig({
      file: write('sweep.json', JSON.stringify({ STALE_SESSION_MS: 6 * 3_600_000, RESIDUAL_FLOOR_CHARS: 500, SWEEP_DEBOUNCE_MS: 60_000 })),
      env: {},
    });
    eq('STALE_SESSION_MS is file-overridable', r.values.STALE_SESSION_MS, 6 * 3_600_000);
    eq('RESIDUAL_FLOOR_CHARS is file-overridable', r.values.RESIDUAL_FLOOR_CHARS, 500);
    eq('SWEEP_DEBOUNCE_MS is file-overridable', r.values.SWEEP_DEBOUNCE_MS, 60_000);
  }
  {
    const r = resolveConfig({ file: path.join(TMP, 'nope.json'), env: { VECTROS_MEM_STALE_SESSION_MS: '28800000' } });
    eq('env wins for STALE_SESSION_MS', r.values.STALE_SESSION_MS, 8 * 3_600_000);
  }
  {
    // THE REJECTION PATH, which is the one that matters. A 30-second staleness would declare every
    // live session "done" and flush transcripts out from under working agents; a zero floor would
    // bill a Haiku call for every phantom Stop. Out-of-range must fall back LOUDLY, not clamp.
    const r = resolveConfig({
      file: write('badsweep.json', JSON.stringify({ STALE_SESSION_MS: 30_000, RESIDUAL_FLOOR_CHARS: 0, SWEEP_DEBOUNCE_MS: 'soon' })),
      env: {},
    });
    eq('a 30s staleness is REJECTED, not accepted', r.values.STALE_SESSION_MS, 24 * 60 * 60 * 1000);
    eq('a 0 floor is REJECTED (it would bill every phantom)', r.values.RESIDUAL_FLOOR_CHARS, 2_000);
    // THE RAILS MUST EXCLUDE THE DANGEROUS REGION, not merely bound the type — CONTEXT_CAP's own
    // lesson (its max is 9999 because posInt(1,10_000) accepted the one value it existed to
    // exclude). A 1-minute staleness would flush LIVE sessions and hand their pending candidates to
    // another agent; a floor of 1 disables the phantom guard while still type-checking.
    const rails = resolveConfig({
      file: write('rails.json', JSON.stringify({ STALE_SESSION_MS: 60_000, RESIDUAL_FLOOR_CHARS: 1 })),
      env: {},
    });
    eq('a 1-MINUTE staleness is REJECTED (it would flush live sessions)', rails.values.STALE_SESSION_MS, 24 * 60 * 60 * 1000);
    eq('a floor of 1 is REJECTED (it disables the phantom guard)', rails.values.RESIDUAL_FLOOR_CHARS, 2_000);
    check('and both rejections say why', rails.rejected.length === 2 && rails.rejected.every((j) => /outside/.test(j.why)), JSON.stringify(rails.rejected));
    eq('a non-numeric debounce is REJECTED', r.values.SWEEP_DEBOUNCE_MS, 600_000);
    eq('and all three rejections are reported, not silent', r.rejected.length, 3);
  }
  {
    // The named exports are what sweep.mjs/recall.mjs/report.mjs actually import — the consumer
    // contract, same as check 10 above for CONTEXT_CAP.
    const prev = process.env.VECTROS_MEMORY_CONFIG;
    process.env.VECTROS_MEMORY_CONFIG = write('wire671.json', JSON.stringify({ STALE_SESSION_MS: 12 * 3_600_000 }));
    const w = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href + '?wire671=1');
    eq('named STALE_SESSION_MS export reflects the file at CONFIG_PATH', w.STALE_SESSION_MS, 12 * 3_600_000);
    if (prev === undefined) delete process.env.VECTROS_MEMORY_CONFIG; else process.env.VECTROS_MEMORY_CONFIG = prev;
  }

  console.log('\n=== 11b. HANDED_TTL_MS — the fourth tunable, owed the same four checks ===');
  /**
   * It shipped into SPEC with no test at all, against this file's own explicit contract ("do NOT
   * bulk them in without a test each") — the contract was written directly above the block that
   * then broke it. It decides how long ONE session holds an orphaned queue: too short and two
   * agents race to opposite judgements on a disposition that is FINAL, too long and a dead
   * session's candidates are stranded for that window. `sweep.mjs` re-exports it, so the re-export
   * is part of the consumer contract too.
   */
  {
    const defs = resolveConfig({ file: path.join(TMP, 'nope.json'), env: {} }).values;
    eq('HANDED_TTL_MS defaults to 2h (n=0 — an explicit guess, not a measurement)', defs.HANDED_TTL_MS, 2 * 60 * 60 * 1000);
    const r = resolveConfig({ file: write('handed.json', JSON.stringify({ HANDED_TTL_MS: 30 * 60_000 })), env: {} });
    eq('HANDED_TTL_MS is file-overridable', r.values.HANDED_TTL_MS, 30 * 60_000);
    const e = resolveConfig({ file: path.join(TMP, 'nope.json'), env: { VECTROS_MEM_HANDED_TTL_MS: '3600000' } });
    eq('env wins for HANDED_TTL_MS', e.values.HANDED_TTL_MS, 3_600_000);
    // The rail, in the direction that costs something: a sub-minute TTL expires a claim while the
    // holder is still verifying, which is the exact double-disposition the claim exists to prevent.
    const bad = resolveConfig({ file: write('handedbad.json', JSON.stringify({ HANDED_TTL_MS: 1_000 })), env: {} });
    eq('a 1-second TTL is REJECTED (it would expire mid-verification)', bad.values.HANDED_TTL_MS, 2 * 60 * 60 * 1000);
    check('and the rejection says why', bad.rejected.length === 1 && /outside/.test(bad.rejected[0].why), JSON.stringify(bad.rejected));
  }
  {
    // The consumer contract, and it has TWO hops: config.mjs's named export, and sweep.mjs's
    // re-export — which is what recall.mjs and the sweep tests actually import.
    const prev = process.env.VECTROS_MEMORY_CONFIG;
    process.env.VECTROS_MEMORY_CONFIG = write('wirehanded.json', JSON.stringify({ HANDED_TTL_MS: 45 * 60_000 }));
    const w = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href + '?wirehanded=1');
    eq('named HANDED_TTL_MS export reflects the file at CONFIG_PATH', w.HANDED_TTL_MS, 45 * 60_000);
    if (prev === undefined) delete process.env.VECTROS_MEMORY_CONFIG; else process.env.VECTROS_MEMORY_CONFIG = prev;
    /**
     * THE RE-EXPORT HOP RUNS IN A CHILD PROCESS, and the first attempt at it here is worth keeping
     * as a warning: `import('./sweep.mjs?q=1')` returned the DEFAULT, not the configured value, and
     * that failure was an artifact of the harness rather than a defect in the code.
     *
     * A query string busts the cache for the module you name — not for what it imports. Fresh
     * `sweep.mjs` still resolved plain `./config.mjs`, which this test file had already evaluated
     * under a different CONFIG_PATH; config.mjs reads its file ONCE at module scope, so the
     * re-export faithfully carried a value fixed before the test set anything. Re-importing with a
     * query can only prove wiring for a module with no cached dependencies.
     *
     * A child process is the honest instrument: a clean module graph, the env set before any of it
     * evaluates — the same shape a real hook invocation has.
     */
    const cfg = write('wirehanded2.json', JSON.stringify({ HANDED_TTL_MS: 45 * 60_000 }));
    const child = spawnSync(process.execPath, ['-e',
      "import(process.argv[1]).then(m => process.stdout.write(String(m.HANDED_TTL_MS)))",
      pathToFileURL(path.join(HOOKS, 'sweep.mjs')).href,
    ], { encoding: 'utf8', env: { ...process.env, VECTROS_MEMORY_CONFIG: cfg }, timeout: 30000 });
    eq("sweep.mjs's re-export carries the value config.mjs resolved (fresh process)", child.stdout.trim(), String(45 * 60_000));
  }

  console.log('\n=== 12. RECALL_QUERY_MAX_CHARS — the outbound-query boundary ===');
  // clampQuery()'s own truncation behavior (prefix-kept, exact-boundary) is covered end-to-end
  // against the real recall.mjs/recall-eval-worker.mjs fetch paths in recall-query-cap-test.mjs;
  // this file owns the SPEC/resolveConfig contract only, matching §11/§11b above.
  {
    const defs = resolveConfig({ file: path.join(TMP, 'nope.json'), env: {} }).values;
    eq('RECALL_QUERY_MAX_CHARS defaults to 4000', defs.RECALL_QUERY_MAX_CHARS, 4_000);
    const r = resolveConfig({ file: write('recallcap.json', JSON.stringify({ RECALL_QUERY_MAX_CHARS: 2_500 })), env: {} });
    eq('RECALL_QUERY_MAX_CHARS is file-overridable', r.values.RECALL_QUERY_MAX_CHARS, 2_500);
    const e = resolveConfig({ file: path.join(TMP, 'nope.json'), env: { VECTROS_MEM_RECALL_QUERY_MAX_CHARS: '6000' } });
    eq('env wins for RECALL_QUERY_MAX_CHARS', e.values.RECALL_QUERY_MAX_CHARS, 6_000);
    // The rail: 8000 is the max, deliberately short of where the API's request-body-size cap sits
    // (around 8192 bytes) — the same "exclude the dangerous region, not merely bound the type"
    // lesson as CONTEXT_CAP/9999 and STALE_SESSION_MS's 4h floor, both cited in this file already.
    const oor = resolveConfig({ file: write('recallcapoor.json', JSON.stringify({ RECALL_QUERY_MAX_CHARS: 8_192 })), env: {} });
    eq('a value AT the request-size cap (8192) is REJECTED, not merely bounded', oor.values.RECALL_QUERY_MAX_CHARS, 4_000);
    check('and it says why', oor.rejected.length === 1 && /outside/.test(oor.rejected[0].why), JSON.stringify(oor.rejected));
  }
  {
    const prev = process.env.VECTROS_MEMORY_CONFIG;
    process.env.VECTROS_MEMORY_CONFIG = write('wirerecallcap.json', JSON.stringify({ RECALL_QUERY_MAX_CHARS: 3_000 }));
    const w = await import(pathToFileURL(path.join(HOOKS, 'config.mjs')).href + '?wirerecallcap=1');
    eq('named RECALL_QUERY_MAX_CHARS export reflects the file at CONFIG_PATH', w.RECALL_QUERY_MAX_CHARS, 3_000);
    eq('clampQuery() (the named export recall.mjs/recall-eval-worker.mjs import) honors that same value',
      w.clampQuery('x'.repeat(5_000)).length, 3_000);
    if (prev === undefined) delete process.env.VECTROS_MEMORY_CONFIG; else process.env.VECTROS_MEMORY_CONFIG = prev;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 11. A NON-OBJECT JSON ROOT IS MALFORMED, NOT CLEAN.
  //
  //     `readJsonSafe` spreads the parsed value over the defaults with no root-type check, so every
  //     one of these came back `state:'ok'` with zero usable keys and NOTHING logged — silent, in
  //     the module whose stated contract is "the loader must SAY WHICH". The array case is the
  //     nastiest: spreading `[{...}]` yields `{"0":{...}}`, which LOOKS like a populated config.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n=== 11. a JSON-valid non-object root is reported, not silently accepted ===');
  for (const [label, body] of [['null', 'null'], ['a number', '42'], ['a string', '"hello"'],
    ['an array', '[{"CONTEXT_CAP": 8000}]']]) {
    const r = resolveConfig({ file: write(`root-${label.replace(/\W/g, '')}.json`, body), env: {} });
    eq(`${label} root is reported as damaged, not ok`, r.state, 'damaged');
    eq(`${label} root applies NO keys`, r.overrides.length, 0);
    eq(`${label} root still yields every default (fail-open)`, r.values.CONTEXT_CAP, SPEC.CONTEXT_CAP.def);
  }
  {
    // The control: a REAL object root must still read clean, or the check above is just breaking config.
    const r = resolveConfig({ file: write('root-ok.json', JSON.stringify({ CONTEXT_CAP: 8000 })), env: {} });
    eq('control: a plain-object root is still ok', r.state, 'ok');
    eq('control: and its value applies', r.values.CONTEXT_CAP, 8000);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 12. UNKNOWN KEYS ARE REPORTED. The loop iterates SPEC and only asks whether the file has each
  //     key, so a typo was read by nobody and mentioned by nobody — the operator concludes the
  //     value applied and debugs the wrong thing.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n=== 12. an unknown config key is surfaced ===');
  {
    const r = resolveConfig({
      file: write('unknown.json', JSON.stringify({ CONTEXT_CAP_: 8000, contextCap: 1, CONTEXT_CAP: 9000 })),
      env: {},
    });
    eq('both unknown spellings are collected', r.unknown.sort().join(','), 'CONTEXT_CAP_,contextCap');
    eq('and the CORRECT key still applies', r.values.CONTEXT_CAP, 9000);
    const lines = [];
    reportConfig(r, 'x', (_, m) => lines.push(m));
    check('the receipt NAMES them', lines.some((l) => /UNKNOWN key/.test(l) && /CONTEXT_CAP_/.test(l)), lines.join(' | '));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 13. CROSS-KNOB CONSTRAINTS. Every one of these was stated in a SPEC note and enforced by
  //     nothing; one note asserted an enforcement that did not exist. Each is RED-proven by
  //     showing the constraint HOLDS at defaults and FIRES on a single in-range knob change —
  //     if it did not hold at defaults the shipped config would be reporting a violation forever,
  //     and if it did not fire the check would be decoration.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n=== 13. cross-knob constraints ===');
  {
    const atDefaults = resolveConfig({ file: '/nonexistent-config', env: {} });
    eq('the SHIPPED defaults violate nothing', atDefaults.violations.length, 0);

    // (a) CLAMP: a tail longer than the stash is meaningless — recall slices what stop.mjs stored.
    const tail = resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_ROLLING_TAIL_CHARS: '20000' } });
    eq('an over-long ROLLING_TAIL_CHARS is CLAMPED to STASH_CHARS',
      tail.values.ROLLING_TAIL_CHARS, tail.values.STASH_CHARS);
    check('and the clamp is reported, not silent',
      tail.violations.some((v) => v.kind === 'clamp' && /ROLLING_TAIL/.test(v.name)), JSON.stringify(tail.violations));
    check('raising STASH_CHARS too honours the request instead of clamping',
      resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_ROLLING_TAIL_CHARS: '5000', VECTROS_MEM_STASH_CHARS: '9000' } })
        .values.ROLLING_TAIL_CHARS === 5000);

    // (b) WARN: the lock relationship. ONE in-range knob is enough to break it — which is exactly
    //     why the rails could not catch it and a SPEC note claiming they did was false.
    const lock = resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_CAPTURE_CLAUDE_TIMEOUT_MS: '600000' } });
    check('a single in-range CAPTURE_CLAUDE_TIMEOUT_MS breaks the lock relationship and SAYS so',
      lock.violations.some((v) => /LOCK_STALE_MS/.test(v.name)), JSON.stringify(lock.violations));
    check('the message names the actual consequence (a duplicate BILLED distiller)',
      lock.violations.some((v) => /DUPLICATE BILLED/i.test(v.why)));
    check('...and the value is still APPLIED — a hook never breaks a turn over config',
      lock.values.CAPTURE_CLAUDE_TIMEOUT_MS === 600_000);
    check('raising LOCK_STALE_MS to cover the product silences it',
      resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_CAPTURE_CLAUDE_TIMEOUT_MS: '600000', VECTROS_MEM_LOCK_STALE_MS: String(3 * 3_600_000) } })
        .violations.length === 0);

    // (c) WARN: reap window ordering, and the reap-vs-sweep window.
    check('inverted reap windows are caught',
      resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_REAP_PHANTOM_AFTER_MS: String(200 * 86_400_000) } })
        .violations.some((v) => /REAP_PHANTOM/.test(v.name)));
    check('reaping state before the sweep may flush it is caught',
      resolveConfig({ file: '/nonexistent-config', env: { VECTROS_MEM_STALE_SESSION_MS: String(29 * 86_400_000), VECTROS_MEM_REAP_STATE_AFTER_MS: String(7 * 86_400_000) } })
        .violations.some((v) => /STALE_SESSION_MS/.test(v.name)));

    // The bounds must be READABLE, or none of the above could have been written at all.
    check('every SPEC rail exposes its own {min,max} (they used to be closed over and unreachable)',
      Object.values(SPEC).every((sp) => typeof sp.parse.min === 'number' && typeof sp.parse.max === 'number'));
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('\ndone');
done();
