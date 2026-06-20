import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `media/**` holds browser-side webview assets (plain JS) that are not part
    // of the TypeScript project, so the type-checked rules cannot parse them.
    ignores: ['dist/**', 'out/**', '.vscode-test/**', 'node_modules/**', 'media/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Load-bearing rule: the pure, host-free core must never reach for the
    // VS Code API or spawn processes directly.
    files: ['src/task/**', 'src/models/**', 'src/util/**', 'src/types/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'Core layer must not import vscode',
            },
          ],
          patterns: ['child_process', 'node:child_process'],
        },
      ],
    },
  },
  {
    // The flat config file itself is not part of the TS project; lint it
    // without type-aware rules to avoid "file not included" errors.
    files: ['eslint.config.mjs', 'esbuild.js', '.vscode-test.mjs'],
    ...tseslint.configs.disableTypeChecked,
  }
);
