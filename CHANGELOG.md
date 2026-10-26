# Changelog

All notable changes to `@vectros-ai/claude-code-agent-memory` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.15.1 — 2026-10-25

Pre-1.0 / beta.

To use this version, update the package and run `claude-code-agent-memory init` again: the hooks run from the deployed
copy, not from the installed package.

### Added

- **`VECTROS_MEM_PROJECT_GIT_TIMEOUT_MS` sets how long the `MEMORY.md` projection waits for each git call.** The projection
  asks git for the repository root and for its working trees. The default is 5000 ms and the range is 10 to 120000. A call
  that outlasts it fails, and with a directory list set the projection then does not write; the receipt names the git call
  that did not complete.
- **`claude-code-agent-memory --help` and `--version` print the usage and the package version and exit 0.**

### Fixed

- **A captured memory whose `kind` or `dest` is outside the allowed values is saved instead of being refused and retried.** An
  unrecognised `kind` is left out and an unrecognised `dest` becomes no suggestion. Memories already waiting in the spool or
  the queue are saved too.
- **A write that loses a race with another write to the same record is tried again on the next flush instead of being counted
  against the memory.** The store answers `409` (`VERSION_CONFLICT`) when another write to the same record committed first.
  Such a write is no longer charged a retry and no longer stops the rest of the spool, so a record that keeps conflicting is
  tried on every flush and holds one of that flush's slots. Any other `409` is still counted, and parks the memory after five
  tries.

### Security

- **A captured memory can no longer close early, with a forged `<candidate>` marker, the block that holds it during the
  customer-identifier check.** Neutralizing a forged marker also no longer hides the text after it, and runs in linear time.

### Changed

- **The comments in the shipped code describe the code as it is today.** Behaviour is unchanged, except that
  `report.mjs --compare` says "QUEUE / RECORD AGREEMENT" and counts "queue entries with an id" and "queue entries with no id".

### Documentation

- **The README names `VECTROS_MEM_PROJECT_GIT_TIMEOUT_MS` and says what a git call that outlasts it does.**

## 0.15.0 — 2026-10-12

Pre-1.0 / beta.

To use this version, update the package and run `claude-code-agent-memory init` again: the hooks run from the deployed
copy, not from the installed package.

### Added

- **Keep a project or directory out of recall and capture.** Two switches exclude a session: the
  `VECTROS_MEMORY_OFF=1` environment variable (for one project, put it in that project's `.claude/settings.local.json`
  and check for the `optout` line in `hooks.log`),
  and directory lists in `config.json`. `EXCLUDED_DIRECTORIES` excludes the listed directories and
  everything beneath them. `INCLUDED_DIRECTORIES`, when present and non-empty, restricts memory to
  sessions under its entries; an excluded directory wins over an included one. Matching ignores
  separator style and trailing separators, is case-insensitive on Windows and macOS, resolves symlinks
  and junctions, never matches a sibling that merely shares a prefix (`C:\work\clientA` does not
  cover `C:\work\clientAX`), understands trailing-dot and 8.3 spellings and the `\\?\` form of a session's directory on Windows (a `\\?\` or `\\.\` entry in a list is refused), and considers both the session's working directory and the directory
  Claude Code was started in. A session that moves into or out of an excluded directory partway through is excluded only while it is there: what it did outside, and the stretch inside once it moves back out, can still be captured. Start the session in the directory to keep all of it out.
- **An excluded session makes no network call, reads no transcript, writes no state, queue, staging or
  spool file and starts no background process.** Each excluded session start leaves one line in `hooks.log`
  naming the reason; it never contains the directory, a prompt or tool content.
- **The background work that covers other sessions skips sessions that started in an excluded directory:** the sweep of idle sessions' unread tails, the cross-session orphan nudge, the orphan cap and the spool drain, judged against the
  lists as they stand when the work runs. A session's working directory and project directory are recorded in its local state at its first reply and in its queue at its first capture. A session is skipped if either is under an excluded directory,
  and an included list admits it only if both are inside it. A session captured before directories were recorded is matched against an excluded list by Claude Code's per-project transcript folder name (an approximation that can also skip a sibling directory whose name continues with `-`), and an included list does not
  admit a session with no recorded directory.
- **The `MEMORY.md` pinned-set refresh honours the same lists.** It writes only into the memory index of a project that
  is allowed: it never writes into the index of a repository that has an excluded directory in it: the repository
  or any of its working trees under an excluded directory, an excluded directory inside the repository or inside one of
  its working trees, and, when `INCLUDED_DIRECTORIES` is set, a repository with a working tree outside it, whichever
  session triggered the refresh (the index is shared by every working tree of the repository). The index is never
  guessed from the projects folder while either list is set, so a session outside any repository does not refresh a
  pinned set then, and neither does one in a repository that has no memory index under its own project folder.
  Claude Code's project folder name (every non-alphanumeric character of the path becomes a `-`, so a path containing
  `_`, `.` or a space is found too) is an
  encoding that different paths share (`/w/acme-corp` and `/w/acme/corp` encode alike), so the refresh also stops when an
  excluded directory's folder name equals the repository's or continues it or is continued by it at a `-` (this also
  stops it for a sibling that merely shares such a prefix); with `INCLUDED_DIRECTORIES` set it stops when a session
  recorded in the repository's own project folder ran outside the included directories (a session started in a
  sub-directory or another working tree is recorded under a different folder name and is not seen).
  `VECTROS_MEMORY_OFF` stops the refresh too. The refusal is one line in `hooks.log`.
- **`CLAUDE.md.sample` has a section for excluded projects**: nothing is recalled on purpose, the agent
  must not search the knowledge base for the project's work, and must not store anything from the
  session in it. The hooks cannot enforce that for an agent that has knowledge-base tools, so it is an
  instruction to put in the excluded project's own `CLAUDE.md`.

### Changed

- **A broken `config.json` turns memory off for every session.** If it cannot be read or parsed, or
  a directory list is not an array of absolute paths (relative, `~`, drive-relative, `\\?\` and `\\.\` entries, and
  entries containing a NUL byte, are refused), or a key looks like one of the two lists but is spelled differently (for
  example `excludedDirectories`), every hook skips its work until the file is fixed. The cause is shown in the session at start and is written to `hooks.log` by every hook until the file is fixed;
  a file saved as UTF-16 and a Windows path with unescaped backslashes are named specifically. A UTF-8
  byte-order mark is accepted. Every other setting keeps its fail-open default. A config file that was
  already malformed therefore now turns memory off instead of falling back to defaults.
- **Source comments state their rules themselves.** Comments that pointed at internal design documents now say what
  the rule is, so the source maps that ship with the package read on their own. No behavior changes.

### Fixed

- **`dispose.mjs` accepts `documented:<path>` and `ignored:covered:<path>` in an ordinary project.** A path is checked
  against your project, normally the git working tree you run the command from, so it works in any git project, from
  any subdirectory, and stores the path relative to the top of that tree. A path outside the project is still refused,
  as is every path from a directory that holds several checkouts without being inside a repository, and every path
  from the runtime directory or a directory beneath it. A path is also refused when it lies in a repository nested
  below the project or is reached through a link that leads outside it, and a git working tree nested below another
  project is a project of its own.
- **A session whose transcript grows past about 512 MiB keeps being captured.** A transcript is read in
  chunks, so a session above that size is measured and distilled like any other, and the mid-run recall
  evaluator reads from the end of the file. The time to read grows with the size of the file and memory does
  not. A single line longer than about 512 MiB still cannot be read.
- **After you upgrade, a session that was skipped because of its size is captured again from where its capture
  stopped** (from its start, if it was never captured). Each run distils a limited amount and each window costs at
  least one model call made through your own Claude Code, so a long backlog in a session you keep using is worked off over several turns; a session that has already ended is caught up by one background run of limited size, and the rest is captured if you resume the session.

## 0.14.0 — 2026-10-01

Pre-1.0 / beta.

### Added

- **Every candidate passes a local content gate before it is transmitted.** Secrets in known formats (AWS
  access keys, API keys and tokens, JWTs, `scheme://user:pass@host` connection strings, private-key blocks) are
  replaced with `[REDACTED]` and the rest of the lesson is sent. A candidate that contains a US Social Security
  number-shaped or payment-card-shaped number, or that a small model call, made through your own Claude Code,
  judges to describe a real, identifiable individual or organization, is withheld and never transmitted; it stays in the local capture log. If the model call is
  unavailable, the candidate is held and retried later. The gate is a best-effort filter and does not recognize
  every secret or personal-data format.
- **Two new settings for the gate's model call:** `VECTROS_MEM_CLASSIFIER_TIMEOUT_MS` (time budget per candidate,
  default 25000) and `VECTROS_MEM_CLASSIFIER_MODEL` (default: the capture model).

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
