#!/usr/bin/env node
/**
 * report.mjs — what is the memory loop actually DOING?
 *
 *   node report.mjs            # summary across every log generation + all session state
 *   node report.mjs --sessions # per-session detail
 *   node report.mjs --served   # which records/docs actually surface
 *   node report.mjs --compare  # does the record corpus agree with the queue? (cutover Phase A)
 *
 * WHY THIS EXISTS. Every hook here is fail-open, so silence is ambiguous by construction —
 * `hooklog.mjs` exists to make "healthy and quiet" distinguishable from "dead". But a per-line
 * trace answers "did this fire?", not "is any of this working?", and the owner's actual question
 * ("how and when is recall firing, and is it guiding anything?") was unanswerable without hand-
 * grepping. The data was already on disk. This reads it.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT: an "influence" score. Recall's success is COUNTERFACTUAL
 * — when it works, the re-derivation that did not happen leaves no trace — so any proxy is a
 * guess wearing a number. One was built and DISPROVEN here on 2026-07-16: a lexical-overlap
 * metric scored a document 97% "novel" while its own heading contained the phrase being matched.
 * Reporting nothing beats reporting that. What IS ground truth: an owner saying "you already know
 * this", and the agent's own AHA reports. Both are human-generated and neither is in this file.
 *
 * Read-only over state/queue/log — it never mutates them and never throws. (The RESIDUAL pass
 * reuses transcript.mjs's ONE char-count definition rather than growing a second; that reader emits
 * a single hlog line if a transcript is genuinely unreadable — the same kind of receipt the capture
 * path leaves — but writes no state, no queue, no memory.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { logGenerations } from './atomic.mjs';
import { read as readQueue } from './queue.mjs';
import { read as readSpool } from './spool.mjs';
import { digestOf } from './capture-map.mjs';
import { bySession } from './candidates.mjs';
import { STALE_SESSION_MS, RESIDUAL_FLOOR_CHARS, SWEEP_DEBOUNCE_MS, ORPHAN_CAP_DAYS, ORPHAN_CAP_MAX_PER_RUN, ORPHAN_CAP_DEBOUNCE_MS } from './config.mjs';
import { blindSpots, noteSkip, isReal, residualFor, isStale, residualBySession, lastCensus } from './residual.mjs';
import { MAX_FLUSH_PER_SWEEP } from './sweep.mjs';
import { logPath } from './hooklog.mjs';
import { queueDir, stateDir, SID_DISPLAY_LEN } from './paths.mjs';

// Single-sourced with hooklog.mjs — honors VECTROS_HOOKLOG_PATH so this can be pointed at a
// redirected (e.g. test-run) log instead of duplicating the default-path derivation.
const LOG = logPath();

/**
 * The residual machinery MOVED to `residual.mjs` when the stale-queue sweep landed, and is re-exported here.
 *
 * It was born in this file because the report was its only consumer. `sweep.mjs` is now the second,
 * and the two MUST enumerate the same population with the same refusals and the same staleness
 * clock — otherwise the ORPHANED tally below is a statement about a different system than the one
 * doing the flushing, which is the only thing that tally is for. Copying it into the sweep would
 * have been exactly the mistake this codebase already learned to avoid (the instance in front of
 * you is a SAMPLE — fix the census, do not re-wire one mechanism per site) in the branch whose
 * founding defect that is.
 *
 * `STALE_SESSION_MS` likewise moved into `config.mjs`'s SPEC — three consumers now share it (this
 * report, the sweep's flush gate, the cross-session nudge's orphan gate) and it is the number an
 * operator is most likely to want to move.
 *
 * Re-exported rather than merely imported so `tests/residual-test.mjs` and any operator muscle
 * memory keep working against `report.mjs`.
 */
export { residualFor, isStale, residualBySession, blindSpots, lastCensus };

/**
 * `--compare` — DOES THE RECORD CORPUS AGREE WITH THE QUEUE? The Phase A exit criterion.
 *
 * Dual-write means every proposal is written twice, and the phase is judged on whether the two
 * stores hold the same set. "No errors in the log" is NOT that check: the failures worth catching
 * are the quiet ones — a spool append that returned false, a proposal parked after its retry
 * budget, a mapping that dropped a field. All of them look like a healthy log.
 *
 * IT COMPARES BY externalId, not by title. Two near-duplicate proposals from one session are a
 * routine distiller output, so a title match would call a divergence agreement and vice versa. The
 * key is minted once and written to both stores precisely so this comparison is a set difference.
 *
 * THE THREE WAYS A QUEUE ENTRY CAN BE ABSENT FROM THE CORPUS ARE NOT THE SAME FINDING, and lumping
 * them is what would make this instrument useless in the week it matters most:
 *
 *   owed    — spooled, not yet synced. EXPECTED, and universal right after deploy or while the
 *             type is unprovisioned. Not a divergence; it is the backlog doing its job.
 *   parked  — spooled, over the retry budget, will never be attempted again. A REAL LOSS, and the
 *             one number that should be zero.
 *   unspooled — in the queue with no spool entry at all. The dual-write did not happen: either
 *             the spool append failed, or the entry predates Phase A (which is most of them at
 *             first, and is why the report separates candidates minted before the cutover).
 *
 * `null` IS NOT `[]`. A lookup that could not RUN returns null, and counting that as "the
 * corpus holds nothing" would report every candidate as missing — a false alarm indistinguishable
 * from a true one. Such a session is reported UNKNOWN and the run exits non-zero.
 */
export async function compareSession(sid, opts = {}) {
  const q = readQueue(sid);
  if (q.state === 'corrupt') return { sid, state: 'unreadable-queue' };

  const inQueue = new Map();
  let preCutover = 0;
  for (const c of q.all.values()) {
    // No externalId => proposed before dual-write shipped. Out of scope for agreement (a later
    // backfill is what gives those records), and counted separately so it cannot read as loss.
    if (!c.externalId) { preCutover++; continue; }
    inQueue.set(c.externalId, c);
  }

  /**
   * The record-side sessionId comes from the externalId's own prefix, not from the FILENAME.
   * Queue files are named with the slugged sid, while the records carry the raw one — identical
   * for today's uuid session ids and silently different for anything else, which would make this
   * report claim a total divergence for a session that is perfectly in sync.
   */
  const anyXid = [...inQueue.keys()][0];
  const rawSid = anyXid ? anyXid.slice(0, anyXid.lastIndexOf(':')) : sid;

  const rows = inQueue.size ? await bySession(rawSid, opts) : [];
  if (rows === null) return { sid, state: 'unknown', preCutover, queued: inQueue.size };
  // externalId -> digest of what the STORE actually holds, recomputed from the returned payload.
  const inCorpus = new Map(rows.filter((r) => r.externalId).map((r) => [r.externalId, digestOf(r)]));
  /**
   * externalId -> the RECORD's own `disposition` — the settle-side half of the agreement check
   * (2026-08-14, the day `dispose.mjs` was found to have zero record writes on the settle path:
   * `settle()`/`reopen()` existed, tested, unwired). The propose-side check above (content
   * digest) was Phase A's whole exit criterion; it has nothing to say about whether a SETTLED
   * candidate's disposition ever reached the record it was written to agree with in the first
   * place. `undefined`/absent normalises to `'pending'`, matching the schema's own default.
   */
  const corpusDisposition = new Map(rows.filter((r) => r.externalId).map((r) => [r.externalId, r.disposition || 'pending']));

  const s = readSpool(sid);
  const owed = new Set(s.owed.map((e) => e.externalId));
  const parked = new Set(s.parked.map((e) => e.externalId));

  const missing = { owed: [], parked: [], unspooled: [], divergent: [], settleDivergent: [] };
  for (const [xid, qev] of inQueue) {
    if (inCorpus.has(xid)) {
      /**
       * PRESENT IS NOT THE SAME AS CORRECT. `externalId` is a TOP-LEVEL key on the create request,
       * so it lands even when the payload does not — which is exactly what `data` vs `payload`
       * does (200, empty record). A set difference calls that agreement. The digest is computed
       * from the claim itself at spool time and recomputed from what the store returns.
       */
      const got = inCorpus.get(xid);
      if (qev.digest && got && got !== qev.digest) missing.divergent.push(xid);
      // The FILE's own idea of this candidate's disposition — `dispositions` is keyed by the
      // FILE's ordinal (`qev.id`, e.g. `c7`), not by externalId, so look it up off `qev.id`.
      const fileDisposition = q.dispositions.get(qev.id) || (q.disposed.has(qev.id) ? 'unknown' : 'pending');
      const recordDisposition = corpusDisposition.get(xid) ?? 'pending';
      if (fileDisposition !== recordDisposition) missing.settleDivergent.push(xid);
      continue;
    }
    if (owed.has(xid)) missing.owed.push(xid);
    else if (parked.has(xid)) missing.parked.push(xid);
    else missing.unspooled.push(xid);
  }
  // A record with no queue entry behind it. Queue-first ordering is supposed to make this
  // impossible, so a non-zero count means the ordering assumption is wrong somewhere.
  const orphaned = [...inCorpus.keys()].filter((x) => !inQueue.has(x));

  return {
    sid, state: s.state === 'corrupt' ? 'unreadable-spool' : 'ok',
    preCutover, queued: inQueue.size,
    agreed: inQueue.size - (missing.owed.length + missing.parked.length
      + missing.unspooled.length + missing.divergent.length + missing.settleDivergent.length),
    missing, orphaned,
  };
}

async function compare() {
  let files = [];
  let dirUnreadable = false;
  try { files = fs.readdirSync(queueDir()).filter((f) => f.endsWith('.jsonl') && isReal(f)); }
  catch (e) {
    // AN UNREADABLE DIRECTORY IS NOT AN EMPTY ONE. This fell through to `files = []`, so a fresh
    // machine — or one EACCES — printed "AGREED: every post-cutover candidate is in both stores"
    // over a corpus it had never looked at. The single most dangerous wrong answer this instrument
    // can give, in the module whose header spends thirty lines refusing exactly that conflation.
    noteSkip('the ENTIRE queue dir', e);
    dirUnreadable = true;
  }

  const results = [];
  for (const f of files) results.push(await compareSession(f.replace(/\.jsonl$/, '')));

  const sum = (k, sub) => results.reduce((n, r) => n + (sub ? (r.missing?.[k]?.length || 0) : (r[k] || 0)), 0);
  /**
   * COUNTED SEPARATELY BECAUSE `orphaned` IS AN ARRAY, and `sum` adds `r[k] || 0` — an empty array
   * is truthy, so `0 + []` is the STRING "0" and `0 + ['a','b']` is "0a,b". The line printed a
   * plausible `0` by coercion in the healthy case and garbage in the only case anyone reads it.
   */
  const orphanTotal = results.reduce((n, r) => n + (r.orphaned?.length || 0), 0);
  const unknown = results.filter((r) => r.state === 'unknown' || r.state.startsWith('unreadable'));

  console.log(`DUAL-WRITE AGREEMENT — ${results.length} session(s)\n`);
  console.log(`  queued since the cutover : ${sum('queued')}`);
  console.log(`  in the record corpus     : ${sum('agreed')}`);
  console.log(`  awaiting sync (owed)     : ${sum('owed', true)}   <- expected; the backlog draining`);
  console.log(`  PARKED (lost)            : ${sum('parked', true)}   <- should be 0`);
  console.log(`  never spooled            : ${sum('unspooled', true)}   <- should be 0`);
  console.log(`  content MISMATCH (row exists, claim differs): ${sum('divergent', true)}   <- should be 0`);
  console.log(`  SETTLE MISMATCH (file/record disposition disagree): ${sum('settleDivergent', true)}   <- should be 0 (dispose.mjs's record-side write, added 2026-08-14)`);
  console.log(`  records with no queue row: ${orphanTotal}   <- should be 0`);
  console.log(`  proposed BEFORE dual-write: ${sum('preCutover')}   <- out of scope; covered by a later backfill`);

  const divergent = results.filter((r) => r.state === 'ok'
    && (r.missing.parked.length || r.missing.unspooled.length || r.missing.divergent.length
      || r.missing.settleDivergent.length || r.orphaned.length));
  if (divergent.length) {
    console.log(`\n*** ${divergent.length} SESSION(S) DIVERGE ***`);
    for (const r of divergent) {
      console.log(`    ${r.sid}: ${r.missing.parked.length} parked, ${r.missing.unspooled.length} never spooled, ${r.missing.divergent.length} content-mismatched, ${r.missing.settleDivergent.length} settle-mismatched, ${r.orphaned.length} orphaned`);
    }
  }
  if (unknown.length) {
    // LOUD and fatal to the exit code: an unrunnable lookup means the comparison did not happen
    // for that session. Reporting agreement over the sessions that DID answer would be the
    // "missing is not broken" inversion this whole subsystem is built to refuse.
    console.log(`\n*** ${unknown.length} SESSION(S) COULD NOT BE COMPARED — this run proves nothing about them ***`);
    for (const r of unknown) console.log(`    ${r.sid}: ${r.state}`);
    process.exitCode = 1;
  }
  if (dirUnreadable) {
    // FIX: `dirUnreadable` was set above (on the queue dir itself failing to list — a
    // DIFFERENT failure than any per-session `unknown` state) but never consulted here. With
    // `files = []`, `results` is empty too, so BOTH `divergent` and `unknown` are vacuously
    // empty and the old code fell straight through to printing "AGREED" over a corpus it never
    // looked at — precisely the "missing is not broken" inversion this module's own header spends
    // thirty lines refusing. Caught by ESLint's `no-unused-vars` during this package's first-ever lint
    // pass over this source (it never had a config before landing under packages/).
    console.log('\n*** THE QUEUE DIRECTORY ITSELF COULD NOT BE LISTED — this run proves nothing; see the blind-spot ledger above ***');
    process.exitCode = 1;
  } else if (!divergent.length && !unknown.length) {
    console.log('\n  AGREED — every post-cutover candidate is in both stores, or owed and still draining.');
  }
}

function readAllLogLines() {
  const out = [];
  // EVERY generation, oldest first — the live log alone spans ~21h at current volume, which is
  // precisely the amnesia that made this report necessary. → atomic.mjs rollAtomic.
  for (const f of logGenerations(LOG)) {
    try { out.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); }
    catch (e) { noteSkip(`log generation ${path.basename(f)}`, e); }
  }
  return out;
}

function parseInjections(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^(\S+) recall\s+\[(\S+)\] injected (.+?), (\d+)c \(prompt #(\d+)(, ORIENT[^)]*)?\)/);
    if (!m) continue;
    const [, ts, sid, what, chars, prompt, orient] = m;
    const pick = (re) => { const x = re.exec(what); return x ? +x[1] : 0; };
    out.push({
      ts, sid, chars: +chars, prompt: +prompt, isOrient: !!orient,
      hits: pick(/(\d+) hits/), orient: pick(/(\d+) orient/),
      nudge: pick(/NUDGE\((\d+)/), dropped: pick(/(\d+) DROPPED/),
    });
  }
  return out;
}

/**
 * Capture stats — filtered to REAL sessions, and that filter is the whole point.
 *
 * The first cut of this function counted raw log lines. It reported a 31% distiller failure rate;
 * three of the four failures were this repo's own drain test, which spawns a deliberately-broken
 * fake binary. A metric that counts its own test harness is not a metric — it is the third time
 * today a measurement here has been wrong in a way that looked authoritative (cf. the 97%-novel
 * lexical score, the "0 records" that was a swallowed HTTP 400). Extract the sid, then filter it.
 */
function parseCapture(lines) {
  const real = isReal;
  const runs = [];
  let failed = 0, gated = 0;
  for (const l of lines) {
    const d = l.match(/capture-worker \[(\S+)\] distilled (\d+)K \((\d+) msgs\) -> (\d+) new \+ (\d+) revised/);
    if (d && real(d[1])) { runs.push({ sid: d[1], k: +d[2], msgs: +d[3], nNew: +d[4], nRev: +d[5] }); continue; }
    const f = l.match(/capture-worker \[(\S+)\] distill FAILED/);
    if (f && real(f[1])) { failed++; continue; }
    const g = l.match(/capture\s+\[(\S+)\] spawned distiller — delta=/);
    if (g && real(g[1])) gated++;
  }
  return { runs, failed, gated };
}

export function foldQueues() {
  const d = { proposed: 0, revised: 0, stored: 0, documented: 0, ignored: 0, autoIgnoredCap: 0, pending: 0, sessions: 0 };
  let files = [];
  try { files = fs.readdirSync(queueDir()).filter((f) => f.endsWith('.jsonl')); }
  catch (e) { noteSkip('the ENTIRE queue dir (every disposition number below is 0 for this reason, not because nothing happened)', e); return d; }
  for (const f of files) {
    if (!isReal(f)) continue;
    d.sessions++;
    /**
     * THE FOLD IS `queue.read()`'s, NOT A SECOND COPY OF IT.
     *
     * This used to re-implement the whole fold — positional ids, a `gone` set, the malformed-line
     * rule — under a comment insisting "this fold must agree with that one or the report disagrees
     * with the system it measures." It then did not: `reopen` landed in queue.mjs and this copy
     * never got the arm, so after a `--reopen` the report counted the candidate as still gone AND
     * still counted it under its old disposition. The comment asserting agreement is exactly what
     * made the divergence invisible.
     *
     * So the structural part — what is PENDING — now comes from the one fold that defines it. Only
     * the per-disposition TALLIES are computed here, because they are event counts the fold does not
     * expose, and they are computed reopen-aware (a reopened candidate is no longer settled, so it
     * must stop counting under the disposition that was undone).
     */
    const sid = f.replace(/\.jsonl$/, '');
    const q = readQueue(sid);
    if (q.state === 'corrupt') { noteSkip(`queue ${f}`, { code: 'corrupt' }); continue; }
    d.pending += q.pending.length;
    for (const c of q.all.values()) { if (c.op === 'revise') d.revised++; else d.proposed++; }

    // Tallies only. `settled` is last-write-wins per id so a dispose→reopen→dispose sequence counts
    // once, under whatever it ended as — and a dispose→reopen counts as nothing, which is the point.
    const settled = new Map();
    let lines = [];
    try { lines = fs.readFileSync(path.join(queueDir(), f), 'utf8').split('\n').filter(Boolean); }
    catch (e) { noteSkip(`queue ${f} (disposition tallies)`, e); continue; }
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { /* silence-ok: queue.mjs's fold skips malformed lines by the same documented rule (one bad append must not strand the queue), and `pending` above already came from that fold — so this pass agrees with it by construction rather than by assertion. */ continue; }
      // `ref` rides along with `disposition` (not tallied separately from it) so a reopen still
      // clears BOTH halves together — the same last-write-wins/dispose-then-reopen-cancels shape
      // the comment above already describes for `disposition` alone.
      if (e.op === 'dispose') settled.set(e.id, { disposition: e.disposition, ref: e.ref });
      else if (e.op === 'reopen') settled.delete(e.id);
    }
    for (const s of settled.values()) {
      if (d[s.disposition] !== undefined) d[s.disposition]++;
      // A SUBSET of `ignored`, not a separate bucket — every orphan-cap auto-write is disposition
      // 'ignored' (settle() enforces DISPOSITIONS), so counting it again here would double-count
      // against the total. This exists so periodic housekeeping can see how much of
      // `ignored` was a human judgment call vs. the cap backstop acting unattended, without either
      // number lying about the other.
      if (s.disposition === 'ignored' && typeof s.ref === 'string' && s.ref.startsWith('auto:orphan-cap')) d.autoIgnoredCap++;
    }
  }
  return d;
}

/** The served-set, from state.injectedIds. Survives log rotation — state files are not rolled. */
function servedSet() {
  const freq = new Map(); let sessions = 0;
  let files = [];
  try { files = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json')); }
  catch (e) { noteSkip('the ENTIRE state dir (the served-set below is empty for this reason, not because nothing was served)', e); return { freq, sessions }; }
  for (const f of files) {
    if (!isReal(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8')); }
    catch (e) { noteSkip(`state ${f}`, e); continue; }
    if (!Array.isArray(s.injectedIds) || !s.injectedIds.length) continue;
    sessions++;
    for (const id of new Set(s.injectedIds)) freq.set(id, (freq.get(id) || 0) + 1);
  }
  return { freq, sessions };
}

const pctile = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * p)] : 0);

const fmtAge = (ms) => (ms === null || ms === undefined ? '?' : ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

async function main() {
  const mode = process.argv[2] || '';

  // BEFORE the log read, deliberately: `--compare` reads the queue, the spool and the store, and
  // needs no hook log at all. Behind the `if (!lines.length) return` below it would have printed
  // "No hook log found" and answered nothing on a fresh machine — which is exactly where someone
  // verifying a deploy stands.
  if (mode === '--compare') return compare();

  const lines = readAllLogLines();
  if (!lines.length) { console.log('No hook log found at ' + LOG); return; }

  const inj = parseInjections(lines).filter((i) => isReal(i.sid));
  const gens = logGenerations(LOG);
  const span = [lines[0].slice(0, 19), lines[lines.length - 1].slice(0, 19)];

  console.log(`Memory loop report — ${gens.length} log generation(s), ${lines.length} lines`);
  console.log(`  window: ${span[0]} .. ${span[1]}\n`);

  if (mode === '--served') {
    const { freq, sessions } = servedSet();
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`WHAT SURFACES — ${ranked.length} distinct records/docs across ${sessions} sessions`);
    console.log(`  in >1 session: ${ranked.filter(([, n]) => n > 1).length}   exactly once: ${ranked.filter(([, n]) => n === 1).length}`);
    console.log('\n  NOTE: the top entries are the PINNED SET arriving via enumeration at every');
    console.log('  orient — that is the always-load tier, not recall finding anything. It says');
    console.log('  nothing about recall quality; read the long tail instead.\n');
    for (const [id, n] of ranked.slice(0, 20)) console.log(`  ${String(n).padStart(4)}x  ${id}`);
    return;
  }

  if (mode === '--sessions') {
    const by = {};
    for (const i of inj) (by[i.sid] ||= []).push(i);
    console.log('PER SESSION (real sessions only)');
    for (const [sid, xs] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${sid.padEnd(10)} ${String(xs.length).padStart(3)} injections · ` +
        `${String(xs.reduce((s, x) => s + x.hits, 0)).padStart(4)} hits · ` +
        `${xs.filter((x) => x.isOrient).length} orient · ${xs.filter((x) => x.nudge).length} nudge · ` +
        `${xs.reduce((s, x) => s + x.dropped, 0)} dropped`);
    }
    const res = residualBySession(Date.now()).slice().sort((a, b) => b.residual - a.residual);
    if (res.length) {
      console.log('\nRESIDUAL PER SESSION (total-offset at rest)');
      for (const r of res) {
        // Three states, not two, and the third is the one the sweep added: a stale session that has
        // ALREADY been flushed still shows a residual (a failed or partial drain holds the watermark
        // honestly), and printing it as "awaiting flush" would send an operator looking for a sweep
        // that already ran. → sweep.mjs § selectFlushable gate 4.
        const state = !isStale(r.ageMs, STALE_SESSION_MS) ? ''
          : r.sweptAt !== null && (r.lastStopAt === null || r.sweptAt >= r.lastStopAt) ? '  STALE, already SWEPT'
            : r.residual < RESIDUAL_FLOOR_CHARS ? '  STALE, under floor (not worth a call)'
              : '  STALE — awaiting flush';
        console.log(`  ${r.sid.slice(0, 10).padEnd(10)} residual ${(Math.round(r.residual / 1000) + 'K').padStart(6)}  idle ${fmtAge(r.ageMs).padStart(6)}${state}`);
      }
    }
    return;
  }

  const chars = inj.map((i) => i.chars);
  console.log('RECALL');
  console.log(`  injections: ${inj.length}   orient(multi-query): ${inj.filter((i) => i.isOrient).length}   steady: ${inj.filter((i) => !i.isOrient).length}`);
  console.log(`  hits served: ${inj.reduce((s, i) => s + i.hits, 0)}   no-hit turns: ${lines.filter((l) => / recall .*no hits/.test(l)).length}`);
  console.log(`  injected chars: p50=${pctile(chars, 0.5)} p90=${pctile(chars, 0.9)} max=${Math.max(0, ...chars)} (cap 9500)`);
  const over = inj.filter((i) => i.chars > 9500).length;
  console.log(`  OVER cap: ${over}${over ? '  *** assemble-to-fit is broken ***' : ''}`);
  console.log(`  turns dropping hits for budget: ${inj.filter((i) => i.dropped).length}`);

  const cap = parseCapture(lines);
  const k = cap.runs.reduce((s, r) => s + r.k, 0);
  console.log('\nCAPTURE');
  console.log(`  gate opened: ${cap.gated}   windows distilled: ${cap.runs.length} (${k}K chars)   FAILED: ${cap.failed}`);
  console.log(`  proposals from those windows: ${cap.runs.reduce((s, r) => s + r.nNew, 0)} new + ${cap.runs.reduce((s, r) => s + r.nRev, 0)} revised`);

  const q = foldQueues();
  console.log('\nDISPOSITION (the agent half)');
  console.log(`  queues: ${q.sessions}   proposed: ${q.proposed}   revised: ${q.revised}`);
  console.log(`  stored: ${q.stored}   documented: ${q.documented}   ignored: ${q.ignored} (of which ${q.autoIgnoredCap} auto, orphan-cap backstop)   PENDING: ${q.pending}`);
  // Same discipline as ORPHANED's own line below (STALE_SESSION_MS/MAX_FLUSH_PER_SWEEP/
  // SWEEP_DEBOUNCE_MS) — an operator asking "what's my current cap / how often does it run" gets
  // the REAL values in force, not just a count of what already happened. Without this an
  // auto-ignored candidate's `--reopen` path is discoverable (dispose.mjs already prints it), but
  // the THRESHOLD that triggered it in the first place was not, anywhere a human would look.
  console.log(`  orphan-cap: auto-ignores a record-backed candidate offered on >=${ORPHAN_CAP_DAYS} distinct `
    + `day(s); at most ${ORPHAN_CAP_MAX_PER_RUN} per run, checked at most once per `
    + `${Math.round(ORPHAN_CAP_DEBOUNCE_MS / 3600_000)}h`);
  console.log(`  nudges injected: ${inj.filter((i) => i.nudge).length}`);

  /**
   * RESIDUAL — the tail no capture ever read. This block turned an ASSUMED loss into a
   * measured one (D), and it is now also the sweep's report card (B): the ORPHANED line is the
   * backlog, and AWAITING FLUSH is what the sweep has not yet reached.
   *
   * KEEP THE TWO SEPARATE. A swept session's residual does not necessarily go to zero — a distill
   * that fails HOLDS the watermark, which is correct and honest — so folding "swept" into "flushed"
   * would report success from the fact that we tried. `awaiting` is the number that should trend to
   * zero as the sweep drains the backlog; if `swept` grows while `awaiting` does not shrink, the
   * flushes are failing and this is where that shows up.
   */
  const res = residualBySession(Date.now());
  const withAny = res.filter((r) => r.residual > 0);
  const totalResidual = res.reduce((s, r) => s + r.residual, 0);
  const stale = res.filter((r) => isStale(r.ageMs, STALE_SESSION_MS));
  const staleResidual = stale.reduce((s, r) => s + r.residual, 0);
  const sweptRows = stale.filter((r) => r.sweptAt !== null && (r.lastStopAt === null || r.sweptAt >= r.lastStopAt));
  const awaiting = stale.filter((r) => !sweptRows.includes(r) && r.residual >= RESIDUAL_FLOOR_CHARS);
  console.log('\nRESIDUAL — tail never distilled');
  /**
   * THE PHANTOM RATIO, printed because its absence cost a week of a misread alarm.
   *
   * A state directory of thousands of files LOOKS like a leak, and the enumeration's cap-firing
   * receipt was read that way. It is not: ~99% of those files are one ~90-byte write per
   * `SessionStart` that never took a prompt (`orient.mjs` § "a session that never gets a prompt now
   * costs one file write"), and the reaper bounds them at REAP_PHANTOM_AFTER_MS. Showing the split
   * turns "why are there 4,600 files?" from an investigation into a line of output.
   */
  console.log(`  state files: ${lastCensus.files} on disk, ${lastCensus.folded} folded`
    + `   (${lastCensus.phantoms} phantoms — a SessionStart that never took a prompt; expected, and reaped on their own window)`
    // PRINTED ONLY WHEN IT BOUND. Reporting `phantoms` beside a total that a cap truncated is the
    // "true counter, false sentence" residual.mjs refuses to write — 4,633 files and 31 phantoms
    // reads as 4,602 real sessions. If the cap bit, the classification is incomplete and says so.
    + (lastCensus.capped ? `
  ⚠ ${lastCensus.capped} file(s) were NOT looked at — the counts above are INCOMPLETE` : ''));
  console.log(`  sessions with a READABLE transcript: ${res.length}   (sessions predating residual tracking have no path; unreadable ones are in the blind-spot ledger below, not here)`);
  console.log(`  total at rest: ${Math.round(totalResidual / 1000)}K chars across ${withAny.length} session(s) with any residual`);
  console.log(`  ORPHANED (in sessions idle >${Math.round(STALE_SESSION_MS / 3600_000)}h): ${Math.round(staleResidual / 1000)}K across ${stale.length}`);
  console.log(`    · AWAITING FLUSH: ${Math.round(awaiting.reduce((s, r) => s + r.residual, 0) / 1000)}K across ${awaiting.length}`
    + ` — the sweep takes ${MAX_FLUSH_PER_SWEEP} per run, at most one run per ${Math.round(SWEEP_DEBOUNCE_MS / 60_000)}m`);
  console.log(`    · already SWEPT: ${Math.round(sweptRows.reduce((s, r) => s + r.residual, 0) / 1000)}K across ${sweptRows.length}`
    + ' — flushed once; any residual left here is a distill that failed or hit MAX_WINDOWS_PER_RUN');
  if (withAny.length) {
    const top = withAny.slice().sort((a, b) => b.residual - a.residual).slice(0, 5);
    console.log('  top: ' + top.map((r) => `${r.sid.slice(0, SID_DISPLAY_LEN)}=${Math.round(r.residual / 1000)}K@${fmtAge(r.ageMs)}`).join('  '));
  }

  console.log('\nINFLUENCE');
  console.log('  Not measured, by choice. Recall\'s success is counterfactual: when it works, the');
  console.log('  re-derivation that did not happen leaves no trace. Every cheap proxy is a guess');
  console.log('  wearing a number (a lexical one was built and disproven here). Ground truth is');
  console.log('  the owner saying "you already know this", and the agent\'s own AHA reports.');
  console.log('\n  Run --sessions for per-session detail, --served for what surfaces.');

  // LAST, and loud when non-empty: what this report could not read. Every number above is
  // conditional on this being empty, so it prints after them rather than scrolling away above.
  if (blindSpots.length) {
    console.log(`\n*** ${blindSpots.length} INPUT(S) UNREADABLE — the numbers above are INCOMPLETE ***`);
    for (const b of blindSpots) console.log(`    ${b}`);
  }
}

// Run as a CLI, but stay importable: tests import `residualFor`/`isStale` as pure functions, and
// `main()` reads the whole log + spawns a full report — it must NOT fire on import. This file IS
// imported for real (by `backfill.mjs`), which is exactly the case this guard exists to handle —
// and exactly where the ORIGINAL `import.meta.url` version of it silently failed.
//
// FOUND LIVE, against the real deployed build (2026-08-14, same root cause as reap.mjs's own fix,
// found the same day): despite `bundle: false`, the build INLINES this file's entire source into
// every file that imports from it — `backfill.mjs`'s dist output carries a full copy of this
// module, `// src/report.mjs` marker and all, not a real `import`. Once inlined, `import.meta.url`
// for this code IS `backfill.mjs`'s own URL, so `main()` fired on every real `backfill.mjs`
// invocation — confirmed live: a full stats report printed ahead of backfill's own output on every
// run. `process.argv[1]`'s BASENAME survives inlining correctly (it reflects what script node was
// actually told to run, which bundling can't change), so that is the real entry-point check.
if (process.argv[1] && path.basename(process.argv[1]) === 'report.mjs') await main();
