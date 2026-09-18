/**
 * The candidate nudge — how the queue becomes visible to the agent.
 *
 * Capture proposes involuntarily; the agent disposes voluntarily. Something has to close that gap,
 * and the choice of trigger is the whole design:
 *
 *   - NOT context pressure (MemGPT's nudge). That assumes a small context that fills predictably.
 *     At 1M we stop at 20% as often as 90%, so it tracks tokens spent, not learning accrued.
 *   - NOT a lifecycle event. `SessionEnd` fires ~2/min with `reason=other` (measured) — unusable.
 *   - NOT a clock. Nothing here drops or nags on a timer.
 *   - CANDIDATE PRESSURE: when enough unsettled candidates have accrued, say so. The count is a
 *     direct measure of the thing we actually care about — undigested learning.
 *
 * AND IT MUST NOT NAG. Re-printing the same list every prompt is exactly the attention tax this
 * system exists to avoid, so the nudge is state-driven, the same way recall downgrades an
 * already-served record: it fires when the pending SET CHANGES, and is otherwise silent. If the
 * agent ignores it, the next capture changes the set and it returns — once. No timer, no decay.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUDGE_THRESHOLD, NUDGE_MAX, NUDGE_ORPHAN_MAX, NUDGE_BODY_MAX_CHARS,
  NUDGE_TITLE_MAX_CHARS, NUDGE_FIELD_MAX_CHARS } from './config.mjs';
import { SID_DISPLAY_LEN } from './paths.mjs';

/**
 * RE-EXPORTED under the name this module has always published. The VALUE moved to the
 * config seam; the export is part of this module's contract — `tests/nudge-test.mjs` drives every
 * one of its cases off it (`seed(NUDGE_THRESHOLD - 1)`), so dropping it does not fail loudly, it
 * makes the threshold `undefined` and every arithmetic on it NaN. Which is what happened: the
 * suite reported eleven unrelated-looking failures, including assertions about the nudge's PROSE.
 * Same shape as `lock.mjs`'s `STALE_MS` and `sweep.mjs`'s `MAX_FLUSH_PER_SWEEP`.
 */
export { NUDGE_THRESHOLD };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * How many unsettled candidates before we interrupt.
 *
 * PROVISIONAL — n=3. The first three real queues under the content gate held 8, 5, and 8 pending
 * after one distiller run each. 5 makes a reviewable batch of roughly one session's learning
 * without interrupting for a single stray thought. This is a guess with a sample behind it, not a
 * tuned value: revisit once queues exist across many sessions. → the handoff's "thresholds are
 * deliberately unset".
 */


/**
 * EVERY MODEL-AUTHORED FIELD GETS THE SAME TREATMENT, and this exists because the last two rounds
 * of that lesson were applied one field at a time.
 *
 * `title` and `body` were capped and whitespace-collapsed; `kind`, `dest` and `revises` were
 * interpolated RAW onto the very same bullet line. All five come verbatim from the distiller
 * (`capture-worker.mjs`), so the distinction was never about provenance — only about which field
 * someone had gotten around to. MEASURED on the shipped module: 12 pending with 5000-char `kind`
 * rendered a **185,777-character** block, and a newline inside `kind` escapes the bullet and lands
 * arbitrary text at column 0 of `additionalContext`.
 *
 * That is verbatim the hazard NUDGE_TITLE_MAX_CHARS's own comment describes — *"a newline in a distiller title
 * breaks out of its bullet ... a candidate could forge whatever structure it liked inside the
 * block"* — sitting unaddressed on the line below it. And it falsified NUDGE_MAX: the cap bounds
 * the COUNT of candidates, which bounds nothing if a single candidate is unbounded.
 *
 * So: one helper, applied to every model-authored field, so the next field added cannot be the
 * one that gets forgotten — fix the census, not the instance.
 */
const field = (v, max = NUDGE_FIELD_MAX_CHARS) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * How many candidates one nudge may LIST. `NUDGE_THRESHOLD` is when it FIRES; this is how big it may
 * GET, and they are different numbers — pending is routinely 8-12 and is unbounded.
 *
 * WHY A CAP IS REQUIRED, not merely tidy: the nudge is ALL-OR-NOTHING against recall's 9500c budget
 * (`recall.mjs`), so a block that outgrows the budget is not truncated — it is DROPPED WHOLE, and
 * every candidate it was carrying goes unsurfaced.
 *
 * TWO NUMBERS, AND THEY MEASURE DIFFERENT THINGS — say which, because a reader who takes one for
 * the other mis-sizes the cap by ~40%:
 *   WORST CASE  ~315c per candidate — every field simultaneously at its cap (title + body + the
 *               three `field()`-capped values). An uncapped list crosses the 9500c budget at ~26
 *               pending and takes the lot with it. This is what the CAP must be safe against.
 *   OBSERVED    ~223c mean (min 192, median 220, max 261) — RE-MEASURED across all 35
 *               real pending candidates, putting the actual cliff at ~42.
 *               This is what the current headroom is.
 * `config.mjs`'s `NUDGE_MAX` note carries the same pair; if you change one, change both.
 * `NUDGE_ORPHAN_MAX` already carried this reasoning; the ORDINARY nudge — which fires far more
 * often — did not.
 *
 * A COUNT CAP IS ONLY A BOUND IF EACH ITEM IS BOUNDED. When this cap first landed, `kind`/`dest`/
 * `revises` were still rendered raw, so 12 candidates could be 185K — the cap bounded the wrong
 * dimension and the comment claiming a worst case was false. Both halves are needed; see `field()`.
 *
 * 12 leaves headroom under the budget alongside the instructions (~2.8K) and the orient block. The
 * remainder is STATED, and `--list` has all of them.
 */

/**
 * A stable signature of the pending set — the nudge fires only when this changes.
 *
 * `c.ordinal ?? c.id`, not `c.id` alone: the OWN-session nudge now reads
 * records, whose `.id` is the real record uuid and whose `.ordinal` is the address (`c1`, `c2`,
 * ...) — the file-shaped orphan nudge still has only `.id`, so the fallback keeps both callers
 * correct without either needing to know which shape it's holding. Either field is unique and
 * stable, which is all a change-detection signature needs.
 */
export const pendingSig = (pending) => pending.map((c) => c.ordinal ?? c.id).sort().join(',');

/**
 * Render the nudge. Returns [] when there is nothing to say.
 *
 * The operating rules ride INSIDE the block, deliberately. The whole premise of this system is
 * that involuntary delivery beats relying on the agent having read a doc — so a nudge that
 * pointed the reader at an external design doc would be reintroducing the discipline dependency
 * it exists to remove.
 * The rules are short because the dangerous ones are few.
 */
export function renderNudge(pending, sessionId) {
  if (pending.length < NUDGE_THRESHOLD) return [];
  const shown = pending.slice(0, NUDGE_MAX);
  const rest = pending.length - shown.length;
  const lines = [
    `MEMORY CANDIDATES (${pending.length} pending) — the capture distiller proposed these from THIS session's ` +
      'transcript. They are proposals, not memories: nothing is stored, and nothing will be, until you settle ' +
      'each one. This is the only write path into memory — the distiller cannot write.',
  ];
  for (const c of shown) {
    /**
     * CAP AND COLLAPSE THE TITLE TOO.
     *
     * `body` got both treatments; `title` — rendered on the same line, from the same
     * model-authored JSON — got neither. A newline in a distiller title breaks out of its bullet
     * and lands in `additionalContext` verbatim, bounded only by the 9500c budget, so a candidate
     * could forge whatever structure it liked inside the block.
     *
     * The rule was already derived ~150 lines away in recall-eval-worker's contradiction cap
     * ("CAP it. Every HIT is capped ... while this was unbounded") and not applied here. Sharpest
     * because evaluate.mjs argues recall is FYI while the nudge "demonstrably gets acted on": the
     * one channel identified as reliably obeyed was the one with an uncapped field.
     * Same census defect, same shape, as the other sites this fix swept up.
     */
    const title = field(c.title || '(untitled)', NUDGE_TITLE_MAX_CHARS);
    const body = String(c.body || '').replace(/\s+/g, ' ').trim();
    // `c.ordinal ?? c.id` — see pendingSig's header: this candidate is
    // record-shaped now, and `.ordinal` (not the real record `.id`) is the address the reader
    // types into dispose.mjs.
    lines.push(
      `- ${field(c.ordinal ?? c.id)} [${field(c.kind) || '?'} → suggests ${field(c.dest) || '?'}] ${title}` +
        (body ? `\n    ${body.length > NUDGE_BODY_MAX_CHARS ? body.slice(0, NUDGE_BODY_MAX_CHARS) + '…' : body}` : '') +
        (c.revises ? `  (revises ${field(c.revises)})` : ''),
    );
  }
  // NO SILENT TRUNCATION — a capped list that does not say it is capped reads as the whole queue,
  // and the reader settles 12 of 30 believing they are done.
  if (rest) lines.push(`  … and ${rest} more not shown — \`--list\` below has all of them.`);
  lines.push(
    /**
     * TWO QUESTIONS, NOT ONE — and the second used to be missing entirely.
     *
     * This block said "verify the claim against the repo", which sounds sufficient and is not: a
     * DOC is in the repo. A settling session once did exactly that, checked two repo docs, and
     * disposed a TRUE candidate as `ignored:PREMISE IS FALSE` — because both docs were STALE. It
     * verified against a description of the system instead of the system.
     *
     * So the instruction now names the DECIDING ARTIFACT: the thing that actually determines the
     * behaviour, not the thing that documents it. For a CI claim that is the CI config file itself
     * plus whatever variables/secrets actually control that run — not a reference doc about CI.
     * Docs lag; the artifact does not.
     */
    'TWO questions per candidate, and both must be answered — the second one is the one that gets skipped:',
    '  1. IS IT TRUE?  Verify against the DECIDING ARTIFACT — the config, the code, or the live state that ' +
      'actually determines the behaviour. NOT a doc that describes it: a doc is in the repo too, and repo ' +
      'docs go stale. (A CI claim is settled by the CI config file + the live CI variables/secrets that ' +
      'actually control the run, never by a reference doc about CI. A behaviour claim is settled by the code and its tests.)',
    '  2. IS IT ALREADY KNOWN?  Search the store / the golden docs for a near-duplicate before adding one.',
    '`dest` is the distiller\'s SUGGESTION, not a decision:',
    '  • A shareable engineering lesson (gotcha/convention) belongs in the REPO DOC, not private memory — the ' +
      'file is the golden source, the KB only indexes it. A doc edit gets reviewed in the MR; a ' +
      'memory write is invisible. Land a doc edit on the same branch as the change it documents.',
    '  • Private/churny operational context → a `memory` record (record_create, type=memory).',
    '  • Already covered, wrong, or not durable → ignore it, WITH the citation or the reason.',
    /**
     * STATE THE ASYMMETRY. The dispositions are not equally risky and the ordering is the opposite
     * of what intuition suggests: `stored` feels like the committing one, so it gets the caution —
     * but it is reversible AND machine-verified, while `ignored` is neither. The costly error is
     * dismissing something true, and nothing about the old wording said so.
     */
    'THE DISPOSITIONS ARE NOT SYMMETRIC — hold `ignored` to a HIGHER bar than `stored`, not a lower one:',
    '  • `stored`  — REVERSIBLE (delete the record) and MACHINE-VERIFIED (read back from the store; a bogus ' +
      'or unrelated id is refused). A mistake here is cheap and detectable.',
    '  • `ignored` — IRREVERSIBLE by default and, in its bare form, checked by NOTHING. A wrong `ignored` ' +
      'DESTROYS a true candidate silently. Cite your evidence and it gets verified like any other claim:',
    `  node "${path.join(HERE, 'dispose.mjs')}" ${sessionId} --list`,
    `  node "${path.join(HERE, 'dispose.mjs')}" ${sessionId} c1=stored:<record-uuid> c2=documented:<path#anchor> ` +
      'c3=ignored:covered:<path|§N|record-id>  c4=ignored:<reason, only when there is nothing to cite>',
    `  node "${path.join(HERE, 'dispose.mjs')}" ${sessionId} --reopen <cN> [why]   # undo a wrong \`ignored\``,
    'Cannot verify one? LEAVE IT PENDING. Unsettled costs one line; a wrong memory is recalled as authoritative, ' +
      'and a wrongly-ignored one is simply gone.',
  );
  return lines;
}

/**
 * How many orphaned candidates one block may carry. The nudge is ALL-OR-NOTHING against a 9500c
 * budget (recall.mjs), so an unbounded orphan block does not "overflow" — it is DROPPED WHOLE, and
 * a swept session with 20 pending would therefore be surfaced never. A cap is what makes the block
 * small enough to actually arrive. The remainder is stated, not hidden, and `--list` has the rest.
 */

/**
 * THE ORPHAN NUDGE. Candidates from a DONE session, handed to a live one.
 *
 * The problem it closes: the sweep flushes a stale session's tail into that session's own queue,
 * but the ordinary nudge is current-session only (`readQueue(sessionId)`). A swept session's agent
 * is GONE — that is what made it eligible — so it can never see its own nudge, and the candidates
 * the flush just produced would sit unsettled forever. Capture would have been made complete and
 * disposition left broken, which is the same tail loss one step further down the pipe.
 *
 * WHY THIS IS SAFE TO HAND OVER, and it rests on a property the sweep did not invent: the distiller
 * writes NOTHING to the store. These are proposals in an append log. Settling them still runs
 * through `dispose.mjs`, which verifies every claim — so a foreign agent disposing them is held to
 * exactly the same bar as the originating one would have been. What is inherited is the WORK, not
 * any authority.
 *
 * WHY ONLY STALE-AND-FLUSHED sessions (enforced in sweep.mjs `orphanedPending`): a LIVE session's
 * pending belongs to its own agent, which is still there to be nudged. Two agents settling one
 * queue is how a candidate gets disposed twice on two different judgements — and a disposition is
 * FINAL (never re-offered), so the second judgement silently loses.
 *
 * THE PROVENANCE LINE IS NOT DECORATION. This block asks an agent to judge claims distilled from a
 * conversation it was never in, so it must say so plainly: the reader has no memory of this work
 * and must verify against the repo rather than against recollection. The ordinary nudge can lean on
 * "you were there"; this one must not let the reader think they were.
 */
export function renderOrphanNudge(orphan, ageHours) {
  if (!orphan || !orphan.pending.length) return [];
  const shown = orphan.pending.slice(0, NUDGE_ORPHAN_MAX);
  const rest = orphan.pending.length - shown.length;
  /**
   * THE OPENING LINE USED TO READ "THIS IS NOT YOUR SESSION'S WORK", AND THAT WAS THE BUG.
   *
   * Observed over real sweeps: every session wants to defer disposition until something forces the
   * issue. Orphaned memories are a shared responsibility, and there is no other session better
   * positioned to dispose of them — every real settlement observed happened only when that case was
   * argued explicitly, against the agent's default inclination to defer.
   *
   * The prompt was arguing the other side. It opened by telling the reader this was NOT their work —
   * a licence to defer, in the first clause, where it carries the most weight — and then contradicted
   * itself four clauses later with "you are that someone". Given a mixed signal and a real task
   * competing for attention, deferring is the rational read, and that is what agents did.
   *
   * So: state the commons plainly, and kill the specific false belief that makes deferral feel safe —
   * that a better-positioned session exists. There isn't one. The queue goes to whoever is here, and
   * "someone else will" resolves to nobody.
   *
   * WHAT IS DELIBERATELY NOT DONE: this stays DISCRETIONARY. No forced settlement, no gate on the
   * turn, no nag escalation. "Cannot verify it? leave it pending" remains a correct outcome and is
   * restated below — an agent pressured into settling what it cannot check will produce a confident
   * wrong `ignored`, which is irreversible and destroys a true candidate silently. The change is to
   * the REASONING the reader brings, not to their freedom: defer because you genuinely cannot judge
   * it, never because it belongs to someone else.
   */
  const lines = [
    `ORPHANED MEMORY CANDIDATES (${orphan.pending.length} pending, from session ${orphan.sid.slice(0, SID_DISPLAY_LEN)} — ` +
      `idle ${ageHours}h, so its tail was swept by the stale-queue flush). THIS QUEUE IS NOW YOURS: the sweep ` +
      'offers each orphaned queue to ONE session at a time, so THERE IS NO SESSION BETTER POSITIONED THAN ' +
      'YOU, and "someone else will settle it" is not how this works — setting it down parks it until your ' +
      'claim lapses, it does not pass it on. (Not a guarantee: two sessions prompting within milliseconds ' +
      'can both be offered it, so run `--list` before you store — what it shows is the truth and this ' +
      'block may be a moment stale.) ' +
      'Orphaned candidates are a SHARED responsibility and this is your share of it. Nothing is stored ' +
      'and nothing will be until someone does. You are that someone.',
  ];
  for (const c of shown) {
    const title = field(c.title || '(untitled)', NUDGE_TITLE_MAX_CHARS);
    const body = String(c.body || '').replace(/\s+/g, ' ').trim();
    lines.push(
      `- ${field(c.id)} [${field(c.kind) || '?'} → suggests ${field(c.dest) || '?'}] ${title}` +
        (body ? `\n    ${body.length > NUDGE_BODY_MAX_CHARS ? body.slice(0, NUDGE_BODY_MAX_CHARS) + '…' : body}` : ''),
    );
  }
  // NO SILENT TRUNCATION. A capped list that does not say it is capped reads as the whole queue, and
  // the reader settles six of twenty believing they are done. → the cap's own comment.
  if (rest) lines.push(`  … and ${rest} more not shown here — \`--list\` below has all of them.`);
  lines.push(
    'Judge each on its merits, and be MORE sceptical than usual — you cannot check these against your own ' +
      'recollection of the session, only against the artifacts.',
    // THE SAME TWO RULES AS THE ORDINARY NUDGE, and this block needs them MORE. Its reader was not in
    // the session, so a stale doc is the only thing they have to be misled by. The first version said
    // 'verify the claim' and 'against the repo' — verbatim the wording already proved
    // insufficient — and mentioned neither the cited-ignore form nor the undo. The population most
    // likely to dismiss a true candidate had been given the weakest rules.
    '  1. IS IT TRUE?  Verify against the DECIDING ARTIFACT — the config, the code, or the live state that ' +
      'determines the behaviour. NOT a doc that describes it: docs go stale, and you have no memory of this ' +
      'session to cross-check them against. (A CI claim is settled by the CI config file + the live CI ' +
      'variables/secrets that actually control the run, never by a reference doc about CI.)',
    '  2. IS IT ALREADY KNOWN?  Search the store / the golden docs before adding a near-duplicate.',
    'Routing as always: a shareable engineering lesson is a REPO DOC edit (the file is golden, the KB indexes ' +
      'it); private/churny operational context is a `memory` record.',
    // This used to call `ignored` outright IRREVERSIBLE two lines above printing the `--reopen`
    // undo command — true-ish, but together they read as "never dismiss anything", which is not
    // the intent; "comes back ONLY if a later reader notices" is the more honest claim.
    'AND THE DISPOSITIONS ARE NOT SYMMETRIC — `stored` is reversible and machine-verified; `ignored` ' +
      'leaves the queue and comes back ONLY if some later reader notices and runs `--reopen`. Assume ' +
      'nobody will. So `ignored` earns the HIGHER bar — cite it, and the citation gets checked:',
    `  node "${path.join(HERE, 'dispose.mjs')}" ${orphan.sid} --list`,
    `  node "${path.join(HERE, 'dispose.mjs')}" ${orphan.sid} c1=stored:<record-uuid> c2=documented:<path#anchor> ` +
      'c3=ignored:covered:<path|§N|record-id>  c4=ignored:<reason, only when there is nothing to cite>',
    `  node "${path.join(HERE, 'dispose.mjs')}" ${orphan.sid} --reopen <cN> [why]   # undo a wrong \`ignored\``,
    'Note the session id — dispose.mjs is addressed per session, so pass THAT id, not your own.',
    // THE DISCRETION CLAUSE, restated at the end because the opening line now pushes the other way.
    // Both halves are load-bearing: "you may leave it" keeps a pressured agent from manufacturing a
    // confident `ignored` it cannot support (irreversible, and it destroys a true candidate silently),
    // while naming the ONE reason that does not count keeps that permission from swallowing the rule.
    'THIS IS DISCRETIONARY. Cannot verify one from here? LEAVE IT PENDING — a guessed `ignored` is ' +
      'irreversible and destroys a true candidate silently. Ignoring with an honest cited reason is equally ' +
      'a settlement. Two things to know before you choose, because both cut against a reflex: ' +
      '(a) PENDING MEANS PARKED, NOT PASSED ON — this block re-fires only when the pending set CHANGES, so ' +
      'leaving all of it pending means you will not see it again this session, and no other session can be ' +
      'offered it while your claim keeps renewing. It is not going back to a pool someone else is working. ' +
      '(b) `ignored:covered:<path>` is machine-checked for EXISTENCE ONLY — nothing verifies the cited doc ' +
      'actually COVERS the candidate, so a plausible-but-wrong citation passes every time. The check cannot ' +
      'catch that; you are the only thing that can. Settle what you can judge, park what you cannot, and ' +
      'never settle something merely to clear it.',
  );
  return lines;
}

/** A stable signature of the orphan block — same nag-avoidance contract as `pendingSig`. */
export const orphanSig = (orphan) => (orphan ? `${orphan.sid}:${pendingSig(orphan.pending)}` : '');
