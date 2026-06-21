/**
 * Unit tests for `parseCodiconNames` - the build-time helper (in `esbuild.js`)
 * that derives the icon-picker name list from the vendored `@vscode/codicons`
 * CSV. Guards the issue's contract: the list is *generated* (never a stale,
 * hand-maintained array), de-duplicated, sorted, and limited to safe
 * `[a-z0-9-]` ids - no network, no hardcoding.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`). Imports the helper
 * from the CommonJS `esbuild.js`; its `main()` is guarded behind
 * `require.main === module`, so loading it here triggers no build.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseCodiconNames } from '../../../esbuild.js';

describe('parseCodiconNames', () => {
  it('extracts the short_name column and skips the header row', () => {
    const csv = 'short_name,character,unicode\naccount,,EB99\nrocket,,EB44\n';
    assert.deepEqual(parseCodiconNames(csv), ['account', 'rocket']);
  });

  it('sorts ids and removes duplicates', () => {
    const csv = 'short_name,character,unicode\nrocket,,1\naccount,,2\nrocket,,3\n';
    assert.deepEqual(parseCodiconNames(csv), ['account', 'rocket']);
  });

  it('ignores blank lines and surrounding whitespace', () => {
    const csv = 'short_name,character,unicode\n\n  account  ,,EB99\n\n';
    assert.deepEqual(parseCodiconNames(csv), ['account']);
  });

  it('drops rows whose id is not a codicon id ([a-z0-9-])', () => {
    const csv = 'short_name,character,unicode\nBad_Name,,1\nok-name,,2\n,,3\n';
    assert.deepEqual(parseCodiconNames(csv), ['ok-name']);
  });

  it('handles CRLF line endings', () => {
    const csv = 'short_name,character,unicode\r\naccount,,EB99\r\nrocket,,EB44\r\n';
    assert.deepEqual(parseCodiconNames(csv), ['account', 'rocket']);
  });

  it('derives a clean, complete list from the real vendored CSV', () => {
    const csvPath = path.join(
      process.cwd(),
      'node_modules',
      '@vscode',
      'codicons',
      'dist',
      'codicon.csv'
    );
    const names = parseCodiconNames(readFileSync(csvPath, 'utf8'));

    assert.ok(names.length > 400, 'expected the full codicon set');
    assert.ok(names.includes('checklist'), 'the default fallback icon must be present');
    assert.ok(names.includes('rocket'));
    assert.ok(
      names.every((n) => /^[a-z0-9-]+$/.test(n)),
      'every id must be a safe codicon id'
    );
    assert.deepEqual(names, [...new Set(names)].sort(), 'must be sorted and de-duplicated');
  });
});
