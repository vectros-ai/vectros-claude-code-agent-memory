# @vectros-ai/claude-code-agent-memory

Cross-session memory for [Claude Code](https://claude.com/claude-code), backed by
[Vectros](https://vectros.ai): recall relevant context automatically at the start of a turn,
distill durable lessons out of a session involuntarily, and dispose them into your Vectros
knowledge base under your own review.

**Pre-1.0 / beta.**

## What it does

Claude Code sessions don't remember each other. This package wires a set of
[hooks](https://docs.claude.com/en/docs/claude-code/hooks) into Claude Code that close that gap,
without ever writing to your knowledge base on their own:

- **Recall.** On every prompt, a rolling window of the conversation is used to search your Vectros
  store; relevant hits are injected into context automatically. A second, debounced pass
  re-evaluates after tool calls using a small nested Claude call (Haiku by default) to catch
  recall opportunities the first pass's plain search misses.
- **Capture.** When a session accumulates enough new transcript, a background worker distills
  candidate lessons out of it — durable facts, decisions, gotchas — and proposes them.
- **Disposition — you decide, always.** A captured candidate is *never* written into your live
  knowledge base automatically. It sits in a review queue until you (or the agent, with the right
  tool access — see "Recommended, not required" below) explicitly disposes of it: point it at a
  real memory record, point it at existing documentation, or discard it. Nothing captured is
  searchable or returned to any query until that happens.

Everything fails open: a missing credential, an unreachable API, or a malformed config value
degrades the affected hook to a no-op rather than breaking your turn.

## Quickstart

The whole loop, start to finish. Every step below is explained in more depth further down this
README — this section exists so you never have to jump around to get from nothing to working.

1. **Provision the two schemas this package needs** (`candidate` and `memory`) into a Vectros
   store. The bundled `agentic-sdlc` blueprint gets you there in one command — use `--tenant test`
   first if you'd rather not point this at real data yet:
   ```bash
   npm i -g @vectros-ai/cli
   vectros login
   vectros bootstrap --blueprint agentic-sdlc --tenant test --no-seed --yes
   ```
2. **Install this package and deploy the hooks:**
   ```bash
   npm install -g @vectros-ai/claude-code-agent-memory
   claude-code-agent-memory init
   ```
   `init` resolves `VECTROS_API_KEY` from whatever `@vectros-ai/cli` identity is active (from step
   1) and pins it — see Credentials below for what that means and how to point it elsewhere.
3. **Restart Claude Code** so the hook entries `init` wrote to `~/.claude/settings.json` take
   effect.
4. **Just use Claude Code.** Nothing to invoke by hand: relevant past context now gets recalled
   automatically at the start of a turn, and a background worker distills durable lessons out of a
   session once it accumulates enough new content. Nothing is written to your knowledge base yet —
   distilled candidates sit in a review queue.
5. **Review and settle what got proposed**, whenever you want (there's no urgency — nothing is
   lost by waiting, and nothing is searchable until you act):
   ```bash
   cd ~/.claude/vectros-memory        # your runtime directory (VECTROS_MEMORY_HOME if overridden)
   node report.mjs                    # what's pending, across all sessions
   node dispose.mjs <sessionId> --list
   ```

That's the whole loop. Everything from here down is reference material for tuning, operating, and
understanding it in more depth.

## Install

```bash
npm install -g @vectros-ai/claude-code-agent-memory
claude-code-agent-memory init
```

`init` deploys the built hook runtime to `~/.claude/vectros-memory` (override with
`VECTROS_MEMORY_HOME`) and wires it into Claude Code by **appending** matcher blocks to your
global `~/.claude/settings.json` — it never touches a matcher block it didn't itself write, and it
never touches project-scoped settings (Claude Code's hooks schema runs every matching matcher
block in parallel, so this is additive; project scope *replaces* global settings for a matching
event rather than merging with it, so writing there risks silently shadowing whatever else you
already have configured globally). Safe to re-run — already-wired entries are recognized and
skipped, not duplicated.

Use `--dry-run` to see what `init` would do without writing anything.

### Requirements

- Node.js ≥ 20
- Claude Code
- A [Vectros](https://vectros.ai) account, with the `candidate` and `memory` record schemas
  provisioned in your store. That's the entire hard requirement — this package makes no calls that
  name any specific blueprint, so any provisioning method that produces those two schemas works.

  The suggested way to get there is the bundled **`agentic-sdlc`** blueprint, which provisions both
  (alongside its own knowledge-base schemas — harmless if you don't use them):
  ```bash
  npm i -g @vectros-ai/cli
  vectros login
  vectros bootstrap --blueprint agentic-sdlc --no-seed --yes
  ```
  Add `--tenant test` first to provision into an isolated test tenant before pointing this package
  at real data. If you already provision `candidate`/`memory` some other way (your own blueprint,
  hand-created schemas), that works identically — nothing here depends on the blueprint's name.

### Recommended, not required

Neither of these is a hard dependency — everything above works without them — but both make the
loop meaningfully better:

- **[`@vectros-ai/mcp-server`](https://www.npmjs.com/package/@vectros-ai/mcp-server)** — gives the
  agent itself tool access to create/update/list/query records (and, if you're using the full
  `agentic-sdlc` knowledge-base blueprint, documents) in your Vectros store. `dispose.mjs` itself
  never creates anything — a `stored:` disposition only VERIFIES a record already exists and marks
  the local candidate settled against it, so *making* that record (or checking whether something
  equivalent already exists before proposing a new one) is real Vectros-store work the agent still
  has to do somehow. Without MCP, that means raw API calls; with it, the agent gets clean
  `record_create`/`record_update`/`record_query`/`hybrid_search`-style tools instead. `dispose.mjs`
  itself is a local script either way — the agent runs it via ordinary shell access, MCP or not.
- **[`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli)** — lets this package resolve
  `VECTROS_API_KEY` from your OS keychain (`vectros keyring show`) instead of a plaintext
  environment variable. This is a security upgrade, not a functional one: without the CLI installed,
  set `VECTROS_API_KEY` directly and everything behaves identically — the only difference is where
  the key at rest lives. (This is unrelated to `CLAUDE_CODE_OAUTH_TOKEN`'s own keychain storage,
  which uses the `@napi-rs/keyring` binding directly and never depends on the CLI being installed at
  all — see Credentials below.)

### Credentials

Two separate credentials, resolved independently:

- **`VECTROS_API_KEY`** — authenticates every search/store call this package makes. Set the
  environment variable directly, or (recommended — see above) install
  [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli) and run `vectros switch <alias>`
  once to activate the identity you want, then run (or re-run) `init`; this package resolves the
  key exactly the way [`@vectros-ai/mcp-server`](https://www.npmjs.com/package/@vectros-ai/mcp-server)
  does (env first, then the CLI's own keyring via `vectros keyring show`). There is no plaintext
  fallback for this specific credential — without the CLI, the env var is the only tier.

  **`init` pins whichever identity is active at that moment, so these hooks stop tracking the
  CLI's active identity from then on.** This matters: `vectros bootstrap` (any blueprint, including
  `--tenant test`) *always* activates the credential it just minted, with no exception for a test
  tenant — so provisioning a completely unrelated test tenant later, on the same machine, would
  otherwise silently redirect every one of these hooks onto it too. Once `init` has pinned an alias,
  a later `vectros switch`/`bootstrap` elsewhere no longer touches these hooks; to point them at a
  *different* identity deliberately, either set `VECTROS_KEYRING_ALIAS` yourself (below — this
  always wins over the pin) or edit/clear `VECTROS_KEYRING_ALIAS` in your runtime directory's
  `credentials.json` and re-run `init`.
- **`CLAUDE_CODE_OAUTH_TOKEN`** — optional. Only needed if you want the capture/recall-eval
  workers' nested `claude -p` calls to run under your own Claude subscription rather than
  `ANTHROPIC_API_KEY`. `init` deploys the mechanism for this (the OS keychain binding) but
  deliberately never a secret; mint and store one with:
  ```bash
  claude setup-token | claude-code-agent-memory set-token
  ```
  Stored in your OS credential store via the optional
  [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) native binding when
  available; falls back to a local `credentials.json` (plaintext, clearly labeled as the weaker
  tier) otherwise.

After setting a credential, restart Claude Code so the new `settings.json` entries take effect.

## CLI reference

```
claude-code-agent-memory <command>

  init [--dry-run]   deploy the hook runtime and wire it into ~/.claude/settings.json
  set-token          store CLAUDE_CODE_OAUTH_TOKEN (read from stdin) for the capture/recall-
                     eval workers' nested `claude -p` child — OS keychain if available, else
                     the plaintext credentials.json fallback tier

Env:
  VECTROS_MEMORY_HOME   where the runtime deploys (default: <claude config dir>/vectros-memory)
  CLAUDE_CONFIG_DIR     Claude Code's own config dir (default: ~/.claude)
  VECTROS_API_BASE_URL  override the Vectros API base (default: https://api.vectros.ai)
  VECTROS_KEYRING_ALIAS pick a specific @vectros-ai/cli identity alias explicitly — beats both
                        the pin `init` wrote and the CLI's ambient active identity
```

`init` also pins whichever `@vectros-ai/cli` identity was active at that moment into your runtime
directory's `credentials.json`, specifically so these hooks don't quietly follow the CLI's active
identity wherever it goes next (see Credentials above) — re-run `init` any time you deliberately
want to move the pin.

## Operating the loop

Once deployed, two commands run directly from your runtime directory
(`~/.claude/vectros-memory` by default) rather than through the `claude-code-agent-memory` CLI
above:

- **`node report.mjs`** — what is the loop actually doing: recall/capture/disposition activity,
  the current undistilled transcript tail, and (`--compare`) whether the local review queue and
  your Vectros record corpus agree. Two extra views: `--served` (which stored records/docs are
  actually surfacing across sessions, and how often — good for spotting a candidate nobody ever
  sees) and `--sessions` (per-session injection/hit/nudge counts, plus each session's residual
  undistilled transcript at rest).
- **`node dispose.mjs <sessionId> --list`** — list pending candidates for a session, then settle
  each one. `<sessionId>` also accepts an unambiguous prefix — the same short form a nudge line
  displays (`ORPHAN-NUDGE(n from 7172bd20)`) — resolved against your local queue files, or refused
  outright if it's ambiguous or matches nothing:
  ```bash
  node dispose.mjs <sessionId> \
    c1=stored:<record-uuid> \
    c2=ignored:already covered by existing docs \
    c3=documented:path/to/your/docs.md#anchor
  ```
  A `stored:` disposition is read back from your Vectros store before it's accepted — a bad id is
  refused rather than silently mis-filed. A disposed candidate is never re-offered, so leave one
  pending rather than guess at it.

Two more scripts in the same directory run automatically off the Stop hook and rarely need a
manual invocation, but both support one when you want to see (or force) what they'd do:

- **`node reap.mjs [--apply]`** — prunes `state/` and `queue/` of stale/phantom session data (dry
  run by default; prints a receipt of what it pruned, deferred, and refused, and why).
- **`node orphan-cap-worker.mjs [--apply]`** — runs the orphan-cap backstop below on demand (dry
  run by default; prints exactly which candidates it would auto-ignore and why).

**The orphan-cap backstop.** A candidate nobody has settled keeps getting re-offered to whichever
session is around, on purpose — nothing is ever silently stranded. If one goes unsettled across
`ORPHAN_CAP_DAYS` *distinct calendar days* (default 7 — not raw offers, so one long session
re-checking it all day never counts as more than a single day), it is auto-disposed `ignored`,
citing the day count as the reason. This is always reversible:
```bash
node dispose.mjs <sessionId> --reopen <cN> "why this deserved a second look"
```
`report.mjs`'s DISPOSITION line shows both the live threshold and how many `ignored` dispositions
were the backstop acting rather than a human call. `touch ORPHAN_CAP_OFF` in the runtime directory
(or `VECTROS_MEM_ORPHAN_CAP_OFF=1`) turns it off entirely.

Every tunable the loop uses (retrieval window sizes, debounce timers, budget caps, …) lives in
`config.mjs` in the runtime directory, with its shipped default and an env-var override
(`VECTROS_MEM_<KEY>`) — `report.mjs`'s output shows which are in force.

## Prompting your agent to use this well

The hooks handle the mechanics — inject on prompt, distill on Stop, queue for review — without
being asked. What they can't do is tell your agent *how to think* about what recall hands it, or
what's actually worth turning into a durable memory versus left pending or ignored. That's a
working discipline, not a mechanism, and it's worth writing down the same way any other project
convention is.

[`CLAUDE.md.sample`](CLAUDE.md.sample) is a starting point for that — not meant to be dropped in
verbatim, but adapted from the real operating principles this package's own authors run day to
day: treat a recall hit as authoritative for what a past session *decided*, never as evidence of
what the code *currently does*; before disposing a candidate, ask whether it's actually true
(verified against the code, not a description of it), whether it's already known, and whether a
future session would really act differently for having read it; leave a candidate pending rather
than guess when you're not sure. Copy what's useful into your own project's CLAUDE.md.

## Contributing / running the test suite

```bash
npm test              # the deterministic suite — no network, no cost, safe anywhere
npm test -- --all     # + the *-real-test.mjs files: real Claude calls (~$0.30) and, if opted
                       # into below, a real round trip against a live Vectros test tenant
```

Every test spawns the real hook binaries as subprocesses against either a fake local HTTP server
(the default) or, for the small number of `*-real-test.mjs` files, real infrastructure — those are
excluded from `npm test` by default and need `--all` or `VECTROS_MEM_TEST_ALL=1`.

**Testing against a real Vectros tenant** (`live-tenant-real-test.mjs`) needs a SECOND, separate
opt-in on top of `--all` — deliberately not the same `VECTROS_KEYRING_ALIAS` that drives normal
hook operation, so a test harness can never be satisfied by whatever your daily-use hooks happen to
be pointed at:

```bash
vectros bootstrap --blueprint agentic-sdlc --tenant test --no-seed --yes   # mint a test credential, once
VECTROS_MEM_TEST_LIVE_ALIAS=<the alias it printed> npm test -- --all
```

Without `VECTROS_MEM_TEST_LIVE_ALIAS` set, this test skips cleanly — the default everywhere,
including CI. Before writing anything, it independently confirms the resolved credential is
genuinely test-scoped two different ways (the secret's own shape, and the CLI's own keyring
bookkeeping) and refuses outright if either says otherwise, rather than trusting an alias name
alone. Set `VECTROS_REQUIRE_LIVE_TESTS=1` in a job that should fail loudly instead of silently
skipping when the tenant isn't configured.

## License

[Apache-2.0](LICENSE)
