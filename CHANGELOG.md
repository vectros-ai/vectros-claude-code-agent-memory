# Changelog

All notable changes to `@vectros-ai/claude-code-agent-memory` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.13.1 — 2026-09-17

Pre-1.0 / beta.

### Security

- **`VECTROS_API_BASE_URL` was never validated, and it determines where every hook fetch attaches
  the live `ssk_*`/`sk_*` bearer — and, on the prompt-firing hooks, the developer's own prompt
  text.** An attacker-influenced value (the env var, or the plaintext `credentials.json` fallback
  tier this name also reads from) could redirect `recall.mjs`, `candidates.mjs`, `dispose.mjs`,
  `enumerate.mjs`, `project.mjs`, and `recall-eval-worker.mjs` to an arbitrary host with no scheme
  constraint and no warning. `cred('VECTROS_API_BASE_URL')` now validates at that one boundary
  (mirroring the same guard already shipped in `@vectros-ai/cli` and `@vectros-ai/mcp-server`):
  `https://` (or `http://` to a loopback host) to an official `vectros.ai`/`*.vectros.ai` host, with
  a loud `VECTROS_ALLOW_INSECURE_BASE_URL=1` opt-out for a trusted local proxy. Consistent with this
  package's fail-open design, a refused value never throws — it resolves to `''`, which every call
  site already turns into the real default (`https://api.vectros.ai`).

### Fixed

- **The README's description of `propose()` never stated that it transmits data automatically.**
  It correctly said a captured candidate is never written into your *searchable* knowledge base
  without disposition — that claim was already true and is unchanged — but it never said that
  distilling a candidate also **immediately POSTs it to your Vectros store** as an unreviewed
  `candidate` record, before any review happens. A reader could reasonably take "you decide,
  always" to mean nothing leaves the machine until then. The README now states the automatic POST
  plainly, in the same bullet, and names what it actually contains — title, body, category,
  session id, and (when the distiller found one) a suggested destination, an area tag, free-text
  tags, or a cited file/doc reference — rather than a partial list that would itself misstate the
  payload. The existing, accurate distinction between "transmitted" and "recallable" is kept, not replaced
  with a broader warning. The same bullet also now states plainly that nothing filters this content
  for sensitivity before it transmits — a candidate can echo a secret or other sensitive transcript
  content verbatim; closing that gap is tracked as its own follow-up, out of scope here.
- **Internal review-process vocabulary, published in this package's shipped `src/`, `dist/`, and
  sourcemaps.** Comments naming this project's own internal review stages, and one runtime string
  literal (a tunable's `note:` field — actual program output, not a strippable comment), reached
  users on three channels: the GitHub source mirror (ships `src/` verbatim), the npm `dist/` build
  (a near-passthrough, `bundle: false`/no `minify`), and every sourcemap whose `sourcesContent`
  embeds the original source. The originally-reported count was 31 hits across 17 files; sweeping
  by category (every phrasing variant of the same internal terminology, not just the instances
  named) found more — 31 files in total. Reworded every instance found (comments only, one runtime
  string) to describe the same finding generically; none of it changes behavior. Re-verified
  against a rebuilt `dist/` and its sourcemaps, not source alone.
- **A second, narrower category of internal framing: references naming this package's own internal
  developer by role, and "flagship"/"dogfood" language describing this as the company's own
  internal tool** — 63 sites across 34 files in `src/` and `src/tests/`. Each rewording kept the
  substantive technical rationale (a measurement, a root cause, a design constraint) and dropped
  only the internal framing/attribution/date wrapper around it — no behavioral change. Five test
  fixtures also used a fake API key shape (`sk_test_smoke0000...`) that isn't distinguishable by
  the published scrub gate's allowlisted "obviously fake" convention; renamed to that convention
  (`sk_test_invalid_...`).
- Removed remaining dated, first-person and development-process narration, and references to
  non-shipped internal tooling, from source comments; technical rationale retained. 65 files in
  `src/`, `src/tests/`, and the build config. A small number of user-visible/test-output strings
  were reworded to the same standard, not just comments: two `report.mjs` console.log lines,
  three `config.mjs` tunable `note:` values (surfaced wherever config defaults are reported), and
  three test-assertion label strings (`dispose-test.mjs`, `nudge-test.mjs`, `config-test.mjs`) —
  none change what the code does, only what it prints or labels.

- **Two more source comments named a sibling package by monorepo-relative path**
  (`base-url.mjs`'s doc comment describing that the same guard is ported into two sibling
  packages' CLI/MCP server; `tests/run-all.mjs`'s note on a sibling package's keyring-lock
  behavior) — found by a post-merge audit. Reworded to describe the siblings generically; no
  behavioral change.

## 0.13.0 — 2026-09-07

Pre-1.0 / beta.

### Fixed

- **A review queue larger than one page (100+ pending candidates) could no longer be listed at
  all.** Paging past the first page sent the resume cursor under the wrong field name, which the
  API rejects outright — every listing read past page one failed instead of returning the rest of
  the queue.
- **Recall queries carrying path-traversal, SSRF-literal, or SQL-comment-idiom shapes no longer
  silently lose recall.** The outbound `/v1/search` query is now normalized (at the same shared
  boundary that already strips harness-tag markup) to defuse the specific byte patterns that could
  trip the edge WAF's content-inspection rules — a query is never rejected outright by this hook,
  but a tripped rule previously meant a silent, zero-hit search on exactly the sessions (security
  engineering, or ordinary local-dev work mentioning `127.0.0.1`/`localhost`) most likely to need
  a real hit back.

## 0.12.0

Pre-1.0 / beta.

### Added

- **`CLAUDE.md.sample`** — a starting-point CLAUDE.md section for prompting your agent to use
  this loop well: how to treat a recall hit (authoritative for what a past session *decided*,
  never evidence of what the code *currently does*), and the three questions worth asking before
  disposing a candidate (is it true, is it already known, would a future session actually act
  differently for having read it). The hooks handle the mechanics; this is the judgment layer
  they can't supply on their own. Referenced from the README's new "Prompting your agent to use
  this well" section.

## 0.11.0

Initial release. Pre-1.0 / beta.

### Added

- **`init` command** — deploys the hook runtime to `~/.claude/vectros-memory` (override with
  `VECTROS_MEMORY_HOME`) and wires it into Claude Code by appending matcher blocks to your global
  `~/.claude/settings.json`. Never touches a matcher block it didn't itself write, never touches
  project-scoped settings, and is safe to re-run — already-wired entries are recognized and
  skipped rather than duplicated. Supports `--dry-run` to preview the change with no writes.
- **Recall hooks** — on every prompt, a rolling window of the conversation is used to search your
  Vectros store and inject relevant hits into context automatically. A second, debounced pass
  re-evaluates after tool calls using a small nested Claude call (Haiku by default) to catch
  recall opportunities the first pass's plain search misses.
- **Capture worker** — once a session accumulates enough new transcript, a background worker
  distills candidate lessons (durable facts, decisions, gotchas) out of it and proposes them into
  a review queue. Nothing captured is written to your knowledge base, or returned by any recall
  query, until you explicitly dispose of it.
- **`dispose.mjs`** (runtime-directory script) — lists and settles pending candidates for a
  session: store one as a real memory record (read back from your Vectros store before it's
  accepted, so a bad id is refused rather than silently mis-filed), point it at existing
  documentation, or discard it with a reason. A disposed candidate is never re-offered. Accepts
  either a session's full id or an unambiguous prefix of one — the same short form a nudge line
  displays — refusing outright (never silently reading as "nothing pending") if the prefix is
  ambiguous or matches nothing.
- **`report.mjs`** (runtime-directory script) — shows current recall/capture/disposition activity,
  the undistilled transcript tail, and (`--compare`) whether the local review queue and your
  Vectros record corpus agree.
- **`set-token` command** — stores an optional `CLAUDE_CODE_OAUTH_TOKEN` (read from stdin) for the
  capture/recall-eval workers' nested `claude -p` child, so those calls can run under your own
  Claude subscription instead of `ANTHROPIC_API_KEY`. Uses your OS credential store via the
  optional `@napi-rs/keyring` native binding when available, falling back to a local
  `credentials.json` (plaintext, clearly labeled as the weaker tier) otherwise.
- **Fail-open by design** — a missing credential, an unreachable API, or a malformed config value
  degrades the affected hook to a no-op instead of breaking your turn.
- Every tunable the loop uses (retrieval window sizes, debounce timers, budget caps, …) lives in
  the deployed `config.mjs`, with a shipped default and a `VECTROS_MEM_<KEY>` env-var override;
  `report.mjs`'s output shows which are currently in force.
- **`reap.mjs`** — prunes `state/` and `queue/` of stale/phantom session data so both grow bounded
  over time. Runs automatically off the Stop hook path (debounced); also runnable directly
  (`node reap.mjs [--apply]`, dry-run by default) with a receipt of what it pruned, deferred, and
  refused. Never prunes a queue with an unsettled candidate or a live claim.
- **Orphan-cap backstop** — a candidate nobody has settled is re-offered to whichever session is
  around, forever, by design; if that persists across `ORPHAN_CAP_DAYS` distinct calendar days
  (default 7), it is auto-disposed `ignored` (never a raw offer count, so one long session
  re-checking it all day never counts for more than a single day). Always reversible via
  `dispose.mjs <sessionId> --reopen <cN>`. Runs as a detached worker off the Stop hook's own path
  (a records write, never inline); off switch: `ORPHAN_CAP_OFF` / `VECTROS_MEM_ORPHAN_CAP_OFF=1`.
  `report.mjs`'s DISPOSITION line shows both the live threshold and how many `ignored`s were the
  backstop acting vs. a human call.
