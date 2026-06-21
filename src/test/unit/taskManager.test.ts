/**
 * Unit tests for {@link TaskManager}: orchestration, the lifecycle state machine,
 * single-instance enforcement, the single shared refresh tick, run/stop/restart
 * and the bulk operations, crash detection, and the auto-restart crash-loop
 * breaker.
 *
 * Wired over a real {@link TaskRunner} but with a {@link FakeProcessSpawner},
 * {@link FakeTimers}, {@link FakeClock}, and {@link FakeTaskStore}, so the full
 * stack is exercised deterministically with no real processes or timers.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { TaskManager, type TaskManagerOptions } from '../../task/TaskManager';
import { TaskRunner } from '../../task/TaskRunner';
import { RunningTaskState } from '../../models/RunningTask';
import { newId, type RunningInstanceId, type TaskDefinitionId } from '../../types/ids';
import { type TaskDefinition } from '../../models/TaskDefinition';
import type { InstanceExit, ITaskStore } from '../../types/contracts';
import { Emitter, type Event } from '../../util/event';
import { FakeProcessSpawner } from './fakes/FakeProcessSpawner';
import { FakeTimers } from './fakes/FakeTimers';
import { FakeClock } from './fakes/FakeClock';

/**
 * A minimal in-memory {@link ITaskStore} for manager tests: just enough to hold
 * definitions and record (count) run/stop side-data calls. The manager only uses
 * `get`, `getAll`, `recordRun`, and `recordStop`.
 */
class FakeTaskStore implements ITaskStore {
  private readonly defs = new Map<TaskDefinitionId, TaskDefinition>();
  private readonly changeEmitter = new Emitter<void>();
  public readonly onDidChangeDefinitions: Event<void> = this.changeEmitter.event;

  public recordRunCalls: TaskDefinitionId[] = [];
  public recordStopCalls: Array<{ id: TaskDefinitionId; code: number | null | undefined }> = [];

  public seed(def: TaskDefinition): TaskDefinition {
    this.defs.set(def.id, def);
    return def;
  }

  public getAll(): TaskDefinition[] {
    return [...this.defs.values()];
  }
  public get(id: TaskDefinitionId): TaskDefinition | undefined {
    return this.defs.get(id);
  }
  public getScope(): never {
    throw new Error('not used');
  }
  public query(): TaskDefinition[] {
    return this.getAll();
  }
  public add(): never {
    throw new Error('not used');
  }
  public update(): never {
    throw new Error('not used');
  }
  public delete(): Promise<void> {
    return Promise.resolve();
  }
  public duplicate(): never {
    throw new Error('not used');
  }
  public recordRun(id: TaskDefinitionId): Promise<void> {
    this.recordRunCalls.push(id);
    return Promise.resolve();
  }
  public recordStop(id: TaskDefinitionId, exitCode: number | null | undefined): Promise<void> {
    this.recordStopCalls.push({ id, code: exitCode });
    return Promise.resolve();
  }
  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Builds a definition with a fresh id, overridable per field. */
function def(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: newId<TaskDefinitionId>(),
    name: 'Task',
    command: 'node app.js',
    allowMultipleInstances: false,
    commandHistory: [],
    ...overrides,
  };
}

/** Full manager harness over a real runner + the fakes. */
function makeManager(opts: Partial<TaskManagerOptions> = {}) {
  const store = new FakeTaskStore();
  const spawner = new FakeProcessSpawner();
  const timers = new FakeTimers();
  const clock = new FakeClock(0);
  const runner = new TaskRunner(spawner, timers, { logRetentionBytes: 1024, defaultShell: '' });
  const options: TaskManagerOptions = {
    stopGraceMs: 5000,
    maxRestartsPerMinute: 5,
    ...opts,
  };
  const manager = new TaskManager(store, runner, clock, timers, options);
  return { manager, store, spawner, timers, clock, runner };
}

describe('TaskManager run() lifecycle', () => {
  it('creates an instance that passes through Starting then reaches Running', async () => {
    const { manager, store } = makeManager();
    const d = store.seed(def());

    // Capture the state at the moment the start event fires (before the
    // synchronous pid promotes it to Running).
    let stateOnStart: RunningTaskState | undefined;
    manager.onDidStartInstance((t) => (stateOnStart = t.state));

    const task = await manager.run(d.id);
    assert.ok(task);
    assert.equal(stateOnStart, RunningTaskState.Starting);
    assert.equal(manager.getInstance(task.instanceId)?.state, RunningTaskState.Running);
    assert.ok(manager.getInstance(task.instanceId)?.pid, 'pid should be set once Running');
    manager.dispose();
  });

  it('records the run against the definition store', async () => {
    const { manager, store } = makeManager();
    const d = store.seed(def());
    await manager.run(d.id);
    assert.deepEqual(store.recordRunCalls, [d.id]);
    manager.dispose();
  });

  it('returns undefined for an unknown definition', async () => {
    const { manager } = makeManager();
    assert.equal(await manager.run('ghost' as TaskDefinitionId), undefined);
    manager.dispose();
  });
});

describe('TaskManager allowMultipleInstances', () => {
  it('blocks a second concurrent instance when allowMultipleInstances is false', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def({ allowMultipleInstances: false }));

    const first = await manager.run(d.id);
    const second = await manager.run(d.id);

    // Same instance returned; only one process ever spawned.
    assert.equal(second?.instanceId, first?.instanceId);
    assert.equal(spawner.requests.length, 1);
    assert.equal(manager.getInstances().length, 1);
    manager.dispose();
  });

  it('allows a fresh instance after the previous one has exited (single-instance)', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def({ allowMultipleInstances: false }));

    const first = await manager.run(d.id);
    spawner.spawned[0].emitExit(0); // first exits → no longer live

    const second = await manager.run(d.id);
    assert.notEqual(second?.instanceId, first?.instanceId);
    assert.equal(spawner.requests.length, 2);
    manager.dispose();
  });

  it('permits multiple concurrent instances when allowMultipleInstances is true', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def({ allowMultipleInstances: true }));

    const a = await manager.run(d.id);
    const b = await manager.run(d.id);

    assert.notEqual(a?.instanceId, b?.instanceId);
    assert.equal(spawner.requests.length, 2);
    assert.equal(
      manager.getInstances().filter((t) => t.state === RunningTaskState.Running).length,
      2
    );
    manager.dispose();
  });
});

describe('TaskManager stop()', () => {
  it('sets Stopping (intentToStop) immediately, then Exited on a requested exit', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    await manager.stop(task!.instanceId);
    const stopping = manager.getInstance(task!.instanceId)!;
    assert.equal(stopping.state, RunningTaskState.Stopping);
    assert.equal(stopping.intentToStop, true);

    // The child exits in response to SIGTERM → requested exit → Exited (not Failed).
    spawner.spawned[0].emitExit(null, 'SIGTERM');
    const ended = manager.getInstance(task!.instanceId)!;
    assert.equal(ended.state, RunningTaskState.Exited);
    assert.equal(ended.signal, 'SIGTERM');
    assert.ok(store.recordStopCalls.length >= 1);
    manager.dispose();
  });

  it('emits onDidExitInstance when an instance ends', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const exits: InstanceExit[] = [];
    manager.onDidExitInstance((e) => exits.push(e));

    const task = await manager.run(d.id);
    spawner.spawned[0].emitExit(0);

    assert.equal(exits.length, 1);
    assert.equal(exits[0].instanceId, task!.instanceId);
    assert.equal(exits[0].exitCode, 0);
    manager.dispose();
  });

  it('stop() on an unknown or already-ended instance is a no-op', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);
    spawner.spawned[0].emitExit(0);

    await manager.stop(task!.instanceId); // already exited
    await manager.stop('ghost' as RunningInstanceId);
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Exited);
    manager.dispose();
  });
});

describe('TaskManager crash detection', () => {
  it('marks a non-zero exit (not requested) as Failed', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitExit(1, null); // crash, no stop requested
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Failed);
    assert.equal(manager.getInstance(task!.instanceId)?.exitCode, 1);
    manager.dispose();
  });

  it('marks a signal-terminated exit (not requested) as Failed', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitExit(null, 'SIGKILL'); // killed externally, not by us
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Failed);
    manager.dispose();
  });

  it('treats a zero exit as a clean Exited even without a stop request', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitExit(0, null);
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Exited);
    manager.dispose();
  });

  it('routes a spawn error to Failed', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitError(new Error('spawn ENOENT'));
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Failed);
    manager.dispose();
  });
});

describe('TaskManager state-machine guards', () => {
  it('terminal states are sticky: a post-exit event cannot revive an instance', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitExit(0); // → Exited
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Exited);

    // A spurious second exit/error must be ignored (illegal transition out of a
    // terminal state is rejected — the guard leaves Exited untouched).
    spawner.spawned[0].emitExit(1);
    spawner.spawned[0].emitError(new Error('late error'));
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Exited);
    manager.dispose();
  });

  it('a Failed instance stays Failed despite further events', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const task = await manager.run(d.id);

    spawner.spawned[0].emitExit(2); // → Failed
    spawner.spawned[0].emitExit(0); // ignored (already terminal)
    assert.equal(manager.getInstance(task!.instanceId)?.state, RunningTaskState.Failed);
    manager.dispose();
  });
});

describe('TaskManager single shared tick timer', () => {
  it('fires onDidTick once per interval while ≥1 instance is running, and stops when none are', async () => {
    const { manager, store, spawner, timers } = makeManager();
    const d = store.seed(def());

    let ticks = 0;
    manager.onDidTick(() => ticks++);

    // No running instances → no interval scheduled yet.
    assert.equal(timers.pendingCount, 0);

    const task = await manager.run(d.id);
    // One shared interval now scheduled.
    assert.equal(timers.pendingCount, 1);

    timers.advance(1000);
    timers.advance(1000);
    assert.equal(ticks, 2);

    // Exit the only instance → interval cleared, no more ticks.
    spawner.spawned[0].emitExit(0);
    assert.equal(timers.pendingCount, 0);
    timers.advance(5000);
    assert.equal(ticks, 2, 'tick must not fire after all instances end');
    void task;
    manager.dispose();
  });

  it('uses exactly one interval for multiple concurrent instances', async () => {
    const { manager, store, spawner, timers } = makeManager();
    const d = store.seed(def({ allowMultipleInstances: true }));

    await manager.run(d.id);
    await manager.run(d.id);
    // Two running instances but only ONE shared interval.
    assert.equal(timers.pendingCount, 1);

    timers.advance(1000);
    // The interval persists while at least one remains live.
    spawner.spawned[0].emitExit(0);
    assert.equal(timers.pendingCount, 1);
    spawner.spawned[1].emitExit(0);
    assert.equal(timers.pendingCount, 0);
    manager.dispose();
  });
});

describe('TaskManager runAll / stopAll', () => {
  it('runAll launches one instance of every not-already-running definition', async () => {
    const { manager, store, spawner } = makeManager();
    const a = store.seed(def({ name: 'A' }));
    const b = store.seed(def({ name: 'B' }));

    await manager.runAll();
    assert.equal(spawner.requests.length, 2);
    const defIds = manager
      .getInstances()
      .map((t) => t.definitionId)
      .sort();
    assert.deepEqual(defIds, [a.id, b.id].sort());

    // A second runAll does not double-launch the already-running ones.
    await manager.runAll();
    assert.equal(spawner.requests.length, 2);
    manager.dispose();
  });

  it('stopAll requests a stop of every live instance', async () => {
    const { manager, store } = makeManager();
    store.seed(def({ name: 'A' }));
    store.seed(def({ name: 'B' }));
    await manager.runAll();

    await manager.stopAll();
    for (const t of manager.getInstances()) {
      assert.equal(t.state, RunningTaskState.Stopping);
      assert.equal(t.intentToStop, true);
    }
    manager.dispose();
  });
});

describe('TaskManager restart()', () => {
  it('stops the live instance and launches a fresh one of the same definition', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const first = await manager.run(d.id);

    // Make the stop complete (so restart proceeds to a clean launch).
    const restartPromise = manager.restart(first!.instanceId);
    spawner.spawned[0].emitExit(null, 'SIGTERM');
    const second = await restartPromise;

    assert.ok(second);
    assert.notEqual(second?.instanceId, first?.instanceId);
    assert.equal(second?.definitionId, d.id);
    assert.equal(spawner.requests.length, 2);
    manager.dispose();
  });

  it('returns undefined for an unknown instance', async () => {
    const { manager } = makeManager();
    assert.equal(await manager.restart('ghost' as RunningInstanceId), undefined);
    manager.dispose();
  });
});

describe('TaskManager autoRestart + crash-loop breaker', () => {
  it('auto-restarts a crashed instance after its startupDelay', async () => {
    const { manager, store, spawner, timers, clock } = makeManager({ maxRestartsPerMinute: 5 });
    const d = store.seed(def({ autoRestart: true, startupDelayMs: 200 }));

    await manager.run(d.id);
    // Crash the first instance (non-zero, not requested).
    spawner.spawned[0].emitExit(1);
    assert.equal(spawner.requests.length, 1, 'restart is scheduled, not immediate');

    // Before the delay elapses: still no restart.
    clock.advance(199);
    timers.advance(199);
    assert.equal(spawner.requests.length, 1);

    // After the delay: a fresh instance is launched.
    clock.advance(1);
    timers.advance(1);
    assert.equal(spawner.requests.length, 2);
    manager.dispose();
  });

  it('trips the crash-loop breaker after maxRestartsPerMinute and notifies once', async () => {
    const tripped: TaskDefinition[] = [];
    const { manager, store, spawner, timers, clock } = makeManager({
      maxRestartsPerMinute: 2,
      onCrashLoop: (d) => tripped.push(d),
    });
    const d = store.seed(def({ autoRestart: true, startupDelayMs: 0 }));

    // Helper: crash whatever the latest spawned process is.
    const crashLatest = () => {
      const proc = spawner.spawned[spawner.spawned.length - 1];
      proc.emitExit(1);
    };

    await manager.run(d.id); // spawn #1
    crashLatest(); // restart #1 scheduled (history len 0 < 2)
    timers.advance(1); // fires restart → spawn #2
    clock.advance(1);

    crashLatest(); // restart #2 scheduled (history len 1 < 2)
    timers.advance(1); // fires restart → spawn #3
    clock.advance(1);

    crashLatest(); // history len 2 >= 2 → breaker trips, NO further restart
    timers.advance(10_000);

    assert.equal(spawner.requests.length, 3, 'no restart after the breaker trips');
    assert.equal(tripped.length, 1, 'crash-loop notification fires exactly once');
    assert.equal(tripped[0].id, d.id);
    manager.dispose();
  });

  it('respects the one-minute window: restarts older than 60s do not count toward the limit', async () => {
    const { manager, store, spawner, timers, clock } = makeManager({ maxRestartsPerMinute: 1 });
    const d = store.seed(def({ autoRestart: true, startupDelayMs: 0 }));

    const crashLatest = () => spawner.spawned[spawner.spawned.length - 1].emitExit(1);

    await manager.run(d.id); // spawn #1
    crashLatest(); // restart #1 scheduled (history empty < 1)
    timers.advance(1); // spawn #2
    clock.advance(1);

    // Advance the clock past the 60s window so the first restart ages out.
    clock.advance(61_000);

    crashLatest(); // history (after filtering) is empty again < 1 → restart allowed
    timers.advance(1); // spawn #3
    assert.equal(spawner.requests.length, 3);
    manager.dispose();
  });

  it('does not auto-restart when maxRestartsPerMinute is 0', async () => {
    const tripped: TaskDefinition[] = [];
    const { manager, store, spawner, timers } = makeManager({
      maxRestartsPerMinute: 0,
      onCrashLoop: (d) => tripped.push(d),
    });
    const d = store.seed(def({ autoRestart: true }));

    await manager.run(d.id);
    spawner.spawned[0].emitExit(1);
    timers.advance(60_000);

    assert.equal(spawner.requests.length, 1);
    assert.equal(tripped.length, 0);
    manager.dispose();
  });

  it('does not auto-restart a clean exit, or when autoRestart is off', async () => {
    const { manager, store, spawner, timers } = makeManager();
    const clean = store.seed(def({ name: 'clean', autoRestart: true }));
    const noRestart = store.seed(def({ name: 'noRestart', autoRestart: false }));

    await manager.run(clean.id);
    await manager.run(noRestart.id);

    spawner.spawned[0].emitExit(0); // clean exit of an autoRestart task → no restart
    spawner.spawned[1].emitExit(1); // crash of a non-autoRestart task → no restart
    timers.advance(60_000);

    assert.equal(spawner.requests.length, 2);
    manager.dispose();
  });
});

describe('TaskManager removeInstance / clearEnded', () => {
  it('removeInstance drops an ended instance and fires onDidRemoveInstance', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def());
    const removed: RunningInstanceId[] = [];
    manager.onDidRemoveInstance((id) => removed.push(id));

    const task = await manager.run(d.id);
    spawner.spawned[0].emitExit(0); // → Exited

    const ok = manager.removeInstance(task!.instanceId);
    assert.equal(ok, true);
    assert.equal(manager.getInstance(task!.instanceId), undefined);
    assert.deepEqual(removed, [task!.instanceId]);
    manager.dispose();
  });

  it('removeInstance refuses a live instance and fires nothing', async () => {
    const { manager, store } = makeManager();
    const d = store.seed(def());
    const removed: RunningInstanceId[] = [];
    manager.onDidRemoveInstance((id) => removed.push(id));

    const task = await manager.run(d.id); // Running (live)
    const ok = manager.removeInstance(task!.instanceId);

    assert.equal(ok, false);
    assert.ok(manager.getInstance(task!.instanceId), 'live instance is retained');
    assert.equal(removed.length, 0);
    manager.dispose();
  });

  it('removeInstance returns false for an unknown id', () => {
    const { manager } = makeManager();
    assert.equal(manager.removeInstance('ghost' as RunningInstanceId), false);
    manager.dispose();
  });

  it('clearEnded removes only ended instances and returns the count', async () => {
    const { manager, store, spawner } = makeManager();
    const d = store.seed(def({ allowMultipleInstances: true }));
    const removed: RunningInstanceId[] = [];
    manager.onDidRemoveInstance((id) => removed.push(id));

    const a = await manager.run(d.id); // will exit
    const b = await manager.run(d.id); // will fail
    const c = await manager.run(d.id); // stays live

    spawner.spawned[0].emitExit(0); // a → Exited
    spawner.spawned[1].emitExit(1); // b → Failed

    const count = manager.clearEnded();

    assert.equal(count, 2);
    assert.equal(manager.getInstance(a!.instanceId), undefined);
    assert.equal(manager.getInstance(b!.instanceId), undefined);
    assert.ok(manager.getInstance(c!.instanceId), 'the live instance is kept');
    assert.deepEqual([...removed].sort(), [a!.instanceId, b!.instanceId].sort());
    manager.dispose();
  });

  it('clearEnded is a no-op when nothing has ended', async () => {
    const { manager, store } = makeManager();
    const d = store.seed(def());
    await manager.run(d.id);
    assert.equal(manager.clearEnded(), 0);
    assert.equal(manager.getInstances().length, 1);
    manager.dispose();
  });
});

describe('TaskManager dispose', () => {
  it('terminates live children, clears the tick, and refuses further runs', async () => {
    const { manager, store, spawner, timers } = makeManager();
    const d = store.seed(def());
    await manager.run(d.id);

    assert.equal(timers.pendingCount, 1); // tick interval scheduled
    manager.dispose();

    assert.equal(spawner.spawned[0].terminated(), true, 'child SIGTERMed on dispose');
    assert.equal(await manager.run(d.id), undefined, 'run after dispose is refused');
    manager.dispose(); // idempotent
  });
});
