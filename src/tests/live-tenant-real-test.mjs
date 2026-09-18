// RED-PROOF, AGAINST REAL VECTROS INFRASTRUCTURE: the ONE thing every other test in this suite
// deliberately does not exercise — that propose -> settle -> read-back actually round-trips over
// the real wire, against a real (test) tenant, through the real shipped dispose.mjs binary.
//
// ⚠ TWO INDEPENDENT GATES, NEITHER OPTIONAL, BOTH MUST PASS BEFORE THIS FILE TOUCHES ANYTHING:
//
//   1. `-real-test.mjs` NAMING — excluded from `run-all.mjs`'s default run; needs `--all` or
//      `VECTROS_MEM_TEST_ALL=1`. Same convention as `drain-real-test.mjs`/`triage-real-test.mjs`.
//      This alone answers "am I willing to spend real time/cost on infra tests" — it says NOTHING
//      about whether a live Vectros tenant is even configured, let alone a SAFE one.
//
//   2. `VECTROS_MEM_TEST_LIVE_ALIAS` — a keyring alias this harness resolves ITSELF, deliberately
//      NOT `VECTROS_KEYRING_ALIAS` (which is what PINS normal hook operation — reusing it here
//      would mean "whatever the operator's daily-use hooks are pointed at" satisfies this gate,
//      which is backwards: a test harness must never trust the same ambient signal that a real,
//      live incident proved can silently point at the wrong tenant — see creds.mjs's own header).
//      Unset -> SKIP loudly (the default, everywhere including CI) unless
//      `VECTROS_REQUIRE_LIVE_TESTS=1` also asks for a hard failure instead.
//
// ⚠ A THIRD GATE THAT IS NOT AN ENV VAR: the resolved secret's own SHAPE. `ssk_test_*` only — a
// `ssk_live_*` (or any non-test-shaped) secret is REFUSED outright, regardless of what alias was
// configured. This is that same incident's lesson turned into code: an operator can misconfigure
// an alias name; the secret's shape is what the platform itself asserts, and this harness trusts
// THAT, not a name a human typed.
//
// Everything this file writes is clearly marked (`[live-tenant-real-test]` in the title) and
// settled by the end of the run — a test tenant accumulating a few harmless, disposed, clearly-
// labeled records is the expected, fine steady state of actually using one for what it's for.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ — derived
const ALIAS = (process.env.VECTROS_MEM_TEST_LIVE_ALIAS || '').trim();
const REQUIRE = process.env.VECTROS_REQUIRE_LIVE_TESTS === '1';

if (!ALIAS) {
  if (REQUIRE) {
    throw new Error('VECTROS_REQUIRE_LIVE_TESTS=1 but VECTROS_MEM_TEST_LIVE_ALIAS is not set — '
      + 'refusing to skip the live-tenant round trip. Point it at a keyring alias for a TEST '
      + 'tenant (e.g. `vectros bootstrap --blueprint agentic-sdlc --tenant test` mints one).');
  }
  console.log('SKIPPED (all cases): VECTROS_MEM_TEST_LIVE_ALIAS is not set — this is the default, '
    + 'everywhere, including CI. Opt in with a keyring alias for a TEST tenant you own; set '
    + 'VECTROS_REQUIRE_LIVE_TESTS=1 in a job that must fail loudly instead of skipping.');
  check('this is a real skip, not a vacuous pass — VECTROS_REQUIRE_LIVE_TESTS was not set either', !REQUIRE);
  done();
} else {
  await runLiveRoundTrip();
}

async function runLiveRoundTrip() {
  /**
   * Resolve the alias's OWN secret directly — not via `cred()` (which would read
   * `VECTROS_KEYRING_ALIAS`/the ambient active identity first, exactly the indirection this file
   * exists to bypass). `--alias` pins it to precisely the identity this run asked for, no matter
   * what else is active on the machine right now.
   */
  const isWindows = process.platform === 'win32';
  let secret;
  try {
    secret = execFileSync('vectros', ['keyring', 'show', '--format', 'raw', '--alias', ALIAS], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, shell: isWindows,
    }).trim();
  } catch (e) {
    const msg = `could not resolve VECTROS_MEM_TEST_LIVE_ALIAS='${ALIAS}' via \`vectros keyring `
      + `show --alias ${ALIAS}\` (${e && e.message}). Is @vectros-ai/cli installed, and does this `
      + `alias exist (\`vectros keyring list\`)?`;
    if (REQUIRE) throw new Error(msg);
    console.log(`SKIPPED (all cases): ${msg}`);
    return done();
  }

  const TEST_SECRET_RE = /^(?:ssk|sk|st)_test_/i;
  if (!TEST_SECRET_RE.test(secret)) {
    // NOT an opt-out — a live-shaped secret here is refused unconditionally. Loud, not silent:
    // this is exactly the misconfiguration a real, live incident already was once (see creds.mjs's
    // header), and staying quiet about it would repeat it.
    throw new Error(`REFUSING TO PROCEED: VECTROS_MEM_TEST_LIVE_ALIAS='${ALIAS}' resolved to a `
      + `secret that is NOT test-shaped (expected ssk_test_*/sk_test_*/st_test_*). This harness `
      + `only ever writes to a tenant whose OWN credential says "test" — an alias name alone is `
      + `not enough to trust. Point VECTROS_MEM_TEST_LIVE_ALIAS at a genuine test-tenant `
      + `alias, e.g. one minted by \`vectros bootstrap --blueprint agentic-sdlc --tenant test\`.`);
  }

  /**
   * A SECOND, INDEPENDENT signal, deliberately — the secret's own prefix (checked above) and the
   * CLI's own bookkeeping (`keyring doctor`'s `tenant` field, populated at mint time from
   * `--tenant`) come from two different places and could in principle disagree (a corrupted
   * keyring index, a future CLI version that changes either encoding). One signal saying "test" is
   * not being trusted alone here — BOTH must agree, or this refuses exactly like a single bad
   * signal would. (`keyring list --json` does NOT carry `tenant` — only `env` (staging/production,
   * a different axis entirely); `doctor --json` is the one that does — confirmed against the real
   * CLI, not assumed.)
   */
  let cliTenant;
  try {
    const isWindowsList = process.platform === 'win32';
    let doctorOut;
    try {
      doctorOut = execFileSync('vectros', ['keyring', 'doctor', '--json'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true, shell: isWindowsList,
      });
    } catch (e) {
      // `doctor` exits NON-ZERO whenever the OVERALL keyring is unhealthy (e.g. an unrelated
      // entry with an unreadable/unrecognised secret) — confirmed against the real CLI, not
      // assumed: it still writes valid, complete JSON to stdout in that case. execFileSync
      // throws on any non-zero exit, but the error it throws carries that stdout, so a health
      // problem elsewhere in the keyring must not stop THIS alias's own signal from being read.
      if (typeof e.stdout !== 'string' || !e.stdout.trim()) throw e;
      doctorOut = e.stdout;
    }
    const entry = JSON.parse(doctorOut).entries?.find((e) => e.alias === ALIAS);
    cliTenant = entry?.tenant;
  } catch (e) {
    throw new Error(`REFUSING TO PROCEED: could not independently confirm '${ALIAS}'s tenant via `
      + `\`vectros keyring doctor --json\` (${e && e.message}) — the secret-shape check alone `
      + `is not enough to proceed on (one signal is not trusted alone here).`);
  }
  if (cliTenant !== 'test') {
    throw new Error(`REFUSING TO PROCEED: the secret for '${ALIAS}' is test-shaped, but the CLI's `
      + `own keyring bookkeeping reports tenant='${cliTenant}', not 'test'. The two signals `
      + `disagree — refusing rather than trusting either alone.`);
  }
  console.log(`Resolved VECTROS_MEM_TEST_LIVE_ALIAS='${ALIAS}' -> secret is test-shaped AND the `
    + `CLI's own bookkeeping agrees (tenant='test'). Both signals confirmed. Proceeding.\n`);

  // Redirect the hooklog only — deliberately NOT importing isolate.mjs (which would also relocate
  // VECTROS_MEMORY_HOME and write VERDICT_MUTATIONS_OFF/SPOOL_OFF markers that block exactly the
  // real writes this file exists to make). Real infrastructure, on purpose, is the whole point.
  const hookLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tenant-real-test-log-'));
  const ENV = { ...process.env, VECTROS_API_KEY: secret, VECTROS_HOOKLOG_PATH: path.join(hookLogDir, 'hooks.log') };
  // `delete`, never `: undefined` — an undefined-valued env entry is stringified to the literal
  // text "undefined" by child_process, not dropped (the exact trap cli-set-token-test.mjs's own
  // header documents), which would be worse than leaving the ambient alias in: a child reading
  // VECTROS_KEYRING_ALIAS="undefined" fails ALIAS_RE and falls through to the active identity —
  // silently reintroducing the very thing this file exists to bypass.
  delete ENV.VECTROS_KEYRING_ALIAS;
  /**
   * ⚠ MUST ALSO CLEAR VECTROS_MEMORY_HOME — not caught by a test. When this file is run
   * the DOCUMENTED way (`npm test -- --all`, i.e. as a child of run-all.mjs), it inherits
   * run-all.mjs's OWN isolate.mjs call: an isolated VECTROS_MEMORY_HOME + a VERDICT_MUTATIONS_OFF
   * marker written into it, specifically so every OTHER test in the suite can't settle/reopen
   * against the real store. This file deliberately does not import isolate.mjs itself (comment
   * above) — but a bare `...process.env` spread still carries an INHERITED isolation through to
   * the spawned dispose.mjs child, silently defeating the settle step this file exists to prove
   * (dispose.mjs's own verdictMutationsDisabled() check would find the inherited marker and
   * refuse). A standalone `node live-tenant-real-test.mjs` run never hits this — VECTROS_MEMORY_HOME
   * is unset there, so it never manifested during authoring. Clearing it here restores the REAL
   * default runtime home regardless of how this file was invoked.
   */
  delete ENV.VECTROS_MEMORY_HOME;

  const mod = await import(pathToFileURL(path.join(DIR, 'candidates.mjs')).href);
  const { propose, bySession, addressablePending } = mod;

  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const SID = `live-tenant-real-test-${RUN_ID}`;
  const TITLE = `[live-tenant-real-test] round-trip probe ${RUN_ID}`;

  // candidates.mjs's own network calls read VECTROS_API_KEY/VECTROS_API_BASE_URL from THIS
  // process's env at call time (via creds.mjs's cred()) — so set them here too, not only in ENV
  // (which only reaches the spawned dispose.mjs child below). propose()/bySession()/
  // addressablePending() below don't touch VECTROS_MEMORY_HOME at all (records-only, no local
  // file queue involved), so THIS process's inherited value is harmless either way — only the
  // spawned dispose.mjs child (which also touches the local file backup) needed the ENV fix above.
  process.env.VECTROS_API_KEY = secret;
  delete process.env.VECTROS_KEYRING_ALIAS;

  console.log(`=== 1. propose() a clearly-marked candidate into the REAL tenant (session ${SID}) ===`);
  const created = await propose(SID, { title: TITLE, body: 'Written by live-tenant-real-test.mjs — safe to ignore/delete.', kind: 'observation', externalId: `${SID}:probe` });
  check('propose() returned a real record, not null (network/credential failure)', created !== null, created);
  if (created) {
    eq('the record echoes the title we sent', created.title, TITLE);
    eq('it starts pending, same as any real proposal', created.disposition, 'pending');
  }

  console.log('\n=== 2. bySession() reads it back — proves the record-store round trip, not just the write ack ===');
  const rows = await bySession(SID);
  check('bySession() did not fail (network/credential unreachable)', rows !== null, rows);
  const found = rows && rows.find((r) => r.title === TITLE);
  check('the proposed candidate is present with a stable ordinal', !!found && !!found.ordinal, found);

  console.log('\n=== 3. addressablePending() surfaces it — proves the ACTUAL nudge-read path works against real infra ===');
  const pending = await addressablePending(SID);
  check('addressablePending() did not fail', pending !== null, pending);
  check('the candidate is in the pending set', !!(pending && pending.some((c) => c.title === TITLE)));

  console.log('\n=== 4. settle it through the REAL, SHIPPED dispose.mjs binary — not candidates.mjs directly ===');
  const ordinal = found ? found.ordinal : null;
  let disposeExit = null;
  if (ordinal) {
    disposeExit = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(DIR, 'dispose.mjs'), SID, `${ordinal}=ignored:live-tenant-real-test.mjs cleanup — safe to ignore`], { env: ENV });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      const t = setTimeout(() => child.kill(), 20000);
      child.on('close', (status) => { clearTimeout(t); resolve({ status, out }); });
    });
    check('dispose.mjs exits 0 settling it', disposeExit.status === 0, disposeExit.out);
  } else {
    check('dispose.mjs settle (SKIPPED — no ordinal resolved above)', false, 'cannot settle without step 2 succeeding');
  }

  console.log('\n=== 5. bySession() AGAIN — proves the settle ACTUALLY reached the record, not just the local file ===');
  const rowsAfter = await bySession(SID);
  const foundAfter = rowsAfter && rowsAfter.find((r) => r.externalId === `${SID}:probe`);
  check('the record is readable after settling', !!foundAfter, foundAfter);
  const settledOnRecord = !!foundAfter && foundAfter.disposition === 'ignored';
  if (foundAfter) {
    eq('the disposition on the RECORD itself flipped to ignored — not just the local file', foundAfter.disposition, 'ignored');
  }

  // NOT unconditional — a prior version of this line printed regardless of outcome, which read as
  // a false all-clear on exactly the runs where settling had actually failed.
  console.log(settledOnRecord
    ? `\n(live tenant: alias='${ALIAS}', session='${SID}' — this run's own record is now settled and harmless to leave)`
    : `\n(live tenant: alias='${ALIAS}', session='${SID}' — settling did NOT confirm above; this probe may still be pending in the test tenant)`);
  done();
}
