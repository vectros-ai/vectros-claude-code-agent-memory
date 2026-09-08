// Exercise dispose.mjs for real — especially the paths that must REFUSE.
// A verification gate that only gets tested on its happy path is not known to be a gate.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // MUST precede any runtime-state path use — see the file header.
import { queueFor, verdictMutationsOffFile } from '../paths.mjs';
import { startFakeRecordsServer } from './fake-records-server.mjs';

/**
 * THIS FILE OPTS IN TO VERDICT MUTATIONS, and it is one of the few that may.
 *
 * `isolate.mjs` writes a `VERDICT_MUTATIONS_OFF` marker into every isolated root so no test can
 * PATCH the owner's real store via `settle`/`reopen` (credentials are deliberately not isolated).
 * dispose.mjs — the CHILD PROCESS spawned below — reaches for that marker on every settle/reopen
 * call, inheriting the same isolated root via `ENV`'s `{...process.env}` spread; left in place,
 * EVERY settle in this whole suite is silently refused, which looks exactly like "the fake server
 * rejected it" and cost real time to tell apart (see spawnAsync's own header on the SEPARATE trap
 * this file also hit). Safe to delete here because nothing in this file ever reaches a real
 * store — `VECTROS_API_BASE_URL` points at `fake-records-server.mjs` for every child process this
 * file spawns. Mirrors `candidates-test.mjs`'s own opt-out exactly, for the same reason.
 */
try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* fine — not there yet */ }

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into a real
// deployment's hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispose-test-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
// This checkout's own repo root — derived by walking up from this file's location. Used ONLY as
// `run()`'s default cwd for cases that don't depend on real repo CONTENT (just on the binary
// running). Anything that cites a real path/section — the `documented:`/`covered:` citation gate
// — uses FAKE_REPO below instead, so this suite never depends on THIS repo's own doc structure
// existing (a real portability bug, found while auditing this file for public-readiness: a fresh
// clone of this package mirrored standalone has none of this repo's other directories, so a test
// that cited real paths in them would fail for every adopter, silently, forever).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SID = 'dispose-test-0001';
const QP = queueFor(SID);
const BOGUS_RECORD = '00000000-0000-0000-0000-000000000000';

/**
 * A SELF-CONTAINED fake repo, built fresh per run, standing in for whatever real repo a `dispose`
 * invocation happens to run inside. Mirrors exactly the structure the `documented:`/`covered:`
 * citation gate looks for (see dispose.mjs's `repoRoot`/`sectionExists`/`docExists`) — a numbered-
 * section conventions doc, a plain doc with an anchorable heading, a root-level doc, and a nested
 * subdirectory to drive the cwd-vs-root-relative cases — none of it tied to any specific adopter's
 * real repo, including this one.
 */
function buildFakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispose-test-fakerepo-'));
  fs.mkdirSync(path.join(root, 'docs', 'development'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'development', 'CONVENTIONS.md'),
    '# Conventions\n\n### 65. A fixture section\n\nBody text for the fixture section, used only by dispose-test.mjs.\n');
  fs.writeFileSync(path.join(root, 'docs', 'development', 'GOTCHAS.md'),
    '# Gotchas\n\n### The fixture anchor\n\nBody text for the fixture anchor, used only by dispose-test.mjs.\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Fixture root doc\n\nUsed only by dispose-test.mjs.\n');
  fs.mkdirSync(path.join(root, 'platform'), { recursive: true });
  return root;
}
const FAKE_REPO = buildFakeRepo();

const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { append, read, queuePath } = await mod('queue.mjs');
const { withOrdinals } = await mod('candidates.mjs');

/**
 * THE FAKE RECORD STORE — a real local HTTP server (see fake-records-server.mjs), not an injected
 * `fetchImpl`. dispose.mjs runs as a real SUBPROCESS below, so it has no way to receive a function
 * from this parent process; pointing `VECTROS_API_BASE_URL` at a real local server lets the
 * actual, unmodified `fetch()` code run — both candidates.mjs's (addressing) and dispose.mjs's
 * own (citation verification).
 */
const server = await startFakeRecordsServer();
const ENV = { ...process.env, VECTROS_API_KEY: 'ssk_test_fake_for_dispose_test', VECTROS_API_BASE_URL: server.url };

/**
 * ASYNC `spawn`, DELIBERATELY — NOT `spawnSync`. The fake server lives in THIS process's event
 * loop. `spawnSync` blocks that event loop for the whole child lifetime, so the server can never
 * answer a request the child makes while it's running: every fetch times out and every call looks
 * like "records unreachable" — exactly the trap `orient-boundary-test.mjs` already hit and
 * documented (its own header: *"`spawnSync` cannot work here... every fetch times out... while
 * appearing to pass"*). Measured directly on this branch: a first draft using `spawnSync` here
 * produced dozens of spurious "RECORDS UNREACHABLE" failures, each after the FULL
 * `CANDIDATE_TIMEOUT_MS` wait, mid-suite — not a clean failure, a slow, confusing one.
 */
function spawnAsync(argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), opts.timeout || 30000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
  });
}

/** `candidates.mjs`'s `normalise()` shape, built from the fake server's raw record — good enough
 * for `withOrdinals` to sort the way the real client does, without importing a private function. */
const toNorm = (rec) => ({
  id: rec.id, createdAt: rec.createdAt, externalId: rec.externalId,
  title: rec.payload.title ?? '', body: rec.payload.body ?? '', kind: rec.payload.kind ?? null,
  sessionId: rec.payload.sessionId ?? null, proposedAt: rec.payload.proposedAt ?? null,
  disposition: rec.payload.disposition ?? null, ref: rec.payload.ref ?? null, resolved: rec.payload.resolved ?? null,
  origin: rec.payload.origin ?? null, revises: rec.payload.revises ?? null, supersededBy: rec.payload.supersededBy ?? null,
  dest: rec.payload.dest ?? null, area: rec.payload.area ?? null, tags: rec.payload.tags ?? [], sourceRef: rec.payload.sourceRef ?? null,
});
/** The SAME `bySession` shape dispose.mjs's own `readRecords()` builds, read straight off the fake
 * server's store — so this test's assertions describe the same reality dispose.mjs acts on. */
const bySessionLocal = (sid) => withOrdinals([...server.store.values()]
  .filter((r) => r.typeName === 'candidate' && r.payload.sessionId === sid)
  .map(toNorm));
const pendingLocal = (sid) => bySessionLocal(sid).filter((c) => c.disposition === 'pending' && !c.supersededBy);
const isPending = (sid, ordinal) => pendingLocal(sid).some((c) => c.ordinal === ordinal);

let seedCounter = 0;
/**
 * Seed ONE candidate, in BOTH stores — the record (addressing + verification target, what
 * dispose.mjs now reads) and the local file (the durability backup dispose.mjs writes to after a
 * successful settle; several cases below assert against it directly). Returns the ordinal (`cN`)
 * this candidate resolves to, exactly as `bySession`'s stable numbering would assign it — the same
 * address the OLD file-driven version of this test seeded directly, so most call sites below are
 * unchanged from before the B2 flip.
 */
function seedCandidate(sid, { title, body = 'b', kind = 'observation', dest = 'memory', sourceRef, revises } = {}) {
  const externalId = `${sid}:seed-${++seedCounter}`;
  const fields = { title, body, kind, dest, sessionId: sid, disposition: 'pending', proposedAt: '2026-01-01', externalId };
  if (sourceRef) fields.sourceRef = sourceRef;
  if (revises) fields.revises = revises;
  server.seed('candidate', fields);
  // The file-side backup entry. `dispose.mjs` no longer reads this for addressing or verification
  // — only `backupToFile` reads it, to resolve this candidate's LOCAL positional id when it writes
  // a settle/reopen backup event. A plain 'propose' is enough regardless of whether this candidate
  // is conceptually a revision — the file's own revise/supersede bookkeeping is not something
  // dispose.mjs consults anymore (see candidates.mjs `readRecords`/`rq.superseded`).
  append(sid, { op: 'propose', externalId, title, body, kind, dest, sourceRef: sourceRef || undefined });
  return bySessionLocal(sid).find((c) => c.externalId === externalId).ordinal;
}

/** Mark `oldExternalId`'s record superseded by `byExternalId` — what production's capture-worker
 * does via `supersedeByExternalId` when a REVISE lands. Seeded directly here (this suite seeds
 * candidates, it doesn't run the real capture pipeline). */
function markSuperseded(oldExternalId, byExternalId) {
  const rec = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.externalId === oldExternalId);
  rec.payload.supersededBy = byExternalId;
}

/** A memory record `stored:`/`covered:` citations can point at — seeded once, freshly "created"
 * (so the recency gate passes), fully offline. Every adopter's OWN real memory records are exactly
 * this shape; there is nothing internal-repo-specific about it. */
const REAL_MEMORY_RECORD = server.seed('memory', { title: 'a real, freshly-written memory record' }).id;
/** The SAME record, but artificially backdated past `DISPOSE_STORED_RECENCY_MIN` (120min default)
 * — exercises the recency gate (case 4) and the "already covered, so recency must NOT apply"
 * exemption (case 9's `covered:<uuid>`) without depending on anything actually existing for 2+
 * hours in a fast test run. */
const OLD_MEMORY_RECORD = server.seed('memory', { title: 'an old, unrelated memory record' }).id;
{
  const old = server.store.get(OLD_MEMORY_RECORD);
  const backdated = new Date(Date.now() - 200 * 60_000).toISOString();
  old.createdAt = backdated;
  old.updatedAt = backdated;
}

try { fs.unlinkSync(QP); } catch {}

// Seed four candidates — same four the file-driven version of this suite seeded, same expected
// ordinals (c1..c4), now sourced from the fake record store.
const [C1, C2, C3, C4] = ['stored path', 'ignored path', 'documented path', 'all-or-nothing canary']
  .map((title) => seedCandidate(SID, { title }));
check('seeded ordinals are c1..c4, exactly as the file-driven version of this suite expected',
  C1 === 'c1' && C2 === 'c2' && C3 === 'c3' && C4 === 'c4', `${C1},${C2},${C3},${C4}`);

const run = async (label, args, expectExit, cwd = REPO) => {
  const r = await spawnAsync([path.join(DIR, 'dispose.mjs'), SID, ...args], { cwd, timeout: 30000, env: ENV });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const pass = r.status === expectExit;
  console.log(`\n--- ${label}`);
  console.log(`    exit=${r.status} (expected ${expectExit}) ${pass ? 'PASS' : '*** FAIL ***'}`);
  for (const l of out.split('\n')) console.log('    | ' + l);
  /**
   * ASSERT IT. `pass` was computed, PRINTED, and discarded — 10 `run()` calls, 0 of 10 exit codes
   * asserted, on the one module that writes to the store. Open the refusal gate wide and this
   * printed `*** FAIL ***` and the suite passed: `run-all.mjs` surfaces child stdout only inside
   * its `failed` branch, so the string was shown exactly when it was redundant and swallowed
   * exactly when it mattered.
   *
   * That is verbatim the construct `assert.mjs` quotes as this project's founding disease — a
   * signal computed, rendered, and never able to fail — sitting in the write path's own gate.
   */
  check(`exit ${expectExit}: ${label}`, pass, `exit=${r.status}, expected ${expectExit}`);
  return r;
};

console.log('=== 1. --list shows the pending set ===');
await run('--list', ['--list'], 0);

console.log('\n=== 2. a BOGUS record id must be REFUSED (this is the whole gate) ===');
await run('c1=stored:<bogus uuid>', [`c1=stored:${BOGUS_RECORD}`], 1);
console.log(`    c1 still pending? ${isPending(SID, 'c1')}  (MUST be true — a refused claim must not settle it)`);

console.log('\n=== 3. ALL-OR-NOTHING: one good spec + one bad must apply NEITHER ===');
await run('c2=ignored + c1=stored:<bogus>', ['c2=ignored:dup', `c1=stored:${BOGUS_RECORD}`], 1);
console.log(`    c2 pending? ${isPending(SID, 'c2')}  (MUST be true — the good spec must NOT have applied)`);
check('c2 was NOT settled by the mixed batch', isPending(SID, 'c2'));

console.log('\n=== 4. CORRESPONDENCE / RECENCY: an OLD, unrelated record must be REFUSED ===');
// THIS FILE USED TO ASSERT THE OPPOSITE, and that is the point. It settled c1 — titled
// "stored path" — with a real, unrelated, pre-existing record. Unrelated content, exit 0,
// "expect false", called a pass. A cold panel used this very line as the proof that dispose
// verified EXISTENCE, not CORRESPONDENCE — and a real uuid is precisely the mistake to expect,
// because recall injects real record uuids into the agent's context on every hit. The gate now
// checks id-echo, typeName, and recency (a stored candidate is a record you JUST wrote); an old
// unrelated record fails the last one.
await run('c1=stored:<a real but OLD, unrelated record>', [`c1=stored:${OLD_MEMORY_RECORD}`], 1);
check('an old unrelated record does NOT settle a candidate', isPending(SID, 'c1'));

// THE ACCEPTANCE CASE — absent from every prior version of this suite (only `stored:`'s REFUSALS
// were ever exercised; the one path where it actually succeeds never was). A record that IS a
// `memory`, freshly written, id-echoing correctly: every gate should pass. A FRESH candidate, not
// c1 — c1 stays pending throughout this file (asserted at the end) since every case that touches
// it is a refusal by design.
{
  const T = seedCandidate(SID, { title: 'stored: the acceptance case' });
  await run(`${T}=stored:<a real, FRESH record>`, [`${T}=stored:${REAL_MEMORY_RECORD}`], 0);
  check('a fresh, correct memory record DOES settle the candidate', !isPending(SID, T));
}

console.log('\n=== 5. idempotent: settling twice is a SKIP, not a duplicate append ===');
// Use `ignored` — it needs no store round-trip, so this tests idempotence rather than the gate.
await run('c2=ignored:dup-check', ['c2=ignored:dup-check'], 0);
const before = read(SID).events;
await run('c2=ignored again', ['c2=ignored:dup-check'], 0);
eq('re-disposing appends nothing to the file backup', read(SID).events, before);

console.log('\n=== 6. documented: a MISSING file is refused; a real one verifies ===');
await run('c3=documented:docs/development/NOPE.md', ['c3=documented:docs/development/NOPE.md'], 1, FAKE_REPO);
await run('c3=documented:GOTCHAS.md#anchor', ['c3=documented:docs/development/GOTCHAS.md#the-fixture-anchor'], 0, FAKE_REPO);

console.log('\n=== 7. a bad disposition word is refused ===');
await run('c4=maybe', ['c4=maybe'], 1);

console.log('\n=== 8. unknown candidate id is refused ===');
await run('c99=ignored', ['c99=ignored'], 1);

console.log('\n=== 9. `ignored:covered:<ref>` — the ONE-WAY DOOR IS NOW CHECKED (2026-07-20 incident) ===');
/**
 * A PM session settled 29 candidates and disposed a TRUE one as `ignored:PREMISE IS FALSE`, citing
 * two repo docs that were themselves STALE. `ignored` is never re-offered, so the candidate was
 * destroyed — and it was the ONLY disposition nothing verified. The undoable ones had four gates;
 * the one-way door had none.
 *
 * REFUSAL FIRST. A gate is only known to be a gate once the bad citation is proven to bounce; the
 * accepting cases below prove only that it is not refusing everything.
 */
{
  const C = seedCandidate(SID, { title: 'covered-citation path' });

  await run(`${C}=ignored:covered:<a file that does not exist>`, [`${C}=ignored:covered:docs/development/NOT-A-REAL-DOC.md`], 1, FAKE_REPO);
  check('a citation to a MISSING FILE is refused', isPending(SID, C));

  /**
   * The bogus section number is ASSEMBLED AT RUNTIME, and that is deliberate. Written out in full,
   * a section-sign followed by digits IS a real citation as far as this repo's own internal
   * citation-lint tooling is concerned, so it would flag this fixture as a citation pointing at
   * nothing — counting test data written to exercise the gate as if it were a real, broken
   * citation. This is data, not a citation, so it is built rather than written. Same move as
   * `dispose.mjs`'s escaped backtick, for the same reason: keep static scanners reading the file
   * the way a human does.
   */
  const NO_SUCH_SECTION = '§' + '99999';
  await run(`${C}=ignored:covered:${NO_SUCH_SECTION}`, [`${C}=ignored:covered:${NO_SUCH_SECTION}`], 1, FAKE_REPO);
  check('a citation to a CONVENTIONS section that does not exist is refused', isPending(SID, C));

  await run(`${C}=ignored:covered:<bogus uuid>`, [`${C}=ignored:covered:${BOGUS_RECORD}`], 1, FAKE_REPO);
  check('a citation to a RECORD that does not exist is refused', isPending(SID, C));

  // ...and only now, the accepting cases. Against FAKE_REPO's own fixture section (§65 there is a
  // fixture heading buildFakeRepo() writes, not any real internal doc's section 65).
  await run(`${C}=ignored:covered:§65`, [`${C}=ignored:covered:§65`], 0, FAKE_REPO);
  check('a REAL CONVENTIONS section is accepted', !isPending(SID, C));

  const P = seedCandidate(SID, { title: 'covered by path' });
  await run(`${P}=ignored:covered:<a real path>`, [`${P}=ignored:covered:docs/development/CONVENTIONS.md`], 0, FAKE_REPO);
  check('a REAL path is accepted', !isPending(SID, P));

  // An OLD record is the CORRECT citation for "already covered", so the recency gate that protects
  // `stored:` must NOT apply here — otherwise the right answer is the one that gets rejected.
  const R = seedCandidate(SID, { title: 'covered by record' });
  await run(`${R}=ignored:covered:<a real, OLD record>`, [`${R}=ignored:covered:${OLD_MEMORY_RECORD}`], 0);
  check('an OLD record is a VALID "already covered" citation (recency must not apply here)', !isPending(SID, R));

  // Bare `ignored:<reason>` stays legal — "not durable" has nothing to cite, and forcing a citation
  // there only teaches the agent to invent one.
  const B = seedCandidate(SID, { title: 'bare ignore stays legal' });
  const bare = await run(`${B}=ignored:not durable`, [`${B}=ignored:not durable, point-in-time`], 0);
  check('bare ignored is still accepted', !isPending(SID, B));
  check('...but it SAYS it was not verified, and points at the cited form',
    /NOT verified/.test(bare.stdout || '') && /covered:/.test(bare.stdout || ''), (bare.stdout || '').slice(0, 400));
}

console.log('\n=== 10. --reopen: a wrong `ignored` is RECOVERABLE (the door swings both ways) ===');
// No pre-flight gate can catch a claim that is wrong on the merits — the disposal that caused this
// work passed every check that existed. Reversibility is the part a gate cannot supply.
{
  const W = seedCandidate(SID, { title: 'wrongly ignored' });
  await run(`${W}=ignored:PREMISE IS FALSE`, [`${W}=ignored:PREMISE IS FALSE`], 0);
  check('it is settled and gone from pending', !isPending(SID, W));

  await run(`--reopen ${W}`, ['--reopen', W, 'the cited docs were stale; the claim is true'], 0);
  check('REOPENED — the destroyed candidate is pending again', isPending(SID, W),
    `pending=${pendingLocal(SID).map((c) => c.ordinal).join(',')}`);
  // The record itself is back to 'pending' — the primary write this whole flip is about.
  const rec = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.payload.title === 'wrongly ignored');
  check('the RECORD disposition is pending again', rec.payload.disposition === 'pending', JSON.stringify(rec.payload));
  // Append-only backup: the reopen does not erase the dispose, it records the correction alongside
  // it, in the LOCAL FILE — the durability backup, not the source of truth anymore, but still
  // written and still append-only.
  const raw = fs.readFileSync(QP, 'utf8');
  check('and BOTH events are retained in the local backup — nothing is rewritten',
    raw.includes('"op":"dispose"') && raw.includes('"op":"reopen"'));

  /**
   * THE `why` TEXT MUST NOT REOPEN CANDIDATES IT MENTIONS. This was a filter over every arg, so
   * `--reopen c7 duplicate of c3` reopened c7 AND c3 — and if c3 had been correctly settled as
   * `stored`, it came back to pending, the nudge re-offered it, and settling it again creates a
   * DUPLICATE record. A prose reason that names another candidate is the normal way to explain a
   * reopen, so the footgun sat on the common path. The old test used a `why` with no `cN` token and
   * could not see it.
   */
  {
    const V = seedCandidate(SID, { title: 'innocent bystander' });
    await run(`${V}=ignored:settled on purpose`, [`${V}=ignored:settled on purpose`], 0);
    check('the bystander is settled', !isPending(SID, V));
    // Reopen a DIFFERENT candidate, mentioning the bystander in the reason.
    await run(`--reopen ${W} (why mentions ${V})`, ['--reopen', W, 'duplicate of', V], 0);
    check('a `cN` inside the REASON is words, not an id — the bystander stays settled',
      !isPending(SID, V), `pending=${pendingLocal(SID).map((c) => c.ordinal).join(',')}`);
  }

  await run('--reopen something already pending', ['--reopen', W], 0); // SKIP, not an error
  await run('--reopen c99 (no such candidate)', ['--reopen', 'c99'], 1);
  await run('--reopen with no id', ['--reopen'], 2);
}

console.log('\n=== 11. a SUPERSEDED candidate must NOT be reopenable ===');
// A `revise` already replaced that claim with a corrected one. Resurrecting the old version would
// re-offer text a later run judged WRONG, while its correction sits pending in the same queue.
// This is why `readRecords()` splits `disposed` from `superseded` instead of keeping one `gone` set.
{
  const OLD = seedCandidate(SID, { title: 'the wrong claim' });
  const oldExternalId = bySessionLocal(SID).find((c) => c.ordinal === OLD).externalId;
  const NEW = seedCandidate(SID, { title: 'the corrected claim', revises: oldExternalId });
  const newExternalId = bySessionLocal(SID).find((c) => c.ordinal === NEW).externalId;
  markSuperseded(oldExternalId, newExternalId);
  check('the superseded candidate is not pending', !isPending(SID, OLD));
  await run(`--reopen ${OLD} (superseded, never disposed)`, ['--reopen', OLD], 1);
  check('and it STAYS gone', !isPending(SID, OLD));
}

console.log('\n=== 12. documented: CONTAINMENT — bounded to the worktree ROOT, not to cwd ===');
/**
 * Both directions, because the first two attempts at this bound got one each wrong:
 *   · `path.relative(process.cwd(), p)` REFUSED `../CLAUDE.md` from a nested subdirectory — inside
 *     the repo, and a citation that worked before the bound existed;
 *   · falling back to `cwd` when no root is found ACCEPTED a sibling repo's path when run from the
 *     parent of several checkouts, which is the exact case the bound is for.
 * A test that only checked `../../../etc/hosts` would have passed against both.
 *
 * All of this runs against FAKE_REPO (built at the top of this file), never against this repo's
 * own real tree — the earlier version of this suite ran directly against whatever real repo
 * happened to check it out, which is exactly the portability bug the fixture exists to remove.
 */
{
  // `run()` executes with cwd = REPO by default; `runFrom()` drives the cwd-sensitive cases against
  // an explicit cwd (always FAKE_REPO or one of its subdirectories in this block).
  const runFrom = (cwd, args) => spawnAsync([path.join(DIR, 'dispose.mjs'), SID, ...args], { cwd, timeout: 30000, env: ENV });

  const A = seedCandidate(SID, { title: 'containment: escapes the tree' });
  const r1 = await run(`${A}=documented:../../../etc/hosts`, [`${A}=documented:../../../etc/hosts`], 1, FAKE_REPO);
  check('a path escaping the worktree is REFUSED', isPending(SID, A));
  check('...and the refusal names containment, not "does not exist"',
    /OUTSIDE this worktree/.test((r1.stdout || '') + (r1.stderr || '')), ((r1.stdout || '') + (r1.stderr || '')).slice(0, 300));

  const B = seedCandidate(SID, { title: 'containment: a real repo path' });
  await run(`${B}=documented:<a real repo-relative path>`, [`${B}=documented:docs/development/CONVENTIONS.md`], 0, FAKE_REPO);
  check('a repo-relative path inside the tree is accepted', !isPending(SID, B));

  // THE FALSE-REFUSAL CASE. From a SUBDIRECTORY, a `..` path that stays inside the worktree must
  // still verify — this is what the cwd-bound version broke.
  const sub = path.join(FAKE_REPO, 'platform'); // guaranteed to exist — buildFakeRepo() always makes it
  const C = seedCandidate(SID, { title: 'containment: dotdot but still inside' });
  {
    const r = await runFrom(sub, [`${C}=documented:../CLAUDE.md`]);
    check('`../CLAUDE.md` from platform/ is INSIDE the worktree and must verify', r.status === 0,
      `exit=${r.status} ${((r.stdout || '') + (r.stderr || '')).slice(0, 300)}`);
    check('and it really settled', !isPending(SID, C));
  }

  /**
   * THE CASE THE PREVIOUS SET COULD NOT REACH — and it is the one the tool's own instructions
   * describe. The refusal text says "cite a path relative to the repo root"; obeying that from a
   * subdirectory resolved against `cwd` instead, giving `<repo>/platform/docs/...` → "does not
   * exist". A verifier that refuses the citation it just asked for is worse than a vague one,
   * because the agent has no way to tell a wrong claim from a wrong base.
   *
   * Structurally invisible to everything above: `run()` uses `cwd = REPO` by default, where the
   * two bases coincide, and the one subdirectory case uses a `../` path that only exercises the
   * OTHER base.
   */
  const E = seedCandidate(SID, { title: 'containment: root-relative from a subdirectory' });
  {
    const r = await runFrom(sub, [`${E}=documented:docs/development/CONVENTIONS.md`]);
    check('a ROOT-relative path (what the diagnostics tell the agent to cite) verifies from platform/',
      r.status === 0, `exit=${r.status} ${((r.stdout || '') + (r.stderr || '')).slice(0, 300)}`);
    check('and it really settled', !isPending(SID, E));
  }

  // A path that exists under NEITHER base must still be refused — the two-base fallback widens
  // which spellings are understood, not which claims pass.
  {
    const F = seedCandidate(SID, { title: 'containment: nonexistent under both bases' });
    const r3 = await runFrom(sub, [`${F}=documented:docs/development/NO-SUCH-DOC.md`]);
    check('a path missing under both bases is REFUSED', r3.status !== 0, `exit=${r3.status}`);
    check('...and the refusal names both bases tried, so the agent can tell WHICH is wrong',
      /tried .* and /.test((r3.stdout || '') + (r3.stderr || '')), ((r3.stdout || '') + (r3.stderr || '')).slice(0, 300));
    check('...and the candidate survives', isPending(SID, F));

    /**
     * A TYPO MUST NOT BE DIAGNOSED AS A SIBLING WORKTREE. With two bases one can escape the tree
     * while the other is inside-and-missing; the escape used to win the diagnosis, so a plain typo
     * was answered with "you are probably pointing at a sibling worktree". The agent believes that
     * and goes looking for the wrong problem.
     */
    const G = seedCandidate(SID, { title: 'containment: typo inside the tree, from a subdirectory' });
    const rG = await runFrom(sub, [`${G}=documented:../docs/NO-SUCH-TYPO.md`]);
    const outG = (rG.stdout || '') + (rG.stderr || '');
    check('a typo under the repo root is REFUSED', rG.status !== 0, `exit=${rG.status}`);
    check('...and is NOT diagnosed as a sibling worktree', !/sibling worktree/.test(outG), outG.slice(0, 300));
    check('...it is diagnosed as missing', /does not exist/.test(outG), outG.slice(0, 300));

    /**
     * THE RECORDED NOTE IS THE RESOLVED PATH, NOT THE SPELLING. A disposition is permanent; a bare
     * `../CLAUDE.md` in the queue cannot tell a later reader WHICH file was verified, and with two
     * bases and two same-named files that ambiguity is reachable.
     */
    const H = seedCandidate(SID, { title: 'containment: the resolved path is PERSISTED, not just printed' });
    const rH = await runFrom(sub, [`${H}=documented:../CLAUDE.md`]);
    const outH = (rH.stdout || '') + (rH.stderr || '');
    check('a cwd-relative citation still verifies', rH.status === 0, `exit=${rH.status} ${outH.slice(0, 200)}`);
    /**
     * ASSERT THE RECORD, NOT STDOUT — the first version of this check read `rH.stdout` while its
     * own name said "recorded". `resolved` is what the RECORD carries now (the primary write, as
     * of B2); the local file backup mirrors it but is no longer the thing that matters here.
     */
    const recH = [...server.store.values()].find((r) => r.typeName === 'candidate' && r.payload.title === 'containment: the resolved path is PERSISTED, not just printed');
    check('the RECORD carries the resolved root-relative path', recH.payload.resolved === 'CLAUDE.md',
      `resolved=${JSON.stringify(recH.payload.resolved)} ref=${JSON.stringify(recH.payload.ref)}`);
    check('...while still keeping what the agent actually typed', recH.payload.ref === '../CLAUDE.md',
      JSON.stringify(recH.payload));
    // The local backup file has SOME dispose event too — the durability copy this call also wrote.
    const raw = fs.readFileSync(queuePath(SID), 'utf8');
    check('the local backup file also has a dispose event on record', raw.includes('"op":"dispose"'));
  }

  /**
   * THE TRUE POSITIVE, which the typo fix broke and no test covered. The only sibling-repo case
   * in this file runs from OUTSIDE any repo, so it returns at the `!root` guard and never reaches
   * the diagnosis at all. From a subdirectory, with two bases, a REAL sibling path must still be
   * told what it is.
   */
  const S = seedCandidate(SID, { title: 'containment: a REAL sibling-repo path from a subdirectory' });
  const sibling = path.join(path.dirname(FAKE_REPO), path.basename(FAKE_REPO) + '-probe-sibling');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'PROBE.md'), '# probe');
  try {
    /**
     * ONE `../`, NOT TWO — and the first draft used two, which made this test VACUOUS: with
     * `../../` both bases land outside the tree, so the OLD logic diagnosed it correctly too and
     * the RED-proof stayed green. The defect only appears when one base is inside and the other
     * escapes: from `platform/`, `../X` resolves to `<repo>/X` (inside, missing) under the cwd
     * base and to `<sibling>/X` (outside, EXISTING) under the root base. That is the shape the fix
     * exists for, and it is the shape a real sibling-repo citation actually has.
     */
    const rS = await runFrom(sub, [`${S}=documented:../${path.basename(sibling)}/PROBE.md`]);
    const outS = (rS.stdout || '') + (rS.stderr || '');
    check('a real sibling-repo citation is REFUSED', rS.status !== 0, `exit=${rS.status}`);
    check('...and is diagnosed as OUTSIDE the worktree, not as a typo',
      /OUTSIDE this worktree/.test(outS), outS.slice(0, 300));
    check('...and the candidate survives', isPending(SID, S));
  } finally {
    try { fs.rmSync(sibling, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /**
   * A DIRECTORY IS NOT A DOCUMENT. Both of these permanently settled a candidate against something
   * that documents nothing, and the anchored form skipped the anchor check entirely (EISDIR was
   * swallowed by the read's catch).
   */
  const DIR1 = seedCandidate(SID, { title: 'containment: a bare directory' });
  const rD1 = await run(`${DIR1}=documented:docs/development (a directory)`, [`${DIR1}=documented:docs/development`], 1, FAKE_REPO);
  check('a directory is REFUSED as a citation', isPending(SID, DIR1),
    ((rD1.stdout || '') + (rD1.stderr || '')).slice(0, 200));
  const DIR2 = seedCandidate(SID, { title: 'containment: the repo root itself' });
  await run(`${DIR2}=documented:. (the root)`, [`${DIR2}=documented:.`], 1, FAKE_REPO);
  check('`documented:.` is REFUSED', isPending(SID, DIR2));

  // THE FALSE-ACCEPTANCE CASE. From OUTSIDE any worktree, a sibling repo's path must not pass.
  const D = seedCandidate(SID, { title: 'containment: sibling repo from outside' });
  const outside = path.dirname(FAKE_REPO); // the OS temp dir — the parent of every fixture repo this file builds
  const rel = path.basename(FAKE_REPO) + '/CLAUDE.md';
  const r2 = await runFrom(outside, [`${D}=documented:${rel}`]);
  check('run from outside any worktree, a sibling path is REFUSED (no root ⇒ no gate ⇒ refuse)',
    r2.status !== 0, `exit=${r2.status} ${((r2.stdout || '') + (r2.stderr || '')).slice(0, 300)}`);
  check('...and the candidate survives', isPending(SID, D));
}

console.log('\n=== `resolved` is recorded on EVERY disposition path, not just `documented` ===');
{
  /**
   * The field was tested only through `documented:`, while its specification names record ids too.
   * Each path writes a different SHAPE — a path, a record phrase, a coverage phrase — and a reader
   * of the permanent record must be able to tell which. Assert against the RECORD (the primary
   * write, as of B2) per path rather than assuming one format.
   */
  const payloadFor = (title) => [...server.store.values()]
    .find((r) => r.typeName === 'candidate' && r.payload.title === title)?.payload || {};

  const K = seedCandidate(SID, { title: 'resolved: covered-by-a-section' });
  await run(`${K}=ignored:covered:§65`, [`${K}=ignored:covered:§65`], 0, FAKE_REPO);
  const evK = payloadFor('resolved: covered-by-a-section');
  check('ignored:covered records WHAT it verified, not just the raw citation',
    typeof evK.resolved === 'string' && /65/.test(evK.resolved), JSON.stringify(evK));

  const L = seedCandidate(SID, { title: 'resolved: a bare ignored has nothing to resolve' });
  await run(`${L}=ignored:not durable`, [`${L}=ignored:not durable`], 0);
  const evL = payloadFor('resolved: a bare ignored has nothing to resolve');
  check('a bare `ignored` records ref only — nothing was verified, so nothing is claimed',
    evL.resolved === null || evL.resolved === undefined, JSON.stringify(evL));
}

console.log('\n=== RED-PROOF: --list renders candidate fields through field(), not raw ===');
{
  // Same bug class as hit.mjs's untrusted metadata (found in the same public-readiness pass): a candidate's
  // title/body/kind/sourceRef is model-authored with no length bound, and this CLI's --list used
  // to print it verbatim. A raw newline in `title` would visually splice one candidate's listing
  // into the next; an unbounded body would flood the terminal on a pathological proposal.
  // `body` already had a partial defense before this fix (`.replace(/\s+/g, ' ')` collapsed its
  // whitespace, just without a length cap) — so it's not a useful red-test target. `title`/`kind`/
  // `dest`/`sourceRef` had NONE at all (raw template interpolation), which is the actual gap this
  // fix closes. Target those.
  const DIRTY_SID = 'dispose-test-dirty-0001';
  const DIRTY_QP = queueFor(DIRTY_SID);
  try { fs.unlinkSync(DIRTY_QP); } catch {}
  seedCandidate(DIRTY_SID, {
    title: 'line one\nFAKE CANDIDATE d99  [forged -> memory]  injected by a hostile title',
    body: 'ordinary body text',
    kind: 'observation\nFAKE kind-line', dest: 'memory',
    sourceRef: 'path.md\nFAKE sourceRef-line',
  });
  const r = await spawnAsync([path.join(DIR, 'dispose.mjs'), DIRTY_SID, '--list'], { cwd: REPO, timeout: 30000, env: ENV });
  console.log('\n--- --list on a hostile candidate');
  console.log(`    exit=${r.status}`);
  const out = (r.stdout || '');
  check('no raw newline reaches stdout from title', !/line one\nFAKE CANDIDATE/.test(out), out.slice(0, 200));
  check('no raw newline reaches stdout from kind', !/observation\nFAKE kind-line/.test(out), out.slice(0, 200));
  check('no raw newline reaches stdout from sourceRef', !/path\.md\nFAKE sourceRef-line/.test(out), out.slice(0, 400));
  try { fs.unlinkSync(DIRTY_QP); } catch {}
}

console.log('\n=== PAGINATION: a corpus larger than one page is not silently truncated ===');
{
  /**
   * The candidate client used to send `cursor`, but `/v1/records/lookup` calls the resume field
   * `startFrom` and rejects unknown keys — so every lookup past page 1 400'd. This fake server's
   * own `nextCursor` used to be hardcoded `null` (see fake-records-server.mjs), so no test running
   * through the REAL subprocess could ever reach page 2 to notice the wrong field name — the fake
   * itself made the defect invisible. Force a genuine multi-page walk through the real subprocess +
   * real HTTP fake, the same code path a live corpus over `CANDIDATE_PAGE_LIMIT` takes.
   */
  const PAGE_SID = 'dispose-test-pagination-0001';
  const PAGE_QP = queueFor(PAGE_SID);
  try { fs.unlinkSync(PAGE_QP); } catch {}
  const N = 5;
  for (let i = 0; i < N; i++) seedCandidate(PAGE_SID, { title: `page candidate ${i}` });
  // A page size well under N forces several round trips, each carrying the previous page's cursor —
  // a client that still sent `cursor` instead of `startFrom` would 400 on the second request.
  const pagedEnv = { ...ENV, VECTROS_MEM_CANDIDATE_PAGE_LIMIT: '2' };
  const r = await spawnAsync([path.join(DIR, 'dispose.mjs'), PAGE_SID, '--list'], { cwd: REPO, timeout: 30000, env: pagedEnv });
  const out = (r.stdout || '') + (r.stderr || '');
  check('a multi-page lookup exits clean', r.status === 0, `exit=${r.status}: ${out.slice(0, 300)}`);
  check(`...and lists all ${N} candidates, not just the first page`,
    out.includes(`${N} pending candidate(s) for ${PAGE_SID}`), out.slice(0, 300));
  check('...never reporting RECORDS UNREACHABLE', !/RECORDS UNREACHABLE/.test(out), out.slice(0, 300));
  try { fs.unlinkSync(PAGE_QP); } catch {}
}

console.log('\n=== RECORDS UNREACHABLE: dispose refuses outright rather than guessing an address ===');
{
  // A bogus base URL that will never answer — the same "unrunnable, not empty" contract
  // candidates.mjs's own header describes, exercised end-to-end through the real subprocess. This
  // one is genuinely a DIFFERENT (unreachable, refusing) endpoint, not this process's own server,
  // so there is no deadlock risk here even with the old spawnSync — kept as spawnAsync anyway for
  // consistency and because a hung connect() would otherwise burn the full 30s child timeout.
  const badEnv = { ...ENV, VECTROS_API_BASE_URL: 'http://127.0.0.1:1' };
  const r = await spawnAsync([path.join(DIR, 'dispose.mjs'), SID, '--list'], { cwd: REPO, timeout: 30000, env: badEnv });
  check('--list against unreachable records exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('...and says RECORDS UNREACHABLE, not "no pending candidates"',
    /RECORDS UNREACHABLE/.test((r.stdout || '') + (r.stderr || '')), ((r.stdout || '') + (r.stderr || '')).slice(0, 300));
  const r2 = await spawnAsync([path.join(DIR, 'dispose.mjs'), SID, 'c1=ignored:whatever'], { cwd: REPO, timeout: 30000, env: badEnv });
  check('settling against unreachable records exits non-zero and writes nothing', r2.status !== 0, `exit=${r2.status}`);
}

console.log('\n=== final state ===');
check('the refused candidate is still pending; the settled ones are gone',
  isPending(SID, 'c1') && !isPending(SID, 'c2'),
  `pending=${pendingLocal(SID).map((c) => c.ordinal).join(',')}`);

try { fs.unlinkSync(QP); } catch {}
await server.close();
console.log('\ndone');

done();
