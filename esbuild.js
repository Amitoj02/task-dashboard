'use strict';

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Vendors the codicon font + stylesheet into `media/` so the CSP-hardened Task
 * Editor webview can render real codicon glyphs (its `localResourceRoots` is
 * pinned to `media/`, and `node_modules/` never ships in the VSIX). These two
 * files are generated artifacts — they are git-ignored and reproduced here on
 * every build/watch from the `@vscode/codicons` dependency.
 *
 * @returns {void}
 */
function copyCodicons() {
  const fromDir = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const toDir = path.join(__dirname, 'media');
  const assets = ['codicon.css', 'codicon.ttf'];
  for (const asset of assets) {
    const from = path.join(fromDir, asset);
    if (!fs.existsSync(from)) {
      throw new Error(
        `Missing ${from}. Run "pnpm install" so @vscode/codicons is available before building.`
      );
    }
    fs.copyFileSync(from, path.join(toDir, asset));
  }
}

/**
 * esbuild plugin that logs build lifecycle and surfaces errors with file
 * locations. Exits the process with a non-zero code on failure so CI fails.
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[build] started');
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        const loc = error.location;
        if (loc) {
          console.error(`✘ [ERROR] ${error.text}`);
          console.error(`    ${loc.file}:${loc.line}:${loc.column}:`);
        } else {
          console.error(`✘ [ERROR] ${error.text}`);
        }
      }
      console.log('[build] finished');
    });
  },
};

async function main() {
  // Vendor codicon assets into media/ before bundling (idempotent, fast).
  copyCodicons();

  /** @type {import('esbuild').BuildOptions} */
  const options = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[build] watching for changes...');
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
