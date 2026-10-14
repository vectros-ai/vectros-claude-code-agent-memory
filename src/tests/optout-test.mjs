#!/usr/bin/env node
/**
 * THE OPT-OUT, IN PROCESS — the matching rules, the config resolution, the live decision, and the
 * four background paths that act on OTHER sessions' leftovers (the tail sweep, the cross-session
 * nudge, the orphan cap, the spool drain). `optout-hooks-test.mjs` drives the real hook binaries;
 * this file is where the edge cases are cheap.
 *
 * Directory strings are fixtures (`C:\work\clientA`-style); nothing here names a real project.
 * Windows rules are asserted from ANY host by passing `platform`, so this file means the same thing
 * in CI on Linux as on a Windows workstation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { check, eq, done } from './assert.mjs';
import { privateRoot } from './isolate.mjs'; // MUST precede any runtime-state path use — see isolate.mjs.

privateRoot('optout-test');
process.env.VECTROS_HOOKLOG_PATH = path.join(process.env.VECTROS_MEMORY_HOME, 'hooks.log');
process.env.VECTROS_API_KEY = 'ssk_test_fake_for_unit_tests';
// The harness's own session may be running inside a Claude Code session with these set.
delete process.env.VECTROS_MEMORY_OFF;
delete process.env.CLAUDE_PROJECT_DIR;

const {
  normalizeDir, dirUnder, optOutEnvOn, optOutDecision, sessionLocations, originDirs,
  transcriptDirUnder, excludedSessionCheck,
} = await import('../exclusion.mjs');
const { resolveConfig, parseExcludedDirectories, reportConfig } = await import('../config.mjs');
const { append, read: readQueue, markCwd } = await import('../queue.mjs');
const { stateDir, queueDir, stateFor, spoolOffFile, verdictMutationsOffFile } = await import('../paths.mjs');

const WIN = { platform: 'win32', realpath: false };
const POSIX = { platform: 'linux', realpath: false };
const MAC = { platform: 'darwin', realpath: false };

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 1. directory matching — Windows ===');
{
  const ex = ['C:\\work\\clientA'];
  check('the directory itself', dirUnder('C:\\work\\clientA', ex, WIN));
  check('a trailing separator on the session directory', dirUnder('C:\\work\\clientA\\', ex, WIN));
  check('a trailing separator on the list entry', dirUnder('C:\\work\\clientA', ['C:\\work\\clientA\\'], WIN));
  check('a subdirectory IS excluded', dirUnder('C:\\work\\clientA\\src\\deep', ex, WIN));
  check('case-insensitive on win32', dirUnder('c:\\WORK\\CLIENTa\\src', ex, WIN));
  check('forward slashes in the session directory', dirUnder('C:/work/clientA/src', ex, WIN));
  check('forward slashes in the list entry', dirUnder('C:\\work\\clientA\\src', ['C:/work/clientA'], WIN));
  check('mixed separators on both sides', dirUnder('C:/work\\clientA/src', ['C:\\work/clientA'], WIN));
  check('doubled separators collapse', dirUnder('C:\\work\\\\clientA\\src', ex, WIN));
  check('a `..` segment is resolved before comparing', dirUnder('C:\\work\\other\\..\\clientA\\x', ex, WIN));
  check('a `..` that LEAVES the directory is not excluded', !dirUnder('C:\\work\\clientA\\..\\other', ex, WIN));

  // THE PREFIX-SIBLING CASES — the whole reason the boundary is a separator and not a character.
  check('PREFIX SIBLING `clientAX` is NOT excluded', !dirUnder('C:\\work\\clientAX', ex, WIN));
  check('a sibling that continues with `-` is NOT excluded', !dirUnder('C:\\work\\clientA-old', ex, WIN));
  check('a sibling that continues with `.` is NOT excluded', !dirUnder('C:\\work\\clientA.bak\\src', ex, WIN));
  check('a PARENT of the excluded directory is NOT excluded', !dirUnder('C:\\work', ex, WIN));
  check('a different drive is NOT excluded', !dirUnder('D:\\work\\clientA', ex, WIN));
  check('a shorter prefix is NOT excluded', !dirUnder('C:\\work\\client', ex, WIN));

  check('a drive root entry covers the whole drive', dirUnder('C:\\anything\\at\\all', ['C:\\'], WIN));
  check('...but not another drive', !dirUnder('D:\\anything', ['C:\\'], WIN));
  check('a UNC share entry', dirUnder('\\\\srv\\share\\clientA\\x', ['\\\\srv\\share\\clientA'], WIN));
  check('...and its prefix sibling is not', !dirUnder('\\\\srv\\share\\clientAX', ['\\\\srv\\share\\clientA'], WIN));
  check('several entries: any one matches', dirUnder('C:\\b\\x', ['C:\\a', 'C:\\b'], WIN));
  check('an empty list excludes nothing', !dirUnder('C:\\work\\clientA', [], WIN));
  check('an empty session directory is not excluded (and does not throw)', !dirUnder('', ex, WIN));
  // Path FORMS a Windows session can report: the same place, spelled differently.
  check('a `\\?\` extended-length cwd', dirUnder('\\\\?\\C:\\work\\clientA\\src', ex, WIN));
  check('a `\\?\UNC\` cwd matches a UNC entry', dirUnder('\\\\?\\UNC\\srv\\share\\clientA\\x', ['\\\\srv\\share\\clientA'], WIN));
  check('a trailing dot on a component (`clientA.` is `clientA` to Windows)', dirUnder('C:\\work\\clientA.\\src', ex, WIN));
  check('a trailing dot on the last component', dirUnder('C:\\work\\clientA.', ex, WIN));
  check('trailing spaces on a component', dirUnder('C:\\work\\clientA \\src', ex, WIN));
  check('...but a dot INSIDE a name is still a different directory', !dirUnder('C:\\work\\client.A', ex, WIN));
  check('...and `clientA.bak` is still a sibling', !dirUnder('C:\\work\\clientA.bak', ex, WIN));
  eq('normalizeDir: one spelling', normalizeDir('C:/Work//ClientA\\', 'win32'), 'c:\\work\\clienta');
  eq('normalizeDir: a root keeps its separator', normalizeDir('C:\\', 'win32'), 'c:\\');
}

console.log('\n=== 2. directory matching — POSIX and macOS ===');
{
  const ex = ['/work/clientA'];
  check('subdirectory', dirUnder('/work/clientA/src', ex, POSIX));
  check('trailing slash on both', dirUnder('/work/clientA/', ['/work/clientA/'], POSIX));
  check('CASE-SENSITIVE off Windows and macOS', !dirUnder('/work/clienta', ex, POSIX));
  check('prefix sibling is not excluded', !dirUnder('/work/clientAX', ex, POSIX));
  check('a backslash is an ordinary filename character, not a separator', !dirUnder('/work/clientA\\src', ['/work/clientA/src'], POSIX));
  check('macOS folds case', dirUnder('/Work/CLIENTA/src', ex, MAC));
  check('macOS still respects the boundary', !dirUnder('/work/clientAX', ex, MAC));
  check('the root entry covers everything', dirUnder('/anything', ['/'], POSIX));
}

console.log('\n=== 3. real paths: a symlink or junction into an excluded directory is caught ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-link-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  const link = path.join(base, 'link');
  let linked = true;
  try { fs.symlinkSync(real, link, 'junction'); } catch { /* silence-ok: some CI sandboxes forbid links; the test then says so below instead of passing vacuously. */ linked = false; }
  if (!linked) {
    console.log('  SKIP  could not create a symlink/junction on this host');
  } else {
    check('the entry names the LINK, the session reports the TARGET', dirUnder(path.join(real, 'sub'), [link]));
    check('the entry names the TARGET, the session started through the LINK', dirUnder(path.join(link, 'sub'), [real]));
    check('an unrelated directory is untouched', !dirUnder(path.join(base, 'elsewhere'), [link]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. config: EXCLUDED_DIRECTORIES / INCLUDED_DIRECTORIES ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-cfg-'));
  const write = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); return f; };
  const resolve = (file) => resolveConfig({ file, env: {} });

  const VALID0 = process.platform === 'win32' ? 'C:\\work\\clientA' : '/work/clientA';
  const none = resolve(path.join(tmp, 'absent.json'));
  eq('no config file: nothing excluded, nothing included, no problem', [none.excluded.dirs, none.excluded.included, none.excluded.problem], [[], [], null]);
  const empty = resolve(write('empty.json', {}));
  eq('a config without the keys: the safe default is empty', [empty.excluded.dirs, empty.excluded.included, empty.excluded.problem], [[], [], null]);

  const good = resolve(write('good.json', { EXCLUDED_DIRECTORIES: [process.platform === 'win32' ? 'C:\\work\\clientA' : '/work/clientA'], INCLUDED_DIRECTORIES: [process.platform === 'win32' ? 'C:\\work' : '/work'] }));
  eq('valid lists resolve', [good.excluded.dirs.length, good.excluded.included.length, good.excluded.problem], [1, 1, null]);
  check('the keys are not reported as UNKNOWN', !good.unknown.includes('EXCLUDED_DIRECTORIES') && !good.unknown.includes('INCLUDED_DIRECTORIES'), good.unknown.join(','));

  const existing = resolve(write('existing.json', { CONTEXT_CAP: 8000 }));
  eq('an EXISTING config (other keys only) is untouched', [existing.values.CONTEXT_CAP, existing.excluded.problem], [8000, null]);

  // FAIL CLOSED — every way the list can be unusable is a `problem`, never "no exclusions".
  const damaged = resolve(write('damaged.json', '{ "EXCLUDED_DIRECTORIES": ['));
  check('a malformed config file is a problem (fail closed)', !!damaged.excluded.problem, JSON.stringify(damaged.excluded));
  const dirAsFile = resolve(tmp);
  check('an unreadable config file is a problem (fail closed)', !!dirAsFile.excluded.problem, JSON.stringify(dirAsFile.excluded));
  check('a non-object root is a problem', !!resolve(write('arr.json', '[1]')).excluded.problem);
  check('a string instead of an array is a problem', !!resolve(write('str.json', { EXCLUDED_DIRECTORIES: '/work/clientA' })).excluded.problem);
  check('null is a problem', !!resolve(write('null.json', { EXCLUDED_DIRECTORIES: null })).excluded.problem);
  check('a non-string entry is a problem', !!resolve(write('num.json', { EXCLUDED_DIRECTORIES: [1] })).excluded.problem);
  check('an empty-string entry is a problem', !!resolve(write('blank.json', { EXCLUDED_DIRECTORIES: ['  '] })).excluded.problem);
  check('a RELATIVE entry is a problem', !!resolve(write('rel.json', { EXCLUDED_DIRECTORIES: ['clientA'] })).excluded.problem);
  check('an invalid INCLUDED_DIRECTORIES is a problem too (a broken allow-list must not read as "no restriction")',
    !!resolve(write('badinc.json', { INCLUDED_DIRECTORIES: 'x' })).excluded.problem);
  // A near-miss key must not fail OPEN: the contract is case-sensitive, so a typo is a problem.
  for (const k of ['excludedDirectories', 'Excluded_Directories', 'EXCLUDED_DIRS', 'EXCLUDE_DIRECTORIES', 'included_dirs', 'INCLUDE_DIRECTORIES']) {
    const r = resolve(write(`typo-${k}.json`, { [k]: ['/work/clientA'] }));
    check(`the near-miss key "${k}" is a problem (fail closed), not "UNKNOWN key ignored"`, !!r.excluded.problem && r.excluded.problem.includes(k), JSON.stringify(r.excluded));
  }
  check('an unrelated unknown key is still just reported', resolve(write('other.json', { SOME_OTHER_KEY: 1 })).excluded.problem === null);
  // Pin the ruled fail-closed behaviour for the damage a hand-edited file commonly has.
  const bom = resolve(write('bom.json', '\uFEFF' + JSON.stringify({ EXCLUDED_DIRECTORIES: [VALID0], CONTEXT_CAP: 8000 })));
  eq('a UTF-8 BOM before the JSON is stripped: the list applies and other settings too', [bom.excluded.problem, bom.excluded.dirs, bom.values.CONTEXT_CAP], [null, [VALID0], 8000]);
  check('a BOM before INVALID json is still a problem', !!resolve(write('bom-bad.json', '\uFEFF{ nope')).excluded.problem);
  const u16 = path.join(tmp, 'utf16.json');
  fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify({ EXCLUDED_DIRECTORIES: [VALID0] }), 'utf16le')]));
  const u16r = resolve(u16);
  check('a UTF-16 file is a problem (fail closed) with its SPECIFIC cause', !!u16r.excluded.problem && /UTF-16/.test(u16r.excluded.problem), JSON.stringify(u16r.excluded));
  const bs = resolve(write('backslash.json', '{"EXCLUDED_DIRECTORIES": ["C:\\work\\clientA"]}'));
  check('an unescaped backslash is a problem (fail closed) with its SPECIFIC cause', !!bs.excluded.problem && /unescaped backslash/.test(bs.excluded.problem), JSON.stringify(bs.excluded));
  const okEsc = resolve(write('escaped-but-broken.json', '{"EXCLUDED_DIRECTORIES": ["C:\\\\work\\\\clientA"],}'));
  check('a CORRECTLY escaped path in an otherwise broken file does not get the backslash hint', !!okEsc.excluded.problem && !/backslash/.test(okEsc.excluded.problem), JSON.stringify(okEsc.excluded));
  check('an empty (zero-byte) file is a problem (fail closed)', !!resolve(write('zero.json', '')).excluded.problem);
  check('a trailing comma is a problem (fail closed)', !!resolve(write('comma.json', '{"CONTEXT_CAP": 8000,}')).excluded.problem);
  const VALID = process.platform === 'win32' ? 'C:\\ok' : '/ok';
  check('(precondition: the fixture path is valid on this platform)', parseExcludedDirectories([VALID]).ok);
  const half = resolve(write('half.json', { EXCLUDED_DIRECTORIES: [VALID], INCLUDED_DIRECTORIES: 5 }));
  check('a problem in one list voids both (no half-trusted state)', half.excluded.dirs.length === 0 && !!half.excluded.problem, JSON.stringify(half.excluded));
  check('win: a `\\\\?\\C:\\x` device path is refused (it would validate as UNC and never match)', !parseExcludedDirectories(['\\\\?\\C:\\x'], 'win32').ok);
  check('win: a `\\\\.\\` device path is refused', !parseExcludedDirectories(['\\\\.\\C:\\x'], 'win32').ok);

  // The parser, per platform.
  check('win: drive path ok', parseExcludedDirectories(['C:\\a'], 'win32').ok);
  check('win: forward-slash drive path ok', parseExcludedDirectories(['C:/a'], 'win32').ok);
  check('win: UNC ok', parseExcludedDirectories(['\\\\srv\\share\\a'], 'win32').ok);
  check('win: drive-relative `C:a` refused', !parseExcludedDirectories(['C:a'], 'win32').ok);
  check('win: rooted-but-driveless `\\a` refused', !parseExcludedDirectories(['\\a'], 'win32').ok);
  check('win: a POSIX path refused', !parseExcludedDirectories(['/a'], 'win32').ok);
  check('posix: absolute ok', parseExcludedDirectories(['/a/b'], 'linux').ok);
  check('posix: `~` refused', !parseExcludedDirectories(['~/a'], 'linux').ok);
  check('posix: a Windows path refused', !parseExcludedDirectories(['C:\\a'], 'linux').ok);
  check('a NUL byte refused', !parseExcludedDirectories(['/a\0b'], 'linux').ok);
  check('an empty array is valid (and means nothing)', parseExcludedDirectories([], 'linux').ok);

  // The receipt names the problem and the consequence, and NEVER echoes a configured path.
  const lines = [];
  reportConfig(resolve(write('leak.json', { EXCLUDED_DIRECTORIES: [process.platform === 'win32' ? 'C:\\ok' : '/ok', 'relative-clientZ-secret'] })), 'f', (h, m) => lines.push(m));
  check('the problem receipt says memory is OFF for every session', lines.some((l) => /memory is OFF for EVERY session/.test(l)), lines.join(' | '));
  check('...and does not echo the configured paths', !lines.some((l) => l.includes('clientZ')), lines.join(' | '));
  const okLines = [];
  reportConfig(good, 'f', (h, m) => okLines.push(m));
  eq('a VALID list produces no receipt line at all (nothing per process, nothing sensitive)', okLines, []);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 5. VECTROS_MEMORY_OFF ===');
{
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) check(`"${v}" turns it on`, optOutEnvOn({ VECTROS_MEMORY_OFF: v }));
  for (const v of [undefined, '', '  ', '0', 'false', 'no', 'FALSE']) check(`${JSON.stringify(v)} leaves it off`, !optOutEnvOn({ VECTROS_MEMORY_OFF: v }));
}

console.log('\n=== 6. the live decision ===');
{
  const cfg = (dirs = [], included = [], problem = null) => ({ dirs, included, problem });
  const D = (over) => optOutDecision({ platform: 'win32', config: cfg(), env: {}, ...over });

  eq('CONTROL: nothing configured → run', D({ input: { cwd: 'C:\\work\\clientA' } }), null);
  eq('env switch', D({ input: { cwd: 'C:\\work\\x' }, env: { VECTROS_MEMORY_OFF: '1' } })?.trigger, 'env');
  eq('env switch beats everything, even with no payload', D({ input: null, env: { VECTROS_MEMORY_OFF: '1' } })?.trigger, 'env');
  eq('an excluded directory', D({ input: { cwd: 'C:\\work\\clientA\\src' }, config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('a prefix sibling runs', D({ input: { cwd: 'C:\\work\\clientAX' }, config: cfg(['C:\\work\\clientA']) }), null);
  eq('the label never carries the directory', /clientA/.test(D({ input: { cwd: 'C:\\work\\clientA' }, config: cfg(['C:\\work\\clientA']) }).label), false);

  // CLAUDE_PROJECT_DIR does not move when a command cd's.
  eq('the project dir excludes a session whose cwd has drifted OUT of the directory',
    D({ input: { cwd: 'C:\\elsewhere' }, env: { CLAUDE_PROJECT_DIR: 'C:\\work\\clientA' }, config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('...and the payload cwd excludes a session whose project dir is elsewhere',
    D({ input: { cwd: 'C:\\work\\clientA' }, env: { CLAUDE_PROJECT_DIR: 'C:\\elsewhere' }, config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('no payload cwd: the project dir still decides',
    D({ input: {}, env: { CLAUDE_PROJECT_DIR: 'C:\\work\\clientA' }, config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('an UNPARSEABLE payload still gets the directory rule, via the process directory',
    D({ input: null, cwd: () => 'C:\\work\\clientA', config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('sessionLocations: payload cwd, project dir, de-duplicated', sessionLocations({ cwd: 'C:\\a' }, { CLAUDE_PROJECT_DIR: 'C:\\a' }, () => 'C:\\proc', 'win32'), ['C:\\a']);
  eq('sessionLocations: the process directory only as a last resort', sessionLocations({}, {}, () => 'proc'), ['proc']);
  eq('a RELATIVE cwd is resolved against the process directory, not compared as written',
    sessionLocations({ cwd: 'clientA\\src' }, {}, () => 'C:\\work', 'win32'), ['C:\\work\\clientA\\src']);
  eq('...so a relative cwd inside an excluded directory is excluded',
    D({ input: { cwd: '.' }, cwd: () => 'C:\\work\\clientA', config: cfg(['C:\\work\\clientA']) })?.trigger, 'directory');
  eq('originDirs keeps BOTH the working directory and the project directory', originDirs({ cwd: 'moved' }, { CLAUDE_PROJECT_DIR: 'start' }), { cwd: 'moved', projectDir: 'start' });
  eq('originDirs: either may be absent', [originDirs({ cwd: 'here' }, {}), originDirs({}, { CLAUDE_PROJECT_DIR: 'p' })], [{ cwd: 'here', projectDir: '' }, { cwd: '', projectDir: 'p' }]);
  eq('originDirs is empty when nothing is known', originDirs({}, {}), { cwd: '', projectDir: '' });

  // FAIL CLOSED.
  eq('an unusable list excludes every session', D({ input: { cwd: 'C:\\anything' }, config: cfg([], [], 'broken') })?.trigger, 'config');

  // INCLUSION.
  const inc = cfg([], ['C:\\work']);
  eq('inside an included root → run', D({ input: { cwd: 'C:\\work\\mine\\src' }, config: inc }), null);
  eq('outside every included root → off', D({ input: { cwd: 'C:\\clients\\z' }, config: inc })?.trigger, 'not-included');
  eq('a prefix sibling of the included root is OUTSIDE it', D({ input: { cwd: 'C:\\workshop' }, config: inc })?.trigger, 'not-included');
  eq('started inside the included root but the project dir is outside → off (every location must be inside)',
    D({ input: { cwd: 'C:\\work\\a' }, env: { CLAUDE_PROJECT_DIR: 'C:\\other' }, config: inc })?.trigger, 'not-included');
  eq('EXCLUSION WINS over an inclusion that covers the same place',
    D({ input: { cwd: 'C:\\work\\clientA\\x' }, config: cfg(['C:\\work\\clientA'], ['C:\\work']) })?.trigger, 'directory');
  eq('...while the rest of the included root still runs',
    D({ input: { cwd: 'C:\\work\\mine' }, config: cfg(['C:\\work\\clientA'], ['C:\\work']) }), null);
  eq('an EMPTY inclusion list means no restriction', D({ input: { cwd: 'C:\\anywhere' }, config: cfg([], []) }), null);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 7. a transcript\'s project directory is the legacy origin ===');
{
  const t = (proj) => `C:\\Users\\u\\.claude\\projects\\${proj}\\abc.jsonl`;
  check('encoded project dir equals the excluded directory', transcriptDirUnder(t('C--work-clientA'), ['C:\\work\\clientA'], 'win32'));
  check('...a subdirectory of it', transcriptDirUnder(t('C--work-clientA-src-deep'), ['C:\\work\\clientA'], 'win32'));
  check('...case-insensitively on win32', transcriptDirUnder(t('c--WORK-CLIENTA'), ['C:\\work\\clientA'], 'win32'));
  check('a different project is not matched', !transcriptDirUnder(t('C--work-other'), ['C:\\work\\clientA'], 'win32'));
  check('a longer NAME with no separator is not matched (`clientAX`)', !transcriptDirUnder(t('C--work-clientAX'), ['C:\\work\\clientA'], 'win32'));
  check('a path that is not Claude Code\'s projects layout infers nothing', !transcriptDirUnder('C:\\tmp\\C--work-clientA\\abc.jsonl', ['C:\\work\\clientA'], 'win32'));
  check('no transcript path: nothing inferred', !transcriptDirUnder(null, ['C:\\work\\clientA'], 'win32'));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 8. the queue records where a session started ===');
{
  const sid = randomUUID();
  eq('a fresh queue has no origin', readQueue(sid).cwd, null);
  append(sid, { op: 'captured', offset: 5 });
  eq('a queue with no cwd event folds cwd:null (every return has the same shape)', readQueue(sid).cwd, null);
  markCwd(sid, 'C:\\work\\first');
  markCwd(sid, 'C:\\work\\second');
  eq('the FIRST cwd event wins — it answers "where did this start"', readQueue(sid).cwd, 'C:\\work\\first');
  check('a cwd event is metadata: no candidate, offset untouched', readQueue(sid).pending.length === 0 && readQueue(sid).offset === 5);
  append(sid, { op: 'cwd', cwd: '' });
  eq('an empty cwd is ignored', readQueue(sid).cwd, 'C:\\work\\first');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 9. excludedSessionCheck — the background paths\' question ===');
const EXD = process.platform === 'win32' ? 'C:\\work\\clientA' : '/work/clientA';
const OKD = process.platform === 'win32' ? 'C:\\work\\mine' : '/work/mine';
const ROOT = process.platform === 'win32' ? 'C:\\work' : '/work';
const sub = (d, ...p) => path.join(d, ...p);
const seedState = (sid, over) => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(stateFor(sid), JSON.stringify(over)); };
{
  const cfg = (dirs = [], included = [], problem = null) => ({ dirs, included, problem });
  const mk = (config) => excludedSessionCheck({ config });

  const sQ = randomUUID(); markCwd(sQ, sub(EXD, 'src'));
  const sS = randomUUID(); seedState(sS, { cwd: EXD, transcriptPath: '/t/x.jsonl' });
  const sOk = randomUUID(); markCwd(sOk, OKD); seedState(sOk, { cwd: OKD });
  const sNone = randomUUID();

  eq('nothing configured: nothing excluded, and no file is even read', [mk(cfg())(sQ), mk(cfg())(sS)], [false, false]);
  const check1 = mk(cfg([EXD]));
  eq('origin recorded in the QUEUE', check1(sQ), true);
  eq('origin recorded in STATE', check1(sS), true);
  eq('an unrelated session is not excluded', check1(sOk), false);
  eq('a session with NO recorded origin predates the feature: not excluded', check1(sNone), false);

  // THE LIST CHANGED AFTER CAPTURE — the case the recorded origin exists for.
  const late = randomUUID(); markCwd(late, OKD);
  eq('captured while its directory was not excluded → not excluded then', mk(cfg([EXD]))(late), false);
  eq('the SAME session, once its directory is added to the list → excluded now', mk(cfg([EXD, OKD]))(late), true);

  eq('an unusable list clears no session', [mk(cfg([], [], 'broken'))(sOk), mk(cfg([], [], 'broken'))(sNone)], [true, true]);

  // Legacy: only a transcript path.
  const legacy = randomUUID();
  const enc = EXD.replace(/[^A-Za-z0-9]/g, '-');
  seedState(legacy, { transcriptPath: path.join(os.homedir(), '.claude', 'projects', enc, `${legacy}.jsonl`) });
  eq('a session with only a transcript path is matched by its project directory', check1(legacy), true);

  // Known facts supplied by the caller are used instead of re-reading.
  eq('caller-supplied origins are used instead of re-reading', excludedSessionCheck({ config: cfg([EXD]) })(randomUUID(), { queueDirs: [EXD], stateDirs: [], transcriptPath: null }), true);

  // BOTH recorded origins count. The project directory can be a PARENT of a directory excluded later.
  const parent = randomUUID(); markCwd(parent, sub(EXD, 'src'), ROOT);
  eq('project dir is a PARENT of the later-excluded directory, cwd is inside it → excluded (any origin)', mk(cfg([EXD]))(parent), true);
  const parentState = randomUUID(); seedState(parentState, { cwd: sub(EXD, 'src'), projectDir: ROOT });
  eq('...the same when the two are recorded in STATE', mk(cfg([EXD]))(parentState), true);
  eq('a session recorded only at the parent project dir is NOT excluded (documented limit: nothing says it was ever inside)', (() => { const p = randomUUID(); markCwd(p, '', ROOT); return mk(cfg([EXD]))(p); })(), false);
  const split = randomUUID(); markCwd(split, OKD, ROOT);
  eq('allow-list: cwd inside the root but the PROJECT dir outside it → not admitted (ALL origins must be inside)', mk(cfg([], [OKD]))(split), true);
  const bothIn = randomUUID(); markCwd(bothIn, sub(OKD, 'a'), OKD);
  eq('allow-list: every recorded origin inside → admitted', mk(cfg([], [OKD]))(bothIn), false);

  // Inclusion.
  const inc = mk(cfg([], [ROOT]));
  eq('inclusion: a session recorded inside the root runs', inc(sOk), false);
  eq('inclusion: a session recorded OUTSIDE it is left alone', mk(cfg([], [OKD]))(sQ), true);
  eq('inclusion: a session with NO origin cannot be shown to be inside → left alone', inc(sNone), true);
  const both = mk(cfg([EXD], [ROOT]));
  eq('inclusion + exclusion: the exclusion wins inside an included root', both(sQ), true);
  eq('inclusion + exclusion: the rest of the root still runs', both(sOk), false);
  const legacyInc = randomUUID();
  seedState(legacyInc, { transcriptPath: path.join(os.homedir(), '.claude', 'projects', OKD.replace(/[^A-Za-z0-9]/g, '-'), `${legacyInc}.jsonl`) });
  eq('inclusion: a legacy session with NO recorded origin is NOT admitted, even if its transcript folder matches', mk(cfg([], [ROOT]))(legacyInc), true);
  const legacySibling = randomUUID();
  const siblingOfIncluded = OKD + '-secret';
  seedState(legacySibling, { transcriptPath: path.join(os.homedir(), '.claude', 'projects', siblingOfIncluded.replace(/[^A-Za-z0-9]/g, '-'), `${legacySibling}.jsonl`) });
  eq('inclusion: the lossy folder match must not admit a sibling (`mine-secret` under `mine`)', mk(cfg([], [OKD]))(legacySibling), true);

  // THE LOSSY TRANSCRIPT MATCH IS FOR SESSIONS WITH NO RECORDED ORIGIN ONLY.
  const siblingDir = EXD + '-new';
  const projectOf = (d) => path.join(os.homedir(), '.claude', 'projects', d.replace(/[^A-Za-z0-9]/g, '-'));
  const sibling = randomUUID();
  markCwd(sibling, siblingDir);
  seedState(sibling, { transcriptPath: path.join(projectOf(siblingDir), `${sibling}.jsonl`) });
  eq('a sibling that continues an excluded name with `-`, WITH a recorded origin, is NOT excluded (the exact check decides)', check1(sibling), false);
  const siblingNoOrigin = randomUUID();
  seedState(siblingNoOrigin, { transcriptPath: path.join(projectOf(siblingDir), `${siblingNoOrigin}.jsonl`) });
  eq('...while the same folder name with NO recorded origin is excluded by the approximation (documented, safe direction)', check1(siblingNoOrigin), true);

  // An origin the check cannot read fails closed.
  const unreadable = excludedSessionCheck({ config: cfg([EXD]), readOrigins: () => ({ dirs: [], transcriptPath: null, unreadable: true }) });
  eq('a session whose files cannot be read is not cleared', unreadable(sNone), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 10. the tail sweep leaves an excluded session\'s transcript alone ===');
{
  const { runSweep } = await import('../sweep.mjs');
  const DAY = 24 * 3600 * 1000;
  const mkTranscript = (name) => {
    const f = path.join(os.tmpdir(), `optout-${name}-${randomUUID()}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(6000) } }) + '\n');
    return f;
  };
  const stale = (over) => ({ transcriptPath: mkTranscript('t'), lastStopAt: Date.now() - 3 * DAY, ...over });
  const ex = randomUUID(); seedState(ex, stale({ cwd: EXD }));
  const exQ = randomUUID(); seedState(exQ, stale({})); markCwd(exQ, sub(EXD, 'deep'));
  const ok = randomUUID(); seedState(ok, stale({ cwd: OKD }));
  const marker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optout-sweep-')), 'last-swept');
  const run = (config, max = 10) => {
    const spawned = [];
    const r = runSweep('me', Date.now(), {
      marker: marker(), max, debounceMs: 1,
      deps: {
        spawn: (...a) => { spawned.push(a[1][1]); return { unref() {} }; },
        claim: () => ({ proceed: true, owned: true }), release: () => 'released', isHeld: () => false,
        markSwept: () => true, isExcluded: excludedSessionCheck({ config }),
      },
    });
    return { r, spawned };
  };

  const control = run({ dirs: [], included: [], problem: null });
  check('CONTROL: with no list the sweep flushes all three stale sessions', [ex, exQ, ok].every((s) => control.spawned.includes(s)), control.spawned.join(','));
  const guarded = run({ dirs: [EXD], included: [], problem: null });
  check('an excluded session (origin in STATE) is not flushed', !guarded.spawned.includes(ex), guarded.spawned.join(','));
  check('an excluded session (origin in the QUEUE) is not flushed', !guarded.spawned.includes(exQ), guarded.spawned.join(','));
  check('a session outside the list IS still flushed', guarded.spawned.includes(ok), guarded.spawned.join(','));
  const gone = run({ dirs: [], included: [], problem: 'broken' });
  eq('an unusable list flushes nothing', gone.spawned.length, 0);
  const inc = run({ dirs: [], included: [OKD], problem: null });
  check('an inclusion list flushes only what is inside it', inc.spawned.length === 1 && inc.spawned[0] === ok, inc.spawned.join(','));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 11. the cross-session nudge never offers an excluded session\'s candidates ===');
{
  const { orphanedPending } = await import('../sweep.mjs');
  const DAY = 24 * 3600 * 1000;
  const mkSession = (cwd) => {
    const sid = randomUUID();
    markCwd(sid, cwd);
    append(sid, { op: 'propose', externalId: randomUUID(), title: 't', body: 'b', kind: 'observation', dest: 'memory' });
    append(sid, { op: 'swept', residual: 9000 }); // flushed: the only kind the nudge offers
    seedState(sid, { cwd, lastStopAt: Date.now() - 3 * DAY });
    return sid;
  };
  const ex = mkSession(sub(EXD, 'x'));
  const ok = mkSession(OKD);
  const offered = (config) => orphanedPending(Date.now(), {
    staleMs: DAY, stateDir: stateDir(), queueDir: queueDir(), isExcluded: excludedSessionCheck({ config }),
  }).map((o) => o.sid);
  const control = offered({ dirs: [], included: [], problem: null });
  check('CONTROL: with no list both are offered', control.includes(ex) && control.includes(ok), control.join(','));
  const guarded = offered({ dirs: [EXD], included: [], problem: null });
  check('the excluded session is NOT offered', !guarded.includes(ex), guarded.join(','));
  check('the other is', guarded.includes(ok), guarded.join(','));
}

console.log('\n=== 12. the orphan cap never settles an excluded session\'s candidates ===');
{
  const { collectOrphanCandidates, planOrphanCap } = await import('../orphan-cap.mjs');
  const mkBreaching = (cwd) => {
    const sid = randomUUID();
    markCwd(sid, cwd);
    append(sid, { op: 'propose', externalId: randomUUID(), title: 't', body: 'b', kind: 'observation', dest: 'memory' });
    for (let d = 1; d <= 8; d++) append(sid, { at: `2026-08-0${d}T10:00:00.000Z`, op: 'handed', toSid: 'someone' });
    return sid;
  };
  const ex = mkBreaching(EXD);
  const ok = mkBreaching(OKD);
  const planned = (config) => planOrphanCap({ queues: collectOrphanCandidates({ isExcluded: excludedSessionCheck({ config }) }) }).breach.map((b) => b.sid);
  const control = planned({ dirs: [], included: [], problem: null });
  check('CONTROL: with no list both breach and would be auto-ignored', control.includes(ex) && control.includes(ok), control.join(','));
  const guarded = planned({ dirs: [EXD], included: [], problem: null });
  check('the excluded session is NOT planned for settlement', !guarded.includes(ex), guarded.join(','));
  check('the other still is', guarded.includes(ok), guarded.join(','));
}

console.log('\n=== 13. the spool drain never promotes an excluded session\'s proposals ===');
{
  // Same opt-in as spool-test.mjs, and safe for the same reason: every call injects `fetchImpl`.
  try { fs.unlinkSync(spoolOffFile()); } catch { /* silence-ok: the marker may already be absent. */ }
  try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* silence-ok: the marker may already be absent. */ }
  const { spool, drainAll, read: readSpool } = await import('../spool.mjs');
  const PASS_GATE = async (fields) => ({ send: true, fields });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body || '{}'));
    return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: 'x', externalId: 'e', payload: {} }), text: async () => '{}' };
  };
  const cand = (n) => ({ title: `t${n}`, body: n === 2 ? 'EXCLUDED-SESSION-BODY-zq9' : `ordinary body ${n}`, kind: 'project' });
  const mine = randomUUID(); markCwd(mine, OKD);
  const ex = randomUUID(); markCwd(ex, EXD);
  const other = randomUUID(); markCwd(other, OKD);
  spool(mine, 'e-mine', cand(1)); spool(ex, 'e-ex', cand(2)); spool(other, 'e-other', cand(3));

  await drainAll(mine, { fetchImpl, gateImpl: PASS_GATE, maxSessions: 10, isExcluded: excludedSessionCheck({ config: { dirs: [EXD], included: [], problem: null } }) });
  eq('the excluded session still owes its proposal (nothing was written for it)', readSpool(ex).owed.length, 1);
  eq('the other session was drained', readSpool(other).owed.length, 0);
  check('no request carried the excluded session\'s content', !calls.some((c) => JSON.stringify(c).includes('EXCLUDED-SESSION-BODY-zq9')), JSON.stringify(calls));
  check('(and the other session\'s content DID go out, so the check above can fail)', calls.some((c) => JSON.stringify(c).includes('ordinary body 3')), JSON.stringify(calls));

  // CONTROL, so the above can fail: with no list the same drain promotes it.
  await drainAll(mine, { fetchImpl, gateImpl: PASS_GATE, maxSessions: 10, isExcluded: excludedSessionCheck({ config: { dirs: [], included: [], problem: null } }) });
  eq('CONTROL: with no list the excluded session\'s proposal IS promoted', readSpool(ex).owed.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 13b. the allow-list is STRICT about real paths; the real files behind the origin check ===');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-strict-'));
  const included = path.join(base, 'included');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(included, 'repo'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
  const trap = path.join(included, 'trap'); // looks inside the root, points outside it
  let linked = true;
  try { fs.symlinkSync(outside, trap, 'junction'); } catch { /* silence-ok: some sandboxes forbid links; reported below instead of passing vacuously. */ linked = false; }
  const { dirWithin } = await import('../exclusion.mjs');
  check('a real directory inside the root is within it', dirWithin(path.join(included, 'repo'), [included]));
  check('a directory outside the root is not', !dirWithin(path.join(outside, 'secret'), [included]));
  if (!linked) console.log('  SKIP  could not create a symlink/junction on this host');
  else {
    check('A LINK INSIDE THE ROOT THAT POINTS OUTSIDE IT IS NOT WITHIN (the allow-list is strict)', !dirWithin(path.join(trap, 'secret'), [included]));
    check('CONTROL: the exclusion form of the same question WOULD count it (any spelling), which is why the two differ', dirUnder(path.join(trap, 'secret'), [included]));
    const root = path.join(base, 'rootlink'); // the ROOT itself is a link: legitimate, must still work
    fs.symlinkSync(included, root, 'junction');
    check('an included root that is itself a link still admits a session spelled through it', dirWithin(path.join(root, 'repo'), [root]));
  }

  // The real file reads behind excludedSessionCheck (the other tests stub them).
  const mkCheck = (cfg) => excludedSessionCheck({ config: cfg });
  const sDamaged = randomUUID();
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFor(sDamaged), '{ this is garbage');
  eq('a DAMAGED state file (it exists, and where the session ran is lost) is not cleared by an exclusion list', mkCheck({ dirs: [EXD], included: [], problem: null })(sDamaged), true);
  const sCorrupt = randomUUID();
  fs.mkdirSync(path.join(queueDir(), `${sCorrupt}.jsonl`), { recursive: true }); // reading a directory as a file: not ENOENT, so 'corrupt'
  eq('an UNREADABLE queue is not cleared either', mkCheck({ dirs: [EXD], included: [], problem: null })(sCorrupt), true);
  const sNeither = randomUUID();
  eq('CONTROL: no files at all is the pre-feature case, and is cleared', mkCheck({ dirs: [EXD], included: [], problem: null })(sNeither), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 13c. the nudge and the orphan cap resolve a STATE-recorded or LEGACY origin too ===');
{
  const { orphanedPending } = await import('../sweep.mjs');
  const { collectOrphanCandidates, planOrphanCap } = await import('../orphan-cap.mjs');
  const DAY = 24 * 3600 * 1000;
  const enc = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  const variants = {
    'state-recorded origin only': (sid) => seedState(sid, { cwd: EXD, lastStopAt: Date.now() - 3 * DAY }),
    'legacy origin (transcript folder only)': (sid) => seedState(sid, { transcriptPath: path.join(os.homedir(), '.claude', 'projects', enc(EXD), `${sid}.jsonl`), lastStopAt: Date.now() - 3 * DAY }),
  };
  for (const [name, seed] of Object.entries(variants)) {
    const sid = randomUUID();
    append(sid, { op: 'propose', externalId: randomUUID(), title: 't', body: 'b', kind: 'observation', dest: 'memory' });
    append(sid, { op: 'swept', residual: 9000 });
    for (let d = 1; d <= 8; d++) append(sid, { at: `2026-08-0${d}T10:00:00.000Z`, op: 'handed', toSid: 'someone' });
    seed(sid);
    const isExcluded = excludedSessionCheck({ config: { dirs: [EXD], included: [], problem: null } });
    const none = excludedSessionCheck({ config: { dirs: [], included: [], problem: null } });
    const offered = (chk) => orphanedPending(Date.now(), { staleMs: DAY, stateDir: stateDir(), queueDir: queueDir(), isExcluded: chk }).map((o) => o.sid);
    const planned = (chk) => planOrphanCap({ queues: collectOrphanCandidates({ isExcluded: chk }) }).breach.map((b) => b.sid);
    check(`${name}: CONTROL: offered by the nudge with no list`, offered(none).includes(sid));
    check(`${name}: NOT offered by the nudge`, !offered(isExcluded).includes(sid));
    check(`${name}: CONTROL: planned by the orphan cap with no list`, planned(none).includes(sid));
    check(`${name}: NOT planned by the orphan cap`, !planned(isExcluded).includes(sid));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 13d. a project dir that is a PARENT of a later-excluded directory, against all four background paths ===');
{
  const { runSweep, orphanedPending } = await import('../sweep.mjs');
  const { collectOrphanCandidates, planOrphanCap } = await import('../orphan-cap.mjs');
  const { spool, drainAll, read: readSpool } = await import('../spool.mjs');
  const DAY = 24 * 3600 * 1000;
  // Launched at ROOT (the project dir), the work happened in EXD/src; the list was empty at capture, so
  // BOTH were recorded; EXD is excluded afterwards.
  const sid = randomUUID();
  markCwd(sid, sub(EXD, 'src'), ROOT);
  append(sid, { op: 'propose', externalId: randomUUID(), title: 't', body: 'PARENT-PROJECT-BODY-q7', kind: 'observation', dest: 'memory' });
  append(sid, { op: 'swept', residual: 9000 });
  for (let d = 1; d <= 8; d++) append(sid, { at: `2026-08-0${d}T10:00:00.000Z`, op: 'handed', toSid: 'someone' });
  const f = path.join(os.tmpdir(), `optout-parent-${randomUUID()}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(6000) } }) + '\n');
  seedState(sid, { cwd: sub(EXD, 'src'), projectDir: ROOT, transcriptPath: f, lastStopAt: Date.now() - 3 * DAY });
  spool(sid, 'e-parent', { title: 'p', body: 'PARENT-PROJECT-BODY-q7', kind: 'project' });
  // The sweep skips a session already marked swept, and the nudge only offers one that IS swept, so the
  // sweep gets its own session with the same recorded origins and no marker.
  const sidSweep = randomUUID();
  markCwd(sidSweep, sub(EXD, 'src'), ROOT);
  seedState(sidSweep, { cwd: sub(EXD, 'src'), projectDir: ROOT, transcriptPath: f, lastStopAt: Date.now() - 3 * DAY });
  const guarded = excludedSessionCheck({ config: { dirs: [EXD], included: [], problem: null } });
  const open = excludedSessionCheck({ config: { dirs: [], included: [], problem: null } });

  const spawned = (chk) => {
    const out = [];
    runSweep('me', Date.now(), {
      marker: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optout-sw-')), 'm'), debounceMs: 1, max: 100,
      deps: { spawn: (...a) => { out.push(a[1][1]); return { unref() {} }; }, claim: () => ({ proceed: true, owned: true }), release: () => 'released', isHeld: () => false, markSwept: () => true, isExcluded: chk },
    });
    return out;
  };
  check('CONTROL: sweep flushes it with no list', spawned(open).includes(sidSweep));
  check('SWEEP: not flushed once the child directory is excluded', !spawned(guarded).includes(sidSweep));
  const offered = (chk) => orphanedPending(Date.now(), { staleMs: DAY, stateDir: stateDir(), queueDir: queueDir(), isExcluded: chk }).map((o) => o.sid);
  check('CONTROL: nudge offers it with no list', offered(open).includes(sid));
  check('NUDGE: not offered', !offered(guarded).includes(sid));
  const planned = (chk) => planOrphanCap({ queues: collectOrphanCandidates({ isExcluded: chk }) }).breach.map((b) => b.sid);
  check('CONTROL: orphan cap plans it with no list', planned(open).includes(sid));
  check('ORPHAN CAP: not planned', !planned(guarded).includes(sid));

  try { fs.unlinkSync(spoolOffFile()); } catch { /* silence-ok: the marker may already be absent. */ }
  try { fs.unlinkSync(verdictMutationsOffFile()); } catch { /* silence-ok: the marker may already be absent. */ }
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.body || '');
    return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: 'x', externalId: 'e', payload: {} }), text: async () => '{}' };
  };
  const PASS_GATE = async (fields) => ({ send: true, fields });
  const me = randomUUID(); markCwd(me, OKD);
  await drainAll(me, { fetchImpl, gateImpl: PASS_GATE, maxSessions: 10, isExcluded: guarded });
  check('SPOOL DRAIN: nothing of it was sent', !calls.some((c) => c.includes('PARENT-PROJECT-BODY-q7')) && readSpool(sid).owed.length === 1, JSON.stringify(calls));
  await drainAll(me, { fetchImpl, gateImpl: PASS_GATE, maxSessions: 10, isExcluded: open });
  check('CONTROL: with no list the same drain sends it', calls.some((c) => c.includes('PARENT-PROJECT-BODY-q7')));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 14. nothing in a hook\'s import graph does, at import time, what the guard exists to stop ===');
{
  /**
   * ES modules evaluate a sibling import while an earlier one awaits, so the guard (optout.mjs)
   * cannot stop module-level code in the hook's OTHER imports. What keeps the guarantee true is that
   * there is none that matters. This is a textual census of the import graph (column-0 statements
   * only; a call continued on an indented line is not seen) and its limits are stated, not hidden.
   * It has a self-test below, so it can fail.
   */
  const SRC = path.dirname(fileURLToPath(import.meta.url)) + '/..';
  const HOOK_FILES = ['orient', 'recall', 'evaluate', 'stop', 'capture'];
  const graph = new Set();
  const walk = (name) => {
    if (graph.has(name)) return;
    graph.add(name);
    const text = fs.readFileSync(path.join(SRC, `${name}.mjs`), 'utf8');
    for (const m of text.matchAll(/^(?:import\b[^\n]*|\})\s*from '\.\/([\w-]+)\.mjs'/gm)) walk(m[1]);
    for (const m of text.matchAll(/\bimport\('\.\/([\w-]+)\.mjs'\)/g)) walk(m[1]); // the guard's dynamic imports
  };
  HOOK_FILES.forEach(walk);

  const FORBIDDEN = /\b(fetch|spawn|spawnSync|execFile|execFileSync|execSync|writeState|writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|writeFileAtomic|markHanded|markCwd|markCaptured|markSwept)\(/;
  const offenders = (source, file) => {
    const out = [];
    source.split('\n').forEach((line, i) => {
      if (!line || /^\s/.test(line) || /^(\/\/|\/\*|\*|\}|\)|import\b|export \{|export default)/.test(line)) return;
      const m = FORBIDDEN.exec(line);
      if (m && !/=>|\bfunction\b/.test(line.slice(0, m.index))) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      if (/\bawait\b/.test(line) && file !== 'optout.mjs') out.push(`${file}:${i + 1}: top-level await: ${line.trim().slice(0, 100)}`);
    });
    return out;
  };
  const found = [...graph].flatMap((n) => offenders(fs.readFileSync(path.join(SRC, `${n}.mjs`), 'utf8'), `${n}.mjs`));
  eq('no module-level network call, spawn, write or top-level await in the hooks\' import graph (other than the guard)', found, []);
  check('the graph walk covered the modules (not an empty set)', ['optout', 'exclusion', 'config', 'queue', 'sweep', 'creds'].every((n) => graph.has(n)), [...graph].join(','));
  for (const h of HOOK_FILES) {
    const first = fs.readFileSync(path.join(SRC, `${h}.mjs`), 'utf8').split('\n').find((l) => /^import\b/.test(l)) || '';
    check(`${h}.mjs imports the opt-out guard FIRST and takes its stdin text from it`,
      /^import \{ stdinText \} from '\.\/optout\.mjs'/.test(first), first);
  }
  // SELF-TEST: the scanner must flag a real offender and leave a definition alone.
  eq('self-test: a module-level fetch is flagged', offenders("const r = fetch('http://x');\n", 'fake.mjs').length, 1);
  eq('self-test: a module-level state write is flagged', offenders("writeState('a', {});\n", 'fake.mjs').length, 1);
  eq('self-test: a top-level await is flagged', offenders('const x = await foo();\n', 'fake.mjs').length, 1);
  eq('self-test: an arrow-function DEFINITION is not', offenders("export const markX = (s) => append(s, {});\nconst f = async () => fetch('u');\n", 'fake.mjs').length, 0);
  eq('self-test: a call inside an indented function body is not', offenders("function g() {\n  fetch('u');\n}\n", 'fake.mjs').length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 15. no shipped or test source file contains a NUL byte ===');
{
  /**
   * A literal NUL makes git treat the whole file as binary (the diff shows "Bin 0 -> N bytes", so it
   * cannot be reviewed), and editors, linters and text-based scrub gates may skip or mangle it. One got
   * in once through an escape sequence that a scripting layer expanded; write `\u0000` in source.
   */
  const SRC = path.dirname(fileURLToPath(import.meta.url)) + '/..';
  const PKG = path.join(SRC, '..');
  const files = [
    ...fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs')).map((f) => path.join(SRC, f)),
    ...fs.readdirSync(path.join(SRC, 'tests')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(SRC, 'tests', f)),
    ...fs.readdirSync(path.join(SRC, 'prompts')).map((f) => path.join(SRC, 'prompts', f)),
    path.join(PKG, 'README.md'), path.join(PKG, 'CHANGELOG.md'),
  ];
  const withNul = files.filter((f) => fs.readFileSync(f).includes(0)).map((f) => path.relative(PKG, f));
  eq('no source, test, prompt or doc file contains a NUL byte', withNul, []);
  check('the scan covered the package (not an empty list)', files.length > 40, String(files.length));
  check('self-test: a buffer containing a NUL is detected', Buffer.from('a\0b').includes(0) && !Buffer.from('ab').includes(0));
}

done();
