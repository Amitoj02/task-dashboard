/**
 * Unit tests for {@link coerceScope}: the host-boundary guard that turns an
 * untrusted webview value into a valid {@link TaskScope}.
 *
 * This is the core of the "Global task is saved as Workspace" fix: the editor
 * now sends the chosen scope, and the host honors it on add — but only after
 * coercing it through this whitelist, falling back to the panel default for
 * anything unexpected.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { coerceScope } from '../../models/TaskDefinition';

describe('coerceScope', () => {
  it('passes through the two valid scopes verbatim', () => {
    assert.equal(coerceScope('global', 'workspace'), 'global');
    assert.equal(coerceScope('workspace', 'global'), 'workspace');
  });

  it('honors a global choice even when the fallback is workspace (the bug)', () => {
    // The reported bug: a "Global" selection was dropped and stored as workspace.
    assert.equal(coerceScope('global', 'workspace'), 'global');
  });

  it('falls back for unknown or malformed values', () => {
    assert.equal(coerceScope(undefined, 'workspace'), 'workspace');
    assert.equal(coerceScope('', 'workspace'), 'workspace');
    assert.equal(coerceScope('GLOBAL', 'workspace'), 'workspace'); // case-sensitive
    assert.equal(coerceScope('project', 'global'), 'global');
    assert.equal(coerceScope(42, 'workspace'), 'workspace');
    assert.equal(coerceScope(null, 'global'), 'global');
    assert.equal(coerceScope({ scope: 'global' }, 'workspace'), 'workspace');
  });
});
