#!/usr/bin/env node
/**
 * THE OPT-OUT, END TO END — the real hook binaries, a real HTTP mock of the API, and a real
 * (throwaway) memory home per scenario.
 *
 * WHAT IT PROVES, per hook (`orient`, `recall`, `evaluate`, `stop`, `capture`): that with
 * `VECTROS_MEMORY_OFF=1`, with a session directory in `EXCLUDED_DIRECTORIES`, and with a session
 * outside an `INCLUDED_DIRECTORIES` list, the hook exits 0 having made ZERO requests, written
 * NOTHING under the memory home, spawned NOTHING, and put neither the prompt nor any tool content
 * in `hooks.log`; and, as the CONTROL that lets those assertions fail, that the same hook with no
 * opt-out does its job.
 *
 * THE LIFECYCLE CASE is the strong one: a whole excluded session — start, prompts, tool calls, Stop,
 * PreCompact — run against a home seeded with everything the Stop path acts on (an expired phantom
 * the reaper deletes, a stale session the sweep flushes, a queue the orphan cap settles, a
 * transcript past the capture gate). The identical sequence outside the list does all four, which
 * is how we know the seeds are live; inside it, nothing moves.
 *
 * NO REAL SPEND, NO REAL STORE. The API base URL is a loopback mock, the API key a stub, and
 * `CLAUDE_CODE_BIN` points at a path that does not exist — so if the opt-out ever failed, a worker
 * that spawned would fail to find a model and the mock would count whatever it sent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs'; // MUST precede any runtime-state path use — see the file header.

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

// ── The mock API: counts EVERY request, whatever the route.
const requests = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || '' });
    // A search whose query carries the marker is refused with a 403: recall then writes a short excerpt of
    // the query into hooks.log, which is the one path by which prompt text CAN reach the log — the control
    // that lets "no prompt content in hooks.log" fail.
    const refuse = req.url.includes('/v1/search') && body.includes('FORCE403');
    res.writeHead(refuse ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hits: [], results: [], records: [], items: [] }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); // 127.0.0.1, not "localhost" — Windows resolves ::1 first and hangs
const BASE = `http://127.0.0.1:${srv.address().port}`;

// ── Fixture directories (they need not exist; only their spelling matters).
const W = path.join(os.tmpdir(), `optout-work-${randomUUID().slice(0, 8)}`);
const EXCLUDED = path.join(W, 'clientA');
const D = {
  excluded: path.join(EXCLUDED, 'src'),
  sibling: path.join(W, 'clientAX'),
  mine: path.join(W, 'mine', 'repo'),
  other: path.join(W, 'other'),
};
const MINE_ROOT = path.join(W, 'mine');

const SECRET_PROMPT = 'FORCE403 SECRET-PROMPT-7f3a please remember the unreleased design';
const SECRET_TOOL = 'SECRET-TOOL-OUTPUT-91bc';
const SECRET_REPLY = 'SECRET-ASSISTANT-REPLY-04de';

/** A fresh, isolated runtime home + its own hooks.log and config file. */
function mkWorld(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-home-'));
  fs.writeFileSync(path.join(root, 'SPOOL_OFF'), 'test\n');
  fs.writeFileSync(path.join(root, 'VERDICT_MUTATIONS_OFF'), 'test\n');
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '# isolated test MEMORY.md\n');
  const cfgFile = path.join(os.tmpdir(), `optout-cfg-${randomUUID()}.json`);
  fs.writeFileSync(cfgFile, Buffer.isBuffer(config) || typeof config === 'string' ? config : JSON.stringify(config));
  const log = path.join(os.tmpdir(), `optout-log-${randomUUID()}.log`);
  const key = randomUUID();
  return { root, cfgFile, log, key, env: {
    VECTROS_MEMORY_HOME: root, VECTROS_MEMORY_INDEX: path.join(root, 'MEMORY.md'),
    VECTROS_MEMORY_CONFIG: cfgFile, VECTROS_HOOKLOG_PATH: log,
    VECTROS_API_BASE_URL: BASE, VECTROS_API_KEY: `stub-key-${key}`,
    CLAUDE_CODE_BIN: path.join(os.tmpdir(), 'optout-no-such-claude.exe'),
    VECTROS_RECALL_EVAL: '', VECTROS_MEMORY_OFF: '', CLAUDE_PROJECT_DIR: '',
    VECTROS_MEM_REAP_OFF: '', VECTROS_MEM_ORPHAN_CAP_OFF: '',
  } };
}

/** Only the requests THIS world's hooks (or their workers) made: each world has its own credential. */
const requestsFor = (w) => requests.filter((r) => r.auth === `Bearer stub-key-${w.key}`);
const logText = (w) => { try { return fs.readFileSync(w.log, 'utf8'); } catch { /* silence-ok: no log file yet means no hook has written one. */ return ''; } };
const logLines = (w) => logText(w).split('\n').filter(Boolean);
// The skip line is identified by its hook COLUMN, not a substring: temp paths and directory names in
// other lines can contain the word.
const isSkipLine = (l) => /^\S+\s+optout\s/.test(l);
const isConfigReceipt = (l) => /^\S+\s+config\s/.test(l);

/** Every file under the home, with its size: a change in either is a write. */
function snapshot(w) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[`${path.relative(w.root, p)}/`] = 'dir'; walk(p); } else out[path.relative(w.root, p)] = fs.statSync(p).size;
    }
  };
  walk(w.root);
  return out;
}

const run = (w, file, payload, extraEnv = {}, rawInput) => spawnSync(process.execPath, [path.join(DIR, file)], {
  input: rawInput ?? JSON.stringify(payload), encoding: 'utf8', timeout: 60000,
  env: { ...process.env, ...w.env, ...extraEnv },
});

/**
 * ASYNC run, for the one case that needs the mock to ANSWER. `spawnSync` blocks this process's event
 * loop, and the mock server lives in this process: a hook run through `run()` can send a request but
 * never get a reply (it waits out its own timeout). Every other case here only needs the request to be
 * counted, which survives that; the 403 control needs a real response.
 */
const runAsync = (w, file, payload, extraEnv = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(DIR, file)], { env: { ...process.env, ...w.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('close', (status) => resolve({ status }));
  child.stdin.end(JSON.stringify(payload));
});

// ── Transcripts: `big` is past the capture gate (100K), `small` is not.
const mkTranscript = (chars) => {
  const f = path.join(os.tmpdir(), `optout-transcript-${randomUUID()}.jsonl`);
  const lines = [];
  for (let n = 0; n < chars; n += 5000) lines.push(JSON.stringify({ type: n % 10000 ? 'user' : 'assistant', message: { content: 'y'.repeat(5000) } }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
};
const BIG = mkTranscript(130_000);
const SMALL = mkTranscript(5_000);

const HOOKS = {
  orient: (sid, cwd) => ({ file: 'orient.mjs', payload: { session_id: sid, hook_event_name: 'SessionStart', source: 'startup', cwd } }),
  recall: (sid, cwd) => ({ file: 'recall.mjs', payload: { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: SECRET_PROMPT, cwd, transcript_path: SMALL } }),
  evaluate: (sid, cwd) => ({ file: 'evaluate.mjs', payload: { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: SECRET_TOOL }, tool_response: { stdout: SECRET_TOOL }, cwd, transcript_path: SMALL } }),
  stop: (sid, cwd) => ({ file: 'stop.mjs', payload: { session_id: sid, hook_event_name: 'Stop', last_assistant_message: SECRET_REPLY, cwd, transcript_path: SMALL } }),
  capture: (sid, cwd) => ({ file: 'capture.mjs', payload: { session_id: sid, hook_event_name: 'Stop', cwd, transcript_path: BIG } }),
};

const noContentInLog = (w) => ![SECRET_PROMPT, SECRET_TOOL, SECRET_REPLY, 'SECRET-'].some((s) => logText(w).includes(s));

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 1. each hook: opt-out by env, by directory, by inclusion list — and the control ===');
{
  // ONE RULE PER SCENARIO. A config that carries both lists lets the inclusion rule skip a session the
  // exclusion rule never matched, which would mask a broken exclusion.
  const exclOnly = { EXCLUDED_DIRECTORIES: [EXCLUDED] };
  const inclOnly = { INCLUDED_DIRECTORIES: [MINE_ROOT] };
  const bothNested = { EXCLUDED_DIRECTORIES: [EXCLUDED], INCLUDED_DIRECTORIES: [W] }; // the excluded dir sits INSIDE the included root
  const scenarios = [
    { name: 'VECTROS_MEMORY_OFF=1', cwd: D.mine, env: { VECTROS_MEMORY_OFF: '1' }, config: {} },
    { name: 'a directory in EXCLUDED_DIRECTORIES', cwd: D.excluded, config: exclOnly },
    { name: 'CLAUDE_PROJECT_DIR in the list (cwd has drifted out)', cwd: D.other, env: { CLAUDE_PROJECT_DIR: D.excluded }, config: exclOnly },
    { name: 'a session OUTSIDE INCLUDED_DIRECTORIES', cwd: D.other, config: inclOnly },
    { name: 'EXCLUSION WINS inside an included root', cwd: D.excluded, config: bothNested },
    { name: 'an UNUSABLE config file (fail closed)', cwd: D.mine, config: '{ "EXCLUDED_DIRECTORIES": [' },
    ...(['win32', 'darwin'].includes(process.platform)
      ? [{ name: 'the same directory spelled in another case', cwd: D.excluded.toUpperCase(), config: exclOnly }] : []),
  ];

  // What "the hook did its job" means for each hook, stated per hook so a control cannot pass on a stray log line.
  const stateOf = (w, sid) => { try { return JSON.parse(fs.readFileSync(path.join(w.root, 'state', `${sid}.json`), 'utf8')); } catch { /* silence-ok: no state file is the answer "nothing was written". */ return null; } };
  const didItsJob = {
    orient: (w, sid) => stateOf(w, sid)?.orientPending === true,
    stop: (w, sid) => typeof stateOf(w, sid)?.lastAssistant === 'string' && stateOf(w, sid).lastAssistant.length > 0,
    recall: (w) => requestsFor(w).some((r) => r.url.includes('/v1/search')),
    // evaluate's job on a normal call: start the debounced background evaluator and record that it did.
    evaluate: (w, sid) => stateOf(w, sid)?.lastEvalAt > 0 && logLines(w).some((l) => /^\S+\s+evaluate\s.*spawned background evaluator/.test(l)),
    capture: (w) => logLines(w).some((l) => /^\S+\s+capture\s/.test(l)),
  };

  for (const [hookName, make] of Object.entries(HOOKS)) {
    // CONTROL: inside the allow-list and outside the exclusion — the hook must do ITS job, by its own measure.
    {
      const w = mkWorld(bothNested);
      const sid = randomUUID();
      const { file, payload } = make(sid, D.mine);
      const r = run(w, file, payload);
      await sleep(400);
      eq(`[${hookName}] CONTROL exits 0`, r.status, 0);
      check(`[${hookName}] CONTROL: with no opt-out the hook does its job`, didItsJob[hookName](w, sid),
        `stderr=${(r.stderr || '').slice(0, 200)} log=${logText(w).slice(0, 300)}`);
    }
    for (const sc of scenarios) {
      const w = mkWorld(sc.config);
      const before = snapshot(w);
      const sid = randomUUID();
      const { file, payload } = make(sid, sc.cwd);
      const r = run(w, file, payload, sc.env);
      await sleep(500); // a detached worker, had one been spawned, would have reached the mock by now
      const label = `[${hookName}] ${sc.name}`;
      eq(`${label}: exits 0`, r.status, 0);
      eq(`${label}: ZERO requests (by this world's own credential)`, requestsFor(w).length, 0);
      eq(`${label}: writes NOTHING under the memory home`, JSON.stringify(snapshot(w)), JSON.stringify(before));
      const optoutLines = logLines(w).filter(isSkipLine);
      // An unusable config is reported loudly by the config loader in every process, by design; nothing else may appear.
      const receipts = logLines(w).filter(isConfigReceipt);
      const other = logLines(w).filter((l) => !isSkipLine(l) && !isConfigReceipt(l));
      eq(`${label}: no hook line other than the skip line`, other, []);
      check(`${label}: config receipts only when the config itself is the problem`,
        sc.name.startsWith('an UNUSABLE') ? receipts.length > 0 : receipts.length === 0, receipts.join('\n'));
      eq(`${label}: the skip line appears only for SessionStart`, optoutLines.length, hookName === 'orient' ? 1 : 0);
      if (sc.name.startsWith('an UNUSABLE') && hookName === 'orient') {
        let msg = null;
        try { msg = JSON.parse(r.stdout).systemMessage; } catch { /* silence-ok: a non-JSON stdout fails the check below with its text. */ }
        check(`${label}: tells the USER in the session, naming the cause (systemMessage on stdout)`, typeof msg === 'string' && /OFF for every session/.test(msg) && /failing closed/.test(msg), r.stdout);
        check(`${label}: ...and the message carries no directory`, !String(msg).includes(W), r.stdout);
      } else {
        check(`${label}: nothing on stdout (no recalled-knowledge block)`, (r.stdout || '') === '', r.stdout);
      }
    }
  }
}

console.log('\n=== 1b. prompt text CAN reach hooks.log in a normal session, and cannot in an excluded one ===');
{
  // The mock refuses any search whose query carries FORCE403; recall then logs an excerpt of the query.
  const control = mkWorld({});
  await runAsync(control, 'recall.mjs', HOOKS.recall(randomUUID(), D.mine).payload);
  check('CONTROL: in a normal session the prompt text reaches hooks.log (so the absence below means something)', logText(control).includes('SECRET-PROMPT'), logText(control));
  const excluded = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  await runAsync(excluded, 'recall.mjs', HOOKS.recall(randomUUID(), D.excluded).payload);
  check('the SAME prompt in an excluded session never reaches hooks.log', !logText(excluded).includes('SECRET-PROMPT') && !logText(excluded).includes('FORCE403'), logText(excluded));
}

console.log('\n=== 2. the skip line names the trigger and carries no directory ===');
{
  const triggers = [
    ['env', { VECTROS_MEMORY_OFF: '1' }, {}, D.mine, /VECTROS_MEMORY_OFF/],
    ['directory', {}, { EXCLUDED_DIRECTORIES: [EXCLUDED] }, D.excluded, /excluded directory/],
    ['not-included', {}, { INCLUDED_DIRECTORIES: [MINE_ROOT] }, D.other, /not under an included directory/],
    ['config', {}, '{ nope', D.mine, /failing closed/],
  ];
  for (const [name, env, config, cwd, re] of triggers) {
    const w = mkWorld(config);
    run(w, 'orient.mjs', HOOKS.orient(randomUUID(), cwd).payload, env);
    const line = logLines(w).find(isSkipLine) || '';
    check(`${name}: one skip line naming the trigger`, re.test(line), line);
    check(`${name}: ...and no directory or session path in it`, !line.includes(W) && !/clientA|other|mine/.test(line.replace(/excluded directory|included directory/g, '')), line);
  }
}

console.log('\n=== 3. matching edges, through the real hook ===');
{
  const cfg = { EXCLUDED_DIRECTORIES: [EXCLUDED + path.sep] };
  const skipped = (cwd, config = cfg) => {
    const w = mkWorld(config);
    run(w, 'orient.mjs', HOOKS.orient(randomUUID(), cwd).payload);
    return logLines(w).some(isSkipLine);
  };
  check('a trailing separator on the list entry still excludes the directory', skipped(EXCLUDED));
  check('a subdirectory is excluded', skipped(path.join(EXCLUDED, 'a', 'b')));
  check('PREFIX SIBLING `clientAX` runs', !skipped(D.sibling));
  check('a parent directory runs', !skipped(W));
  if (process.platform === 'win32') {
    check('forward slashes', skipped(D.excluded.replace(/\\/g, '/')));
  }
}

console.log('\n=== 3b. a junction/symlink into an excluded directory, through the real hook ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-hook-link-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  const link = path.join(base, 'link');
  let linked = true;
  try { fs.symlinkSync(real, link, 'junction'); } catch { /* silence-ok: some sandboxes forbid links; reported below instead of passing vacuously. */ linked = false; }
  if (!linked) console.log('  SKIP  could not create a symlink/junction on this host');
  else {
    const skippedBy = (cwd, listed) => {
      const w = mkWorld({ EXCLUDED_DIRECTORIES: [listed] });
      run(w, 'orient.mjs', HOOKS.orient(randomUUID(), cwd).payload);
      return logLines(w).some(isSkipLine);
    };
    check('the list names the LINK, the session reports the TARGET', skippedBy(path.join(real, 'sub'), link));
    check('the list names the TARGET, the session started through the LINK', skippedBy(path.join(link, 'sub'), real));
    check('CONTROL: an unrelated directory runs', !skippedBy(path.join(base, 'elsewhere'), link));
  }
}

console.log('\n=== 3c. with the DEFAULT log location (inside the runtime home) the skip line is the ONLY write ===');
{
  const w = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const home = path.join(w.root, 'hooks.log');
  const before = snapshot(w);
  const r = run(w, 'orient.mjs', HOOKS.orient(randomUUID(), D.excluded).payload, { VECTROS_HOOKLOG_PATH: '' });
  const after = snapshot(w);
  eq('exits 0', r.status, 0);
  eq('the only change under the runtime home is hooks.log gaining the skip line', Object.keys(after).filter((k) => !(k in before) || after[k] !== before[k]), ['hooks.log']);
  check('...and it is exactly one skip line', fs.readFileSync(home, 'utf8').split('\n').filter(Boolean).length === 1 && isSkipLine(fs.readFileSync(home, 'utf8').trim()));
}

console.log('\n=== 4. VECTROS_RECALL_EVAL is unchanged and the guard stays out of its way (all five hooks) ===');
{
  for (const [hookName, make] of Object.entries(HOOKS)) {
    // With the recursion guard set: the hook exits 0 and does NOTHING, in an excluded directory (no skip
    // line: its own guard handled it, exactly as before) and in an ordinary one alike.
    for (const [where, cwd, config] of [['an excluded directory', D.excluded, { EXCLUDED_DIRECTORIES: [EXCLUDED] }], ['an ordinary directory', D.mine, {}]]) {
      const w = mkWorld(config);
      const before = snapshot(w);
      const { file, payload } = make(randomUUID(), cwd);
      const r = run(w, file, payload, { VECTROS_RECALL_EVAL: '1' });
      eq(`[${hookName}] RECALL_EVAL=1 in ${where}: exits 0`, r.status, 0);
      eq(`[${hookName}] RECALL_EVAL=1 in ${where}: logs nothing and writes nothing`, [logLines(w), JSON.stringify(snapshot(w)) === JSON.stringify(before), requestsFor(w).length], [[], true, 0]);
    }
  }
}

console.log('\n=== 5. an unparseable payload ===');
{
  const w = mkWorld({});
  const r = run(w, 'stop.mjs', null, {}, '{ not json');
  eq('CONTROL: still reports it, exactly as before', [r.status, logLines(w).some((l) => /unparseable stdin/.test(l))], [0, true]);
  const w2 = mkWorld({});
  const r2 = run(w2, 'stop.mjs', null, { VECTROS_MEMORY_OFF: '1' }, '{ not json');
  eq('with the env switch it exits silently', [r2.status, logLines(w2)], [0, []]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 6. LIFECYCLE: a whole excluded session against a home seeded with everything the Stop path acts on ===');

/** Seed what each background component of the Stop path would act on. */
function seedLeftovers(w) {
  const dirs = ['state', 'queue'].map((d) => path.join(w.root, d));
  dirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const seeded = {};
  // (a) an expired phantom — the reaper deletes it.
  seeded.phantom = randomUUID();
  const ph = path.join(w.root, 'state', `${seeded.phantom}.json`);
  fs.writeFileSync(ph, '{}');
  const old = new Date(Date.now() - 60 * DAY);
  fs.utimesSync(ph, old, old);
  // (b) a stale session with an unread tail — the sweep flushes it.
  seeded.stale = randomUUID();
  fs.writeFileSync(path.join(w.root, 'state', `${seeded.stale}.json`),
    JSON.stringify({ transcriptPath: mkTranscript(8000), lastStopAt: Date.now() - 3 * DAY }));
  // (c) a queue offered on 8 distinct days with a candidate nobody settled — the orphan cap settles it.
  seeded.orphan = randomUUID();
  const lines = [{ op: 'propose', externalId: randomUUID(), title: 't', body: 'b', kind: 'observation', dest: 'memory', at: '2026-08-01T00:00:00.000Z' }];
  for (let d = 1; d <= 8; d++) lines.push({ at: `2026-08-0${d}T10:00:00.000Z`, op: 'handed', toSid: 'someone' });
  fs.writeFileSync(path.join(w.root, 'queue', `${seeded.orphan}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return seeded;
}

/** The whole sequence of one session's hook events. */
function lifecycle(w, sid, cwd, env = {}) {
  const out = [];
  const go = (file, payload) => out.push(run(w, file, payload, env).status);
  go('orient.mjs', HOOKS.orient(sid, cwd).payload);
  for (let i = 0; i < 3; i++) go('recall.mjs', HOOKS.recall(sid, cwd).payload);
  for (let i = 0; i < 3; i++) go('evaluate.mjs', HOOKS.evaluate(sid, cwd).payload);
  go('stop.mjs', HOOKS.stop(sid, cwd).payload);
  go('capture.mjs', HOOKS.capture(sid, cwd).payload);
  go('capture.mjs', { session_id: sid, hook_event_name: 'PreCompact', cwd, transcript_path: BIG });
  return out;
}

let controlSid;
{
  // CONTROL — the same sequence in an ordinary directory. It must do all four things, or the
  // excluded run below proves nothing.
  const w = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const seeded = seedLeftovers(w);
  controlSid = randomUUID();
  const codes = lifecycle(w, controlSid, D.mine);
  await sleep(3000);
  const log = logText(w);
  check('CONTROL: every hook exited 0', codes.every((c) => c === 0), codes.join(','));
  check('CONTROL: the mock API was reached', requestsFor(w).length > 0, String(requestsFor(w).length));
  check('CONTROL: the reaper deleted the expired phantom', !fs.existsSync(path.join(w.root, 'state', `${seeded.phantom}.json`)), log);
  check('CONTROL: the sweep flushed the stale session', /FLUSHED/.test(log), log);
  check('CONTROL: the orphan cap spawned its worker', /orphan-cap\s.*spawned worker/.test(log), log);
  check('CONTROL: capture spawned the distiller (the gate was open)', /spawned distiller/.test(log), log);
  check('CONTROL: stop recorded the session\'s starting directory in state',
    (() => { try { return JSON.parse(fs.readFileSync(path.join(w.root, 'state', `${controlSid}.json`), 'utf8')).cwd === D.mine; } catch { /* silence-ok: a missing state file fails the check with its own message. */ return false; } })());
  check('CONTROL: capture recorded the starting directory in the queue, at first capture',
    (() => { try { return fs.readFileSync(path.join(w.root, 'queue', `${controlSid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.op === 'cwd' && e.cwd === D.mine); } catch { /* silence-ok: a missing queue file fails the check with its own message. */ return false; } })());
}
{
  for (const [name, config, env, cwd] of [
    ['a directory in EXCLUDED_DIRECTORIES', { EXCLUDED_DIRECTORIES: [EXCLUDED] }, {}, D.excluded],
    ['VECTROS_MEMORY_OFF=1', {}, { VECTROS_MEMORY_OFF: '1' }, D.mine],
    ['a MALFORMED config.json (fail closed)', '{ "EXCLUDED_DIRECTORIES": [', {}, D.mine],
    ['a session outside INCLUDED_DIRECTORIES', { INCLUDED_DIRECTORIES: [MINE_ROOT] }, {}, D.other],
  ]) {
    const w = mkWorld(config);
    seedLeftovers(w);
    const before = snapshot(w);
    const sid = randomUUID();
    const codes = lifecycle(w, sid, cwd, env);
    await sleep(3000);
    const label = `EXCLUDED SESSION (${name})`;
    check(`${label}: every hook exited 0`, codes.every((c) => c === 0), codes.join(','));
    eq(`${label}: ZERO requests to the API across the whole lifecycle`, requestsFor(w).length, 0);
    eq(`${label}: nothing under the memory home changed (no state/ queue/ prompts/ staged/ locks/ spool/ write, no reap, no sweep marker)`,
      JSON.stringify(snapshot(w)), JSON.stringify(before));
    check(`${label}: the expired phantom was NOT reaped`, Object.keys(snapshot(w)).filter((k) => k.startsWith('state')).length === 3, JSON.stringify(snapshot(w)));
    // The config loader reports a broken config on every process, by design; those receipts are the only other lines allowed.
    const lines = logLines(w).filter((l) => !isConfigReceipt(l));
    eq(`${label}: exactly ONE line in hooks.log, the skip`, lines.length, 1);
    if (name.startsWith('a MALFORMED')) {
      check(`${label}: the skip line names the cause`, /failing closed/.test(lines[0] || '') && /damaged|MALFORMED|unparseable/.test(lines[0] || ''), lines[0]);
      check(`${label}: ...and the config loader says memory is OFF for every session`, logLines(w).some((l) => /memory is OFF for EVERY session/.test(l)), logText(w));
    }
    check(`${label}: ...and it is the skip line`, isSkipLine(lines[0] || '') && /skip/.test(lines[0]), lines.join('\n'));
    check(`${label}: no prompt or tool content in hooks.log`, noContentInLog(w), logText(w));
    check(`${label}: no worker was spawned (no lock was taken)`, !fs.existsSync(path.join(w.root, 'locks')), '');
  }
}

console.log('\n=== 7. the list changes AFTER a session was captured ===');
{
  /**
   * TWO WORLDS, IDENTICAL SEEDS. A finished session whose queue recorded its starting directory when it
   * was captured, an unread tail past the floor, and a state file old enough to be stale. The ONLY
   * difference is the config the ordinary session's Stop runs under. In the control world the sweep must
   * flush the session — that is what proves this exact fixture is flushable, so a no-flush in the other
   * world can only be the exclusion.
   */
  const seed = (w) => {
    const sid = randomUUID();
    fs.mkdirSync(path.join(w.root, 'queue'), { recursive: true });
    fs.mkdirSync(path.join(w.root, 'state'), { recursive: true });
    const qfile = path.join(w.root, 'queue', `${sid}.jsonl`);
    fs.writeFileSync(qfile, [{ op: 'cwd', cwd: path.join(EXCLUDED, 'later') }, { op: 'captured', offset: 1000 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(w.root, 'state', `${sid}.json`), JSON.stringify({ transcriptPath: BIG, lastStopAt: Date.now() - 3 * DAY }));
    return { sid, qfile };
  };
  const bystanderStop = async (w) => {
    run(w, 'capture.mjs', { session_id: randomUUID(), hook_event_name: 'Stop', cwd: D.mine, transcript_path: SMALL });
    await sleep(1500);
  };

  const wc = mkWorld({}); // control: nothing excluded
  const sc = seed(wc);
  await bystanderStop(wc);
  check('CONTROL: with no list the sweep FLUSHES this exact session', logText(wc).includes(`FLUSHED ${sc.sid.slice(0, 8)}`), logText(wc));
  check('CONTROL: ...and marks it swept', /"op":"swept"/.test(fs.readFileSync(sc.qfile, 'utf8')), '');

  const we = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] }); // the list now names the directory the session started in
  const se = seed(we);
  await bystanderStop(we);
  check('the sweep ran and SAID it left a session alone for being in an excluded directory',
    logLines(we).some((l) => /sweep\b.*left alone because they originated in an excluded directory/.test(l)), logText(we));
  check('...and did NOT flush it', !logText(we).includes(`FLUSHED ${se.sid.slice(0, 8)}`), logText(we));
  check('...so its queue gained no swept marker', !/"op":"swept"/.test(fs.readFileSync(se.qfile, 'utf8')), '');
  check('...and no distiller took its lock', !fs.existsSync(path.join(we.root, 'locks', `${se.sid}.lock`)), '');
}

console.log('\n=== 8. the starting directories are recorded by stop.mjs, first wins, both kept ===');
{
  const stateAt = (w, sid) => JSON.parse(fs.readFileSync(path.join(w.root, 'state', `${sid}.json`), 'utf8'));
  const w = mkWorld({});
  const sid = randomUUID();
  run(w, 'stop.mjs', HOOKS.stop(sid, D.mine).payload);
  eq('the first Stop records its working directory', stateAt(w, sid).cwd, D.mine);
  eq('...and no project dir when Claude Code supplied none', stateAt(w, sid).projectDir, undefined);
  run(w, 'stop.mjs', HOOKS.stop(sid, D.other).payload);
  eq('a later Stop from elsewhere does not move it (first wins)', stateAt(w, sid).cwd, D.mine);

  const sid2 = randomUUID();
  run(w, 'stop.mjs', HOOKS.stop(sid2, D.mine).payload, { CLAUDE_PROJECT_DIR: D.sibling });
  eq('BOTH are recorded: the working directory...', stateAt(w, sid2).cwd, D.mine);
  eq('...and CLAUDE_PROJECT_DIR (either can be what a later exclusion names)', stateAt(w, sid2).projectDir, D.sibling);

  const sid3 = randomUUID();
  run(w, 'stop.mjs', { session_id: sid3, hook_event_name: 'Stop', last_assistant_message: '', cwd: D.mine, transcript_path: SMALL });
  const empty = stateAt(w, sid3);
  check('an EMPTY-message Stop records neither a directory nor a transcript path (that would admit phantoms to the sweep)', empty.cwd === undefined && empty.transcriptPath === undefined, JSON.stringify(empty));
}

console.log('\n=== 9. the config receipt is deferred: an excluded session writes ONE line, not one per hook process ===');
{
  // A non-list key in config.json makes the loader write `config applied: …` in every hook process.
  const cfg = { EXCLUDED_DIRECTORIES: [EXCLUDED], CONTEXT_CAP: 8000 };
  const w = mkWorld(cfg);
  run(w, 'orient.mjs', HOOKS.orient(randomUUID(), D.excluded).payload);
  eq('SessionStart in an excluded directory: exactly the skip line', [logLines(w).length, isSkipLine(logLines(w)[0] || '')], [1, true]);
  for (const hook of ['evaluate', 'recall', 'stop', 'capture']) run(w, ...Object.values(HOOKS[hook](randomUUID(), D.excluded)).slice(0, 2));
  eq('then every other event of that session adds NOTHING (no per-prompt, no per-tool-call line)', logLines(w).length, 1);
  check('...and no `config applied` line at all', !logText(w).includes('config applied'), logText(w));

  const wc = mkWorld(cfg);
  // No `transcript_path` here, on purpose: with one, the first evaluate call spawns a DETACHED background evaluator,
  // a second process that writes its own `config applied` line whenever it gets scheduled, so the count below would be
  // 1 or 2 depending on machine load. Without it no worker can start and the hook writes exactly one receipt.
  const controlPayload = HOOKS.evaluate(randomUUID(), D.mine).payload;
  delete controlPayload.transcript_path;
  run(wc, 'evaluate.mjs', controlPayload);
  eq('CONTROL: a session that RUNS still gets its receipt, once per hook process', logLines(wc).filter((l) => /config applied: CONTEXT_CAP=8000\(file\)/.test(l)).length, 1);
  check('...and only the hook process wrote to the log (no background worker started)', logLines(wc).every((l) => /^\S+\s+(config|evaluate)\s/.test(l)) && logLines(wc).length === 2, logText(wc));

  // A broken config keeps its loud per-process receipt (the other half of failing closed).
  const wb = mkWorld('{ nope');
  run(wb, 'evaluate.mjs', HOOKS.evaluate(randomUUID(), D.mine).payload);
  check('a BROKEN config still writes its receipt on every hook process', logLines(wb).some((l) => /memory is OFF for EVERY session/.test(l)), logText(wb));
}

console.log('\n=== 10. what a hand-edited config.json looks like, end to end through the hook ===');
{
  const exclJson = JSON.stringify({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const skipFor = (config, cwd) => {
    const w = mkWorld(config);
    const r = run(w, 'orient.mjs', HOOKS.orient(randomUUID(), cwd).payload);
    return { w, r, line: logLines(w).find(isSkipLine) || '' };
  };
  const bom = skipFor('\uFEFF' + exclJson, D.excluded);
  check('a UTF-8 BOM is stripped: the list applies', /excluded directory/.test(bom.line), bom.line);
  const bomOther = skipFor('\uFEFF' + exclJson, D.mine);
  eq('...and a directory outside the list still runs', bomOther.line, '');

  const u16 = skipFor(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(exclJson, 'utf16le')]), D.mine);
  check('a UTF-16 file fails closed and the skip line says so', /failing closed/.test(u16.line) && /UTF-16/.test(u16.line), u16.line);
  check('...and so does the message shown in the session', /UTF-16/.test(u16.r.stdout), u16.r.stdout);

  const bs = skipFor('{"EXCLUDED_DIRECTORIES": ["C:\\work\\clientA"]}', D.mine);
  check('an unescaped backslash fails closed and the skip line names that cause', /failing closed/.test(bs.line) && /unescaped backslash/.test(bs.line), bs.line);
  check('...and the in-session message does too', /unescaped backslash/.test(bs.r.stdout), bs.r.stdout);
}

console.log('\n=== 11. PreCompact, by directory ===');
{
  const pre = (cwd) => ({ session_id: randomUUID(), hook_event_name: 'PreCompact', cwd, transcript_path: BIG });
  const wc = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const pc = pre(D.mine);
  run(wc, 'capture.mjs', pc);
  const marked = (() => { try { return JSON.parse(fs.readFileSync(path.join(wc.root, 'state', `${pc.session_id}.json`), 'utf8')).orientPending === true; } catch { /* silence-ok: no state file means it was not marked. */ return false; } })();
  check('CONTROL: a PreCompact in an ordinary directory marks the post-compact orientation', marked);
  const we = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const before = snapshot(we);
  const r = run(we, 'capture.mjs', pre(D.excluded));
  await sleep(500);
  eq('a PreCompact in an excluded directory exits 0', r.status, 0);
  eq('...writes nothing, marks nothing, logs nothing, requests nothing', [JSON.stringify(snapshot(we)) === JSON.stringify(before), logLines(we), requestsFor(we).length], [true, [], 0]);
}

console.log('\n=== 12. PINS A DOCUMENTED LIMIT: a session that moves into an excluded directory and back out ===');
{
  // Not a feature: a test that makes today's behaviour visible, so that changing it is a decision.
  // A session captured once outside the directory, then working INSIDE it (every hook silent), then
  // back outside: the next ordinary Stop distills everything since the last capture, including the
  // stretch spent inside. The README says so.
  const w = mkWorld({ EXCLUDED_DIRECTORIES: [EXCLUDED] });
  const sid = randomUUID();
  fs.mkdirSync(path.join(w.root, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'queue', `${sid}.jsonl`), [{ op: 'cwd', cwd: D.mine, projectDir: '' }, { op: 'captured', offset: 1000 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const stop = (cwd) => run(w, 'capture.mjs', { session_id: sid, hook_event_name: 'Stop', cwd, transcript_path: BIG });
  stop(D.excluded);
  await sleep(300);
  eq('while the session is INSIDE the excluded directory its hooks do nothing', [logLines(w), fs.existsSync(path.join(w.root, 'locks'))], [[], false]);
  stop(D.mine);
  await sleep(800);
  const spawned = logLines(w).find((l) => /spawned distiller/.test(l)) || '';
  const delta = Number((/delta=(\d+)K/.exec(spawned) || [])[1]);
  check('back outside, the next Stop distills the WHOLE delta since the last capture, including the stretch spent inside (documented limit)',
    delta >= 100 && /since offset 1K/.test(spawned), spawned || logText(w));
}

console.log('\n=== 13. Windows path forms through the real hook (where the host can express them) ===');
if (process.platform !== 'win32') {
  console.log('  SKIP  these are Windows spellings of a directory');
} else {
  const skipped = (cwd, listed = EXCLUDED) => {
    const w = mkWorld({ EXCLUDED_DIRECTORIES: [listed] });
    run(w, 'orient.mjs', HOOKS.orient(randomUUID(), cwd).payload);
    return logLines(w).some(isSkipLine);
  };
  check('an extended-length `\\\\?\\` cwd', skipped('\\\\?\\' + D.excluded));
  check('a trailing dot on a component of the cwd', skipped(EXCLUDED + '.\\src'));
  check('a trailing dot on the last component', skipped(D.excluded + '.'));
  check('CONTROL: a prefix sibling written with `\\\\?\\` still runs', !skipped('\\\\?\\' + D.sibling));

  // 8.3 short names: only where the volume generates them (otherwise short === long and there is nothing to test).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-83-'));
  const long = path.join(base, 'ClientAlphaLongName');
  fs.mkdirSync(path.join(long, 'src'), { recursive: true });
  let short = '';
  try { short = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${path.join(long, 'src')}').ShortPath`], { encoding: 'utf8' }).stdout.trim(); } catch { /* silence-ok: no PowerShell means no short name to try. */ }
  if (!short || short.toLowerCase() === path.join(long, 'src').toLowerCase()) console.log('  SKIP  this volume does not generate 8.3 short names');
  else check('an 8.3 short-name cwd resolves to the listed long name', skipped(short, long), short);
}

srv.close();
done();
