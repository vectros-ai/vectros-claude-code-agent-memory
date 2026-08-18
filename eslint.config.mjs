// ---------------------------------------------------------------------------
// ESLint flat config (ESLint 9+) for @vectros-ai/claude-code-agent-memory.
//
// Self-contained (each public package carries its own config — they ship as
// independent GitHub repos, so a shared base outside the package tree would not
// resolve after a fork). Unlike its TypeScript siblings, this package is plain
// Node ESM throughout — no bundled TypeScript toolchain, matching its own
// zero-runtime-dependency design (see tsup.config.mjs).
// ---------------------------------------------------------------------------
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
