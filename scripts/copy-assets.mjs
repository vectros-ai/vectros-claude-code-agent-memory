#!/usr/bin/env node
/**
 * Postbuild step — copy non-JS assets tsup doesn't touch into `dist/`.
 *
 * Two unrelated reasons, one script (both are "the file has to exist next to the built code,
 * not just exist somewhere in the package"):
 *   - `src/prompts/*.md` -> `dist/prompts/`: `capture-worker.mjs`/`recall-eval-worker.mjs` read
 *     these at runtime via `path.join(HERE, 'prompts', …)`, `HERE` being their OWN deployed
 *     directory.
 *   - `README.md` -> `dist/README.md`: `cli.mjs`'s `init` deploys everything under `dist/` (minus
 *     itself) to the runtime directory and its own `printNextSteps()` output points the operator
 *     at "the runtime directory's README.md" for how the loop works — that claim is only true if
 *     the README actually ships there. Found by checking `deployRuntime()`'s copy loop against
 *     that claim rather than assuming it: it copies `dist/*`, and README.md lives at the
 *     package root, so without this step `init` silently deployed nothing at the path its own
 *     output told the operator to read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const promptsSrc = path.join(ROOT, 'src', 'prompts');
const promptsDest = path.join(ROOT, 'dist', 'prompts');
fs.mkdirSync(promptsDest, { recursive: true });
for (const f of fs.readdirSync(promptsSrc)) {
  fs.copyFileSync(path.join(promptsSrc, f), path.join(promptsDest, f));
}
console.log(`copied ${fs.readdirSync(promptsSrc).length} prompt file(s) to dist/prompts/`);

fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(ROOT, 'dist', 'README.md'));
console.log('copied README.md to dist/README.md');
