/**
 * Integration: "Show Output" remains reliable after a task's terminal is closed.
 *
 * Reproduces the bug from issue #2: a finished instance stays listed in Running
 * Tasks (Exited), but once the user closes its terminal tab, **Show Output**
 * used to silently do nothing — the terminal and its retained output were torn
 * down together, so `reveal()` had nothing left to show.
 *
 * The fix decouples the durable per-instance entry (which holds the retained
 * replay tail) from the disposable terminal, so closing the tab keeps the entry
 * and `reveal()` recreates a fresh terminal on demand. We assert that behavior
 * end-to-end through the real `taskDashboard.showOutput` command and a real OS
 * process: revealing after a close opens a *new* terminal for the same instance
 * (with the same stable title), rather than no-opping.
 *
 * @remarks Environment-gated like the rest of the integration suite: requires
 * `@vscode/test-electron` (a VS Code build + a display). Timeouts are generous
 * because real processes and the renderer are slow.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { activateExtension, longRunningCommand, shortLivedCommand, waitFor, delay } from './helpers';
import { COMMAND_IDS } from '../../util/commandIds';
import { isLive, RunningTaskState } from '../../models/RunningTask';
import type { ExtensionTestApi } from '../../extension';
import type { TaskDefinition } from '../../models/TaskDefinition';

/** Generous deadline for a real process to spawn, then exit on its own. */
const LIFECYCLE_TIMEOUT_MS = 20000;

/** Unique task name so we can match *our* terminals by their `name #N` title. */
const TASK_NAME = 'OutputReopen';

/** Reports whether a terminal belongs to our seeded task (`OutputReopen #N`). */
function isOurTerminal(t: vscode.Terminal): boolean {
  return t.name.startsWith(`${TASK_NAME} #`);
}

describe('Show Output after the terminal is closed', () => {
  let api: ExtensionTestApi;
  const seeded: TaskDefinition[] = [];

  before(async function () {
    this.timeout(60000);
    api = await activateExtension();
  });

  afterEach(async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS + 10000);

    // Stop anything still live, then clear ended instances so the provider
    // disposes any terminals it still owns for this test.
    await api.manager.stopAll();
    await waitFor(() => api.manager.getInstances().every((t) => !isLive(t)), {
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      description: 'all instances to reach a terminal state in afterEach',
    });
    api.manager.clearEnded();

    // Dispose any of our terminals that linger, so they cannot bleed into the
    // next spec's view of `vscode.window.terminals`.
    for (const term of vscode.window.terminals.filter(isOurTerminal)) {
      term.dispose();
    }

    for (const def of seeded.splice(0)) {
      await api.store.delete(def.id);
    }
  });

  it('reveals a fresh terminal after a finished task’s terminal is closed', async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS * 2 + 20000);

    // Capture every terminal the provider opens for our task. It creates one at
    // start and — the fix — a second one when output is revealed after the first
    // was closed.
    const opened: vscode.Terminal[] = [];
    const openSub = vscode.window.onDidOpenTerminal((t) => {
      if (isOurTerminal(t)) {
        opened.push(t);
      }
    });

    try {
      const def = await api.store.add(
        {
          name: TASK_NAME,
          // Long-running so we control the lifecycle: open the terminal, then
          // stop the instance, then close the tab — deterministically.
          command: longRunningCommand(),
          workingDirectory: '',
          allowMultipleInstances: true,
        },
        'workspace'
      );
      seeded.push(def);

      const task = await api.manager.run(def.id);
      assert.ok(task, 'run() should return a RunningTask');

      // The provider creates the instance's terminal on start.
      await waitFor(() => opened.length >= 1, {
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
        description: 'the initial terminal to be created',
      });
      const initial = opened[0];

      // Reveal it through the real command so the renderer attaches (open fires),
      // and wait until the process is actually running.
      await vscode.commands.executeCommand(COMMAND_IDS.showOutput, task.instanceId);
      await waitFor(
        () => api.manager.getInstance(task.instanceId)?.state === RunningTaskState.Running,
        { timeoutMs: LIFECYCLE_TIMEOUT_MS, description: 'instance to reach Running' }
      );

      // Stop it: the instance ends but stays *listed*, and the terminal is kept
      // open (we never signal the pty to close), so it is still revealable.
      await api.manager.stop(task.instanceId);
      await waitFor(
        () => {
          const t = api.manager.getInstance(task.instanceId);
          return !!t && !isLive(t);
        },
        { timeoutMs: LIFECYCLE_TIMEOUT_MS, description: 'instance to end but stay listed' }
      );
      assert.ok(
        vscode.window.terminals.some(isOurTerminal),
        'an exited instance’s terminal must be kept open (revealable), not auto-closed'
      );

      // The user closes the terminal tab. Because the terminal was still open,
      // this fires the pty `close` callback, which detaches the live terminal but
      // keeps the durable entry (and its replay tail).
      initial.dispose();

      // Wait until it is gone, which guarantees `close` ran and detached.
      await waitFor(() => !vscode.window.terminals.some(isOurTerminal), {
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
        description: 'the closed terminal to disappear',
      });

      // The bug: this used to silently do nothing. The fix: it recreates a
      // terminal for the still-listed instance and replays the retained output.
      await vscode.commands.executeCommand(COMMAND_IDS.showOutput, task.instanceId);
      await waitFor(() => opened.length >= 2, {
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
        description: 'Show Output to recreate the terminal after it was closed',
      });

      assert.equal(opened.length, 2, 'reveal-after-close should open exactly one new terminal');
      assert.equal(
        opened[1].name,
        initial.name,
        'the recreated terminal should keep the same stable title'
      );
      assert.ok(
        vscode.window.terminals.some(isOurTerminal),
        'a terminal for the instance should be present again after Show Output'
      );
    } finally {
      openSub.dispose();
    }
  });

  it('still no-ops Show Output for an instance cleared from the list', async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS * 2 + 20000);

    const def = await api.store.add(
      {
        name: TASK_NAME,
        command: shortLivedCommand(),
        workingDirectory: '',
        allowMultipleInstances: true,
      },
      'workspace'
    );
    seeded.push(def);

    const task = await api.manager.run(def.id);
    assert.ok(task);

    await waitFor(
      () => {
        const t = api.manager.getInstance(task.instanceId);
        return !!t && !isLive(t);
      },
      { timeoutMs: LIFECYCLE_TIMEOUT_MS, description: 'instance to exit' }
    );

    // Clearing removes the entry entirely (onDidRemoveInstance → disposeEntry).
    const removed = api.manager.removeInstance(task.instanceId);
    assert.equal(removed, true, 'an ended instance should be removable');
    await waitFor(() => !vscode.window.terminals.some(isOurTerminal), {
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      description: 'the cleared instance’s terminal to be disposed',
    });

    // Revealing a forgotten instance must not resurrect a terminal.
    const before = vscode.window.terminals.filter(isOurTerminal).length;
    await vscode.commands.executeCommand(COMMAND_IDS.showOutput, task.instanceId);
    await delay(200);
    const after = vscode.window.terminals.filter(isOurTerminal).length;
    assert.equal(after, before, 'Show Output on a cleared instance should stay a no-op');
    assert.equal(after, 0, 'no terminal should exist for a cleared instance');
  });
});
