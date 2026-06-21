/**
 * Integration: the Running Tasks view and a real process lifecycle.
 *
 * Runs inside a real VS Code host and exercises the full
 * spawn -> running -> stop -> exit path against the *real* manager and a real OS
 * process. The process is the host's own Node binary running an inline
 * `setInterval` so it is trivial, cross-platform, and stays alive until killed.
 *
 * We assert:
 *  - launching a definition yields a live {@link RunningTask} that reaches
 *    `Running` and exposes a real OS `pid`;
 *  - the {@link RunningTaskTreeProvider} renders that instance as a
 *    {@link RunningNode} with the expected `contextValue`;
 *  - stopping it drives the instance to a terminal state and the OS process
 *    actually goes away (no orphan).
 *
 * Every test stops all instances in `afterEach`, and a final check verifies no
 * child is left alive — orphan prevention is a load-bearing guarantee.
 *
 * @remarks Environment-gated: requires `@vscode/test-electron` (VS Code download
 * + display). Timeouts are generous because real processes and the host are slow.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { activateExtension, longRunningCommand, waitFor } from './helpers';
import { RunningTaskTreeProvider } from '../../views/RunningTaskTreeProvider';
import { RunningNode } from '../../views/nodes';
import { SystemClock } from '../../adapters/SystemClock';
import { isLive, RunningTaskState } from '../../models/RunningTask';
import type { ExtensionTestApi } from '../../extension';
import type { TaskDefinition } from '../../models/TaskDefinition';

/** Generous deadline for a real process to spawn and reach `Running`. */
const SPAWN_TIMEOUT_MS = 20000;

/** Generous deadline for a real process to exit after a stop request. */
const STOP_TIMEOUT_MS = 20000;

/**
 * Reports whether a process with the given pid is currently alive.
 *
 * `process.kill(pid, 0)` sends no signal but performs the permission/existence
 * check: it throws `ESRCH` when the process is gone. Used to prove orphan
 * prevention without coupling to a platform-specific tool.
 *
 * @param pid - The OS process id to probe.
 * @returns `true` if the process appears to exist, else `false`.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it; treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('Running view', () => {
  let api: ExtensionTestApi;
  const seeded: TaskDefinition[] = [];

  before(async function () {
    this.timeout(60000);
    api = await activateExtension();
  });

  afterEach(async function () {
    this.timeout(STOP_TIMEOUT_MS + 10000);

    // Always stop everything so a failed assertion can't leave orphans.
    await api.manager.stopAll();
    await waitFor(() => api.manager.getInstances().every((t) => !isLive(t)), {
      timeoutMs: STOP_TIMEOUT_MS,
      description: 'all instances to reach a terminal state in afterEach',
    });

    // Remove seeded definitions.
    for (const def of seeded.splice(0)) {
      await api.store.delete(def.id);
    }
  });

  it('launching a definition produces a live instance with a real pid', async function () {
    this.timeout(SPAWN_TIMEOUT_MS + 20000);

    const def = await api.store.add(
      {
        name: 'Long Runner',
        command: longRunningCommand(),
        workingDirectory: '',
        allowMultipleInstances: false,
      },
      'workspace'
    );
    seeded.push(def);

    const task = await api.manager.run(def.id);
    assert.ok(task, 'run() should return a RunningTask');
    assert.equal(task.definitionId, def.id);

    // Wait until it is actually Running with a pid (spawn is async).
    await waitFor(
      () => {
        const t = api.manager.getInstance(task.instanceId);
        return !!t && t.state === RunningTaskState.Running && typeof t.pid === 'number';
      },
      { timeoutMs: SPAWN_TIMEOUT_MS, description: 'instance to reach Running with a pid' }
    );

    const live = api.manager.getInstance(task.instanceId);
    assert.ok(live, 'instance should be queryable');
    assert.equal(live.state, RunningTaskState.Running);
    assert.ok(typeof live.pid === 'number' && live.pid > 0, 'instance should expose a real pid');
    assert.ok(pidAlive(live.pid), 'the OS process should actually be alive');
  });

  it('the running tree renders the live instance as a RunningNode', async function () {
    this.timeout(SPAWN_TIMEOUT_MS + 20000);

    const def = await api.store.add(
      {
        name: 'Tree Runner',
        command: longRunningCommand(),
        workingDirectory: '',
        allowMultipleInstances: false,
      },
      'workspace'
    );
    seeded.push(def);

    const task = await api.manager.run(def.id);
    assert.ok(task);

    await waitFor(
      () => api.manager.getInstance(task.instanceId)?.state === RunningTaskState.Running,
      { timeoutMs: SPAWN_TIMEOUT_MS, description: 'instance to reach Running' }
    );

    const provider = new RunningTaskTreeProvider(api.manager, new SystemClock());
    try {
      const nodes = provider.getChildren();
      const node = nodes.find((n) => n.task.instanceId === task.instanceId);
      assert.ok(node instanceof RunningNode, 'live instance should appear as a RunningNode');
      assert.equal(node.contextValue, 'runningTask.running');

      const item = provider.getTreeItem(node);
      assert.equal(item.id, task.instanceId, 'TreeItem.id should be the instance id');
      assert.ok(
        typeof item.description === 'string' && item.description.includes('PID'),
        'description should include the PID'
      );
      // A live row must NOT carry a duration in the description (a ticking value
      // would require a per-second refresh that dismisses hovers / drops clicks).
      // The duration is formatted "mm:ss", so its tell-tale colon is absent.
      assert.ok(
        typeof item.description === 'string' && !item.description.includes(':'),
        'a running row should show no duration in its description'
      );

      // The tooltip is resolved lazily (on hover), not eagerly in getTreeItem.
      assert.equal(item.tooltip, undefined, 'getTreeItem should not build the tooltip eagerly');

      const resolved = provider.resolveTreeItem(item, node);
      assert.ok(resolved, 'resolveTreeItem should return the item');
      assert.ok(
        resolved.tooltip instanceof vscode.MarkdownString,
        'resolveTreeItem should populate a MarkdownString tooltip'
      );
      const tip = resolved.tooltip.value;
      assert.ok(tip.includes('Running'), 'tooltip should report the Running status');
      assert.ok(tip.includes(String(node.task.pid)), 'tooltip should include the PID');
      assert.ok(tip.includes('Duration'), 'tooltip should include the live duration');
    } finally {
      provider.dispose();
    }
  });

  it('stopping a running instance ends it and kills the OS process', async function () {
    this.timeout(SPAWN_TIMEOUT_MS + STOP_TIMEOUT_MS + 20000);

    const def = await api.store.add(
      {
        name: 'Stoppable',
        command: longRunningCommand(),
        workingDirectory: '',
        allowMultipleInstances: false,
      },
      'workspace'
    );
    seeded.push(def);

    const task = await api.manager.run(def.id);
    assert.ok(task);

    await waitFor(
      () => {
        const t = api.manager.getInstance(task.instanceId);
        return t?.state === RunningTaskState.Running && typeof t.pid === 'number';
      },
      { timeoutMs: SPAWN_TIMEOUT_MS, description: 'instance to reach Running with a pid' }
    );

    const pid = api.manager.getInstance(task.instanceId)?.pid;
    assert.ok(typeof pid === 'number', 'pid should be known before stopping');

    await api.manager.stop(task.instanceId);

    // The instance should reach a terminal (non-live) state.
    await waitFor(
      () => !isLive(api.manager.getInstance(task.instanceId) ?? { state: RunningTaskState.Exited }),
      {
        timeoutMs: STOP_TIMEOUT_MS,
        description: 'instance to reach a terminal state',
      }
    );

    const ended = api.manager.getInstance(task.instanceId);
    assert.ok(ended, 'instance should remain queryable after exit');
    assert.ok(!isLive(ended), `instance should be terminal, was ${ended.state}`);
    assert.ok(ended.endedAt !== undefined, 'endedAt should be stamped');

    // The OS process must actually be gone (orphan prevention).
    await waitFor(() => !pidAlive(pid), {
      timeoutMs: STOP_TIMEOUT_MS,
      description: 'the OS process to disappear',
    });
    assert.ok(!pidAlive(pid), 'the OS process should be killed, not orphaned');
  });

  it('stopAll stops every live instance', async function () {
    this.timeout(SPAWN_TIMEOUT_MS + STOP_TIMEOUT_MS + 20000);

    const def = await api.store.add(
      {
        name: 'Multi Runner',
        command: longRunningCommand(),
        workingDirectory: '',
        allowMultipleInstances: true,
      },
      'workspace'
    );
    seeded.push(def);

    const a = await api.manager.run(def.id);
    const b = await api.manager.run(def.id);
    assert.ok(a && b, 'allowMultipleInstances should permit two instances');
    assert.notEqual(a.instanceId, b.instanceId, 'two distinct instances should be created');

    await waitFor(
      () =>
        [a.instanceId, b.instanceId].every(
          (id) => api.manager.getInstance(id)?.state === RunningTaskState.Running
        ),
      { timeoutMs: SPAWN_TIMEOUT_MS, description: 'both instances to reach Running' }
    );

    await api.manager.stopAll();

    await waitFor(() => api.manager.getInstances().every((t) => !isLive(t)), {
      timeoutMs: STOP_TIMEOUT_MS,
      description: 'all instances to stop',
    });

    for (const id of [a.instanceId, b.instanceId]) {
      const t = api.manager.getInstance(id);
      assert.ok(t && !isLive(t), 'every instance should be terminal after stopAll');
    }
  });
});
