// rollAtomic: the history must SURVIVE, and the roll must not lose concurrent appends.
// The old rotateAtomic discarded everything past the last 2000 lines — that is the bug.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const mod = async (f) => import(pathToFileURL(path.join(DIR, f)).href);
const { rollAtomic, logGenerations } = await mod('atomic.mjs');

const TMP = path.join(os.tmpdir(), 'roll-test-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
const LOG = path.join(TMP, 'hooks.log');
const clean = () => { for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f)); };

console.log('=== 1. a roll PRESERVES the head (the old code deleted it) ===');
fs.writeFileSync(LOG, Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n') + '\n');
rollAtomic(LOG, { keepGenerations: 5, stamp: 'gen1' });
console.log(`  live log exists after roll? ${fs.existsSync(LOG)}  (expect false — recreated on next append)`);
const archived = fs.readFileSync(LOG + '.gen1', 'utf8').split('\n').filter(Boolean);
eq('a roll PRESERVES every line (the old code discarded the head)', archived.length, 100);
check('the HEAD survived the roll', archived[0] === 'line-0');
check('the tail survived the roll', archived[99] === 'line-99');

console.log('\n=== 2. an appender recreates the live log; no lines lost across the roll ===');
fs.appendFileSync(LOG, 'after-roll-1\n');
fs.appendFileSync(LOG, 'after-roll-2\n');
const all = logGenerations(LOG);
const total = all.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
console.log(`  generations: ${all.length} (${all.map((f) => path.basename(f)).join(', ')})`);
eq('no lines lost across a roll + subsequent appends', total.length, 102);
console.log(`  a reader spans history? ${total.includes('line-0') && total.includes('after-roll-2')}`);

console.log('\n=== 3. generations are PRUNED to the cap (disk cannot grow forever) ===');
clean();
for (let g = 1; g <= 8; g++) {
  fs.writeFileSync(LOG, `gen-${g}-content\n`);
  rollAtomic(LOG, { keepGenerations: 3, stamp: `2026-07-16T00-0${g}-00` });
}
const kept = fs.readdirSync(TMP).sort();
eq('generations are pruned to the cap', kept.length, 3);
check('pruning keeps the NEWEST generations', kept.some((f) => f.endsWith('00-08-00')));
check('pruning drops the oldest', !kept.some((f) => f.endsWith('00-01-00')));

console.log('\n=== 4. rolling a nonexistent file is a no-op, not a throw ===');
clean();
console.log(`  rollAtomic(missing) -> ${rollAtomic(LOG, { keepGenerations: 3, stamp: 'x' })}  (expect false, no exception)`);

console.log('\n=== 5. logGenerations ignores .tmp leftovers (a failed writeFileAtomic) ===');
fs.writeFileSync(LOG, 'live\n');
fs.writeFileSync(LOG + '.9999.tmp', 'garbage\n');
fs.writeFileSync(LOG + '.gen-real', 'archived\n');
const g = logGenerations(LOG).map((f) => path.basename(f));
console.log(`  generations: ${g.join(', ')}`);
check('logGenerations excludes writeFileAtomic .tmp leftovers', !g.some((f) => f.endsWith('.tmp')));
check('the live log sorts LAST (newest)', g[g.length - 1] === 'hooks.log');

clean(); fs.rmdirSync(TMP);
done();
