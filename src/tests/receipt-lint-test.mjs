#!/usr/bin/env node
/**
 * THE RECEIPT-DISCIPLINE ENFORCER — every fail-open catch must say what it did, checked mechanically.
 *
 * WHY THIS FILE EXISTS: this discipline needs a `run-all.mjs`, not another paragraph.
 *
 * Four censuses were opened against this codebase. Two closed permanently; two kept reverting to
 * instance-fixing. The split was not effort and it was not care:
 *
 *   | census              | closed? | had a mechanical enforcer? |
 *   |---------------------|---------|----------------------------|
 *   | assert.mjs 10/10    | YES     | yes — run-all.mjs          |
 *   | CONTENDED retry     | YES     | n/a — one module, one fix  |
 *   | queue.read() corrupt| no (2/4)| no                         |
 *   | receipt discipline         | no (2 open) | no                     |
 *
 * The two that closed are the two with a machine checking them. The two that stayed open were
 * handed over as a WRITTEN LIST WITH file:line — the strongest possible version of "write it down
 * forcefully" — and were still swept only where a test named the instance. Twice, inside this very
 * fix, only the site the test named got fixed, not the shape, and the next run named the next
 * site. Both times the TEST did the sweeping. Where no test existed, no sweep happened.
 *
 * That is the real claim, and it indicts prose as a control. So this is the control.
 *
 * THE RULE. Every `catch` block in the runtime hooks must do at least one of:
 *
 *   1. DISTINGUISH  — reference `.code` or `ENOENT` (absent is not the same as broken)
 *   2. LOG          — `hlog(...)` or `console.error/warn/log(...)`
 *   3. RETHROW      — `throw` (not fail-open at all)
 *   4. RECEIPT      — return a `state:` / `ok:` / `why:` field for the caller to honour
 *   5. DECLARE      — carry `silence-ok: <reason>` inside the block
 *
 * (5) is not a loophole, it is the point. this discipline permits silence — "missing → a safe default, quietly"
 * — and an earlier, narrower version of this rule was withdrawn on exactly that ground. A rule that
 * cannot express its legitimate exceptions gets disabled wholesale. So the exception must be written
 * at the site, must carry a reason, and is greppable forever:  grep -rn 'silence-ok' src/*.mjs
 *
 * WHY EVERY CATCH, and not the narrower rule tried earlier ("every `catch` that returns a
 * default"). Because the narrower rule MISSES THE CASE THAT MOTIVATED THIS RULE IN THE FIRST PLACE.
 * `loadCreds` was:
 *
 *     let file = {};
 *     try { ... file = parsed; } catch { /​* missing/unreadable/malformed → fail-open *​/ }
 *
 * The catch body is EMPTY — the default was established *before* the try. A lint scoped to catches
 * that return a default would have graded that file clean while the worst violation of this discipline in the
 * system sat inside it. It was found by reading the code, not by the narrower rule; encoding
 * that rule literally would have encoded the blind spot with it. An empty catch is the most
 * silent thing there is, so it needs a reason more than any other shape, not less.
 *
 * WHAT THIS FILE MUST NOT DO — and the reason it is built the way it is: a lint that silently skips
 * what it cannot parse would be the exact defect this file exists to catch, shipped as its own
 * remedy. So the scanner self-checks (braces must balance after blanking) and a file it cannot parse FAILS the run
 * rather than passing quietly. A checker that cannot observe what it claims is worse than none,
 * because it also confers confidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { blank } from './lintlib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE); // the runtime hooks — the things that ship and fail open

// `blank()` now lives in ./lintlib.mjs — undeclared-const-test.mjs needed it too, and a second
// copy would have been the exact census failure this discipline is about. Its history (the nested-template bug that
// made a flat scanner report a file it had entirely failed to read as clean) is documented there.

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Read a `{...}` block starting at `i`; returns the index just past its closing brace. */
function endOfBlock(b, i) {
  let depth = 0;
  for (; i < b.length; i++) {
    if (b[i] === '{') depth++;
    else if (b[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return i;
}

/**
 * Every catch body in `src`, as {start,end} offsets into the ORIGINAL source.
 *
 * TWO SHAPES, and missing the second one made this lint blind to the most silent construct in the
 * system. It used to handle only the statement form:
 *
 *     try { … } catch (e) { … }          // the `(e)` is optional, then a BLOCK
 *
 * so for `.catch(() => {})` it consumed `(() => {})` as that optional group, landed on `;`, failed
 * `b[i] !== '{'` and `continue`d — the handler was never counted, never classified, never printed.
 * SIX of them ship in this tree, every one of them the tail of a hook's `main()`:
 *
 *     main().catch(() => {});            // capture, evaluate, orient, recall, stop, recall-eval-worker
 *
 * That is the widest fail-open surface here by a distance. ANY throw anywhere in a hook's main()
 * lands there and is discarded — no injection, no state write, no log — which is indistinguishable
 * from a healthy quiet session. this discipline's founding story, unreachable by its own enforcer. And the tell
 * was in the tree: `recall-eval-worker.mjs:309` documents a bug this exact construct swallowed,
 * eleven lines above its own `main().catch(() => {})`.
 *
 * The self-test could not catch it either: all three red-proof fixtures were block form, so the
 * skipped shape was never exercised. `check('the scanner actually found catch blocks', total > 40)`
 * guards against scanning NOTHING — not against systematically skipping ONE shape. A count over a
 * corpus you silently filter is a coverage hole wearing a receipt that only proves the happy path.
 */
function catchBlocks(src) {
  const b = blank(src);
  const blocks = [];
  const re = /\bcatch\b/g;
  let m;
  while ((m = re.exec(b))) {
    let i = m.index + 5;
    while (i < b.length && /\s/.test(b[i])) i++;

    // ── Shape 2 FIRST: `.catch(<arrow>)` — the promise handler. Detect it by what follows the
    // parens, not by what precedes `catch`: a `.` before it is suggestive, not decisive.
    if (b[i] === '(') {
      const open = i;
      let d = 1; i++;
      while (i < b.length && d > 0) { if (b[i] === '(') d++; else if (b[i] === ')') d--; i++; }
      const close = i; // just past ')'
      let j = i;
      while (j < b.length && /\s/.test(b[j])) j++;
      if (b[j] !== '{') {
        // Not a try/catch clause. If the parens hold an ARROW, its body IS the handler body.
        const inner = b.slice(open + 1, close - 1);
        const arrow = inner.indexOf('=>');
        if (arrow === -1) continue; // `.catch(namedFn)` — nothing inline to read
        let k = open + 1 + arrow + 2;
        while (k < b.length && /\s/.test(b[k])) k++;
        if (b[k] === '{') blocks.push({ start: k, end: endOfBlock(b, k), line: lineOf(src, m.index) });
        // An EXPRESSION body (`.catch(e => null)`) has no braces: take the rest of the parens, so
        // it is classified rather than skipped.
        else blocks.push({ start: k, end: close - 1, line: lineOf(src, m.index) });
        continue;
      }
      i = j; // it was `catch (e) {` after all
    }

    // ── Shape 1: the statement form, `catch {` or `catch (e) {`.
    if (b[i] !== '{') continue;
    blocks.push({ start: i, end: endOfBlock(b, i), line: lineOf(src, m.index) });
  }
  return blocks;
}

/** The self-check: if blanking left unbalanced braces, this file is NOT safely scannable. */
function balanced(src) {
  const b = blank(src);
  let d = 0;
  for (const c of b) {
    if (c === '{') d++;
    else if (c === '}') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

const DISTINGUISHES = /\.code\b|ENOENT/;
/**
 * The receipt CHANNELS this codebase actually has. `hlog` is the shared one; `log()` is
 * project.mjs's own projection log; `noteSkip()` is report.mjs's blind-spot ledger. A rule that
 * only recognised the channel it was written against would push authors toward the wrong one.
 */
const LOGS = /\bhlog\s*\(|\bconsole\.(error|warn|log)\s*\(|\bnoteSkip\s*\(|\blog\s*\(/;
const RETHROWS = /\bthrow\b/;
/**
 * A receipt is an object PROPERTY — `{ state: 'corrupt' }`, `{ ok: false, why }` — so it must be
 * anchored to `{` or `,`.
 *
 * The loose `/\b(state|ok|why)\s*:/` matched the marker `silence-ok:` itself (`-` then `ok` is a word
 * boundary), so ANY block mentioning silence-ok was silently graded "receipt" — including the two
 * rubber-stamps the negative assertions below exist to reject. It also matched the bare word "ok:"
 * in any prose. A pattern loose enough to match the rule's own name is loose enough to match
 * nothing in particular.
 */
const RECEIPT = /[{,]\s*(state|ok|why|error)\s*:/;

/**
 * The reason behind `silence-ok:`, or null if there isn't a real one.
 *
 * The naive `/silence-ok:\s*\S/` ACCEPTED `catch { /​* silence-ok: *​/ }` — `\s*` skipped the space and `\S`
 * happily matched the `*` of the comment terminator. A declaration with no reason is exactly the
 * rubber-stamp this rule exists to prevent, and the first version of the rule licensed it. Caught by
 * this file's own negative assertion, which is the only reason it isn't still true.
 *
 * The SECOND version was wrong too, and the same assertion caught it again: stripping `*​/` only at
 * end-of-line left `catch { /​* silence-ok: *​/ return {}; }` claiming a reason of "*​/ return {}; }" —
 * long enough, has letters, passes. The reason must end where the COMMENT ends, not where the line
 * does. Two bugs in four lines, both in the direction of accepting a rubber stamp; a rule's
 * enforcement drifts toward permissiveness unless something asserts otherwise.
 */
function declaredReason(body) {
  const m = /silence-ok:([^\n]*)/.exec(body);
  if (!m) return null;
  const reason = m[1].split('*/')[0].trim(); // the reason ends at the comment, not at the newline
  return reason.length >= 8 && /[A-Za-z]{3}/.test(reason) ? reason : null;
}

function classify(body) {
  if (declaredReason(body)) return 'declared';
  if (DISTINGUISHES.test(body)) return 'distinguishes';
  if (LOGS.test(body)) return 'logs';
  if (RETHROWS.test(body)) return 'rethrows';
  if (RECEIPT.test(body)) return 'receipt';
  return null;
}

const files = fs.readdirSync(HOOKS).filter((f) => f.endsWith('.mjs')).sort();

console.log(`=== this discipline receipt lint — ${files.length} runtime hook files (tests/ is out of scope) ===\n`);

const violations = [];
const unparseable = [];
const declared = [];
const tally = {};
let total = 0;

/**
 * A block's OWN body — with any NESTED catch bodies masked out.
 *
 * ⚠️ THIS IS THE FIX FOR THE LINT'S OWN NEUTRALIZATION, and it was live on the exact population
 * this lint was written to reach. `catchBlocks` emits OVERLAPPING blocks (an outer body textually
 * contains its inner ones), and `classify` tries `declaredReason` FIRST against the whole body. So
 * **any `silence-ok:` in a nested catch graded every ENCLOSING catch as `declared`** — which is the
 * shape of all six arrow handlers this branch just added:
 *
 *     main().catch((e) => {
 *       try { hlog('recall', `hook CRASHED …`); }
 *       catch { |* silence-ok: the log IS the last resort … *| }
 *     });
 *
 * PROVEN before this fix: deleting the `hlog(...)` from any of the six left the lint GREEN. The
 * handler became `{ try { } catch { |* silence-ok: … *| } }` -> `declared` -> 0 violations. The
 * file's own headline finding — a silent `main().catch(() => {})` — restored, and invisible to the
 * enforcer built to catch it. The commit's proof ("6 before, 0 after") was satisfied by the WRONG
 * proposition: the six grade `declared` because of a comment, never `logs`. The lint could not
 * observe the thing its commit message claimed.
 *
 * The fixtures missed it because they differ from the shipped shape in exactly the load-bearing
 * way: `ARROW_SILENT` has no comment, `ARROW_LOGS` has no nested catch. Neither is a handler whose
 * receipt is guarded by a `silence-ok:` catch — which is every real one.
 *
 * Masking is the honest primitive: a `silence-ok:` declares silence for ITS OWN catch, and says
 * nothing about the block that encloses it.
 */
function ownBody(src, blk, all) {
  let body = src.slice(blk.start, blk.end);
  const nested = all.filter((o) => o !== blk && o.start >= blk.start && o.end <= blk.end);
  // Blank back-to-front so earlier offsets stay valid.
  for (const o of nested.sort((a, b) => b.start - a.start)) {
    const rs = o.start - blk.start;
    const re = o.end - blk.start;
    body = body.slice(0, rs) + ' '.repeat(re - rs) + body.slice(re);
  }
  return body;
}

for (const f of files) {
  const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
  if (!balanced(src)) { unparseable.push(f); continue; }
  const blocks = catchBlocks(src);
  for (const blk of blocks) {
    total++;
    const body = ownBody(src, blk, blocks);
    const kind = classify(body);
    if (kind === 'declared') declared.push({ f, line: blk.line, reason: declaredReason(body) });
    if (kind) { tally[kind] = (tally[kind] || 0) + 1; continue; }
    violations.push({ f, line: blk.line, snippet: body.replace(/\s+/g, ' ').slice(0, 72) });
  }
}

for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log(`  ${String(violations.length).padStart(3)}  SILENT (violations)`);
console.log(`  ${'-'.repeat(30)}\n  ${String(total).padStart(3)}  catch blocks scanned\n`);

/**
 * PRINT the declared exceptions, every run. An exception nobody ever re-reads is a silent catch
 * with extra syntax; printing them makes the allow-list an artifact a reviewer can audit in one
 * screen instead of a grep they have to think to run.
 */
if (declared.length) {
  console.log(`  declared exceptions (silence-ok) — ${declared.length}, each must still earn its silence:`);
  for (const d of declared) console.log(`    ${`${d.f}:${d.line}`.padEnd(28)} ${d.reason}`);
  console.log('');
}

if (violations.length) {
  console.log('  Silent fail-open catches — each must distinguish ENOENT, log, rethrow, return a');
  console.log('  receipt, or declare `silence-ok: <reason>`:\n');
  for (const v of violations) console.log(`    ${v.f}:${v.line}  ${v.snippet}`);
  console.log('');
}

/**
 * RED-PROOF: every hook spawned `detached, stdio: 'ignore'` has NO other way to surface an
 * uncaught throw to a human — there's no parent stdio to see it on. `capture-worker.mjs` was the
 * one exception (bare `await main();`, found during an OSS-readiness pass); this is a
 * static structural check because reliably forcing a real uncaught exception through this file's
 * deliberately fail-open call graph (every read/spawn/fetch already catches its own errors, by
 * design) would need test infrastructure disproportionate to what it proves. What this DOES prove:
 * the fix can never silently regress back to a bare `await main();` in either file.
 */
console.log('=== detached-worker crash-receipt check ===\n');
for (const f of ['capture-worker.mjs', 'recall-eval-worker.mjs']) {
  const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
  const tail = src.trimEnd().slice(-400);
  check(`${f} ends with main().catch(...), not a bare await main()`,
    /main\(\)\s*\.catch\(/.test(tail) && !/^\s*await main\(\);\s*$/m.test(tail),
    tail.replace(/\s+/g, ' ').slice(-120));
}
console.log('');

// ── The assertions.
check('the scanner could parse every hook file (a file it cannot read must not pass quietly)',
  unparseable.length === 0, `unparseable: ${unparseable.join(', ')}`);
check('the scanner actually found catch blocks (a lint that scans nothing passes everything)',
  total > 40, `only ${total} found — the blanker or the brace matcher is broken`);
eq('no silent fail-open catches in the runtime hooks', violations.length, 0);

/**
 * RED-PROOF, in-process: the lint must be able to FAIL. Without this the whole file is another
 * signal that cannot observe its claim — which is the disease, not the cure. (A test you have not
 * watched fail is a hypothesis. Here the sabotage is synthetic and asserted,
 * so the proof rides in the suite forever instead of living in a commit message.)
 */
const SABOTAGE = `
  try { risky(); } catch { return {}; }
`;
const CLEAN_LOG = `
  try { risky(); } catch (e) { hlog('x', 'failed: ' + e.message); return {}; }
`;
const CLEAN_DECLARED = `
  try { fs.mkdirSync(d); } catch { /* silence-ok: best-effort mkdir; the write below reports the real error */ }
`;
const sabBlocks = catchBlocks(SABOTAGE);
eq('RED-proof: the sabotage sample yields exactly one catch block', sabBlocks.length, 1);
check('RED-proof: a silent `catch { return {}; }` is CAUGHT',
  classify(SABOTAGE.slice(sabBlocks[0].start, sabBlocks[0].end)) === null);

/**
 * THE ARROW SHAPE — and the reason every fixture above it was insufficient.
 *
 * All three sabotage fixtures were `catch {` STATEMENT form, so the self-test only ever exercised
 * the shape the scanner could already read. Meanwhile the scanner skipped `.catch(() => {})`
 * entirely, and SIX of them shipped — the outermost handler of six hooks, the widest fail-open
 * surface in the system. The lint reported 0 violations and was correct about everything it looked
 * at. `check('the scanner actually found catch blocks', total > 40)` cannot see this: it guards
 * against scanning NOTHING, not against silently skipping ONE SHAPE. A corpus you filter without
 * saying so is the same coverage-honesty discipline, and a fixture set that only covers the working path violates it too.
 *
 * So the fixtures now span BOTH shapes. If the arrow arm is ever removed, these fail.
 */
const ARROW_SILENT = 'main().catch(() => {});';
const arrowBlocks = catchBlocks(ARROW_SILENT);
eq('RED-proof: the ARROW shape is SEEN at all (six of these shipped, invisible)', arrowBlocks.length, 1);
check('RED-proof: a silent `main().catch(() => {})` is CAUGHT',
  classify(ARROW_SILENT.slice(arrowBlocks[0].start, arrowBlocks[0].end)) === null);

const ARROW_LOGS = 'main().catch((e) => { hlog("x", `crashed: ${e}`); });';
const arrowLog = catchBlocks(ARROW_LOGS);
eq('the arrow shape yields exactly one block when it logs, too', arrowLog.length, 1);
eq('an ARROW handler that logs is accepted', classify(ARROW_LOGS.slice(arrowLog[0].start, arrowLog[0].end)), 'logs');

/** An EXPRESSION-bodied handler has no braces. It must be classified, not skipped. */
const ARROW_EXPR = 'p.catch((e) => null);';
eq('an expression-bodied arrow handler is still SEEN (no braces to find)', catchBlocks(ARROW_EXPR).length, 1);

/** `.catch(namedFn)` is a REFERENCE, not an inline body — there is nothing here to read. */
eq('a named-function handler is not a body this lint can judge, and is not invented',
  catchBlocks('p.catch(handleIt);').length, 0);

/**
 * THE SHIPPED SHAPE — a handler whose receipt is guarded by a nested `silence-ok:` catch.
 *
 * Every fixture above is missing the one feature that neutralized this lint in production: an
 * ENCLOSING catch containing a NESTED declared one. `ARROW_SILENT` has no comment; `ARROW_LOGS` has
 * no nested catch. So the suite was green while all six real handlers graded `declared` — and would
 * have stayed green if their `hlog` were deleted. These two cases are the shape that actually ships.
 */
const NESTED = [
  'main().catch((e) => {',
  "  try { hlog('recall', `crashed: ${e}`); }",
  '  catch { /* silence-ok: the log is the last resort and there is nowhere left to report. */ }',
  '});',
].join('\n');
const nestBlocks = catchBlocks(NESTED);
eq('the shipped shape yields TWO blocks — the outer handler and its inner guard', nestBlocks.length, 2);
const outer = nestBlocks.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
eq('THE NEUTRALIZATION: the outer handler grades on ITS OWN body — logs, not declared',
  classify(ownBody(NESTED, outer, nestBlocks)), 'logs');

/** And with the receipt removed, the same shape must be CAUGHT — this is the bug that went green. */
const NESTED_SILENT = NESTED.replace("hlog('recall', `crashed: ${e}`);", '');
const nsBlocks = catchBlocks(NESTED_SILENT);
const nsOuter = nsBlocks.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
check("RED-proof: a nested `silence-ok:` must NOT launder its enclosing handler's silence",
  classify(ownBody(NESTED_SILENT, nsOuter, nsBlocks)) === null,
  'the outer handler logs NOTHING and was graded acceptable — the lint is neutralized');
const logBlk = catchBlocks(CLEAN_LOG)[0];
eq('a catch that logs is accepted', classify(CLEAN_LOG.slice(logBlk.start, logBlk.end)), 'logs');
const decBlk = catchBlocks(CLEAN_DECLARED)[0];
eq('a catch declaring `silence-ok: <reason>` is accepted',
  classify(CLEAN_DECLARED.slice(decBlk.start, decBlk.end)), 'declared');
check('a bare `silence-ok` with NO reason is NOT accepted (the reason is the whole point)',
  classify('{ /* silence-ok: */ return {}; }') === null);
check('a `silence-ok` whose "reason" is only the comment terminator is NOT accepted',
  classify('{ /* silence-ok: */ }') === null);

/**
 * The blanker is the load-bearing assumption of this whole file — if it mis-reads a file, the lint
 * under-reports and calls it clean. So it is asserted against the exact shapes that fool it, with
 * the nested template (the one that actually broke it, from project.mjs:135) first.
 */
check('blanker: a NESTED template literal does not unbalance the file (project.mjs:135)',
  balanced('const s = `a${k ? ` (${k})` : \'\'} b`; try { a(); } catch { b(); }'));
check('blanker: a brace inside a string cannot open a block',
  balanced('const s = "{"; try { a(); } catch { b(); }'));
check('blanker: a quote inside a comment does not start a string',
  balanced("/* don't */ try { a(); } catch { b(); }"));
check('blanker: an unbalanced brace in a template literal is ignored',
  balanced('const t = `}}}`; try { a(); } catch { b(); }'));
check('blanker: a catch INSIDE a template interpolation is still scanned',
  catchBlocks('const s = `x${(() => { try { a(); } catch { return 1; } })()}y`;').length === 1);

done();
