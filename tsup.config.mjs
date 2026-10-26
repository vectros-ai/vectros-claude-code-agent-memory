import { defineConfig } from 'tsup';

/**
 * Build for @vectros-ai/claude-code-agent-memory.
 *
 * UNLIKE its siblings (`cli`, `mcp-server`, `blueprints`), this package has ZERO runtime
 * dependencies to bundle — every file under `src/` is already plain Node ESM using only
 * `node:*` builtins (confirmed by grep across the whole tree before this config was written).
 * The one third-party dependency, `@napi-rs/keyring`, is OPTIONAL and NATIVE (a `.node` binary),
 * so it can never be bundled regardless — every consumer's own install resolves its own
 * platform prebuild, exactly like `@vectros-ai/cli`'s identical `@napi-rs/keyring` handling.
 *
 * `bundle: false` is therefore the right shape, not a shortcut: it keeps the deployed FILE LAYOUT
 * flat and one-file-per-entry (`init` deploys the BUILT `dist/` tree to
 * `~/.claude/vectros-memory/`, and Claude Code's `settings.json` hook commands invoke individual
 * files there by name — `node .../recall.mjs`, `node .../capture.mjs`, … — not a single entry
 * point; a bundled single-file output would break that contract).
 *
 * ⚠ `bundle: false` MUST BE SET IN THE CONFIG OBJECT BELOW, not merely asserted in this prose:
 * tsup's default is `bundle: true`, which replaces every sibling import with that sibling's entire
 * source, zero exceptions. A dual-mode file's own top-level "am I the CLI entry point"
 * `import.meta.url`-based self-check would then be duplicated, verbatim, into every OTHER entry
 * that imports anything from it — and spuriously match there too, because after full bundling
 * there is no separate module identity left for `import.meta.url` to distinguish. (`capture.mjs`
 * imports from `reap.mjs`, and other tools import from `report.mjs`; a spurious match can
 * crash the Stop-hook critical path.) With `bundle: false` zero sibling source survives
 * inlining and every import is real. The `path.basename(process.argv[1])`-based self-checks in
 * `reap.mjs`/`report.mjs`/`project.mjs` stay as belt-and-braces even though `import.meta.url` is
 * trustworthy — they cost nothing and remove one more way this can go wrong.
 *
 * `src/tests/**` is excluded (this is a build config, not a test runner) and copied in by
 * `package.json`'s own `files` list only implicitly — tests never ship in `dist`, only source.
 * `src/prompts/*.md` are plain-text assets, not JS — tsup does not touch them; `scripts/
 * copy-assets.mjs` copies them into `dist/prompts/` as a build postprocess (see `package.json`'s
 * `build` script) so `capture-worker.mjs`/`recall-eval-worker.mjs`'s `path.join(HERE, 'prompts',
 * …)` resolves against the DEPLOYED module's own directory, exactly as it does today in the
 * unbuilt source tree.
 */
export default defineConfig({
  entry: ['src/*.mjs'],
  format: ['esm'],
  // Must be set here, not just asserted in the header comment: tsup's default is `bundle: true`.
  bundle: false,
  // `bundle: false` does not rewrite import specifiers — `from './paths.mjs'` still needs an
  // actual `paths.mjs` on disk. The output extension therefore has to MATCH those specifiers
  // exactly (tsup's ESM default of `.js` would leave `paths.js` on disk while every sibling still
  // imports `./paths.mjs`: a fresh `ERR_MODULE_NOT_FOUND`, not a warning).
  outExtension: () => ({ js: '.mjs' }),
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  splitting: false,
  // No `external` entry — `bundle: false` above already means nothing is ever bundled, so there is
  // nothing for `external` to exclude, so a reservation for @napi-rs/keyring would be reasoning
  // from a config claim that is not operative. It never gets bundled regardless (it's a native
  // `.node` binary; `deployKeyring()` in cli.mjs handles shipping it, a runtime concern with no
  // connection to this build-time option).
});
