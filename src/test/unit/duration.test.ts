/**
 * Unit tests for {@link formatDuration}: the pure `mm:ss` / `h:mm:ss` formatter
 * used by the Running Tasks view.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`). Imports the formatter
 * from its host-free home so loading this spec never pulls in `vscode`.
 */

import assert from 'node:assert/strict';
import { formatDuration } from '../../util/duration';

describe('formatDuration', () => {
  it('formats sub-minute durations as mm:ss', () => {
    assert.equal(formatDuration(0), '00:00');
    assert.equal(formatDuration(999), '00:00'); // floors to whole seconds
    assert.equal(formatDuration(1000), '00:01');
    assert.equal(formatDuration(59_000), '00:59');
  });

  it('rolls over into minutes', () => {
    assert.equal(formatDuration(60_000), '01:00');
    assert.equal(formatDuration(65_000), '01:05');
    assert.equal(formatDuration(599_000), '09:59');
  });

  it('switches to h:mm:ss once it reaches an hour', () => {
    assert.equal(formatDuration(3_600_000), '1:00:00');
    assert.equal(formatDuration(3_661_000), '1:01:01');
    assert.equal(formatDuration(45_015_000), '12:30:15');
  });

  it('clamps negative input to zero', () => {
    assert.equal(formatDuration(-1), '00:00');
    assert.equal(formatDuration(-100_000), '00:00');
  });
});
