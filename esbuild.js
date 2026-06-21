'use strict';

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Parses the vendored `codicon.csv` into a sorted, de-duplicated list of codicon
 * ids (the `short_name` column). These are exactly the names the bundled
 * `codicon.css` exposes as `.codicon-<id>` classes, and the names a user may set
 * as a task icon - so deriving the list here keeps the icon picker in lock-step
 * with whatever `@vscode/codicons` version is installed (no hand-maintained,
 * stale list, no network fetch).
 *
 * The CSV header is `short_name,character,unicode`; ids never contain commas
 * (every id matches `^[a-z0-9-]+$`), so a plain split on the first comma is safe.
 *
 * @param {string} csv - Raw `codicon.csv` contents.
 * @returns {string[]} Sorted, unique, validated codicon ids.
 */
function parseCodiconNames(csv) {
  const isId = /^[a-z0-9-]+$/;
  const names = new Set();
  const lines = csv.split(/\r?\n/);
  // Skip the header row (index 0).
  for (let i = 1; i < lines.length; i++) {
    const id = lines[i].split(',')[0].trim();
    if (isId.test(id)) {
      names.add(id);
    }
  }
  return Array.from(names).sort();
}

/**
 * Vendors the codicon font + stylesheet into `media/` and derives the codicon
 * id list (`codicon-names.json`) so the CSP-hardened Task Editor webview can both
 * render real codicon glyphs and offer a searchable icon picker. The webview's
 * `localResourceRoots` is pinned to `media/` and `node_modules/` never ships in
 * the VSIX, so these files must live under `media/`. All three are generated
 * artifacts - git-ignored and reproduced here on every build/watch from the
 * `@vscode/codicons` dependency.
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

  // Derive the icon-picker name list from the same vendored package.
  const csvPath = path.join(fromDir, 'codicon.csv');
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `Missing ${csvPath}. Run "pnpm install" so @vscode/codicons is available before building.`
    );
  }
  const names = parseCodiconNames(fs.readFileSync(csvPath, 'utf8'));
  fs.writeFileSync(path.join(toDir, 'codicon-names.json'), JSON.stringify(names));
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

// Only build when invoked directly (`node esbuild.js`); stay side-effect-free
// when required (e.g. by unit tests exercising `parseCodiconNames`).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseCodiconNames };
