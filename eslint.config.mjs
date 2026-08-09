// @ts-check
import js from '@eslint/js';
import next from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

/**
 * Workspace ESLint config (flat, ESLint 9).
 *
 * Scope is deliberately narrow: rules that catch REAL BUGS, not style.
 * Formatting is not linted — there is no Prettier in this repo and adding a
 * style gate now would bury genuine findings under thousands of cosmetic ones.
 *
 * The high-value rules here are the type-aware async ones
 * (`no-floating-promises`, `no-misused-promises`). In a NestJS + BullMQ codebase
 * an unawaited promise is a silently swallowed failure — exactly the class of
 * defect this gate exists to catch.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'apps/api/prisma/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Type-aware rules, backend only ─────────────────────────────────────────
  // apps/api is where unawaited promises actually cost money (dropped queue
  // jobs, unlogged failures). The web app is excluded to keep lint fast.
  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Swallowing an error silently is explicitly against our contributing
      // rules, so make the linter enforce it rather than code review.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // ── Next.js app ────────────────────────────────────────────────────────────
  // Registered so the existing inline `@next/next/*` disable comments resolve
  // (without the plugin ESLint errors with "rule definition not found"), and so
  // the app gets Next's own correctness checks.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { '@next/next': next },
    rules: {
      ...next.configs.recommended.rules,
      // App Router — there is no `pages/` directory, so this rule can only
      // ever emit a "Pages directory cannot be found" warning.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // ── Shared relaxations ─────────────────────────────────────────────────────
  {
    rules: {
      // `any` is a smell, not a build break. Surfaced, not blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused args prefixed with _ are an intentional signal.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── Tests ──────────────────────────────────────────────────────────────────
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'apps/api/test/**/*.ts'],
    rules: {
      // Tests legitimately assert on loosely-typed response bodies.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
