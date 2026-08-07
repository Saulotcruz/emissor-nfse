// Config raiz — cobre server/ e scripts/. O web/ tem a sua própria.
import js from '@eslint/js';

const globaisNode = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'web/**', 'coverage/**', 'reports/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globaisNode,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['warn', 'smart'],
      'no-return-await': 'warn',
      'require-atomic-updates': 'off',
    },
  },
  {
    // Arquivos .cjs são CommonJS de verdade (o pm2 exige isso para o ecosystem),
    // então precisam de sourceType próprio e dos globais do CommonJS.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globaisNode,
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    files: ['server/tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globaisNode,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
];
