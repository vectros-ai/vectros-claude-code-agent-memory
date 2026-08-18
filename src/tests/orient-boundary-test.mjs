#!/usr/bin/env node
/**
 * THE ORIENT BOUNDARY — `orientPending` must survive an orientation that never arrived.
 *
 * This is the THIRD round of ONE bug, and the shape is worth more than the fix:
 *
 *   round 1 — the flag was consumed on ENTRY. A network blip produced `hits=[]` and
 *             `orientLines=[]`, fell into the nothing-to-inject guard (whose body is `writeState`),
 *             and persisted `orientPending: false`. The session ran its whole life with no pinned
 *             set. Fixed by moving the clear to the delivery site.
 *   round 2 — "on delivery" was read as "we reached the delivery code". But the guard at recall.mjs
 *             only returns when hits AND orientLines AND nudge are ALL empty — so enumeration
 *             failing (`orientLines=[]`) while search SUCCEEDS (`hits>0`) walks straight past it to
 *             the clear. Zero orientation delivered, boundary consumed, never re-owed.
 *   round 3 — the comment above the line said "A failed orient leaves the flag set, so the next
 *             healthy prompt orients". The code said `if (isFirstPrompt) state.orientPending =
 *             false`. The comment described the fix; the line never got it.
 *
 * The rule was already written 4 lines above the bug, for the enumerated ids:
 * *"over-offering is recoverable, a false receipt is not"* — and `orientPending: false` with no
 * orientation delivered is a false receipt about the most expensive thing this hook does.
 *
 * WHY A STUB API AND NOT A FIXTURE. The failure needs enumeration to fail while search succeeds,
 * which is a split no fixture can express honestly — feeding `recall.mjs` a pre-baked orientLines=[]
 * would validate my assumption, not the contract (a real-graph validation, not a paraphrase). So this stands up a real HTTP server, points
 * the real `recall.mjs` at it with `VECTROS_API_BASE_URL`, and lets the unmodified hook run its own
 * fetch path in its own process. The stub is the API; the code under test is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { queueFor, stateFor } from '../paths.mjs';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into
// production hooks.log. (Full rationale: hooklog.mjs's header, sweep-test.mjs's copy of this line.)
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orient-boundary-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/
const SID = 'orient-boundary-test-0001';
const SP = stateFor(SID);
const QP = queueFor(SID);

const reset = () => { for (const f of [SP, QP]) { try { fs.unlinkSync(f); } catch { /* not there; fine */ } } };

/** A search hit that survives reshape() with a real id. */
const hit = (id, n) => ({
  sourceType: 'GenericRecord', recordId: id,
  snippet: `a durable claim number ${n} that is long enough to render as a real line of recall context`,
  metadata: { recordType: 'memory', kind: 'project', priority: '0' },
});

/**
 * @param {(url:string, reqBody:string)=>({status:number, body:any})} route
 *
 * The request BODY is handed to `route`, and it is not a convenience: the pinned lookup and the
 * thread lookup are both `POST /v1/records/lookup`, so the body is the ONLY thing that tells them
 * apart. This harness accumulated it and threw it away, which is precisely why the resume split
 * (pinned succeeds, thread fails) had zero coverage while the code branched on it.
 */
function withStub(route, fn) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = route(req.url, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  // 127.0.0.1 explicitly, never "localhost": on Windows that resolves ::1 first and hangs.
  srv.listen(0, '127.0.0.1');
  return new Promise((resolve) => {
    srv.on('listening', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { resolve(await fn(base)); } finally { srv.close(); }
    });
  });
}

/**
 * ASYNC spawn, deliberately — `spawnSync` cannot work here and the failure is silent-ish.
 *
 * The stub server lives in THIS process. `spawnSync` blocks the event loop for the child's whole
 * lifetime, so the server can never answer the request the child is making: every fetch times out,
 * `search()` returns `[]`, the guard fires, and case 1 takes ROUND ONE's path while appearing to
 * pass. The preconditions below are what caught it — a test whose setup fails silently proves the
 * opposite of what it claims. (Diagnosed in one line by the receipt discipline this branch just added:
 * `search FAILED (timeout after 5000ms)`.)
 */
const runRecall = (base) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(DIR, 'recall.mjs')], {
    env: { ...process.env, VECTROS_API_BASE_URL: base, VECTROS_API_KEY: 'stub-key-for-test' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.stdin.end(JSON.stringify({
    session_id: SID, prompt: 'kick off the work on the branch', cwd: os.tmpdir(),
    hook_event_name: 'UserPromptSubmit',
  }));
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('close', () => {
    clearTimeout(timer);
    if (/ReferenceError|TypeError|Cannot find|ERR_MODULE/.test(err)) {
      return resolve({ crash: err.trim().split('\n')[0] });
    }
    let ctx = '';
    try { ctx = JSON.parse(out || '{}').hookSpecificOutput?.additionalContext || ''; }
    catch { /* no injection this turn — ctx stays '' and the assertions read the STATE, which is the real subject */ }
    let state = {};
    try { state = JSON.parse(fs.readFileSync(SP, 'utf8')); }
    catch { /* no state written; the assertions surface it */ }
    // 'Session orientation' is the first-prompt HITS header — it ships whether or not the
    // enumeration produced anything, so it cannot tell the two apart (it fooled the first draft of
    // this test). Since 2026-07-17 the PINNED set is no longer injected (it lives in the auto-loaded
    // MEMORY.md; enumerate.mjs § renderOrientBlock), so the only thing the orient block still injects
    // is the resumed thread — 'This thread's earlier working memory'. That is the marker that
    // observes an injected orient block; `injectedPin` separately proves the pinned set is ABSENT
    // from the injection (the efficiency win) — the same measurement-honesty rule as elsewhere.
    resolve({
      ctx, state,
      injectedThread: ctx.includes("This thread's earlier working memory"),
      injectedPin: ctx.includes('PINNED-BODY-MARKER'),
    });
  });
});

/**
 * @param {'startup'|'resume'} [source] — the SessionStart source recorded at the boundary.
 *
 * This wrote no `orientSource`, so `isResume` was ALWAYS false and every resume-only branch in
 * `enumerate.mjs` had zero coverage while the suite reported full green. A default parameter is
 * what makes the resume cases below expressible at all.
 */
const seedPending = (source = 'startup') => {
  fs.mkdirSync(path.dirname(SP), { recursive: true });
  fs.writeFileSync(SP, JSON.stringify({
    orientPending: true, promptCount: 0, injectedIds: [], orientSource: source,
  }));
};

/** A pinned record. `titleLen` is the knob: `line()` caps the BODY at 400 and the title NOT AT ALL.
 *  The body carries PINNED-BODY-MARKER so a test can assert the pinned set is (or is NOT) injected. */
const pin = (i, titleLen = 40) => ({
  id: `pin-${i}`,
  typeName: 'memory',
  payload: {
    title: 'T'.repeat(titleLen) + ` #${i}`,
    body: 'PINNED-BODY-MARKER standing context that matters, at length, '.repeat(20),
    priority: 30,
    kind: 'feedback',
    area: 'ops',
  },
});

/** A resumed-thread episodic record — what the orient block DOES still inject. Big title overflows. */
const threadRec = (i, titleLen = 40) => ({
  id: `thr-${i}`,
  typeName: 'memory',
  payload: {
    title: 'R'.repeat(titleLen) + ` #${i}`,
    body: 'THREAD working-memory observation from earlier in this session, '.repeat(20),
    priority: 0,
    kind: 'observation',
    area: 'ops',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BUG: enumeration FAILS, search SUCCEEDS. The flag must survive.
// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. enumeration fails (500) + search succeeds -> orientPending MUST survive ===');
reset(); seedPending();
let r = await withStub(
  (url) => url.includes('/records/lookup')
    ? { status: 500, body: { error: 'stub: enumeration is down' } }   // orientLines = []
    : { status: 200, body: { results: [hit('rec-aaa', 1), hit('rec-bbb', 2)] } }, // hits > 0
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: search really did return hits (the nothing-to-inject guard must NOT fire)',
  r.ctx.length > 0, `ctx was empty (${r.ctx.length}c) — the guard fired and this test proves nothing`);
check('the pinned set is never injected — it lives in MEMORY.md', !r.injectedPin);
eq('THE BUG: orientPending survives an orientation that never arrived',
  r.state.orientPending, true);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The healthy path still consumes the boundary — a flag that never clears is its own bug.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. enumeration succeeds -> orientPending IS consumed ===');
reset(); seedPending();
r = await withStub(
  (url) => url.includes('/records/lookup')
    ? { status: 200, body: { data: [pin(1)] } }                       // pinned lookup succeeds (has the marker)
    : { status: 200, body: { results: [hit('rec-aaa', 1)] } },
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: the delivery path ran (search hits shipped, guard did not fire)',
  r.ctx.length > 0, `ctx=${r.ctx.slice(0, 120)}`);
check('the pinned lookup succeeded but the pinned block was NOT injected (MEMORY.md carries it)', !r.injectedPin);
check('a pinned record is NOT force-marked served — pins are never suppressed from hits (lossy if MEMORY.md is stale)',
  !(r.state.injectedIds || []).includes('pin-1'));
eq('the healthy path consumes the boundary', r.state.orientPending, false);

// ─────────────────────────────────────────────────────────────────────────────
// 2b. THE EMPTY TIER — HTTP 200 {data:[]}. The orient RAN and had nothing to say.
//
// This is the case the first three missed, and it is the one that matters most: it is the
// state of EVERY NEW USER and every OSS adopter, and never of the machine this was written
// on — which has pinned records, so the dogfood could not surface it. Case 1 covers 500,
// case 2 covers one record, case 3 covers both-fail; none covers SUCCESS-WITH-NOTHING.
//
// With the round-3 gate (`orientPart.length && !orientDropped`) the flag never cleared, so
// every prompt for the life of the session re-ran the full multi-query orient: ~6x the REST
// calls, the rolling-window tail never read, already-served hits dropped without their
// `[recalled earlier]` line, and the 50th prompt of the session still told it was "matching this session's kickoff".
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2b. enumeration succeeds but the tier is EMPTY -> boundary IS consumed ===');
reset(); seedPending();
r = await withStub(
  (url) => url.includes('/records/lookup')
    ? { status: 200, body: { data: [] } }                          // SUCCESS. Tier genuinely empty.
    : { status: 200, body: { results: [hit('rec-aaa', 1)] } },
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: the search still delivered, so the nothing-to-inject guard did NOT fire',
  r.ctx.length > 0, `ctx empty (${r.ctx.length}c) — the guard fired and this proves nothing`);
check('no orient block injected (empty tier, and pinned would not inject anyway)', !r.injectedThread && !r.injectedPin);
eq('an EMPTY tier consumes the boundary — the orient ran, and owed nothing',
  r.state.orientPending, false);

// ─────────────────────────────────────────────────────────────────────────────
// 2c. THE NEW USER, EXACTLY — empty tier AND an empty store. FOURTH ROUND of one bug.
//
// 2b stubs a search HIT so the nothing-to-inject path is not taken, and says so in its own
// precondition. That precondition is honest, and what it honestly documents is the avoidance:
// every case above walks the delivery path. A brand-new user has BOTH an empty pinned tier and an
// empty store, so nothing is injected at all — and the guard that used to sit on that path
// returned before the flag was ever decided. The orient RAN. It owed nothing. The flag latched
// anyway, for the life of the session, for exactly the population the round-4 fix names and for
// nobody on this machine.
//
// Round 1 the same guard persisted `false` (consumed a boundary never delivered); round 4 it
// persisted `true` (never consumed one that was). Same guard, opposite direction, both bugs — the
// reason the fix is structural (ONE commit site, output decided after) and not a fifth predicate.
//
// This case and case 3 are the DISCRIMINATING PAIR: identical nothing-to-inject path, opposite
// `orientOk`, opposite verdicts. Together they prove the flag now follows the receipt and not the
// control flow. Neither alone proves it.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2c. empty tier + EMPTY STORE -> nothing injected at all -> boundary IS consumed ===');
reset(); seedPending();
r = await withStub(
  (url) => url.includes('/records/lookup')
    ? { status: 200, body: { data: [] } }       // SUCCESS. Tier genuinely empty.
    : { status: 200, body: { results: [] } },   // SUCCESS. Store genuinely empty. THE new user.
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: NOTHING was injected — this really IS the nothing-to-inject path',
  r.ctx.length === 0, `ctx was ${r.ctx.length}c — something was injected and this proves nothing`);
eq('THE BUG: an empty store still consumes the boundary — the orient ran, and owed nothing',
  r.state.orientPending, false);
check('and state was still COMMITTED on that path, not skipped',
  r.state.promptCount === 1, `promptCount=${r.state.promptCount} — expected 1`);

// ─────────────────────────────────────────────────────────────────────────────
// 2d. THE INJECTED BLOCK OVERFLOWS THE BUDGET — now via the RESUMED-THREAD block (pinned no longer
//     injects), so this exercises the FIT loop on the content that is actually injected. `line()`
//     caps the body at BODY_MAX=400 and the TITLE at nothing, so a big thread set overruns
//     CONTEXT_CAP and `orientDropped` goes positive.
//
//     `orientDropped` used to gate the FLAG as well as the served-marking. But the drop is
//     DETERMINISTIC: the retry re-renders the same block against the same budget and drops the
//     same lines. That is not a re-owe, it is a loop — so the boundary is CONSUMED (pinned lookup
//     succeeded → orientOk), and the dropped THREAD records are NOT served (they stay eligible as
//     hits). This case ALSO proves the win: a big pinned set is stubbed, and it is neither injected
//     (MEMORY.md carries it) nor budget-consuming — and its ids are NOT force-marked served, so a
//     pin is never suppressed from surfacing as a hit (a stale MEMORY.md must not hide it).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2d. RESUME: THREAD block overflows -> boundary consumed; pinned NOT injected, NOT suppressed ===');
reset(); seedPending('resume');
r = await withStub(
  (url, body) => {
    if (!url.includes('/records/lookup')) return { status: 200, body: { results: [] } };
    if (body.includes('threadId')) return { status: 200, body: { data: Array.from({ length: 8 }, (_, i) => threadRec(i, 1100)) } };
    return { status: 200, body: { data: Array.from({ length: 12 }, (_, i) => pin(i, 1100)) } }; // big pinned set
  },
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: a THREAD block was delivered, partially (near cap)',
  r.injectedThread && r.ctx.length > 6000 && r.ctx.length <= 9500,
  `ctx=${r.ctx.length}c injectedThread=${r.injectedThread} — expected a near-cap thread block`);
check('THE WIN: the big pinned set is NOT injected and does NOT consume the budget', !r.injectedPin);
eq('a DETERMINISTIC drop consumes the boundary — the retry would be byte-identical',
  r.state.orientPending, false);
check('pinned ids are NOT force-marked served — pins are never suppressed from hits (a stale MEMORY.md must not hide a pin)',
  Array.from({ length: 12 }, (_, i) => `pin-${i}`).every((id) => !(r.state.injectedIds || []).includes(id)),
  `injectedIds=${JSON.stringify(r.state.injectedIds)}`);
check('a DROPPED thread record is NOT marked served (it stays eligible as a hit)',
  !(r.state.injectedIds || []).includes('thr-7'), `injectedIds=${JSON.stringify(r.state.injectedIds)}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2e. RESUME, thread lookup DOWN, pinned fine — the second latch, and a regression this branch
//     introduced. Both lookups are POST /v1/records/lookup, so the request BODY is the only
//     discriminator; the harness used to collect it and discard it, which is why this had no test.
//
//     A thread failure while pinned succeeds means the endpoint is up and the key is good, so the
//     realistic cause is a persistent shape-400 on `{field:'threadId'}` — the retry cannot fix it
//     and re-injects the whole pinned block every prompt. It is a DEGRADATION with a receipt, not
//     an unrunnable orientation.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2e. RESUME: pinned ok, thread lookup 500 -> degraded, but boundary IS consumed ===');
reset(); seedPending('resume');
let sawThread = false; // did the resume path ACTUALLY fire? -> see the precondition below
r = await withStub(
  (url, body) => {
    if (!url.includes('/records/lookup')) return { status: 200, body: { results: [] } };
    // THE DISCRIMINATOR — same URL, same method; only the body differs.
    if (body.includes('threadId')) { sawThread = true; return { status: 500, body: { error: 'stub: thread lookup is down' } }; }
    return { status: 200, body: { data: [pin(1)] } };
  },
  runRecall,
);
check('no crash', !r.crash, r.crash);
/**
 * THE PRECONDITION THAT ACTUALLY OBSERVES THE RESUME PATH.
 *
 * This used to be `check('the resume path really ran', r.injectedOrient)` — and `injectedOrient` is
 * SOURCE-INDEPENDENT: it is true on every non-resume path in the file. So the assertion was
 * satisfied by a run that never made a thread lookup at all. `recall.mjs` reads
 * `state.orientSource || 'startup'`, so breaking the plumbing silently yields `isResume=false` ->
 * `thread = Promise.resolve([])` -> never null -> `ok = pinned !== null` -> **2e and 2f both still
 * pass with the resume path completely disabled.** The fallback satisfies the test.
 *
 * `sawThread` is the only thing here that can tell a resume from a startup: both lookups POST to
 * the same URL, so the request BODY is the discriminator — which this harness has always collected
 * and thrown away.
 */
check('precondition: the THREAD lookup was actually attempted — this is a resume, not a startup',
  sawThread, 'no threadId lookup was made: isResume was false, so this case proves nothing about resume');
check('precondition: the hook reached the state commit (prompt #1 ran to completion)',
  r.state.promptCount === 1, `promptCount=${r.state.promptCount}`);
eq('a failed SUPPLEMENT does not re-owe the orientation — the core (pinned lookup) ran',
  r.state.orientPending, false);

// ─────────────────────────────────────────────────────────────────────────────
// 2f. RESUME, PINNED down -> the core failed -> the boundary IS still owed. The discriminating
//     partner to 2e: same resume path, same guard, opposite tier down, opposite verdict. Without
//     this, 2e alone would also pass a build that simply never re-owed anything.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2f. RESUME: thread ok, PINNED lookup 500 -> the core failed -> still owed ===');
reset(); seedPending('resume');
sawThread = false;
r = await withStub(
  (url, body) => {
    if (!url.includes('/records/lookup')) return { status: 200, body: { results: [hit('rec-aaa', 1)] } };
    if (body.includes('threadId')) { sawThread = true; return { status: 200, body: { data: [] } }; }
    return { status: 500, body: { error: 'stub: pinned lookup is down' } };
  },
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: the THREAD lookup was actually attempted (2f is the resume partner of 2e)',
  sawThread, 'no threadId lookup was made: isResume was false, so this proves nothing about resume');
eq('a failed CORE still owes the orientation — a retry can fix this one', r.state.orientPending, true);

// ─────────────────────────────────────────────────────────────────────────────
// 2g. THE PRE-FLAG SESSION — the FIFTH latch, and the first that latches OFF.
//
// Every case above seeds `orientPending: true`. The OTHER way to be prompt #1 is the pre-flag
// path — `orientPending === undefined && !promptCount` — which is every session whose state file
// predates the flag, and every session whose state was written by an older hook. No case covered
// it, so the suite was green over a value it never produced.
//
// The bug: recall could only ever WRITE false. On `true` a failure survives by not being touched;
// on `undefined` there is nothing to leave alone, and `promptCount` has just moved to 1 — so
// `!promptCount` is false forever and the session can never be prompt #1 again. The orientation is
// not re-owed, it is GONE. Rounds 1-5 latched ON (over-offering, recoverable). This is the false
// receipt the header at the top of this file calls unrecoverable.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2g. PRE-FLAG session (no orientPending field) + orient FAILS -> must RE-OWE ===');
reset();
fs.mkdirSync(path.dirname(SP), { recursive: true });
fs.writeFileSync(SP, JSON.stringify({ promptCount: 0, injectedIds: [] })); // NO orientPending — pre-flag
r = await withStub(
  (url) => url.includes('/records/lookup')
    ? { status: 500, body: { error: 'stub: enumeration is down' } }
    : { status: 200, body: { results: [hit('rec-aaa', 1)] } },
  runRecall,
);
check('no crash', !r.crash, r.crash);
check('precondition: this really was treated as prompt #1', r.state.promptCount === 1,
  `promptCount=${r.state.promptCount} — not the first-prompt path; this proves nothing`);
check('precondition: no orient block was injected (enumeration failed)', !r.injectedThread && !r.injectedPin);
eq('THE BUG: a failed orient on the PRE-FLAG path must RE-OWE, not evaporate',
  r.state.orientPending, true);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Total failure: both fail -> nothing injected -> flag STILL survives (round 1's bug, still
//    fixed). Same path as 2c, opposite receipt: this is the half that proves the fall-through did
//    not simply clear the flag unconditionally.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. both fail -> nothing injected -> orientPending survives (round 1 regression) ===');
reset(); seedPending();
r = await withStub(() => ({ status: 500, body: { error: 'stub: everything is down' } }), runRecall);
check('no crash', !r.crash, r.crash);
eq('a totally failed recall still owes the orientation', r.state.orientPending, true);

reset();
done();
