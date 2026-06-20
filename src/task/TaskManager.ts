/**
 * Orchestration hub and single source of truth for *running* task state.
 *
 * `TaskManager` owns the `Map<instanceId, RunningTask>`, enforces
 * `allowMultipleInstances`, drives the lifecycle state machine through a single
 * guarded {@link transition} method, and owns the **one** shared refresh timer
 * (started on the first `Running` transition, cleared when the running count
 * reaches zero). It translates the lower-level {@link TaskRunner} events into the
 * granular {@link ITaskManagerControl} event surface the view/output layers
 * subscribe to, and records run/stop side-data back into the {@link ITaskStore}.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`. All collaborators arrive via the constructor.
 */

import { Emitter, type Event, type IDisposable } from '../util/event';
import { newId, type RunningInstanceId, type TaskDefinitionId } from '../types/ids';
import { RunningTaskState, isLive, type RunningTask } from '../models/RunningTask';
import type { TaskDefinition } from '../models/TaskDefinition';
import type {
  IClock,
  ITaskManagerControl,
  ITaskStore,
  ITimerHandle,
  ITimers,
  InstanceExit,
  InstanceOutput,
  StopOptions,
} from '../types/contracts';
import { TaskRunner } from './TaskRunner';

/** Tuning knobs for the manager, sourced from configuration. */
export interface TaskManagerOptions {
  /** Default milliseconds between SIGTERM and SIGKILL when a stop omits its own. */
  stopGraceMs: number;

  /** Crash-loop breaker: max automatic restarts within a one-minute window (0 disables auto-restart). */
  maxRestartsPerMinute: number;

  /**
   * Resolves a definition's working directory to an absolute path the spawner can
   * use, or `undefined` to inherit. Injected so the core stays free of `vscode`
   * and `path` workspace resolution; the composition root supplies it.
   */
  resolveCwd?: (def: TaskDefinition) => string | undefined;

  /**
   * Notifies the host that the crash-loop breaker tripped for a definition, so it
   * can surface a single notification. Optional; omitted in tests.
   */
  onCrashLoop?: (def: TaskDefinition) => void;
}

/** The single shared tick interval, in milliseconds. */
const TICK_INTERVAL_MS = 1000;

/** Window over which the crash-loop breaker counts restarts. */
const RESTART_WINDOW_MS = 60_000;

/**
 * Valid lifecycle transitions. A transition not present here is rejected by
 * {@link TaskManager.transition} (and never mutates state), making illegal
 * sequences impossible regardless of event ordering races.
 */
const TRANSITIONS: Readonly<Record<RunningTaskState, ReadonlySet<RunningTaskState>>> = {
  [RunningTaskState.Starting]: new Set([
    RunningTaskState.Running,
    RunningTaskState.Stopping,
    RunningTaskState.Exited,
    RunningTaskState.Failed,
  ]),
  [RunningTaskState.Running]: new Set([
    RunningTaskState.Stopping,
    RunningTaskState.Exited,
    RunningTaskState.Failed,
    RunningTaskState.Restarting,
  ]),
  [RunningTaskState.Stopping]: new Set([RunningTaskState.Exited, RunningTaskState.Failed]),
  [RunningTaskState.Restarting]: new Set([
    RunningTaskState.Starting,
    RunningTaskState.Exited,
    RunningTaskState.Failed,
  ]),
  [RunningTaskState.Exited]: new Set<RunningTaskState>(),
  [RunningTaskState.Failed]: new Set<RunningTaskState>(),
};

/**
 * Implements {@link ITaskManagerControl} over a {@link TaskStore} and a
 * {@link TaskRunner}.
 */
export class TaskManager implements ITaskManagerControl {
  /** All known instances (live and recently ended), in creation order. */
  private readonly instances = new Map<RunningInstanceId, RunningTask>();

  /** Restart timestamps (epoch ms) per definition, for the crash-loop breaker. */
  private readonly restartHistory = new Map<TaskDefinitionId, number[]>();

  /** Pending auto-restart timers, so they can be cancelled on dispose. */
  private readonly restartTimers = new Set<ITimerHandle>();

  /** The single shared refresh timer; present only while ≥1 instance is running. */
  private tickTimer: ITimerHandle | undefined;

  /** Subscriptions to the runner's events. */
  private readonly runnerSubs: IDisposable[];

  // -- Emitters --------------------------------------------------------------

  private readonly startEmitter = new Emitter<RunningTask>();
  private readonly updateEmitter = new Emitter<RunningTask>();
  private readonly exitEmitter = new Emitter<InstanceExit>();
  private readonly outputEmitter = new Emitter<InstanceOutput>();
  private readonly tickEmitter = new Emitter<void>();

  /** Set once disposed. */
  private disposed = false;

  /** @inheritdoc */
  public readonly onDidStartInstance: Event<RunningTask> = this.startEmitter.event;
  /** @inheritdoc */
  public readonly onDidUpdateInstance: Event<RunningTask> = this.updateEmitter.event;
  /** @inheritdoc */
  public readonly onDidExitInstance: Event<InstanceExit> = this.exitEmitter.event;
  /** @inheritdoc */
  public readonly onDidOutput: Event<InstanceOutput> = this.outputEmitter.event;
  /** @inheritdoc */
  public readonly onDidTick: Event<void> = this.tickEmitter.event;

  /**
   * @param store - The definition store (for run/stop side-data and lookups).
   * @param runner - The process engine.
   * @param clock - Time source for timestamps and the crash-loop window.
   * @param timers - Scheduler for the shared tick and auto-restart delays.
   * @param options - Tuning knobs.
   */
  public constructor(
    private readonly store: ITaskStore,
    private readonly runner: TaskRunner,
    private readonly clock: IClock,
    private readonly timers: ITimers,
    private options: TaskManagerOptions
  ) {
    this.runnerSubs = [
      this.runner.onDidStart(({ instanceId, pid }) => this.handleRunnerStart(instanceId, pid)),
      this.runner.onDidOutput(({ instanceId, chunk }) =>
        this.outputEmitter.fire({ instanceId, chunk })
      ),
      this.runner.onDidExit((exit) => this.handleRunnerExit(exit)),
      this.runner.onDidError(({ instanceId, error }) => this.handleRunnerError(instanceId, error)),
    ];
  }

  /**
   * Updates tuning knobs at runtime (e.g. after a settings change).
   *
   * @param options - The new options (merged over the current ones).
   */
  public setOptions(options: Partial<TaskManagerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ---------------------------------------------------------------------------
  // Reads (ITaskManager)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  public getInstances(): RunningTask[] {
    return [...this.instances.values()];
  }

  /** @inheritdoc */
  public getInstance(instanceId: RunningInstanceId): RunningTask | undefined {
    return this.instances.get(instanceId);
  }

  /** @inheritdoc */
  public getBufferedOutput(instanceId: RunningInstanceId): Buffer {
    return this.runner.getBufferedOutput(instanceId);
  }

  // ---------------------------------------------------------------------------
  // Controls (ITaskManagerControl)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  public run(id: TaskDefinitionId): Promise<RunningTask | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    const def = this.store.get(id);
    if (!def) {
      return Promise.resolve(undefined);
    }

    // Enforce single-instance: return the existing live one rather than spawning.
    if (!def.allowMultipleInstances) {
      const existing = this.getInstances().find((t) => t.definitionId === id && isLive(t));
      if (existing) {
        return Promise.resolve(existing);
      }
    }

    return Promise.resolve(this.launch(def));
  }

  /** @inheritdoc */
  public async restart(
    instanceId: RunningInstanceId,
    options?: StopOptions
  ): Promise<RunningTask | undefined> {
    const task = this.instances.get(instanceId);
    if (!task) {
      return undefined;
    }
    const def = this.store.get(task.definitionId);
    if (!def) {
      return undefined;
    }

    if (isLive(task)) {
      await this.stop(instanceId, options);
    }
    return this.launch(def);
  }

  /** @inheritdoc */
  public async runAll(): Promise<void> {
    for (const def of this.store.getAll()) {
      const hasLive = this.getInstances().some((t) => t.definitionId === def.id && isLive(t));
      if (!hasLive) {
        await this.run(def.id);
      }
    }
  }

  /** @inheritdoc */
  public stop(instanceId: RunningInstanceId, options?: StopOptions): Promise<void> {
    const task = this.instances.get(instanceId);
    if (!task || !isLive(task)) {
      return Promise.resolve();
    }
    // Show "Stopping" immediately (during the SIGTERM grace window).
    this.transition(task, RunningTaskState.Stopping, { intentToStop: true });
    const grace = options?.graceMs ?? this.options.stopGraceMs;
    this.runner.stop(instanceId, grace);
    return Promise.resolve();
  }

  /** @inheritdoc */
  public async stopAll(options?: StopOptions): Promise<void> {
    for (const task of this.getInstances()) {
      if (isLive(task)) {
        await this.stop(task.instanceId, options);
      }
    }
  }

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.stopTick();
    for (const t of this.restartTimers) {
      t.cancel();
    }
    this.restartTimers.clear();

    for (const sub of this.runnerSubs) {
      sub.dispose();
    }
    this.runnerSubs.length = 0;

    // The runner SIGTERMs every live child during its own dispose.
    this.runner.dispose();

    this.instances.clear();
    this.restartHistory.clear();

    this.startEmitter.dispose();
    this.updateEmitter.dispose();
    this.exitEmitter.dispose();
    this.outputEmitter.dispose();
    this.tickEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Creates a new {@link RunningTask}, records the run, and asks the runner to
   * spawn. The instance starts in {@link RunningTaskState.Starting}.
   */
  private launch(def: TaskDefinition): RunningTask {
    const instanceId = newId<RunningInstanceId>();
    const task: RunningTask = {
      instanceId,
      definitionId: def.id,
      name: def.name,
      state: RunningTaskState.Starting,
      startedAt: this.clock.now(),
      intentToStop: false,
    };
    this.instances.set(instanceId, task);
    this.startEmitter.fire(task);

    // Persist run side-data (history + last start). Best-effort: never block launch.
    void this.store.recordRun(def.id).catch(() => {
      /* persistence failures must not break launching */
    });

    const cwd = this.resolveCwd(def);
    const pid = this.runner.start(instanceId, def, cwd);
    if (pid !== undefined) {
      // pid known synchronously → already running.
      this.handleRunnerStart(instanceId, pid);
    }
    return task;
  }

  /** Marks an instance running once the runner confirms a pid. */
  private handleRunnerStart(instanceId: RunningInstanceId, pid: number): void {
    const task = this.instances.get(instanceId);
    if (!task) {
      return;
    }
    // Idempotent: a synchronous pid plus the runner event can both arrive.
    if (task.state === RunningTaskState.Running && task.pid === pid) {
      return;
    }
    if (task.state === RunningTaskState.Starting || task.state === RunningTaskState.Restarting) {
      this.transition(task, RunningTaskState.Running, { pid });
      this.startTick();
    } else if (task.pid === undefined) {
      task.pid = pid;
      this.updateEmitter.fire(task);
    }
  }

  /** Handles a runner exit: moves to Exited/Failed, records stop, maybe restarts. */
  private handleRunnerExit(exit: {
    instanceId: RunningInstanceId;
    code?: number;
    signal?: string;
    requested: boolean;
  }): void {
    const task = this.instances.get(exit.instanceId);
    if (!task || !isLive(task)) {
      return;
    }

    const crashed = !exit.requested && (exit.signal !== undefined || (exit.code ?? 0) !== 0);
    const target = crashed ? RunningTaskState.Failed : RunningTaskState.Exited;

    this.transition(task, target, {
      endedAt: this.clock.now(),
      exitCode: exit.code,
      signal: exit.signal,
    });

    void this.store.recordStop(task.definitionId, exit.code).catch(() => {
      /* persistence failures must not break exit handling */
    });

    this.exitEmitter.fire({
      instanceId: exit.instanceId,
      exitCode: exit.code,
      signal: exit.signal,
    });

    this.maybeStopTick();

    if (crashed) {
      this.maybeAutoRestart(task);
    }
  }

  /** Handles a runner spawn/runtime error: the instance failed. */
  private handleRunnerError(instanceId: RunningInstanceId, error: Error): void {
    const task = this.instances.get(instanceId);
    if (!task || !isLive(task)) {
      return;
    }
    this.transition(task, RunningTaskState.Failed, {
      endedAt: this.clock.now(),
    });
    // Surface the failure as output so the terminal shows why it never started.
    this.outputEmitter.fire({
      instanceId,
      chunk: Buffer.from(`\n[failed to start: ${error.message}]\n`, 'utf8'),
    });
    this.exitEmitter.fire({ instanceId });
    this.maybeStopTick();
  }

  /**
   * Auto-restarts a crashed instance if its definition opts in and the
   * crash-loop breaker has not tripped within the trailing one-minute window.
   */
  private maybeAutoRestart(task: RunningTask): void {
    const def = this.store.get(task.definitionId);
    if (!def?.autoRestart || this.options.maxRestartsPerMinute <= 0 || this.disposed) {
      return;
    }

    const now = this.clock.now();
    const history = (this.restartHistory.get(def.id) ?? []).filter(
      (t) => now - t < RESTART_WINDOW_MS
    );

    if (history.length >= this.options.maxRestartsPerMinute) {
      // Breaker tripped: stop restarting and notify once.
      this.restartHistory.set(def.id, history);
      this.options.onCrashLoop?.(def);
      return;
    }

    history.push(now);
    this.restartHistory.set(def.id, history);

    const delay = Math.max(0, def.startupDelayMs ?? 0);
    const timer = this.timers.setTimeout(() => {
      this.restartTimers.delete(timer);
      if (!this.disposed) {
        void this.run(def.id);
      }
    }, delay);
    this.restartTimers.add(timer);
  }

  /**
   * The single guarded mutation point for instance state.
   *
   * Applies `patch`, then transitions to `next` only if the move is permitted by
   * {@link TRANSITIONS}; on an illegal transition the patch is still applied but
   * the state is left unchanged (and an update still fires so views stay fresh).
   * Always emits {@link onDidUpdateInstance}.
   */
  private transition(
    task: RunningTask,
    next: RunningTaskState,
    patch?: Partial<RunningTask>
  ): void {
    if (patch) {
      Object.assign(task, patch);
    }
    if (TRANSITIONS[task.state].has(next)) {
      task.state = next;
    }
    this.updateEmitter.fire(task);
  }

  /** Resolves a definition's working directory via the injected resolver. */
  private resolveCwd(def: TaskDefinition): string | undefined {
    try {
      return this.options.resolveCwd?.(def);
    } catch {
      return undefined;
    }
  }

  // -- Shared tick -----------------------------------------------------------

  /** Starts the single shared tick timer if it is not already running. */
  private startTick(): void {
    if (this.tickTimer || this.disposed) {
      return;
    }
    this.tickTimer = this.timers.setInterval(() => this.tickEmitter.fire(), TICK_INTERVAL_MS);
  }

  /** Stops the shared tick timer once no instances remain live. */
  private maybeStopTick(): void {
    const anyLive = this.getInstances().some((t) => isLive(t));
    if (!anyLive) {
      this.stopTick();
    }
  }

  /** Cancels and clears the shared tick timer. */
  private stopTick(): void {
    this.tickTimer?.cancel();
    this.tickTimer = undefined;
  }
}
