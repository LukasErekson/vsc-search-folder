// ESLint flat config (ESLint 9 + typescript-eslint).
'use strict';

const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['out/**', 'node_modules/**', '*.vsix'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
);
