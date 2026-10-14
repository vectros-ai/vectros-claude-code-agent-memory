/**
 * THE OPT-OUT GUARD — import this FIRST in every hook.
 *
 * A session can be excluded from recall and capture two ways: `VECTROS_MEMORY_OFF=1` in the
 * environment (settable per project through the `env` block of `.claude/settings.local.json`), or a
 * session directory that is at or under an entry of `EXCLUDED_DIRECTORIES` in `config.json` (or, with
 * `INCLUDED_DIRECTORIES` present, not inside it). The rules live in `exclusion.mjs`; this module
 * applies them, once, before the importing hook has done anything else.
 *
 * WHY AN IMPORT AND NOT A FUNCTION THE HOOKS CALL. A guard each hook has to remember to call is a
 * guard one hook will eventually forget. Importing this module as the first import of a hook, and
 * parsing the `stdinText` it exports instead of reading stdin, means the decision is taken before
 * ANY of the hook's own code runs: no network call, transcript read, `state/` `queue/` `prompts/`
 * `staged/` write or worker spawn can happen first. An excluded session makes this process exit 0
 * right here and the hook's own code never executes.
 *
 * WHAT THIS DOES NOT PROMISE, because the first draft of this comment did: ES modules evaluate a
 * sibling import while an earlier one is still awaiting, so the module-level code of the hook's OTHER
 * imports (reading `credentials.json`) can run before the decision. None of it makes a network call,
 * writes state or spawns anything; `tests/optout-test.mjs` fails if a module-level statement in the
 * hook import graph starts to. Adding such a statement to a sibling module defeats the guard, and that
 * test is what stands in the way.
 *
 * NO STATIC LOCAL IMPORTS, AND THAT IS LOAD-BEARING. The first thing this module does is ask the
 * config loader to hold back its receipt (`config applied: …`, one line per hook process). That has to
 * happen before the config module is evaluated, and a static import would evaluate it first. So the
 * modules that reach the config loader are imported dynamically, after the request is made. The
 * receipt is written once the session is known to run (or when the config itself is the problem), so
 * an excluded session leaves one line at its start and none per prompt.
 *
 * THE STDIN IS READ HERE, ONCE. The decision needs the payload's `cwd`, a stream can be read only
 * once, and top-level `await` is what lets an import do it. The text is exported as `stdinText` and
 * every hook parses that instead of reading stdin itself — a hook that kept its own reader would
 * find the stream already drained.
 *
 * ONE LOG LINE PER SESSION START. The skip is recorded on `SessionStart` only, naming the trigger and
 * nothing else: no directory, no prompt, no tool content. Every other event of an excluded session
 * exits silently. (A session that never fires `SessionStart` through these hooks — wired mid-session,
 * say — is excluded all the same, and silent.) When the cause is an unusable config the user is also
 * told in the session itself, on stdout, because a whole machine's memory going quiet should not be
 * discoverable only by reading a log.
 *
 * `VECTROS_RECALL_EVAL=1` is NOT this switch and is not touched by it. It is the recursion guard
 * for the nested `claude` calls the workers make; each hook keeps its own check of it, and this
 * module stays out of the way of that case (it reads nothing, decides nothing and defers nothing), so
 * such a call behaves exactly as it did before.
 *
 * FAIL-OPEN EXCEPT WHERE THE LIST CANNOT BE TRUSTED. An unparseable payload is the hook's own
 * problem to report (it still does); the env switch and the list still apply to it, using
 * `CLAUDE_PROJECT_DIR` or the process's own directory. A config file that cannot be read, or an
 * invalid `EXCLUDED_DIRECTORIES`, excludes every session — see `config.mjs`.
 */

/** Read stdin fully (async — a sync fd-0 read trips a libuv assert on Windows pipes). */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

const nested = process.env.VECTROS_RECALL_EVAL === '1';

// BEFORE the first await and before anything is imported: the siblings start evaluating the moment
// this module first awaits. → config.mjs `emitConfigReceipt`.
if (!nested) globalThis[Symbol.for('vectros.memory.deferConfigReceipt')] = true;

/** The raw hook payload. Empty inside a nested worker call, which exits at the hook's own guard. */
export const stdinText = nested ? '' : await readStdin();

if (!nested) {
  let input = null;
  try { input = JSON.parse(stdinText); }
  catch { /* silence-ok: an unparseable payload is reported by the hook that owns it ("skip: unparseable stdin"); the env switch and the directory list below still apply to it. */ }

  const { hlog } = await import('./hooklog.mjs');
  const { optOutDecision } = await import('./exclusion.mjs');
  const { emitConfigReceipt, optOutConfig } = await import('./config.mjs');

  const decision = optOutDecision({ input });
  if (!decision) {
    emitConfigReceipt();
  } else {
    // A config that is itself the problem keeps its per-process receipt: it is the loud half of failing closed.
    if (optOutConfig().problem) emitConfigReceipt();
    if (input?.hook_event_name === 'SessionStart') {
      hlog('optout', `skip: ${decision.label} — recall and capture are off for this session`, input.session_id);
      if (decision.trigger === 'config') {
        const message = `agent-memory is OFF for every session: ${decision.label}. See hooks.log in the memory runtime directory.`;
        process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`, () => process.exit(0));
        // Exit from the write callback so the message is not cut off; the timer is only a backstop.
        setTimeout(() => process.exit(0), 2000);
        await new Promise(() => {});
      }
    }
    process.exit(0);
  }
}
