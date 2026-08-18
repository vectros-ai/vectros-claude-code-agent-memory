// The falsifiable claim: triage converts a corpus-miss (plausible-but-wrong search hits) to
// SILENCE while KEEPING a genuinely relevant hit. Real Haiku, real prompt file, against
// realistically-shaped search results (structurally representative of what a live corpus miss
// vs. a live real hit look like; the specific topics below are illustrative, not this package's
// own real decision history). If it fails either half, the stage is not worth its call.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { check, done } from './assert.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Self-redirect so a standalone run of this file (outside run-all.mjs) never writes into a real
// deployment's hooks.log.
process.env.VECTROS_HOOKLOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'triage-real-log-')), 'hooks.log');

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const PROMPT = path.join(DIR, 'prompts', 'recall-triage.md');
const { cred } = await import(pathToFileURL(path.join(DIR, 'creds.mjs')).href);

const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN ||
  path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

function childEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
    'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID','CLAUDE_AGENT_SDK_VERSION','CLAUDE_CODE_OAUTH_SCOPES','CLAUDE_EFFORT','AI_AGENT','BAGGAGE']) delete env[k];
  const t = cred('CLAUDE_CODE_OAUTH_TOKEN'); if (t) env.CLAUDE_CODE_OAUTH_TOKEN = t;
  const a = cred('ANTHROPIC_API_KEY'); if (a) env.ANTHROPIC_API_KEY = a;
  env.VECTROS_RECALL_EVAL = '1';
  return env;
}

function triage(activity, query, results) {
  const sys = fs.readFileSync(PROMPT, 'utf8');
  const res = spawnSync(CLAUDE_BIN, [
    '-p', '--model', 'claude-haiku-4-5-20251001', '--system-prompt', sys,
    '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
    '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode,AskUserQuestion',
    '--max-turns', '1',
  ], {
    input: `<agent_activity>\n${activity}\n</agent_activity>\n\n<query>\n${query}\n</query>\n\n<results>\n${results}\n</results>`,
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: childEnv(), windowsHide: true,
  });
  if (res.status !== 0) return { error: 'exit ' + res.status + ' ' + (res.stderr||'').slice(0,120) };
  let t; try { t = JSON.parse(res.stdout).result; } catch { t = res.stdout; }
  const m = String(t).match(/\{[\s\S]*\}/);
  if (!m) return { error: 'no JSON: ' + String(t).slice(0,120) };
  try { return JSON.parse(m[0]); } catch (e) { return { error: 'parse: ' + e.message }; }
}

// ── CASE A: the corpus miss — five plausible-sounding but topically WRONG hits, structurally
// representative of what a real corpus miss looks like (each superficially adjacent to the
// query, none actually answering it). Deliberately drawn from an UNRELATED fictional domain (an
// e-commerce order/fulfillment service) — this package has no decision-doc history of its own to
// draw on, and topics that happened to shadow a real internal architecture doc were flagged and
// replaced here; a triage test needs plausible-but-wrong shape, not real subject matter.
const A_ACTIVITY = `ASSISTANT: I need to understand the number-coercion bug. A field declared 'number' reads back as the string "10" while the write validator demands a Number, so record_update 400s on a field I never sent. Let me work out where the type is lost.`;
const A_QUERY = 'How does the storage layer lose a number field type on read, and what fixes it?';
const A_RESULTS = [
  '- [decision, ledger] Currency amounts are stored as integer minor units, never floats, to avoid rounding drift across the ledger service. `doc-0101` (document_get)',
  '- [decision, catalog] Inventory count reconciliation: a nightly job diffs the cached count against the source of truth and heals drift. `doc-0102` (document_get)',
  '- [decision, integration] Outbound webhook retry budget: exponential backoff capped at five attempts before dead-lettering. `doc-0103` (document_get)',
  '- [decision, shipping] Shipment tracking numbers use a checked-digit scheme, adopted after a carrier integration rejected malformed values. `doc-0104` (document_get)',
  '- [decision, address] Postal codes are stored as strings, never parsed as numbers, to preserve a leading zero. `doc-0105` (document_get)',
].join('\n');

// ── CASE B: the real hit — one genuinely relevant result among plausible noise, structurally
// representative of what recall surfacing something that actually changes course looks like. The
// noise items are the same unrelated fictional fulfillment domain as CASE A; only the one real
// hit is genuinely self-referential (hybrid-search score behavior this package's own recall.mjs
// depends on and documents in its README/config).
const B_ACTIVITY = `ASSISTANT: The score field is pure rank-fusion order so it carries no relevance signal. semanticScore does discriminate — real hits top out at 0.48-0.54, the corpus miss is 0.334 and flat. I am going to propose an absolute similarity floor on semanticScore at around 0.4.`;
const B_QUERY = 'Can an absolute similarity floor be used to filter hybrid search results?';
const B_RESULTS = [
  '- [decision, search] Recalibrate the minimum relevance threshold after a tuning pass compressed the score scale and collapsed the relevant-vs-noise margin; the floor was lowered to compensate. `doc-0110` (document_get)',
  '- [decision, integration] Outbound webhook retry budget: exponential backoff capped at five attempts before dead-lettering. `doc-0103` (document_get)',
  '- [decision, billing] Order refunds are metered as negative usage, symmetric with the original charge. `doc-0106` (document_get)',
  '- [runbook, ops] Disaster-recovery drill: RTO/RPO targets and how to validate a restore of the fulfillment database. `doc-0107` (document_get)',
  '- [decision, support] Support-ticket priority score: a weighted rubric of SLA age and account tier. `doc-0108` (document_get)',
].join('\n');

console.log('=== CASE A — corpus MISS (five plausible-but-wrong hits) ===');
console.log('    MUST return keep: []  (old behaviour: all five injected as confident citations)');
const a = triage(A_ACTIVITY, A_QUERY, A_RESULTS);
console.log('  -> ' + JSON.stringify(a));
check('CORPUS MISS: triage keeps NOTHING (five plausible-but-wrong hits)', !a.error && Array.isArray(a.keep) && a.keep.length === 0, JSON.stringify(a));

console.log('\n=== CASE B — real HIT (the one result that actually changed this session\'s course) ===');
console.log('    MUST keep doc-0110, and ideally flag the CONTRADICTION (an absolute floor was rejected)');
const b = triage(B_ACTIVITY, B_QUERY, B_RESULTS);
console.log('  -> ' + JSON.stringify(b));
const keptRight = Array.isArray(b.keep) && b.keep.includes('doc-0110');
const droppedNoise = Array.isArray(b.keep) && !b.keep.includes('doc-0106') && !b.keep.includes('doc-0107');
check('REAL HIT: triage keeps the relevant hit (the one that changed this session)', keptRight, JSON.stringify(b));
check('REAL HIT: the billing/DR noise is dropped', droppedNoise);
console.log(`  flagged contradiction? ${!!b.contradiction}  ${b.contradiction ? '-> "' + b.contradiction + '"' : '(null — acceptable, it is the rare channel)'}`);

done();
