/**
 * Credential resolution for @vectros-ai/claude-code-agent-memory.
 *
 * Two credentials, two different resolution paths, for two different reasons — the shapes below
 * are the outcome of that reasoning, laid out inline rather than pointed at elsewhere.
 *
 *   VECTROS_API_KEY          — env, else the CLI credential-helper contract:
 *                               `vectros keyring show --format raw [--alias <a>]`. The SAME
 *                               contract @vectros-ai/mcp-server already resolves its own key
 *                               through (see its `resolve-key.ts`) — zero code coupling, just a
 *                               stable one-line text contract, the same shape as `git
 *                               credential`/`docker-credential-*`/`aws credential_process`. No
 *                               plaintext-file fallback for this one: an adopter without the CLI
 *                               installed sets the env var, same as every other consumer of this
 *                               contract, rather than this package inventing a second store for a
 *                               secret the CLI already owns.
 *   CLAUDE_CODE_OAUTH_TOKEN   — env, else the OS credential store via the optional
 *                               `@napi-rs/keyring` native binding (the preferred tier — at-rest
 *                               encrypted, OS-native), else a local `credentials.json` file as a
 *                               last resort — WARNED,
 *                               because unlike the keychain it is plaintext at rest. No CLI
 *                               equivalent exists for this credential (it authenticates the
 *                               nested `claude -p` child, not a Vectros call), so this package
 *                               owns its storage directly rather than delegating.
 *
 * WHY CLAUDE_CODE_OAUTH_TOKEN stays OUT of settings.json / a session-wide env var: set
 * session-wide it would also be picked up by the owner's NORMAL Claude Code sessions — and a
 * `setup-token` credential is INFERENCE-SCOPED ONLY (it can't establish Remote Control sessions),
 * so a stray global would silently DEGRADE the primary tool's auth. The token is needed by
 * exactly one thing: the `claude -p` child the capture/recall-eval workers spawn. So it stays out
 * of the parent process's env entirely and is injected only into that child — narrowest blast
 * radius. See `childEnv()` below.
 *
 * FAIL-OPEN THROUGHOUT: every resolver returns `''` rather than throwing, and every caller is
 * written to degrade to "do nothing" on an empty credential (each hook's own `if (!API_KEY)
 * return`) — a missing/misconfigured credential must never break a Claude Code turn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readJsonSafe } from './atomic.mjs';
import { hlog } from './hooklog.mjs';
import { credentialsFile, workersOffFile } from './paths.mjs';
import { CREDS_HELPER_TIMEOUT_MS, CREDS_HELPER_MAX_BUFFER, CREDS_DETAIL_MAX_CHARS } from './config.mjs';

const require = createRequire(import.meta.url);

/**
 * KILL SWITCH for the nested-inference workers — presence of the file is the OFF signal.
 * A file, not an env var, deliberately: hooks are fresh processes that read from disk on every
 * invocation, so `touch WORKERS_OFF` takes effect on the very next hook with no app restart —
 * which is exactly what you want from a switch you reach for while something is actively broken.
 */
export function workersDisabled() {
  try { return fs.existsSync(workersOffFile()); } catch { /* silence-ok: existsSync barely throws; "not disabled" is the status quo on the rare failure — the workers' own gates still apply. Failing the other way would silently disable the loop, the worse direction. */ return false; }
}

// ── The plaintext file tier. Used for: (a) non-secret/low-sensitivity config values that were
//    never worth a keychain entry (VECTROS_API_BASE_URL, the ANTHROPIC_API_KEY alt-auth path for
//    the nested child), and (b) CLAUDE_CODE_OAUTH_TOKEN's LAST-RESORT fallback when no native
//    keychain binding is available — always with a loud warning, see resolveOAuthToken below.

let cachedFile;

/**
 * Read the credentials file once per process. Never throws; never logs the values.
 *
 * ABSENT AND MALFORMED ARE NOT THE SAME THING. `credentials.json` is hand-authored — the file
 * most likely to be *malformed* rather than absent (one trailing comma is enough) — and a silent
 * `{}` on a malformed file is indistinguishable from "no credential configured", which is
 * otherwise a perfectly legitimate quiet state. So: `readJsonSafe`, which keeps that distinction.
 * ENOENT stays quiet (unconfigured is real and fine); anything else announces itself once.
 */
function loadCredsFile() {
  if (cachedFile) return cachedFile;
  const r = readJsonSafe(credentialsFile(), {});
  if (r.state === 'unreadable' || r.state === 'damaged') {
    hlog('creds', `credentials.json ${r.state === 'damaged' ? 'DAMAGED' : 'UNREADABLE'} (${r.why}) — `
      + `every file-backed credential now resolves to '' and the loop will no-op as if `
      + `UNCONFIGURED. This is not "no key set"; fix the file.`);
  }
  cachedFile = r.value && typeof r.value === 'object' ? r.value : {};
  return cachedFile;
}

// ── VECTROS_API_KEY: delegate to the installed `vectros` CLI's keyring.

/** Secret-shaped substrings, redacted from anything that could reach a log. */
const SECRET_RE = /(?:ssk|sk|st)_(?:live|test)_[A-Za-z0-9._-]+/gi;

function redactDetail(message) {
  const redacted = String(message).replace(/\s+/g, ' ').trim().replace(SECRET_RE, '[redacted]');
  return redacted.length > CREDS_DETAIL_MAX_CHARS ? `${redacted.slice(0, CREDS_DETAIL_MAX_CHARS)}…` : redacted;
}

/**
 * Shape-only test-tenant detection (`ssk_test_…`/`sk_test_…`/`st_test_…`) — the tenant rides the
 * key itself (the CLI's own `bootstrap --tenant` help text: "the tenant rides the key (ssk_test_*
 * vs ssk_live_*)"), so this needs no network round trip.
 *
 * Exists because `vectros bootstrap --tenant test` silently ACTIVATES the newly minted test
 * credential as the machine's default identity — a real, live incident: provisioning a test
 * tenant for this package's own harness work flipped the active identity, and every hook that
 * resolves `VECTROS_API_KEY` with no explicit `VECTROS_KEYRING_ALIAS` (the common case — see
 * `runKeyringHelper` above) silently ran against the test tenant instead of live, with nothing
 * surfacing the switch. This is the mitigation on THIS package's side while the underlying CLI
 * behavior is addressed upstream: one loud line is not a guarantee every caller reads hooks.log,
 * but it is strictly better than the silence that let this run unnoticed for a live session.
 */
const TEST_KEY_RE = /^(?:ssk|sk|st)_test_/i;
let testKeyWarned = false;
function warnIfTestKeyOnce(key) {
  if (testKeyWarned || !key || !TEST_KEY_RE.test(key)) return;
  testKeyWarned = true;
  hlog('creds', 'VECTROS_API_KEY resolves to a TEST-tenant secret (ssk_test_*) — this run is '
    + 'operating against a test tenant, not live. If that is not deliberate: `vectros keyring '
    + 'doctor` to see the active identity, `vectros switch <alias>` to fix it.');
}

/**
 * Resolve `command` to an ABSOLUTE path via PATH (+ PATHEXT on Windows), or undefined.
 *
 * Ported from @vectros-ai/mcp-server's `resolve-key.ts` (the SAME credential-helper contract,
 * same hazard): a relative PATH entry resolves against the CURRENT DIRECTORY, so returning a
 * bare command name and letting the shell re-resolve it would let a stray `./vectros.bat` sitting
 * in whatever directory a hook happens to run from execute instead of the trusted binary this
 * lookup found. Absolute-or-nothing is what the Windows spawn below rests on.
 */
function resolveCommandPath(command) {
  const platform = process.platform;
  const pathVar = process.env.PATH || process.env.Path || process.env.path || '';
  if (!pathVar) return undefined;
  const exts = platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];
  for (const rawDir of pathVar.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1'); // Windows PATH entries may be quoted
    if (!dir || !path.isAbsolute(dir)) continue; // never resolve a cwd-relative PATH entry — see above
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* silence-ok: candidate just doesn't exist at this dir/ext — try the next one */ }
    }
  }
  return undefined;
}

const ALIAS_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Spawn `vectros keyring show --format raw [--alias <a>]` and return its secret, or `''`.
 *
 * SYNCHRONOUS, deliberately — matching the sync `execFileSync`/`spawnSync` convention already
 * used throughout this codebase (`windowsHide: true` on every spawn site), because `cred()` is
 * called at MODULE TOP LEVEL by several hooks (`recall.mjs`, `capture.mjs`, `evaluate.mjs`, …) —
 * an async credential resolver would ripple an `await` through every one of those call sites, far
 * outside this file's scope. The real cost this accepts: `recall.mjs` fires on every
 * UserPromptSubmit, so with no env var set this spawns a `vectros` child on every prompt. Each
 * hook invocation is already a fresh process (no cross-invocation cache is possible without
 * re-inventing an at-rest store — the exact problem the CLI keyring already solves), so this is a
 * genuine, accepted latency trade-off, not an oversight — flagged here for whoever profiles the
 * install story.
 */
/**
 * The alias to pass to `keyring show`, or `''` to fall through to the CLI's ambient ACTIVE
 * identity. Three tiers, in order:
 *
 *   1. `VECTROS_KEYRING_ALIAS` env var — explicit, per-invocation, always wins.
 *   2. `credentials.json`'s pinned `VECTROS_KEYRING_ALIAS` — written once by `init` (see cli.mjs's
 *      `pinKeyringAlias`), from whatever WAS active at install time. This is the tier that exists
 *      because `vectros bootstrap --tenant test` unconditionally activates the newly minted
 *      credential — including for a test tenant — with no relation to what a caller actually
 *      wants. Without a pin, EVERY hook that resolves `VECTROS_API_KEY` with no explicit alias
 *      silently follows that ambient pointer wherever it goes next, forever, including into a
 *      completely unrelated test-tenant mint run for some other purpose entirely (a real incident:
 *      provisioning a test-tenant harness credential flipped a machine's hooks onto the test
 *      tenant with nothing surfacing it). Pinning at install time means a LATER ambient switch
 *      elsewhere on the machine cannot silently redirect this package's hooks — they keep
 *      resolving whatever was deliberately pinned.
 *   3. Neither set — fall through to the CLI's ambient active identity, exactly as before this was
 *      found. Kept as the last resort (not removed) for zero-config first runs and any adopter who
 *      never ran `init` on this machine at all (e.g. `VECTROS_API_KEY` set directly).
 */
function resolveAliasPreference() {
  const env = (process.env.VECTROS_KEYRING_ALIAS || '').trim();
  if (env) return env;
  const pinned = String(loadCredsFile().VECTROS_KEYRING_ALIAS || '').trim();
  return pinned;
}

function runKeyringHelper() {
  const resolved = resolveCommandPath('vectros');
  if (!resolved) return ''; // CLI not installed — quiet; the caller's own fail-open handles it, same as "unconfigured"

  const alias = resolveAliasPreference();
  if (alias && !ALIAS_RE.test(alias)) {
    hlog('creds', 'the configured VECTROS_KEYRING_ALIAS is not a valid alias (letters/digits/dot/dash/underscore only) — ignoring it and using the active identity');
  }
  const args = ['keyring', 'show', '--format', 'raw', ...(alias && ALIAS_RE.test(alias) ? ['--alias', alias] : [])];

  const isWindows = process.platform === 'win32';
  // `shell: true` on Windows needs the resolved path quoted ourselves (it may contain spaces,
  // e.g. `C:\Program Files\...`); resolveCommandPath already guaranteed it is absolute, which is
  // what stops the shell re-resolving a bare name from the current directory.
  const file = isWindows ? `"${resolved}"` : resolved;
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8', timeout: CREDS_HELPER_TIMEOUT_MS, maxBuffer: CREDS_HELPER_MAX_BUFFER,
      windowsHide: true, shell: isWindows,
    });
    return out.trim();
  } catch (e) {
    // Exit 1/2 = "the keyring has no key for you" (no active identity, no such alias, an entry
    // that won't decrypt, or an old CLI that predates the command) — quiet, the same event as
    // unconfigured. Anything else (a wedged CLI, a timeout, a spawn failure) gets one hlog line
    // so it doesn't silently look identical to "nothing set".
    const code = e && e.status;
    if (code !== 1 && code !== 2) {
      hlog('creds', `\`vectros keyring show\` failed (${redactDetail((e && (e.stderr || e.message)) || e)}) — VECTROS_API_KEY resolves to '' this run`);
    }
    return '';
  }
}

/**
 * `vectros keyring list --json`'s `active` field, or `''` on ANY failure (CLI not installed, no
 * active identity, a malformed response, a spawn error) — this is a best-effort ONE-SHOT probe
 * for `cli.mjs`'s `pinKeyringAlias` at `init` time, not something a hook calls on every
 * invocation, so it does not need `resolveApiKey`'s memoization.
 *
 * FOUND against the real CLI, not the test suite's fake (the fake accepted whatever flag it was
 * given, so this was never caught locally): `keyring list --help` on the actually-installed CLI
 * only supports a bare `--json` boolean, not `--format json` (which `keyring show` DOES support,
 * a genuinely different flag on a sibling subcommand). The wrong flag made `init`'s alias pinning
 * — the actual mitigation this whole file exists for — silently find nothing to pin on every
 * real machine, `catch`-swallowed into the same "nothing to pin" path as no-CLI-installed.
 *
 * Deliberately the SAME `resolveCommandPath`/spawn shape as `runKeyringHelper` — one place that
 * knows how to safely invoke the `vectros` binary (the absolute-path resolution exists
 * specifically to stop a relative PATH entry re-resolving against the current directory; see
 * `resolveCommandPath`'s own header), not a second copy of that reasoning.
 */
export function resolveActiveKeyringAlias() {
  const resolved = resolveCommandPath('vectros');
  if (!resolved) return '';
  const isWindows = process.platform === 'win32';
  const file = isWindows ? `"${resolved}"` : resolved;
  try {
    const out = execFileSync(file, ['keyring', 'list', '--json'], {
      encoding: 'utf8', timeout: CREDS_HELPER_TIMEOUT_MS, maxBuffer: CREDS_HELPER_MAX_BUFFER,
      windowsHide: true, shell: isWindows,
    });
    const parsed = JSON.parse(out);
    return typeof parsed.active === 'string' ? parsed.active : '';
  } catch { /* silence-ok: no vectros, no active identity, a wedged CLI, unparsable output — every case is "nothing to pin", exactly like resolveApiKey()'s own fail-open contract. */ return ''; }
}

/**
 * Is `secret` shaped like a TEST-tenant credential? Exported alongside `TEST_KEY_RE` itself so a
 * caller outside this module (`cli.mjs`'s `pinKeyringAlias`) can apply the SAME shape check
 * `warnIfTestKeyOnce` uses at hook-run time, at PIN time instead — found in review: the original
 * pin logic happily durable-pins whatever is active with no regard for its shape, which means an
 * operator who runs `init` in the narrow window right after an unrelated `vectros bootstrap
 * --tenant test` (structurally the SAME mistake this whole fallback tier exists to stop happening
 * LATER) gets it baked in at install time instead, with only the quieter per-hook warning to catch
 * it afterward. A cheap, loud check at pin time is worth having in addition to that, not instead
 * of it — `pinKeyringAlias` still pins (never overwrites a choice), just says so unmistakably.
 */
export function isTestShapedSecret(secret) {
  return TEST_KEY_RE.test(String(secret || ''));
}

/** Resolve a NAMED alias's raw secret — not the active one. Same safe-invocation shape as
 * `runKeyringHelper`; used only for the one-shot shape check above, never on a hot path. */
export function resolveKeyringSecretByAlias(alias) {
  const resolved = resolveCommandPath('vectros');
  if (!resolved || !ALIAS_RE.test(alias)) return '';
  const isWindows = process.platform === 'win32';
  const file = isWindows ? `"${resolved}"` : resolved;
  try {
    const out = execFileSync(file, ['keyring', 'show', '--format', 'raw', '--alias', alias], {
      encoding: 'utf8', timeout: CREDS_HELPER_TIMEOUT_MS, maxBuffer: CREDS_HELPER_MAX_BUFFER,
      windowsHide: true, shell: isWindows,
    });
    return out.trim();
  } catch { /* silence-ok: same fail-open contract as every other resolver here. */ return ''; }
}

let apiKeyTried = false;
let apiKeyResolved = '';

function resolveApiKey() {
  if (apiKeyTried) return apiKeyResolved; // memoized per process — cred() may be read more than once by one hook
  apiKeyTried = true;
  try { apiKeyResolved = runKeyringHelper(); } catch { /* silence-ok: belt-and-suspenders — runKeyringHelper() already catches every failure it knows about internally; this only guards against a bug in that handling itself, and the fail-open contract here is identical either way. */ apiKeyResolved = ''; }
  return apiKeyResolved;
}

// ── CLAUDE_CODE_OAUTH_TOKEN: OS keychain via @napi-rs/keyring, else the warned plaintext file.

/**
 * Service/account this package files its ONE keychain entry under. Stable and
 * user-recognisable — shows up in Windows Credential Manager / `secret-tool search`. Distinct
 * from `@vectros-ai/cli`'s own `vectros-cli` service: this is a different secret (an Anthropic
 * OAuth token, not a Vectros key) with a different owner (this package, not the CLI).
 */
const KEYCHAIN_SERVICE = 'vectros-claude-code-agent-memory';
const OAUTH_ACCOUNT = 'claude-code-oauth-token';

let keychainBinding; // undefined = not yet probed; null = probed and unavailable

/**
 * Load `@napi-rs/keyring` synchronously via `createRequire`, since it is an OPTIONAL native
 * dependency that may simply not be installed (unsupported platform, an install run with
 * `--no-optional`) — never let its absence throw past this module. `Entry#getPassword()` on the
 * binding never throws (a missing entry, a locked collection, and a dead credential service all
 * collapse to `null` upstream — see `@vectros-ai/cli`'s `os-keychain.ts` for the documented
 * source of that behaviour); `#setPassword()` does throw on failure, which the caller catches.
 */
function loadKeychain() {
  if (keychainBinding !== undefined) return keychainBinding;
  try {
    keychainBinding = require('@napi-rs/keyring');
  } catch {
    // silence-ok: an OPTIONAL native dependency that legitimately isn't installed (no prebuilt
    // for this platform, an install run with --no-optional) is expected, not an error — every
    // caller degrades to the plaintext file tier, WARNED, exactly as this module documents above.
    keychainBinding = null;
  }
  return keychainBinding;
}

let oauthWarned = false;
function warnPlaintextFallbackOnce() {
  if (oauthWarned) return;
  oauthWarned = true;
  hlog('creds', 'CLAUDE_CODE_OAUTH_TOKEN resolved from the plaintext credentials.json fallback tier '
    + '(no OS credential store available). Install/enable @napi-rs/keyring for at-rest encryption.');
}

function resolveOAuthToken() {
  const kc = loadKeychain();
  if (kc) {
    try {
      const entry = new kc.Entry(KEYCHAIN_SERVICE, OAUTH_ACCOUNT);
      const pw = entry.getPassword();
      if (pw) return pw;
    } catch { /* silence-ok: treat exactly like "no entry" — fall through to the file tier below */ }
  }
  const fromFile = loadCredsFile().CLAUDE_CODE_OAUTH_TOKEN;
  if (fromFile) {
    warnPlaintextFallbackOnce();
    return fromFile;
  }
  return '';
}

/**
 * Write CLAUDE_CODE_OAUTH_TOKEN into the OS keychain when available. Exported for `init`/a future
 * `set-token` verb — this module itself only ever READS credentials at hook-run time.
 * Throws on a genuine store failure (a locked/unreachable keychain); the caller decides whether
 * that is fatal to its own flow.
 */
export function storeOAuthToken(token) {
  const kc = loadKeychain();
  if (!kc) throw new Error('@napi-rs/keyring is not available on this platform/install — set CLAUDE_CODE_OAUTH_TOKEN in credentials.json instead');
  new kc.Entry(KEYCHAIN_SERVICE, OAUTH_ACCOUNT).setPassword(token);
}

/** The inverse of {@link storeOAuthToken} — for a future rotate/uninstall verb, and test cleanup. */
export function removeOAuthToken() {
  const kc = loadKeychain();
  if (!kc) return false;
  try {
    return new kc.Entry(KEYCHAIN_SERVICE, OAUTH_ACCOUNT).deleteCredential();
  } catch { /* silence-ok: best-effort cleanup — a failed delete just leaves the entry in place, and the next storeOAuthToken() overwrites it regardless. */ return false; }
}

/**
 * TEST-ONLY escape hatch — read the raw keychain entry, bypassing `cred()`'s module-level
 * memoization, so the test suite can SNAPSHOT the real entry before writing a throwaway test
 * value into it and RESTORE the snapshot afterward, rather than unconditionally deleting
 * whatever was there.
 *
 * Exists because of a real incident: the keychain entry this module writes to
 * (`KEYCHAIN_SERVICE`/`OAUTH_ACCOUNT` above) is a fixed, machine-wide constant — the SAME
 * entry a real deployment's real `CLAUDE_CODE_OAUTH_TOKEN` lives in. A routine `npm test` run
 * on a machine that had already migrated a real token into the keychain silently deleted it a
 * SECOND time (the first incident was the plaintext-file tier; this is the keychain tier —
 * same root cause, different storage layer: test code assuming it owns a resource it doesn't).
 * `storeOAuthToken`/`removeOAuthToken` are the write primitives a snapshot/restore needs; this
 * is the matching read primitive with no caller-visible caching to fight.
 */
export function _peekOAuthTokenRaw() {
  const kc = loadKeychain();
  if (!kc) return null;
  try { return new kc.Entry(KEYCHAIN_SERVICE, OAUTH_ACCOUNT).getPassword(); } catch { /* silence-ok: matches resolveOAuthToken() above — treat an unreadable entry exactly like "no entry", null, which is this function's own absent-value return. */ return null; }
}

// ── The public surface. Unchanged shape from the pre-packaged module, so every existing caller
//    (`cred()` called at module top level throughout the hooks) keeps working untouched.

/** Resolve one credential. Explicit env always wins (back-compat / explicit override). */
export function cred(name) {
  // VECTROS_API_KEY gets its own branch (not just the generic env-first fallthrough below) so the
  // test-tenant check applies to BOTH resolution paths — an explicit env var can be a test key
  // pasted in by mistake just as easily as the ambient keyring identity can be one.
  if (name === 'VECTROS_API_KEY') {
    const key = process.env.VECTROS_API_KEY || resolveApiKey();
    if (key) warnIfTestKeyOnce(key);
    return key;
  }
  const env = process.env[name];
  if (env) return env;
  if (name === 'CLAUDE_CODE_OAUTH_TOKEN') return resolveOAuthToken();
  return loadCredsFile()[name] || ''; // VECTROS_API_BASE_URL, ANTHROPIC_API_KEY — unchanged, file-backed
}

/**
 * The environment for a nested `claude -p`. ONE definition — both workers import it.
 *
 * IT IS AN ALLOW-LIST, deliberately: everything the child needs is named explicitly rather than
 * inherited via `...process.env`, because that child's INPUT is attacker-influenceable (it is
 * transcript text, and an agent quoting a malicious file into its own prose lands there). A
 * denylist of secret names is a promise to remember every future one; naming exactly what the
 * child needs is the only version of this that stays true as the parent env grows.
 */
const CHILD_ENV_ALLOW = [
  // Windows/Node runtime essentials. Without these the binary does not launch.
  'SystemRoot', 'windir', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ProgramW6432',
  'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE', 'SystemDrive', 'USERNAME',
  // Node itself.
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH',
  // Corporate networks: a nested call that cannot reach the API is useless.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export function childEnv() {
  const env = {};
  for (const k of CHILD_ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];

  // The ONE credential this child is entitled to: the subscription token for its own inference.
  // Injected here and nowhere else — never in the parent session, whose host-managed Desktop auth
  // a session-wide setup-token would degrade (see the module header).
  const token = cred('CLAUDE_CODE_OAUTH_TOKEN');
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const apiKey = cred('ANTHROPIC_API_KEY');
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

  // NOT passed, deliberately: VECTROS_API_KEY. The child makes no Vectros call — the worker runs
  // the search itself, as deterministic code we control. Giving it the key would license a
  // direct-write path this design never intends the nested inference to have.
  env.VECTROS_RECALL_EVAL = '1'; // the nested session must not re-fire any hook
  return env;
}
