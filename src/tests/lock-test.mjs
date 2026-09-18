#!/usr/bin/env node
/**
 * THE WORKER LOCK — claim/release, and the two facts that must not be one.
 *
 * WHY THIS EXISTS. The lock carries the concurrency invariant for the whole capture path and had
 * ZERO tests, because it was ~25 lines inline in a hook that runs `main()` on import: exercising it
 * meant standing up a 100K transcript and a real spawn. So it was never exercised, and the bug
 * that was there was found by READING. Extracting it to `lock.mjs` is what made these five cases
 * expressible; that is the whole reason for the seam.
 *
 * WHAT IT NO LONGER PROTECTS, and read this before valuing any of it. The lock existed because a
 * duplicate worker was DATA LOSS: `nextId(all)` minted candidate ids by folding the queue, so two
 * workers on one snapshot both produced `c1` and the fold's last-write-wins destroyed one. That
 * allocator is GONE — ids are positional, assigned by `queue.mjs`'s fold from the log's own order,
 * so a collision is unrepresentable (→ `queue-test.mjs` § the duplicate-worker race). A duplicate
 * worker now costs SPEND, not candidates. The lock is a cost guard; it is not load-bearing for
 * correctness, and this file should not be read as though it were.
 *
 * THE `owned` SPLIT — hygiene, and honest about it. `claimed` answered both "may I spawn?" and "do
 * I hold the lock?"; on a non-EEXIST claim failure it was set true (a deliberate fail-open) and
 * that same true authorized `unlinkSync`, releasing a lock this process never took. This is
 * justified as a live Windows hazard, but **that has never actually been measured, and this file
 * still does not measure it** — see 4c, which states the case UNMEASURED and says why `node:fs`
 * cannot reach it. (A header asserting a measurement its own file does not contain is exactly the
 * failure mode 4c below exists to call out — this paragraph is not exempt from that standard just
 * because it names it.) The split is kept because it costs
 * one variable and the two facts differ; whether its trigger is reachable is OPEN. The real defect
 * on that path was silence.
 *
 * COVERED: the two claim outcomes (1 success, 2/4b EEXIST — the fail-open branch is unreachable
 * from node:fs, see 4c), the three release outcomes (3 — where the actual
 * invariant lives), the platform contract the design rests on (4a/4b/4c), the stale-clear handoff
 * (5). NOT covered, deliberately and out loud: a real ENOSPC/EMFILE claim failure, which would need
 * `fs` stubbed — testing a paraphrase of the pipeline rather than the pipeline (a real-graph validation, not a paraphrase).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check, eq, done } from './assert.mjs';
import './isolate.mjs';   // reaches config.mjs transitively — unisolated it read the operator's live config
import { claim, release, isHeld, STALE_MS } from '../lock.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
const SID = 'lock-test-0001';
const lockAt = (n) => path.join(TMP, n, 'x.lock');
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* nothing there */ } };

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 1. clean claim -> proceed AND owned; the lock exists and holds our pid ===');
const L1 = lockAt('clean');
const r1 = claim(L1, SID);
eq('a clean claim proceeds', r1.proceed, true);
eq('a clean claim OWNS the lock', r1.owned, true);
check('the lock file was actually created', fs.existsSync(L1));
eq('and it holds the claimant pid', fs.readFileSync(L1, 'utf8'), String(process.pid));
check('the parent dir was created for us', fs.existsSync(path.dirname(L1)));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. EEXIST -> do NOT proceed, do NOT own, and do not touch the holder ===');
const r2 = claim(L1, SID); // same path, still held by case 1
eq('a lost race does NOT proceed', r2.proceed, false);
eq('a lost race does NOT own', r2.owned, false);
check('the incumbent lock is untouched', fs.existsSync(L1));
eq('and still holds the ORIGINAL pid — we did not overwrite it', fs.readFileSync(L1, 'utf8'), String(process.pid));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. release: owned -> frees; NOT owned -> leaves it alone (THE BUG) ===');
eq('release(owned=false) does NOT free — it is not ours', release(L1, false, SID), 'not-ours');
check('  ...and the lock is still there', fs.existsSync(L1),
  'the lock was deleted by a process that never claimed it — THIS IS THE BUG');
eq('release(owned=true) frees', release(L1, true, SID), 'released');
check('  ...and the lock is gone', !fs.existsSync(L1));

/**
 * THREE states, not a boolean — and this is the assertion that proves why.
 *
 * `release` returned true/false, so "not ours, correctly untouched" and "OURS, and the release
 * FAILED" were the same value — and capture.mjs reported the second as "lock left alone (not
 * ours)". A receipt naming the wrong subject, about the one state that means WE wedged capture for
 * 30 minutes. These two lines are the only thing that can tell them apart.
 */
eq('an already-gone lock is RELEASED, not failed — absent IS the goal state', release(L1, true, SID), 'released');

/**
 * `check('the three states are distinct', new Set(['not-ours','released','failed']).size === 3)`
 * stood here. It is a fact about three hardcoded string literals: it never calls
 * `release`, never imports a thing, and passes if the module is deleted. A tautology wearing a
 * test's clothes — and it was standing in for the ONE state this file never produced, the state
 * `lock.mjs`'s own header calls *"we wedged capture for 30 minutes and nobody knows"*.
 *
 * So produce it. A DIRECTORY at the lock path cannot be `unlink`ed, which is a real `release`
 * failure from the real fs, on a lock we really "own".
 */
const LF = lockAt('releaseFails');
fs.mkdirSync(LF, { recursive: true });
const failed = release(LF, true, SID);
check('precondition: the release really did fail against the real fs (the path is still there)',
  fs.existsSync(LF), 'the directory was removed — this case proves nothing');
eq("THE STATE NOTHING ELSE PRODUCES: an owned lock we could not free reports 'failed', "
  + "not 'not-ours' — the boolean reported this as someone else's lock", failed, 'failed');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. WHAT `wx` ACTUALLY RAISES — the evidence, and the boundary of it.
 *
 * A `wx` claim against a file another process holds OPEN can, in principle, raise EPERM/EBUSY
 * rather than EEXIST. That claim is easy to assert and hard to actually measure: `claim()` writes
 * via `writeFileSync`, which opens AND closes, so no handle is ever held by THIS process's own
 * claim; a second-Node-process harness cannot produce a sharing violation either (libuv opens
 * FILE_SHARE_READ|WRITE|DELETE). A table that lists the held-open row as measured, without either
 * of those actually producing the condition, is asserting a measurement the test does not contain.
 *
 * MEASURED here, and this is all of it:
 *   4a  wx vs. an existing CLOSED file ....... EEXIST
 *   4b  wx vs. a directory .................. EEXIST   (so a directory cannot induce the fail-open)
 *
 * UNMEASURED, stated in 4c: the disputed held-open case. Not reachable from `node:fs`.
 *
 * The one thing that IS worth pinning: unlink of a file another process holds open SUCCEEDS on
 * Windows, so the guard's failing half is not hypothetical even though its trigger is.
 * ─────────────────────────────────────────────────────────────────────────────
 */
console.log('\n=== 4. the platform contract the fix rests on (measured, not assumed) ===');

// 4a — an existing, CLOSED file. `claim()` uses writeFileSync, which opens and closes, so this is
// the plain case. Nobody disputed it; it is here as the baseline the other two are read against.
const L4 = lockAt('contract');
claim(L4, SID);
let codeVsFile = null;
try { fs.writeFileSync(L4, 'other', { flag: 'wx' }); } catch (e) { codeVsFile = e.code; }
eq('wx against an existing CLOSED file raises EEXIST', codeVsFile, 'EEXIST');

// 4b — a DIRECTORY. This is what the first draft used to "induce" a non-EEXIST failure. It doesn't.
const L4d = lockAt('contractDir');
fs.mkdirSync(L4d, { recursive: true });
let codeVsDir = null;
try { fs.writeFileSync(L4d, 'x', { flag: 'wx' }); } catch (e) { codeVsDir = e.code; }
eq('wx against a DIRECTORY also raises EEXIST — it cannot induce the fail-open branch', codeVsDir, 'EEXIST');
eq('  ...so claim() correctly reads a directory as a lost race, not a fail-open',
  claim(L4d, SID).proceed, false);
release(L4, true, SID);

/**
 * 4c — THE DISPUTED CASE, and the only one that was ever in question: ANOTHER PROCESS, holding a
 * REAL OPEN HANDLE.
 *
 * This is the whole finding. 4a/4b measure only a closed file in one process — asserting that as a
 * measurement of the held-open case would be exactly the trap this file warns against elsewhere.
 * A test that pins the undisputed case and reports a verdict on the disputed one is worse than no
 * test: it launders an assumption into a fact.
 *
 * So: spawn a child, have it hold the handle open, and ask while it is still holding.
 */
/**
 * 4c — THE DISPUTED CASE IS **UNMEASURED**, deliberately. This comment is the deliverable.
 *
 * A harness stood here. It spawned a second Node process, had it hold the handle open, claimed with
 * `wx`, got EEXIST, and reported the question settled. It settled NOTHING: libuv opens with
 * FILE_SHARE_READ|WRITE|DELETE, so a second NODE process cannot produce a sharing violation — the
 * probe could only ever return the answer it assumed. A check that cannot fail is not evidence, and
 * dressing one as a measurement of the contested case is worse than leaving the case open: it
 * closes the question in the reader's mind while observing nothing.
 *
 * The realistic producers — a NON-Node holder (AV, indexer, backup) opening FILE_SHARE_NONE, or
 * delete-pending state (`unlink` while another handle is open) — are unreachable from `node:fs`.
 * So it is unmeasured here and unmeasured anywhere. `atomic.mjs` § CONTENDED is the counter-witness
 * that keeps it open: this platform DOES raise EPERM/EACCES/EBUSY when someone holds the target
 * open (56% of renames), for a different syscall, and nobody has shown `wx` is exempt.
 */
console.log('  --- 4c: THE DISPUTED CASE — deliberately UNMEASURED (see comment) ---');
const L4h = lockAt('heldOpen');
claim(L4h, SID);
const fdHeld = fs.openSync(L4h, 'r'); // a live handle — the most `node:fs` can actually hold
let unlinkedLive = false;
try { fs.unlinkSync(L4h); unlinkedLive = true; } catch { /* silence-ok: the check below IS the report of this outcome. */ }
fs.closeSync(fdHeld);
/**
 * The one thing here that IS pinned, and the reason the `owned` split stays: if the fail-open
 * branch is ever reachable, the delete lands. This observes the damage, not the trigger.
 */
check("PINNED: unlink of a file with a LIVE open handle succeeds — so the guard's failing half is real",
  unlinkedLive, 'unlink was refused — then the owned split defends against nothing on this platform');
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. isHeld: fresh -> held; stale -> cleared; absent -> free ===');
const L5 = lockAt('held');
claim(L5, SID);
eq('a fresh lock is HELD', isHeld(L5, SID), true);
// Backdate past the staleness window. mtime is the clock, so this is the real mechanism.
const old = new Date(Date.now() - STALE_MS - 60_000);
fs.utimesSync(L5, old, old);
eq('a STALE lock is not held', isHeld(L5, SID), false);
check('  ...and was cleared, so the next claim can proceed', !fs.existsSync(L5));
eq('an absent lock is free', isHeld(lockAt('nope'), SID), false);
check('  ...and stays absent (the ENOENT path must not create anything)', !fs.existsSync(lockAt('nope')));

/**
 * The stale-clear must be a real handoff, not just a delete: this is the wedge-recovery path, and
 * "cleared it" without "and the next worker got in" is half the invariant.
 */
const r5 = claim(L5, SID);
eq('after a stale clear, a fresh claim OWNS the lock', r5.owned, true);
release(L5, true, SID);

rm(TMP);
done();
