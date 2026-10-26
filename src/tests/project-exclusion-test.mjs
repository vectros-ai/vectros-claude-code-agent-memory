#!/usr/bin/env node
/**
 * THE MEMORY.md PROJECTION AND THE DIRECTORY LISTS — the pinned set is written into a file that
 * every session started in the owning project auto-loads, so the project the write LANDS in has to
 * be allowed, not only the session that triggered it.
 *
 * These drive the real projector (`project.mjs` as a subprocess) against a loopback records server,
 * with a private Claude config directory so no real MEMORY.md is reachable. Each leak case has a
 * control with no lists configured, which must DO the write: a leak test whose control cannot write
 * proves nothing about the refusal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, done, requireGit } from './assert.mjs';
import './isolate.mjs'; // MUST precede any runtime-state path use — see the file header.
import { startFakeRecordsServer } from './fake-records-server.mjs';
import { encodeProjectDir } from '../exclusion.mjs';

requireGit(); // every case builds real repositories or worktrees

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECTOR = path.join(DIR, 'project.mjs');
const server = await startFakeRecordsServer();
server.seed('memory', { title: 'PINNED-FIXTURE-TITLE', body: 'Used only by project-exclusion-test.mjs.', kind: 'feedback', priority: 20, status: 'active' });

// Physical paths: the projector derives its folder name from the child's real working directory, so a fixture
// under a linked temp directory (macOS /var -> /private/var) would otherwise name a different folder.
const mk = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture', ...args], { cwd, encoding: 'utf8' });
/** Claude Code's folder name for a project directory, as `project.mjs` derives it from the git root. */
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's real encoding, written out here on purpose
const BLOCK = 'PINNED-FIXTURE-TITLE';

function runProjector({ cwd, lists, claudeHome, extraEnv = {} }) {
  const home = mk('project-excl-home-');
  const cfg = path.join(home, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(lists || {}));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome, VECTROS_MEMORY_HOME: home, VECTROS_MEMORY_CONFIG: cfg,
    VECTROS_HOOKLOG_PATH: path.join(home, 'hooks.log'),
    VECTROS_API_BASE_URL: server.url, VECTROS_API_KEY: 'stub-key-project-exclusion-test',
    // The projector gives each git call a few seconds and, when git does not answer, falls back to discovery
    // (which, with a directory list set, refuses to write). On a saturated machine a git process can take longer
    // than that to start, which flipped the repository cases into a refusal at random. Every case here wants git
    // to answer, so it gets a generous budget; the case that wants git NOT to answer overrides it below.
    VECTROS_MEM_PROJECT_GIT_TIMEOUT_MS: '120000',
    VECTROS_MEMORY_OFF: '', CLAUDE_PROJECT_DIR: '', ...extraEnv,
    GIT_CEILING_DIRECTORIES: path.dirname(cwd), // a scratch directory must not find a repository above itself
  };
  delete env.VECTROS_MEMORY_INDEX; // the escape hatch bypasses resolution, which is what is under test
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROJECTOR], { cwd, env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', () => { clearTimeout(timer); rm(home); resolve(out.trim()); });
  });
}

/** A Claude config dir holding one project folder whose MEMORY.md exists. */
function claudeWith(folder, transcriptCwd) {
  const claudeHome = mk('project-excl-claude-');
  const idx = path.join(claudeHome, 'projects', folder, 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, '# the project\'s own memory index\n');
  // A recorded session of the project: Claude Code writes the working directory on every line.
  if (transcriptCwd) fs.writeFileSync(path.join(claudeHome, 'projects', folder, 'session-1.jsonl'), `${JSON.stringify({ type: 'user', cwd: transcriptCwd })}\n`);
  return { claudeHome, idx };
}
const wrote = (idx) => fs.readFileSync(idx, 'utf8').includes(BLOCK);

console.log('\n=== a session outside any repository: the single-index fallback ===');
{
  const base = mk('project-excl-fallback-');
  const excluded = path.join(base, 'clientA');
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(excluded); fs.mkdirSync(scratch);
  const { claudeHome, idx } = claudeWith(slugOf(excluded));
  try {
    const control = await runProjector({ cwd: scratch, lists: {}, claudeHome });
    check('control: with no lists the fallback writes the pinned set into the only index', wrote(idx), control);
    fs.writeFileSync(idx, '# the project\'s own memory index\n');

    const out = await runProjector({ cwd: scratch, lists: { EXCLUDED_DIRECTORIES: [excluded] }, claudeHome });
    check('the only index belongs to an EXCLUDED project: nothing is written into it', !wrote(idx), out);
    check('...and the receipt says why the index was not guessed', /directory list/.test(out), out);

    const inc = await runProjector({ cwd: scratch, lists: { INCLUDED_DIRECTORIES: [scratch] }, claudeHome });
    check('with an allow-list the fallback cannot show the index is inside it: refused', !wrote(idx), inc);
    check('...and the receipt says why the index was not guessed', /directory list/.test(inc), inc);

    const off = await runProjector({ cwd: scratch, lists: {}, claudeHome, extraEnv: { VECTROS_MEMORY_OFF: '1' } });
    check('VECTROS_MEMORY_OFF turns the projector off too', !wrote(idx), off);
  } finally { rm(base); rm(claudeHome); }

  // A folder name is only a lossy encoding of a directory (a project reached through a junction is stored under
  // the spelling it was opened with), so the index is not guessed whenever a list is set, even for a sibling.
  const base2 = mk('project-excl-fallback-sib-');
  const excluded2 = path.join(base2, 'clientA');
  const sibling = path.join(base2, 'clientAX');
  const scratch2 = path.join(base2, 'scratch');
  for (const d of [excluded2, sibling, scratch2]) fs.mkdirSync(d);
  const c2 = claudeWith(slugOf(sibling));
  try {
    const out = await runProjector({ cwd: scratch2, lists: { EXCLUDED_DIRECTORIES: [excluded2] }, claudeHome: c2.claudeHome });
    check('a list is set: the index is not guessed even when its folder only shares a name prefix with an excluded directory', !wrote(c2.idx), out);
  } finally { rm(base2); rm(c2.claudeHome); }
}

console.log('\n=== a worktree whose main checkout is excluded: the git-root path ===');
{
  const base = mk('project-excl-wt-');
  const main = path.join(base, 'clientA');
  const wt = path.join(base, 'elsewhere');
  fs.mkdirSync(main);
  const gi = git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const gw = git(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  check('fixture: a linked worktree was created (needs git on PATH)', gi.status === 0 && gw.status === 0, `${gi.stderr}${gw.stderr}`);
  const common = git(wt, 'rev-parse', '--git-common-dir').stdout.trim();
  const root = path.dirname(path.resolve(wt, common)); // what project.mjs derives
  const { claudeHome, idx } = claudeWith(slugOf(root), main);
  try {
    const control = await runProjector({ cwd: wt, lists: {}, claudeHome });
    check('control: the worktree resolves to the main checkout\'s index and writes it', wrote(idx), control);
    fs.writeFileSync(idx, '# the project\'s own memory index\n');

    const out = await runProjector({ cwd: wt, lists: { EXCLUDED_DIRECTORIES: [main] }, claudeHome });
    check('the owning checkout is EXCLUDED: a session in an unlisted worktree writes nothing into it', !wrote(idx), out);
    check('...and the receipt names the exclusion', /excluded/.test(out), out);

    const inc = await runProjector({ cwd: wt, lists: { INCLUDED_DIRECTORIES: [wt] }, claudeHome });
    check('the owning checkout is outside the allow-list: nothing is written', !wrote(idx), inc);
    check('...and the receipt names the allow-list', /included/.test(inc), inc);

    // The index belongs to the repository, so the exclusion can sit BELOW or BESIDE the root too: an excluded
    // subdirectory, or an excluded linked working tree, loads the same index as the root.
    const sub = await runProjector({ cwd: main, lists: { EXCLUDED_DIRECTORIES: [path.join(main, 'secret')] }, claudeHome });
    check('an excluded SUBDIRECTORY of the root shares the index: nothing is written for a session elsewhere in the root', !wrote(idx), sub);
    check('...and the receipt names the exclusion', /excluded/.test(sub), sub);
    const sibWt = await runProjector({ cwd: main, lists: { EXCLUDED_DIRECTORIES: [wt] }, claudeHome });
    check('an excluded linked WORKING TREE shares the index: nothing is written for a session in the root', !wrote(idx), sibWt);

    // With an allow-list, a session recorded in the repository's project folder that ran OUTSIDE the included
    // directories means another path shares the folder name: nothing is written. A folder with no recorded
    // session shows nothing against the repository (sessions are mostly started in working trees and
    // sub-directories, which are recorded under other folder names).
    const bare = claudeWith(slugOf(root));
    const noSession = await runProjector({ cwd: wt, lists: { INCLUDED_DIRECTORIES: [base] }, claudeHome: bare.claudeHome });
    check('an allow-list and a project folder with no recorded session: the repository inside the list refreshes', wrote(bare.idx), noSession);
    rm(bare.claudeHome);
    const elsewhere = claudeWith(slugOf(root), path.join(os.tmpdir(), 'somewhere-else-entirely'));
    const wrongSession = await runProjector({ cwd: wt, lists: { INCLUDED_DIRECTORIES: [base] }, claudeHome: elsewhere.claudeHome });
    check('...but a recorded session that ran outside the included directories stops the refresh', !wrote(elsewhere.idx), wrongSession);
    check('...and the receipt names it', /ran outside it/.test(wrongSession), wrongSession);
    rm(elsewhere.claudeHome);

    const ok = await runProjector({ cwd: wt, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'unrelated')], INCLUDED_DIRECTORIES: [base] }, claudeHome });
    check('an unrelated exclusion plus an allow-list that covers it still writes', wrote(idx), ok);
  } finally { rm(base); rm(claudeHome); }
}

console.log('\n=== two paths that Claude Code names alike, and a folder name that does not match ===');
{
  const base = mk('project-excl-collide-');
  const repo = path.join(base, 'acme-corp');      // not excluded
  const excluded = path.join(base, 'acme', 'corp'); // excluded; encodes to the same folder name
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  const common = git(repo, 'rev-parse', '--git-common-dir').stdout.trim();
  const rootDir = path.dirname(path.resolve(repo, common));
  const { claudeHome, idx } = claudeWith(slugOf(rootDir));
  try {
    const control = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'unrelated')] }, claudeHome });
    check('control: an unrelated exclusion lets the repository refresh', wrote(idx), control);
    fs.writeFileSync(idx, '# the project\'s own memory index\n');
    const out = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [excluded] }, claudeHome });
    check('an excluded directory with the same project folder name shares the index: nothing is written', !wrote(idx), out);
    check('...and the receipt says so', /same project folder name/.test(out), out);

    // Exclusion means "at or under": an excluded PARENT whose encoding the repository's folder continues
    // (`/w/acme` excluded, repository `/w/acme-corp`) can be a session in `/w/acme/corp`, which loads this folder.
    fs.writeFileSync(idx, '# the project\'s own memory index\n');
    const parentExcluded = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'acme')] }, claudeHome });
    check('an excluded directory whose name this repository\'s folder continues: nothing is written', !wrote(idx), parentExcluded);
    // ...and the other way round: an excluded directory below a path that encodes to this folder.
    const childExcluded = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'acme', 'corp', 'client')] }, claudeHome });
    check('an excluded directory that continues this repository\'s folder name: nothing is written', !wrote(idx), childExcluded);
    // A name that only shares leading characters (no separator boundary) is not an overlap.
    const near = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'acme-cor')] }, claudeHome });
    check('a name that merely starts alike (no boundary) does not stop the refresh', wrote(idx), near);
  } finally { rm(base); rm(claudeHome); }

  // The repository's own folder is not found under the derived name (a path Claude Code spells differently).
  const base2 = mk('project-excl-miss-');
  const repo2 = path.join(base2, 'repo');
  fs.mkdirSync(repo2);
  git(repo2, 'init', '-q');
  const c2 = claudeWith('some-other-folder-name');
  try {
    const out = await runProjector({ cwd: repo2, lists: { EXCLUDED_DIRECTORIES: [path.join(base2, 'unrelated')] }, claudeHome: c2.claudeHome });
    check('a list is set and the derived folder is missing: another project\'s index is not written', !wrote(c2.idx), out);
    check('...and the receipt gives that reason, not a generic one', /derived from the repository path/.test(out), out);
  } finally { rm(base2); rm(c2.claudeHome); }
}

console.log('\n=== a path with an underscore, a dot and a space ===');
{
  // The folder Claude Code created for a session started in `C:\Users\micha\tmp_check.v1 x` was
  // `C--Users-micha-tmp-check-v1-x`: every non-alphanumeric character becomes a dash.
  check('the shared encoding turns every non-alphanumeric character into a dash',
    encodeProjectDir('C:\\Users\\micha\\tmp_check.v1 x') === 'C--Users-micha-tmp-check-v1-x', encodeProjectDir('C:\\Users\\micha\\tmp_check.v1 x'));
  const base = mk('project-excl-odd-');
  const repo = path.join(base, 'tmp_check.v1 x');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  const common = git(repo, 'rev-parse', '--git-common-dir').stdout.trim();
  const rootDir = path.dirname(path.resolve(repo, common));
  const { claudeHome, idx } = claudeWith(slugOf(rootDir));
  try {
    const noList = await runProjector({ cwd: repo, lists: {}, claudeHome });
    check('no list: the index in the real folder name is found and written', wrote(idx), noList);
    fs.writeFileSync(idx, '# the project\'s own memory index\n');
    // With a list set the index is never guessed from the projects folder, so this only passes when the
    // derived folder name is right.
    const withList = await runProjector({ cwd: repo, lists: { EXCLUDED_DIRECTORIES: [path.join(base, 'unrelated')] }, claudeHome });
    check('a list is set: the same repository still refreshes (the derived folder name is right)', wrote(idx), withList);
  } finally { rm(base); rm(claudeHome); }
}

console.log('\n=== lists that cannot be read ===');
{
  const base = mk('project-excl-bad-');
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(scratch);
  const { claudeHome, idx } = claudeWith('anything');
  try {
    const out = await runProjector({ cwd: scratch, lists: { EXCLUDED_DIRECTORIES: 'not-an-array' }, claudeHome });
    check('a broken list turns the projection off too', !wrote(idx), out);
  } finally { rm(base); rm(claudeHome); }
}

console.log('\n=== git that does not answer: the receipt names it, and a git that does answer writes ===');
if (process.platform === 'win32') {
  console.log('  SKIP  a stub git needs a POSIX shell; this case runs on Linux and macOS');
} else {
  const base = mk('project-excl-gitwait-');
  const repo = path.join(base, 'repo');
  const stub = path.join(base, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(stub);
  git(repo, 'init', '-q');
  // A `git` earlier on PATH that never answers within the budget.
  fs.writeFileSync(path.join(stub, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const common = git(repo, 'rev-parse', '--git-common-dir').stdout.trim();
  const { claudeHome, idx } = claudeWith(slugOf(path.dirname(path.resolve(repo, common))));
  const lists = { EXCLUDED_DIRECTORIES: [path.join(base, 'unrelated')] };
  try {
    const out = await runProjector({
      cwd: repo, lists, claudeHome,
      extraEnv: { PATH: `${stub}${path.delimiter}${process.env.PATH}`, VECTROS_MEM_PROJECT_GIT_TIMEOUT_MS: '300' },
    });
    check('git does not answer within its budget: nothing is written', !wrote(idx), out);
    check('...and the receipt names the timeout instead of blaming the directory list', /git did not answer within 300ms/.test(out), out);
    const control = await runProjector({ cwd: repo, lists, claudeHome });
    check('control: with the real git answering, the same repository refreshes', wrote(idx), control);
  } finally { rm(base); rm(claudeHome); }
}

await server.close();
done();
