import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // `compile-tests` runs `tsc -p ./ --outDir out` with `rootDir: "."`, so the
  // `src/` prefix is preserved in the output tree (src/test -> out/src/test).
  files: 'out/src/test/integration/**/*.test.js',
  version: 'stable',
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
