/**
 * Unit tests for {@link runningCountBadge}: the pure activity-bar badge summary
 * derived from the set of running instances.
 *
 * Verifies that only live instances are counted, that the tooltip pluralizes,
 * and that a zero count yields `undefined` (so the badge is cleared rather than
 * rendered as a literal "0").
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { RunningTaskState, runningCountBadge, type RunningTask } from '../../models/RunningTask';
import { newId, type RunningInstanceId, type TaskDefinitionId } from '../../types/ids';

/** Builds a minimal {@link RunningTask} in a given state. */
function task(state: RunningTaskState): RunningTask {
  return {
    instanceId: newId<RunningInstanceId>(),
    definitionId: newId<TaskDefinitionId>(),
    name: 'Task',
    state,
    startedAt: 0,
    intentToStop: false,
  };
}

describe('runningCountBadge', () => {
  it('returns undefined when there are no instances', () => {
    assert.equal(runningCountBadge([]), undefined);
  });

  it('returns undefined when no instance is live', () => {
    const ended = [task(RunningTaskState.Exited), task(RunningTaskState.Failed)];
    assert.equal(runningCountBadge(ended), undefined);
  });

  it('counts a single live instance with a singular tooltip', () => {
    const badge = runningCountBadge([task(RunningTaskState.Running)]);
    assert.deepEqual(badge, { value: 1, tooltip: '1 task running' });
  });

  it('counts multiple live instances with a plural tooltip', () => {
    const badge = runningCountBadge([
      task(RunningTaskState.Running),
      task(RunningTaskState.Starting),
      task(RunningTaskState.Stopping),
    ]);
    assert.deepEqual(badge, { value: 3, tooltip: '3 tasks running' });
  });

  it('counts only live instances, ignoring exited/failed ones', () => {
    const badge = runningCountBadge([
      task(RunningTaskState.Running),
      task(RunningTaskState.Restarting),
      task(RunningTaskState.Exited),
      task(RunningTaskState.Failed),
    ]);
    assert.deepEqual(badge, { value: 2, tooltip: '2 tasks running' });
  });
});
