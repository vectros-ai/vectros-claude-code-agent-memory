/**
 * HERMETIC RUNTIME ROOT for the suite. Import this FIRST in any test that touches runtime state.
 *
 * WHY IT EXISTS — a real failure, not a precaution. `orient-boundary-test.mjs` case 2c asserts that
 * an empty pinned tier plus an empty store injects NOTHING. It failed on the author's machine with
 * `ctx was 3689c`, and the 3689 characters were real: `nudge.mjs`'s cross-session orphan block had
 * found a genuine orphaned queue belonging to a genuine OTHER session, sitting in the single shared
 * `~/.claude/vectros-memory/queue/` that no test could point away from. The test was correct, the
 * code was correct, and the run was red — because the suite and the live runtime shared one
 * directory. Its own precondition caught it and printed the byte count, which is the only reason
 * this was a loud failure rather than a silently wrong assertion.
 *
 * Two consequences beyond that one case:
 *   · Any test that writes `WORKERS_OFF` was writing the operator's real kill switch, and removing
 *     it in teardown re-enabled workers whether or not the operator had turned them off.
 *   · The reaper DELETES from `state/`. It cannot be exercised against a directory holding the
 *     author's 5,779 live state files.
 *
 * HOW. `paths.mjs` derives every path from `VECTROS_MEMORY_HOME` through FUNCTIONS resolved per
 * call, not module constants — so setting the variable here, in an import that evaluates before the
 * importing module's body, relocates the whole runtime for this process and every child it spawns
 * (every spawn site in this suite spreads `process.env`). That per-call resolution is the property
 * this file depends on; a memoized root would already have been read by the time we got here.
 *
 * CREDENTIALS STAY REAL, AND THE ORDER MATTERS. `credentialsFile()` resolves UNDER the root, so
 * relocating the root would move the real `credentials.json` out from under the `*-real-test.mjs`
 * files that make live Haiku and Vectros calls — they would fail to authenticate and, being
 * fail-open, would report a green vacuous pass rather than an error. So the real path is captured
 * and pinned to `VECTROS_HOOK_CREDENTIALS` BEFORE the root moves. State is isolated; the credential
 * is not state.
 *
 * IDEMPOTENT AND DEFERENTIAL. If `VECTROS_MEMORY_HOME` is already set, an outer harness
 * (`run-all.mjs`, or an operator debugging against a specific root) owns it and nothing here fires.
 * That is what lets one temp root span a whole suite run while a standalone `node tests/x-test.mjs`
 * still gets its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialsFile, memoryHome } from '../paths.mjs';

/** The isolated root in effect for this process, real or inherited. Exported for receipts. */
export let ISOLATED_ROOT = memoryHome();

if (!process.env.VECTROS_MEMORY_HOME?.trim()) {
  // Capture BEFORE the move — see the header. `||=` so an explicit override still wins.
  process.env.VECTROS_HOOK_CREDENTIALS ||= credentialsFile();

  ISOLATED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vectros-mem-test-'));
  process.env.VECTROS_MEMORY_HOME = ISOLATED_ROOT;

  // Keep the log inside the isolated root by default, so a standalone run leaves the production
  // log untouched without each file repeating the redirect. → hooklog.mjs § TEST-MODE REDIRECT.
  if (!process.env.VECTROS_HOOKLOG_PATH?.trim()) {
    process.env.VECTROS_HOOKLOG_PATH = path.join(ISOLATED_ROOT, 'hooks.log');
  }

  /**
   * ⚠ NO TEST MAY PROMOTE A SPOOLED PROPOSAL TO A REAL RECORD.
   *
   * Credentials are deliberately NOT isolated (the `*-real-test.mjs` files need the real ones), and
   * `capture-worker` now ends every run with an unconditional `drainAll`. Those two facts together
   * mean a suite run that leaves an owed spool entry behind and then spawns the worker would POST
   * candidate records to the OWNER'S REAL STORE with the owner's real key. Today it is latent only
   * because two test files happen to clean up and happen to sort in a helpful order — one rename
   * away from firing, and `run-all.mjs --all` drives a real distiller that genuinely spools.
   *
   * The marker makes it structural instead of incidental. Spooling still works and is still
   * asserted; only the network promotion is off, which is the half no test needs.
   */
  fs.mkdirSync(ISOLATED_ROOT, { recursive: true });
  fs.writeFileSync(path.join(ISOLATED_ROOT, 'SPOOL_OFF'),
    'written by tests/isolate.mjs — no test may promote a spooled proposal to a real record\n');
  /**
   * ⚠ NO TEST MAY SETTLE, REOPEN, OR SUPERSEDE A CANDIDATE AGAINST THE REAL STORE, either.
   * `SPOOL_OFF`'s sibling: `candidates.mjs`'s `settle`/`reopen`/`markSuperseded` reach the live
   * store the same way `flush`/`drainAll` do, and credentials are real here for the same reason
   * (the `*-real-test.mjs` files need them) — so the same structural gate applies, not just the
   * write path. `candidates-test.mjs` is the one file that opts back in, the same way
   * `spool-test.mjs` opts back into `SPOOL_OFF`.
   */
  fs.writeFileSync(path.join(ISOLATED_ROOT, 'VERDICT_MUTATIONS_OFF'),
    'written by tests/isolate.mjs — no test may settle/reopen/supersede a candidate against the real store\n');

  /**
   * ⚠ MEMORY.md IS NOT UNDER THE ROOT, AND THIS IS THE HOLE THAT MATTERED MOST (review finding,
   * 2026-07-29).
   *
   * `VECTROS_MEMORY_HOME` relocates everything `paths.mjs` derives — but `project.mjs` writes the
   * PINNED BLOCK into `~/.claude/projects/<repo-slug>/memory/MEMORY.md`, which hangs off
   * `claudeHome()`, not off our root, because it belongs to Claude Code rather than to us. It is
   * also the single most valuable file the runtime touches: it is auto-loaded into every session.
   *
   * The suite reaches it. `smoke.mjs` and `queue-test.mjs` spawn `capture.mjs`, and
   * `capture.mjs` § "The PROJECTION below is deliberately NOT gated" spawns `project.mjs` detached
   * with the full inherited env — including the REAL `VECTROS_API_KEY` this file pins two lines up.
   * So the projector fetched the real pinned set and rewrote the operator's real MEMORY.md.
   *
   * AND RELOCATING THE ROOT MADE IT STRICTLY WORSE, TWICE OVER:
   *   · `doProject` is `now - (lastProjectAt || 0) >= PROJECT_DEBOUNCE_MS`. Against the old shared
   *     root the test SID's state persisted `lastProjectAt`, so re-runs inside ten minutes skipped
   *     the projector. With a fresh temp root every run the field is always absent, so the
   *     projection now fires on EVERY suite run.
   *   · `QUARANTINE_DIR` — where the projector preserves a hand-edited pinned block before
   *     overwriting it — IS under the root, so it moved into the throwaway temp dir. Isolation
   *     relocated the safety net and left the thing it protects.
   *
   * `project.mjs` has carried a `VECTROS_MEMORY_INDEX` escape hatch labelled "tests" all along; it
   * simply was never wired. The file is created empty so the projector has a real target — it only
   * ever writes to a path that already exists.
   */
  if (!process.env.VECTROS_MEMORY_INDEX?.trim()) {
    const idx = path.join(ISOLATED_ROOT, 'MEMORY.md');
    fs.writeFileSync(idx, '# isolated test MEMORY.md — the real one lives under ~/.claude/projects/\n');
    process.env.VECTROS_MEMORY_INDEX = idx;
  }
}

/**
 * A SECOND, PRIVATE root, for a test file that needs to be the only one scanning its own
 * directory tree (several tests enumerate `queue/`/`state/`/`spool/` wholesale, and the ordinary
 * suite-shared `ISOLATED_ROOT` above holds every sibling test file's own fixtures too).
 *
 * REPEATS the two structural safety markers above (`SPOOL_OFF`, `VERDICT_MUTATIONS_OFF`) into the
 * NEW root — found missing by review, 2026-08-17: several test files were moving
 * `VECTROS_MEMORY_HOME` to their own `fs.mkdtempSync` root by hand, AFTER this module's own import
 * had already written those markers into the FIRST (shared) root. The new root inherited neither
 * marker, so the structural gate against a real network write was silently absent for every one of
 * those files — safe only by accident (nothing in them happened to reach a gated call), exactly the
 * "incidentally safe, not structurally safe" shape `SPOOL_OFF`/`VERDICT_MUTATIONS_OFF` exist to
 * rule out in the first place. Use this instead of hand-rolling the `mkdtempSync` + env-var-set.
 *
 * A caller that genuinely needs real mutations against its own fake server (settling/reopening a
 * candidate, spooling and draining) unlinks `VERDICT_MUTATIONS_OFF`/`SPOOL_OFF` afterward, same as
 * `candidates-test.mjs`/`spool-test.mjs` already opt back in against the shared root.
 */
export function privateRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-root-`));
  process.env.VECTROS_MEMORY_HOME = root;
  fs.writeFileSync(path.join(root, 'SPOOL_OFF'),
    'written by tests/isolate.mjs privateRoot() — no test may promote a spooled proposal to a real record\n');
  fs.writeFileSync(path.join(root, 'VERDICT_MUTATIONS_OFF'),
    'written by tests/isolate.mjs privateRoot() — no test may settle/reopen/supersede a candidate against the real store\n');
  return root;
}
