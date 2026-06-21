/**
 * Unit tests for {@link reorderIds}: the pure move-within-an-ordered-list helper
 * behind the Task Definitions drag-and-drop reorder.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { reorderIds } from '../../util/reorder';

describe('reorderIds', () => {
  it('moves a single item to just before the target', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], ['d'], 'b'), ['a', 'd', 'b', 'c']);
  });

  it('appends to the end when the target is undefined', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['a'], undefined), ['b', 'c', 'a']);
  });

  it('moves multiple items, preserving the dragged order', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], ['d', 'a'], 'c'), ['b', 'd', 'a', 'c']);
  });

  it('keeps the dragged order even when it differs from list order', () => {
    // Dragged as [c, a] (selection order) -> inserted in that order before 'b'.
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['c', 'a'], 'b'), ['c', 'a', 'b']);
  });

  it('ignores moving ids that are not in the list (e.g. another scope)', () => {
    // 'x' is foreign and dropped; only 'c' relocates, to just before 'a'.
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['x', 'c'], 'a'), ['c', 'a', 'b']);
  });

  it('drops every foreign moving id and returns a copy unchanged', () => {
    const order = ['a', 'b', 'c'];
    const result = reorderIds(order, ['x', 'y'], 'b');
    assert.deepEqual(result, ['a', 'b', 'c']);
    assert.notEqual(result, order, 'returns a fresh array, not the input');
  });

  it('treats a drop onto one of the moving rows as a no-op', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['b', 'c'], 'b'), ['a', 'b', 'c']);
  });

  it('appends when the target is not found in the list', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['a'], 'zzz'), ['b', 'c', 'a']);
  });

  it('returns a copy unchanged when nothing valid is moving', () => {
    const order = ['a', 'b'];
    const result = reorderIds(order, [], 'a');
    assert.deepEqual(result, ['a', 'b']);
    assert.notEqual(result, order);
  });

  it('is a no-op (same order) when dropping an item right before itself-adjacent target', () => {
    // 'a' removed, then re-inserted before 'b' -> back to the start.
    assert.deepEqual(reorderIds(['a', 'b', 'c'], ['a'], 'b'), ['a', 'b', 'c']);
  });
});
