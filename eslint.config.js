import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// @ziro/core is the framework-free heart (ADR-001): no frameworks, no IO.
const CORE_FORBIDDEN_IMPORTS = [
  '@nestjs/*',
  '@anthropic-ai/*',
  '@google/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  'ioredis',
  'bullmq',
  'express',
  'node:fs',
  'node:fs/*',
  'node:http',
  'node:https',
  'node:net',
  'node:dns',
  'node:child_process',
  'fs',
  'http',
  'https',
  'net',
  'child_process',
];

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    'apps/api/drizzle/**',
    '.claude/**',
    'data/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: CORE_FORBIDDEN_IMPORTS,
              message: '@ziro/core must stay framework-free and IO-free (ADR-001).',
            },
          ],
        },
      ],
    },
  },
  {
    // CLAUDE.md §4.1: money is integer paise, never a float. Tests may use numbers freely.
    // datagen applies it to the code that builds and renders money (not to its RNG or calendar).
    files: [
      'packages/core/src/money/**/*.ts',
      'packages/datagen/src/world/**/*.ts',
      'packages/datagen/src/render/**/*.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'No Number() coercion in money code: use bigint (BigInt, BigInt literals).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'No floating-point in money code.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: 'No floating-point in money code.',
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: 'No floating-point formatting in money code.',
        },
        {
          selector: "MemberExpression[object.name='Math']",
          message: 'No Math.* in money code: it is floating-point.',
        },
        {
          selector: 'Literal[raw=/^[0-9]*[.][0-9]+/]',
          message: 'No decimal literals in money code: use integer paise and basis points.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
