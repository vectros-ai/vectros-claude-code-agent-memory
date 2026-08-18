# Changelog

All notable changes to `@vectros-ai/claude-code-agent-memory` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
