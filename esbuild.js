'use strict';

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
