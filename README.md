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
  candidate lessons out of it — durable facts, decisions, gotchas — and **automatically POSTs each
  one to your Vectros store** as an unreviewed `candidate` record, without asking first. Before
  that POST, every candidate passes a local content gate. Secrets in known formats (AWS access
  keys, API keys and tokens, JWTs, `scheme://user:pass@host` connection strings, private-key blocks) are
  replaced with `[REDACTED]`, and the rest of the lesson is sent. A candidate that contains a US Social
  Security number-shaped or payment-card-shaped number, or that a small model call, made through your own
  Claude Code, judges to describe a real, identifiable individual or organization, is withheld and never transmitted;
  security-related lessons are not withheld for that reason. A withheld candidate stays only in
  this machine's local capture log and spool file, and no command in this package lists a withheld candidate for review.
  The model call's judgment is tested here only against a fake model response. If the model call is unavailable, the candidate
  is held and retried later. The gate is a best-effort filter: it does not recognize every secret
  or personal-data format. Capture does not make transmitted content recallable — see Disposition
  below.
- **Disposition — you decide, always.** A captured candidate is *never* written into your live
  knowledge base automatically. It sits in a review queue until you (or the agent, with the right
  tool access — see "Recommended, not required" below) explicitly disposes of it: point it at a
  real memory record, point it at existing documentation, or discard it. Nothing captured is
  searchable or returned to any query until that happens.

Everything fails open: a missing credential, an unreachable API, or a malformed config value
degrades the affected hook to a no-op rather than breaking your turn. The one exception is the
directory lists described in [Keeping a project out of recall and capture](#keeping-a-project-out-of-recall-and-capture):
if they cannot be read, memory is switched off rather than left on.

## Quickstart

The whole loop, start to finish. Every step below is explained in more depth further down this
README — this section exists so you never have to jump around to get from nothing to working.

1. **Provision the two schemas this package needs** (`candidate` and `memory`) into a Vectros
   store. The bundled `agentic-sdlc` blueprint gets you there in one command — use `--tenant test`
   first if you'd rather not point this at real data yet:
   ```bash
   npm i -g @vectros-ai/cli
   vectros login
   vectros bootstrap --blueprint agentic-sdlc --tenant test --no-seed --yes --activate
   ```
   (`--activate` makes the new test key your active identity even when a live identity is
   already active; without it, a `--tenant test` bootstrap leaves an active live identity in place.)
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
  `--tenant test`) activates the credential it just minted unless that would displace an active live
  identity — so provisioning an unrelated tenant later, on the same machine, would otherwise
  redirect every one of these hooks onto it too. Once `init` has pinned an alias,
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
  VECTROS_API_BASE_URL  override the Vectros API base (default: https://api.vectros.ai).
                        Validated before every hook fetch attaches your credential: must be
                        an official vectros.ai/*.vectros.ai host (or http:// to localhost). An
                        untrusted value is refused and falls back to the default rather than
                        being used — it is never silently sent to the wrong place.
  VECTROS_ALLOW_INSECURE_BASE_URL
                        set 1 to bypass that check for a trusted local proxy — logs a loud
                        warning every time it's used. Not recommended: it sends your key and
                        prompt text to whatever host VECTROS_API_BASE_URL names, unvalidated.
  VECTROS_KEYRING_ALIAS pick a specific @vectros-ai/cli identity alias explicitly — beats both
                        the pin `init` wrote and the CLI's ambient active identity
```

`init` also pins whichever `@vectros-ai/cli` identity was active at that moment into your runtime
directory's `credentials.json`, specifically so these hooks don't quietly follow the CLI's active
identity wherever it goes next (see Credentials above). `init` leaves an existing pin alone; to move it
deliberately, delete `VECTROS_KEYRING_ALIAS` from `credentials.json` and re-run `init`.

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
    "c2=ignored:already covered by existing docs" \
    c3=documented:path/to/your/docs.md#anchor
  ```
  A `stored:` disposition is read back from your Vectros store before it's accepted — a bad id is
  refused rather than silently mis-filed. A `documented:` or `ignored:covered:` path is checked
  against your project, normally the git working tree you run the command from; a path outside it is
  refused, and so is any path when you run the command from the runtime directory or a directory beneath it. For those
  two forms run it from inside your project, giving the full path to `dispose.mjs` (the nudge prints
  the command that way). A disposed candidate is never re-offered, so leave one pending rather than guess at it.

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
(`VECTROS_MEM_<KEY>`) — overrides in force are logged to `hooks.log` as `config applied: KEY=value(source)`.
The content gate's model call has its own time budget, `VECTROS_MEM_CLASSIFIER_TIMEOUT_MS`
(default 25000), and uses the model named by `VECTROS_MEM_CLASSIFIER_MODEL` (default: the capture
model). The `MEMORY.md` projection waits at most `VECTROS_MEM_PROJECT_GIT_TIMEOUT_MS` (default 5000, range
10 to 120000) for each git call (finding the repository root, listing its working trees); a call that outlasts it
fails, and with a directory list set the projection then does not write.

## Keeping a project out of recall and capture

By default the hooks run for every Claude Code session on the machine. If a project or directory
must not take part in recall and capture, exclude it.

**What "excluded" means.** For an excluded session none of the five hooks makes a network call,
reads the transcript, writes any state, queue, staging or spool file, or starts a background process.
Nothing is recalled into the session by these hooks, nothing is distilled from it, and no candidate or
record is created from it. (Claude Code itself still loads any `MEMORY.md` pinned-set cache that
already exists for the project. The hooks never refresh that file for a repository that has an excluded directory in it,
whichever session is running. The file is shared by every working tree of the repository, so an excluded
subdirectory or an excluded linked working tree stops the refresh for the whole repository, and with
`INCLUDED_DIRECTORIES` set only a repository whose working trees are all inside the list is refreshed. While either
list is set the index is never guessed from the projects folder, so a session outside any repository refreshes
nothing, and neither does one in a repository that has no memory index under its own project folder. Claude Code's project folder
name is an encoding that different paths share (`/w/acme-corp` and `/w/acme/corp` encode alike), so the refresh also
stops when an excluded directory's folder name equals the repository's or continues it or is continued by it at a `-`,
and, with `INCLUDED_DIRECTORIES` set, when a session recorded in the repository's own project folder ran outside the
included directories.) The only trace is one line appended to `hooks.log` when the session starts (see
[Checking that it worked](#checking-that-it-worked)); a resumed, cleared or compacted session starts
again and logs another.

**Two switches.**

- **Directory lists in `config.json`** (the primary switch) in the runtime directory (`~/.claude/vectros-memory/config.json`
  by default; `VECTROS_MEMORY_CONFIG` points elsewhere). Entries are absolute paths:
  ```json
  {
    "EXCLUDED_DIRECTORIES": ["C:\\work\\clientA", "C:\\work\\clientB"],
    "INCLUDED_DIRECTORIES": ["C:\\Users\\me\\projects"]
  }
  ```
  - `EXCLUDED_DIRECTORIES`: sessions in these directories, or any directory beneath them, are
    excluded.
  - `INCLUDED_DIRECTORIES`: when this list is present and non-empty, **only** sessions under one of
    its entries take part, and everything else is excluded. Use it when it is safer to say where
    memory may run than to remember every place it must not. Absent or empty means no restriction.
  - An excluded directory stays excluded even when an included directory contains it.

  On Windows, matching treats `/` and `\` alike, ignores a trailing separator, and is case-insensitive on
  Windows and macOS (on a case-sensitive macOS volume that can exclude a directory that differs only
  in case). `C:\work\clientA` covers `C:\work\clientA\src` but not `C:\work\clientAX`.
  Windows spellings of a session's directory match too (write list entries in the plain form: a `\\?\` or `\\.\` entry is
  rejected and switches memory off): `\\?\C:\work\clientA`, a trailing dot or space on a
  component, and 8.3 short names (these last resolve through the real path, so they need the directory
  to exist). Symlinks and junctions are resolved, and the two lists treat that differently on purpose:
  an **excluded** directory matches if EITHER spelling of the session's directory is under it, but an
  **included** directory admits a session only if EVERY spelling is inside it, so a link that sits
  inside an included directory and points outside it is not admitted. A session is matched on its
  working directory and on the directory Claude Code was started in (`CLAUDE_PROJECT_DIR`); a session
  that has wandered out of an excluded directory is still excluded, and with an included list every
  one of those locations has to be inside it. A listed network share must be reachable when a hook
  runs: resolving a path on an unreachable share can stall the hook until the operating system gives
  up.

- **`VECTROS_MEMORY_OFF=1`** in the environment of the session. To scope it to one project, put it
  in that project's `.claude/settings.local.json`:
  ```json
  { "env": { "VECTROS_MEMORY_OFF": "1" } }
  ```
  Unset, empty, `0`, `false` and `no` leave it off; any other value turns it on.
  Claude Code applies a project's `env` settings to the session, and the hooks inherit the session's
  environment, but this package's tests do not exercise that path, so treat it as unverified until you
  have seen the `optout` line in `hooks.log` for a session started this way. Prefer the directory
  lists when the exclusion matters.

**A broken `config.json` turns memory off for every session.** An unparseable or unreadable
`config.json`, or an `EXCLUDED_DIRECTORIES`/`INCLUDED_DIRECTORIES` value that is not an array of
absolute paths, makes every hook skip its work (no recall, no capture, no requests) until the file is
fixed. A transient failure to read the file (it is locked while an editor saves it) switches memory
off for that one hook invocation only. You are told in the session itself (a message at session start
names the cause), and `hooks.log` in the runtime directory has the detail: each session's first line is
an `optout` line naming the cause (`failing closed`), and the config loader repeats the reason on every
hook process. The two most common hand-editing causes are named specifically: a file saved as UTF-16,
and a Windows path with unescaped backslashes (write `"C:\\work\\clientA"` or `"C:/work/clientA"`). A
UTF-8 byte-order mark, which Windows Notepad adds, is accepted. This is the one setting whose failure switches the hooks off: a list that cannot be honoured is not
safe to ignore. Other settings in the same file keep their usual fail-open behaviour.

**`WORKERS_OFF` is not an opt-out.** The `WORKERS_OFF` file in the runtime directory stops only the
background model calls: the capture distiller, the mid-run recall evaluator and the tail sweep.
Recall still sends each prompt to your Vectros store for search, and the hooks still read and write
their state. `VECTROS_RECALL_EVAL` is an internal guard that keeps the nested Claude calls those
workers make from triggering the hooks again; it is not a switch for your own sessions. Use the two
switches above.

**What it does not do.**

- **It is not retroactive within a session.** It applies from a session's first hook, so start such
  sessions inside the directory. A session that starts elsewhere and moves into an excluded directory
  later is NOT protected for what it did before the move: its hooks go quiet from that point, but
  everything captured before stays, and the tail sweep later reads that finished session's whole
  transcript, including the part written inside the excluded directory. The same holds if it moves
  back out: the next ordinary Stop distills everything written since the last capture, including the
  stretch spent inside the excluded directory.
- **A session is matched on its project directory and its working directory.** A session rooted in a
  directory that is not excluded is not protected for work it does inside an excluded subdirectory if
  neither of those two ever points there (for example, when it only touches files there by absolute
  path). Start such sessions in the directory itself.
- It does not remove anything already captured. Excluding a directory leaves existing queue files,
  spool files and records where they are; delete them yourself if they should go.
- Excluding a directory after sessions in it were captured is honoured for their leftovers. Each
  session's working directory and its project directory are both recorded when it is first captured,
  and the tail sweep, the cross-session orphan nudge, the orphan cap and the spool drain all skip a
  session if ANY recorded directory is under an excluded directory as the list stands now (and, with
  an included list, unless ALL of them are inside it). A project directory that is merely the parent
  of the excluded one does not by itself exclude a session. Sessions captured before the directories
  were recorded are matched against an `EXCLUDED_DIRECTORIES` list by the name of Claude Code's
  per-project transcript folder (an approximation that errs towards excluding); a session with no
  recorded directory and no such folder is not treated as excluded, and an `INCLUDED_DIRECTORIES` list
  does not admit it.

### Telling the agent

The hooks decide what is injected and what is captured; they do not decide what an agent does with
the tools it has. An agent in an excluded project that also has the Vectros MCP server can still
search the knowledge base or create records if it chooses to, and nothing in this package can stop
that. So say it where the agent will read it: put the last section of
[`CLAUDE.md.sample`](CLAUDE.md.sample) ("This project is excluded from agent memory") in that
project's own `CLAUDE.md`, or in a user-level `CLAUDE.md` that applies only there. It tells the agent
that nothing was recalled on purpose, not to search the knowledge base for the project's work, and
not to store anything from the session in it. The same file's general guidance ("if nothing was
injected, consider querying the store yourself") carries an exception for excluded projects, so the
two do not contradict each other.

### Checking that it worked

Start a session in the directory and send a prompt. For an excluded session:

- no recalled-knowledge blocks appear in the session;
- `hooks.log` (in the runtime directory) gets one new line from the `optout` hook each time the
  session starts, naming the trigger (`VECTROS_MEMORY_OFF`, an excluded directory, not under an included
  directory, or an unusable config) and nothing for prompts, tool calls or Stop events. It never
  contains the directory, the prompt or any tool content. The config loader's own line
  (`config applied: …`, written when `config.json` overrides a setting) is held back for an excluded
  session, so it adds nothing; it is written for sessions that run, and, while `config.json` is
  broken, by every hook process.

If the switch is set through `.claude/settings.local.json`, confirm the `optout` line appears the
first time you use it: that line is how you know the setting reached the hook processes.

### Deploying a new version

The hooks run from the deployed copy in the runtime directory, not from the installed package, so a
new version takes effect only once it is deployed:

```bash
npm install -g @vectros-ai/claude-code-agent-memory@latest
claude-code-agent-memory init
```

`init` copies the built runtime into the runtime directory and leaves the entries it already wired
in `settings.json` alone. Each hook is a fresh process that reads the deployed files, so the new code
takes effect on the next hook that runs; until the deploy, sessions run the old hooks, with no
opt-out. (A change to a project's `.claude/settings.local.json` is read by Claude Code at session
start, so start a new session after editing it.)

To deploy a build from a source checkout instead, run `npm run build` in the package, then
`node dist/cli.mjs init`.

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
