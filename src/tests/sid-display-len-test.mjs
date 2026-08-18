// RED-PROOF: every place that truncates a session id for DISPLAY (hooklog.mjs's `[abc12345]`
// bracket, nudge.mjs/recall.mjs's ORPHAN-NUDGE text, report.mjs's tables, sweep.mjs's diagnostic
// lines) has to use the exact same length, or an id copied from one place silently stops matching
// what another place expects — dispose.mjs's prefix resolution depends on this agreement
// specifically. A shared constant only prevents drift if nothing re-hardcodes the number instead
// of importing it; this file is the mechanical check that nothing does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { blank } from './lintlib.mjs';
import './isolate.mjs';
import { SID_DISPLAY_LEN } from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.dirname(HERE);
const RUNTIME = fs.readdirSync(HOOKS).filter((f) => f.endsWith('.mjs')).sort();

console.log(`=== SID_DISPLAY_LEN (${SID_DISPLAY_LEN}) — every display truncation shares it, none re-hardcode ===`);

check('the constant itself is the value every caller assumes', SID_DISPLAY_LEN === 8, `got ${SID_DISPLAY_LEN}`);

// A bare `.slice(0, 8)` outside paths.mjs's own definition is a truncation that did NOT import
// the shared constant — exactly the drift this file exists to catch. Scoped to the LITERAL 8, not
// every `.slice(0, N)`: this codebase truncates plenty of other things (bodies, error messages,
// timestamps) to plenty of other lengths, and none of those are session-id display truncations or
// have anything to do with SID_DISPLAY_LEN. paths.mjs itself is exempt: it's where the literal `8`
// is allowed to live, once.
const BARE_SLICE = /\.slice\(0,\s*8\)/g;
const offenders = [];
for (const f of RUNTIME) {
  if (f === 'paths.mjs') continue;
  const code = blank(fs.readFileSync(path.join(HOOKS, f), 'utf8'));
  for (const m of code.matchAll(BARE_SLICE)) {
    offenders.push(`${f}:${code.slice(0, m.index).split('\n').length}  ${m[0]}`);
  }
}
for (const o of offenders) console.log(`  RE-HARDCODED  ${o}`);
eq('no runtime file re-hardcodes a numeric .slice(0, N) instead of importing SID_DISPLAY_LEN', offenders.length, 0);

check('RED-proof: a re-hardcoded slice IS caught',
  [...blank('const x = sid.slice(0, 8);\n').matchAll(BARE_SLICE)].length === 1);
check('RED-proof: the shared-constant form is NOT caught',
  [...blank('const x = sid.slice(0, SID_DISPLAY_LEN);\n').matchAll(BARE_SLICE)].length === 0);

// Every module known to truncate a session id for display actually imports the constant — a
// weaker, file-level version of the same check, cheap to keep in sync by name if a new one is
// added later.
const EXPECTED_IMPORTERS = ['hooklog.mjs', 'nudge.mjs', 'recall.mjs', 'report.mjs', 'sweep.mjs', 'dispose.mjs'];
for (const f of EXPECTED_IMPORTERS) {
  const code = fs.readFileSync(path.join(HOOKS, f), 'utf8');
  check(`${f} imports SID_DISPLAY_LEN from paths.mjs`, /import\s*\{[^}]*\bSID_DISPLAY_LEN\b[^}]*\}\s*from\s*['"]\.\/paths\.mjs['"]/.test(code), code.slice(0, 200));
}

done();
