#!/usr/bin/env node
/**
 * @vectros-ai/claude-code-agent-memory — installer CLI.
 *
 *   npx @vectros-ai/claude-code-agent-memory init [--dry-run]
 *
 * Deploys this package's BUILT hook files to the runtime directory (`~/.claude/vectros-memory` by
 * default, or `VECTROS_MEMORY_HOME`) and wires them into Claude Code by APPENDING matcher blocks
 * to the GLOBAL `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json`) — never the
 * project-scoped settings file, and never touching any matcher block this package didn't itself
 * write. The full reasoning behind both choices: Claude Code's hooks schema allows multiple
 * matcher blocks per event, ALL firing in parallel, so appending is additive by construction; and
 * project-scope HARD-OVERRIDES (does not merge with) global settings for a matching event, so
 * writing there risks silently shadowing whatever else the adopter already has globally.
 *
 * WHY npx AND NOT A LIVE HOOK INVOCATION: hooks fire on every prompt/tool-call, so per-invocation
 * npx resolution overhead is a non-starter — this command runs ONCE (or once per upgrade) to
 * deploy a plain `node <path>` command into settings.json, and that plain command is what
 * actually fires on each hook event afterward.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { claudeHome, memoryHome, credentialsFile } from './paths.mjs';
import { writeFileAtomic, readJsonSafe } from './atomic.mjs';
import { storeOAuthToken, resolveActiveKeyringAlias, resolveKeyringSecretByAlias, isTestShapedSecret } from './creds.mjs';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url)); // the deployed dist/ directory this file itself lives in
const args = process.argv.slice(2);
const verb = args[0];
const dryRun = args.includes('--dry-run');

/**
 * One matcher block per (event, file) pair, in Claude Code's `settings.json` shape.
 */
const HOOK_FILES = {
  SessionStart: ['orient.mjs'],
  UserPromptSubmit: ['recall.mjs'],
  PostToolUse: ['evaluate.mjs'],
  Stop: ['stop.mjs', 'capture.mjs'],
  PreCompact: ['capture.mjs'],
};

function usage() {
  console.log([
    'Usage: claude-code-agent-memory <command>',
    '',
    'Commands:',
    '  init [--dry-run]   deploy the hook runtime and wire it into ~/.claude/settings.json',
    '  set-token          store CLAUDE_CODE_OAUTH_TOKEN (read from stdin) for the capture/recall-',
    '                     eval workers\' nested `claude -p` child — OS keychain if available, else',
    '                     the plaintext credentials.json fallback tier.',
    '                       claude setup-token | claude-code-agent-memory set-token',
    '                       echo "<token>" | claude-code-agent-memory set-token',
    '',
    'Env:',
    '  VECTROS_MEMORY_HOME   where the runtime deploys (default: <claude config dir>/vectros-memory)',
    "  CLAUDE_CONFIG_DIR     Claude Code's own config dir (default: ~/.claude)",
  ].join('\n'));
}

/**
 * `set-token` — the SETUP PATH for `CLAUDE_CODE_OAUTH_TOKEN` that `init` itself deliberately does
 * not attempt: `init` deploys the MECHANISM (the keychain binding, per `deployKeyring()`), never a
 * secret. Reads the token from STDIN, not argv — an argv value sits in shell history and any
 * `ps`/Task-Manager listing for as long as the process is briefly alive; stdin does not, and it
 * matches this exact codebase's own `vectros keyring show --format raw` one-line-secret
 * convention, so `claude setup-token | claude-code-agent-memory set-token` composes the same way.
 *
 * Tries the OS keychain first via `storeOAuthToken()` (creds.mjs); on any failure — most commonly
 * `@napi-rs/keyring` not being available on this platform/install — falls back to writing
 * `credentials.json` directly (the same file `creds.mjs`'s OWN read-side fallback tier already
 * reads, so nothing new to wire up on the read side), loudly labelled as the weaker tier so a
 * caller reading the output is never quietly on the fallback.
 */
function setToken() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (e) {
    console.error(`could not read stdin (${e.message}).`);
    console.error('Usage: claude setup-token | claude-code-agent-memory set-token');
    console.error('   or: echo "<token>" | claude-code-agent-memory set-token');
    process.exitCode = 1;
    return;
  }
  const token = raw.trim();
  if (!token) {
    console.error('no token received on stdin — nothing to store.');
    process.exitCode = 1;
    return;
  }

  try {
    storeOAuthToken(token);
    console.log('stored CLAUDE_CODE_OAUTH_TOKEN in the OS credential store.');
    return;
  } catch (e) {
    console.log(`OS credential store unavailable (${e.message}) — falling back to the plaintext credentials.json tier.`);
  }

  const file = credentialsFile();
  const existing = readJsonSafe(file, {});
  const creds = existing.value && typeof existing.value === 'object' ? existing.value : {};
  creds.CLAUDE_CODE_OAUTH_TOKEN = token;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(creds, null, 2) + '\n');
  console.log(`stored CLAUDE_CODE_OAUTH_TOKEN in ${file} (plaintext — install/enable @napi-rs/keyring for at-rest encryption).`);
}

/** Copy every built file (hooks + prompts/) EXCEPT this installer itself into the runtime dir. */
function deployRuntime() {
  const dest = memoryHome();
  // FOUND (PM cold pass, this MR): unguarded — `--dry-run` created the runtime DIRECTORY for
  // real even though every file/keyring copy below it correctly checks `dryRun` first, silently
  // contradicting this package's own README/CHANGELOG claim that `--dry-run` makes no writes.
  if (!dryRun) fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(HERE)) {
    if (f === 'cli.mjs' || f === 'cli.mjs.map') continue; // the installer never deploys into the runtime it installs
    const src = path.join(HERE, f);
    const dst = path.join(dest, f);
    if (fs.statSync(src).isDirectory()) {
      if (!dryRun) fs.cpSync(src, dst, { recursive: true });
    } else if (!dryRun) {
      fs.copyFileSync(src, dst);
    }
    copied++;
  }
  console.log(`${dryRun ? '[dry-run] would deploy' : 'deployed'} ${copied} item(s) to ${dest}`);
  deployKeyring(dest);
  return dest;
}

/**
 * Copy `@napi-rs/keyring` (+ whichever ONE platform-specific optional subpackage actually
 * resolved on THIS install) into the runtime dir's own `node_modules/`, so `creds.mjs`'s
 * `require('@napi-rs/keyring')` — run from the flat DEPLOYED location, which otherwise has no
 * `node_modules` of its own — can still find it.
 *
 * FOUND EMPIRICALLY, before any live cutover: without this, that require always
 * `MODULE_NOT_FOUND`s post-deploy, and `CLAUDE_CODE_OAUTH_TOKEN` silently degrades to the
 * plaintext-file tier on every real install — not just platforms lacking a prebuild, which is
 * the only case that degradation is supposed to cover.
 *
 * Deliberately copies only the ONE platform package this machine's loader actually uses, not all
 * twelve `@napi-rs/keyring` carries as `optionalDependencies` — keeps the deployed runtime from
 * bloating with binaries for platforms nobody here is running.
 *
 * FOUND EMPIRICALLY (a real, live CI failure, not a hypothetical): which package is "the one this
 * machine actually uses" must be asked of the loader itself, not inferred by walking
 * `optionalDependencies` and taking the first name that merely `require.resolve()`s. A package
 * being resolvable only proves npm put a directory there — it's a documented npm optional-
 * dependency bug class (the same one this file's own error message points at,
 * github.com/npm/cli/issues/4828) that a stray, wrong-libc stub can be left resolvable alongside
 * the real one, and `Object.keys(optionalDependencies)` iterates in fixed declaration order (every
 * linux arch here lists its `-gnu` variant before its `-musl` one) — so on a real musl container
 * the old first-match loop silently copied the incompatible glibc package, and the genuinely
 * correct musl one was never deployed at all. Forcing the real `require('@napi-rs/keyring')` here
 * runs the SAME musl-aware platform switch `creds.mjs` will run at actual hook-time, so reading
 * back which platform package that load populated into `require.cache` is authoritative —
 * whatever it picked is guaranteed to be loadable, because it was just, in fact, loaded.
 */
function deployKeyring(dest) {
  let keyringPkgDir;
  try {
    keyringPkgDir = path.dirname(require.resolve('@napi-rs/keyring/package.json'));
  } catch {
    console.log('  (skipping @napi-rs/keyring: not installed here — CLAUDE_CODE_OAUTH_TOKEN falls back to the plaintext-file tier)');
    return;
  }

  try {
    require('@napi-rs/keyring'); // side effect: its own loader resolves + require.cache's the ONE platform package it actually needs
  } catch (e) {
    console.log(`  (skipping @napi-rs/keyring: no platform binary loads on this OS/arch (${e.message}) — CLAUDE_CODE_OAUTH_TOKEN falls back to the plaintext-file tier)`);
    return;
  }
  let platformPkgDir;
  let platformPkgName;
  for (const cachedPath of Object.keys(require.cache)) {
    const m = cachedPath.replace(/\\/g, '/').match(/\/@napi-rs\/(keyring-[^/]+)\/package\.json$/);
    if (m) {
      platformPkgName = `@napi-rs/${m[1]}`;
      platformPkgDir = path.dirname(cachedPath);
      break;
    }
  }
  if (!platformPkgDir) {
    console.log('  (skipping @napi-rs/keyring: loaded, but could not identify which platform package it used — CLAUDE_CODE_OAUTH_TOKEN falls back to the plaintext-file tier)');
    return;
  }

  const scopeDir = path.join(dest, 'node_modules', '@napi-rs');
  if (!dryRun) {
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.cpSync(keyringPkgDir, path.join(scopeDir, 'keyring'), { recursive: true });
    fs.cpSync(platformPkgDir, path.join(scopeDir, platformPkgName.split('/')[1]), { recursive: true });
  }
  console.log(`${dryRun ? '[dry-run] would deploy' : 'deployed'} @napi-rs/keyring + ${platformPkgName} to ${scopeDir}`);
}

/**
 * Append a matcher block per (event, file) pair, unless a block already carries our exact
 * command — idempotent across re-runs, so re-running `init` after an upgrade re-deploys the
 * files but never duplicates the wiring. Reads and merges the existing file; never overwrites or
 * removes anything this package didn't itself add.
 */
function mergeSettings(runtimeDir) {
  const settingsPath = path.join(claudeHome(), 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error(`refusing to touch ${settingsPath}: it exists but is not valid JSON (${e.message}). Fix or remove it, then re-run init.`);
      process.exitCode = 1;
      return null;
    }
  }
  settings.hooks ||= {};

  let added = 0;
  for (const [event, files] of Object.entries(HOOK_FILES)) {
    settings.hooks[event] ||= [];
    const commands = files.map((f) => `node "${path.join(runtimeDir, f)}"`);
    /**
     * PER-COMMAND, not per-event. The first cut checked "does ANY block already carry ANY of
     * this event's commands" and skipped the WHOLE event on a single match — so an upgrade that
     * adds a file to an event already partially wired (e.g. `Stop` gaining a third hook file)
     * silently wired NOTHING new for that event: the pre-existing command for the OTHER file
     * satisfied `already`, and the new one was never added, with no diagnostic. Found by a review
     * agent tracing this docstring's own "an upgrade... never duplicates the wiring" claim
     * against what happens when `HOOK_FILES[event]` grows. Compute what's actually missing,
     * across every existing block for this event, and add only that.
     */
    const existing = new Set(settings.hooks[event]
      .flatMap((block) => (Array.isArray(block.hooks) ? block.hooks : []))
      .map((h) => h.command));
    const missing = commands.filter((c) => !existing.has(c));
    if (!missing.length) continue;
    settings.hooks[event].push({ hooks: missing.map((command) => ({ type: 'command', command })) });
    added++;
  }

  if (!added) {
    console.log(`${settingsPath} already wires this runtime — nothing to add.`);
    return settingsPath;
  }
  if (dryRun) {
    console.log(`[dry-run] would add ${added} matcher block(s) to ${settingsPath}`);
    return settingsPath;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // FOUND (PM cold pass, this MR): this used to be a plain fs.writeFileSync — a truncate-then-
  // write over the user's ENTIRE global Claude Code config (MCP servers, permissions, every other
  // tool's hooks), not just the block this function adds. `writeFileAtomic` is already the tier
  // used for credentials.json a few lines away in this same file; settings.json is at least as
  // consequential and had no reason to be on the weaker path.
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`wired ${added} hook event(s) into ${settingsPath}`);
  return settingsPath;
}

/**
 * Pin whatever `vectros` identity is CURRENTLY active into `credentials.json`, so this package's
 * hooks resolve a STABLE alias from here on — immune to a LATER, unrelated `vectros switch`/
 * `bootstrap --tenant test` elsewhere on the machine changing what "active" means out from under
 * them (a real incident: provisioning an unrelated test-tenant credential for this package's own
 * harness work silently flipped a machine's active identity, and every hook that resolves
 * `VECTROS_API_KEY` with no explicit alias followed it — undetected, for a live session).
 *
 * Best-effort and NEVER fatal to `init`: no `vectros` install, no active identity yet, or a
 * failed probe all just skip pinning — the adopter still has the `VECTROS_API_KEY`/
 * `VECTROS_KEYRING_ALIAS` env-var escape hatches this always had. Never overwrites an alias
 * already pinned — that's a deliberate prior choice (possibly hand-edited), not this run's to
 * silently replace.
 */
function pinKeyringAlias() {
  const file = credentialsFile();
  const existing = readJsonSafe(file, {});
  const creds = existing.value && typeof existing.value === 'object' ? existing.value : {};
  if (creds.VECTROS_KEYRING_ALIAS) {
    console.log(`  keyring alias already pinned: '${creds.VECTROS_KEYRING_ALIAS}' (unchanged — edit ${file} to re-pin)`);
    return;
  }
  const active = resolveActiveKeyringAlias();
  if (!active) {
    console.log('  no active `vectros` identity found to pin — hooks will follow whatever becomes');
    console.log(`  active later, until you pin one: set VECTROS_KEYRING_ALIAS, or add`);
    console.log(`  {"VECTROS_KEYRING_ALIAS": "<alias>"} to ${file}.`);
    return;
  }
  /**
   * Check what's ABOUT to be pinned, not just what's currently pinned — a durable-but-wrong pin is
   * the same mistake this whole tier exists to prevent LATER, just made permanent at install time
   * instead (found in review). Loud, not blocking: an operator can legitimately want their normal
   * hooks pointed at a test tenant (a dedicated dev machine, say), so this warns and still pins —
   * it just makes sure that choice is visible rather than a silent side effect of whatever happened
   * to be active the moment `init` ran.
   */
  const secret = resolveKeyringSecretByAlias(active);
  if (secret && isTestShapedSecret(secret)) {
    console.log(`  ⚠ '${active}' is a TEST-tenant identity (ssk_test_*) — about to pin it as these `);
    console.log(`  hooks' default. If that's not deliberate: \`vectros switch <a live alias>\` and `);
    console.log(`  re-run init before this pin takes hold.`);
  }
  if (dryRun) {
    console.log(`  [dry-run] would pin keyring alias '${active}' to ${file}`);
    return;
  }
  creds.VECTROS_KEYRING_ALIAS = active;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(creds, null, 2) + '\n');
  console.log(`  pinned keyring alias '${active}' to ${file} — hooks now resolve THIS identity`);
  console.log(`  regardless of what the CLI's active identity later becomes. To change it: edit`);
  console.log(`  that file, or delete its VECTROS_KEYRING_ALIAS line and re-run init.`);
}

function printNextSteps(runtimeDir) {
  console.log('');
  console.log('Next steps:');
  console.log('  1. Provision the `candidate` and `memory` record schemas in your Vectros store —');
  console.log('     that is the entire schema dependency; no specific blueprint is required.');
  console.log('  2. Set a credential: export VECTROS_API_KEY, or install @vectros-ai/cli and run');
  console.log('     `vectros switch <alias>` once to activate the identity you want these hooks to');
  console.log('     use — `init` just pinned whatever was active at THIS moment (see above); switching');
  console.log('     again later does not silently move these hooks, by design.');
  console.log('  2b. Optional — only needed if you want capture/recall-eval\'s nested inference to');
  console.log('      run under your own subscription rather than ANTHROPIC_API_KEY:');
  console.log('        claude setup-token | claude-code-agent-memory set-token');
  console.log('  3. Restart Claude Code so the new entries in ~/.claude/settings.json take effect.');
  console.log(`  4. Runtime state lives in ${runtimeDir} — see its README.md for how the loop works.`);
}

switch (verb) {
  case 'init': {
    const runtimeDir = deployRuntime();
    const settingsPath = mergeSettings(runtimeDir);
    console.log('');
    console.log('Pinning the active keyring identity (hooks should not drift with a later `vectros switch`):');
    pinKeyringAlias();
    if (settingsPath) printNextSteps(runtimeDir);
    break;
  }
  case 'set-token':
    setToken();
    break;
  default:
    usage();
    process.exitCode = verb ? 1 : 0;
}
