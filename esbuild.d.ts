/**
 * Type surface for the testable helpers that `esbuild.js` (CommonJS) exports.
 *
 * The build script's primary job is bundling and vendoring assets; only the
 * pure, unit-testable helpers are declared here so specs can import them with
 * full typing. Adjacent to `esbuild.js`, so `import ... from './esbuild.js'`
 * resolves to these declarations.
 */

/** Parses a `codicon.csv` body into sorted, unique, `[a-z0-9-]`-only codicon ids. */
export function parseCodiconNames(csv: string): string[];
