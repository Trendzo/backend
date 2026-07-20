import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Strict typing — match user's "no slack" stance
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      // One upload service, enforced. Storage vendor SDKs may only be imported by the
      // drivers; everything else goes through `@/shared/storage/index.js`. Without this
      // the rule is a convention people drift from.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', 'cloudinary'],
              message:
                'Import storage through @/shared/storage/index.js — vendor SDKs belong in src/shared/storage/drivers/ only.',
            },
          ],
        },
      ],
    },
  },
  {
    // The drivers are the one place a vendor SDK is allowed.
    files: ['src/shared/storage/drivers/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
  prettier,
];
