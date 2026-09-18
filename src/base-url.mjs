/**
 * Base-URL validator — credential-exfil guard.
 *
 * `cred('VECTROS_API_BASE_URL')` feeds every network call this package makes
 * (`recall.mjs`, `candidates.mjs`, `dispose.mjs`, `enumerate.mjs`, `project.mjs`,
 * `recall-eval-worker.mjs`) — each attaches the live `ssk_*`/`sk_*` bearer, and the
 * hooks that fire on a prompt also attach the developer's own prompt text. An
 * attacker-controlled base URL — reachable via the env var, or the plaintext
 * `credentials.json` fallback tier `cred()` also reads for this name — exfiltrates
 * both to an arbitrary host.
 *
 * This validates the URL BEFORE it is ever attached to a credentialed fetch:
 *   - require `https://` — except `http://` to a loopback host (localhost/
 *     127.0.0.1/::1), for local proxying/dev;
 *   - require the host to be an official Vectros host: `vectros.ai` or a
 *     `*.vectros.ai` subdomain (strict suffix match — `api.vectros.ai.evil.com`
 *     and `evilvectros.ai` are rejected);
 *   - a loud, explicit opt-out (`VECTROS_ALLOW_INSECURE_BASE_URL=1`) permits an
 *     arbitrary host for a trusted local proxy, AFTER a warning.
 *
 * Mirrors the same guard in two sibling packages' CLI and MCP server
 * (same defect class, ported a third time rather than pulled into a shared
 * workspace dependency — each package already keeps its own tiny copy).
 *
 * FAIL-OPEN, unlike its siblings: this package's whole credential-resolution
 * contract (`creds.mjs`'s module header) is "never throw — every resolver
 * returns '' and every caller degrades to doing nothing." So `validateApiBaseUrl`
 * does not throw; it returns `undefined` on a refused URL (after one `hlog` line),
 * and the caller (`creds.mjs`'s `cred()`) lets that fall through to the safe
 * default every call site already has (`cred('VECTROS_API_BASE_URL') || 'https://api.vectros.ai'`).
 */
import { hlog } from './hooklog.mjs';

/** The official Vectros apex + subdomain suffix. */
const ALLOWED_HOST_APEX = 'vectros.ai';
const ALLOWED_HOST_SUFFIX = '.vectros.ai';

/** Env var that loudly opts out of the host allow-list (trusted local proxy). */
export const INSECURE_BASE_URL_ENV = 'VECTROS_ALLOW_INSECURE_BASE_URL';

/** localhost / 127.0.0.1 / ::1 (URL.hostname keeps IPv6 brackets). */
function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function insecureOptOutFromEnv() {
  const v = (process.env[INSECURE_BASE_URL_ENV] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Validate `rawUrl` and return it unchanged on success, or `undefined` (after one
 * `hlog('creds', …)` line explaining why) on refusal.
 */
export function validateApiBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    hlog('creds', `VECTROS_API_BASE_URL ${JSON.stringify(rawUrl)} is not a parseable absolute URL `
      + '(expected e.g. https://api.vectros.ai) — falling back to the default.');
    return undefined;
  }

  const allowInsecure = insecureOptOutFromEnv();
  const scheme = url.protocol;
  // Strip a single trailing dot (the FQDN form `api.vectros.ai.` is a legit alias
  // of the real host) so the suffix/loopback checks treat them alike.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = isLoopbackHost(host);

  if (allowInsecure) {
    if (scheme !== 'https:' && scheme !== 'http:') {
      hlog('creds', `VECTROS_API_BASE_URL has scheme "${scheme}" — only http/https are supported; `
        + 'falling back to the default.');
      return undefined;
    }
    hlog('creds', `WARNING: ${INSECURE_BASE_URL_ENV} is set — sending Vectros credentials + prompt `
      + `text to UNVALIDATED host "${url.host}". This bypasses the base-URL allow-list. Unset it `
      + 'unless you are intentionally proxying to a trusted local endpoint.');
    return rawUrl;
  }

  if (scheme === 'http:') {
    if (!loopback) {
      hlog('creds', `Refusing insecure http:// VECTROS_API_BASE_URL for non-loopback host `
        + `"${url.host}" — use https:// (or set ${INSECURE_BASE_URL_ENV}=1 to override for a `
        + 'trusted local proxy). Falling back to the default.');
      return undefined;
    }
    return rawUrl;
  }
  if (scheme !== 'https:') {
    hlog('creds', `Refusing VECTROS_API_BASE_URL with scheme "${scheme}" — only https:// (or `
      + 'http:// to localhost) is allowed. Falling back to the default.');
    return undefined;
  }

  // https — host must be loopback or an official Vectros host.
  if (loopback) return rawUrl;
  if (host === ALLOWED_HOST_APEX || host.endsWith(ALLOWED_HOST_SUFFIX)) return rawUrl;

  hlog('creds', `Refusing VECTROS_API_BASE_URL host "${url.host}" — not an official Vectros host `
    + `(expected vectros.ai or a *.vectros.ai subdomain). Set ${INSECURE_BASE_URL_ENV}=1 to override `
    + '(e.g. for a trusted local proxy); never point this at an untrusted host while authenticated. '
    + 'Falling back to the default.');
  return undefined;
}
