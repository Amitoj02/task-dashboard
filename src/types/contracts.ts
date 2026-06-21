/**
 * The seams (interfaces) that decouple the pure core from the VS Code host.
 *
 * Every dependency the core needs from the outside world is expressed here as a
 * narrow interface. Concrete, host-aware implementations live under
 * `src/adapters/**` and are wired up only in `extension.ts`. Tests substitute
 * in-memory fakes. The core never sees a concrete `vscode` type.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

import type { Event, IDisposable } from '../util/event';
import type { TaskDefinition, TaskDefinitionInput, TaskScope } from '../models/TaskDefinition';
import type { RunningTask } from '../models/RunningTask';
import type { RunningInstanceId, TaskDefinitionId } from './ids';

/**
 * A persistent key/value store, modelled on `vscode.Memento`.
 *
 * Two instances are injected into the store: one backed by global state and one
 * backed by workspace state, enabling global-vs-workspace partitioning of task
 * definitions.
 */
export interface ITaskStorage {
  /**
   * Reads a previously stored value.
   *
   * @typeParam T - Expected type of the stored value.
   * @param key - The storage key.
   * @returns The stored value, or `undefined` if absent.
   */
  get<T>(key: string): T | undefined;

  /**
   * Writes (or, with `undefined`, clears) a value.
   *
   * @param key - The storage key.
   * @param value - The value to persist, or `undefined` to remove the key.
   * @returns A promise that resolves once the write is committed.
   */
  update(key: string, value: unknown): Promise<void>;
}

/**
 * A source of the current time.
 *
 * Injected so timestamps are deterministic under test (a fake clock can advance
 * virtual time) rather than reading the wall clock directly.
 */
export interface IClock {
  /** @returns The current time as epoch milliseconds. */
  now(): number;
}

/**
 * Validates filesystem paths for the host layer (e.g. a task's working
 * directory) without coupling callers to `fs`.
 *
 * Implementations live under `src/adapters/**`; the webview Task Editor receives
 * one so it can authoritatively confirm a chosen working directory exists and is
 * a directory before a task is saved. All methods are failure-safe: an I/O error
 * resolves to `false` rather than rejecting.
 */
export interface IPathValidator {
  /**
   * Reports whether something exists at `path`.
   *
   * @param path - An absolute or workspace-relative filesystem path.
   * @returns A promise resolving to `true` if the path exists, else `false`.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Reports whether `path` exists and resolves to a directory.
   *
   * @param path - An absolute or workspace-relative filesystem path.
   * @returns A promise resolving to `true` if `path` is a directory, else `false`.
   */
  isDirectory(path: string): Promise<boolean>;
}

/**
 * A registered timer that can be cancelled.
 *
 * Returned by {@link ITimers} so the core can schedule and tear down timers
 * without referencing Node's ambient `setTimeout`/`setInterval` return types
 * directly — keeping it injectable and deterministic under test.
 */
export interface ITimerHandle {
  /** Cancels the timer. Idempotent: safe to call after it has already fired/been cancelled. */
  cancel(): void;
}

/**
 * A source of scheduled callbacks (one-shot and repeating).
 *
 * Injected so the core's grace-timeouts, startup delays, and the single shared
 * refresh tick can be driven by a fake clock in tests rather than real wall-clock
 * timers. The concrete adapter wraps Node's `setTimeout`/`setInterval`.
 */
export interface ITimers {
  /**
   * Schedules a one-shot callback.
   *
   * @param callback - Invoked once after `delayMs`.
   * @param delayMs - Delay in milliseconds.
   * @returns A handle that cancels the pending callback.
   */
  setTimeout(callback: () => void, delayMs: number): ITimerHandle;

  /**
   * Schedules a repeating callback.
   *
   * @param callback - Invoked every `intervalMs` until cancelled.
   * @param intervalMs - Interval in milliseconds.
   * @returns A handle that stops the repeating callback.
   */
  setInterval(callback: () => void, intervalMs: number): ITimerHandle;
}

/**
 * Options for spawning a child process.
 *
 * Mirrors the subset of `child_process.spawn` options the runner needs. The
 * core builds these from a validated {@link TaskDefinition}; the concrete
 * spawner adapter translates them to real `spawn` arguments (adding
 * `windowsHide`, `stdio`, and platform-specific `detached`).
 */
export interface SpawnOptions {
  /** The program (or shell) to execute. */
  command: string;

  /** Argument vector passed to {@link command}. */
  args: string[];

  /** Working directory for the child. Absent/empty inherits the parent's cwd. */
  cwd?: string;

  /** Full environment for the child (already merged over `process.env` by the caller). */
  env?: Record<string, string | undefined>;

  /**
   * Whether the child should start its own process group (POSIX `detached`), so a
   * negative-pid group kill can take down the whole tree. The adapter ignores
   * this on Windows (which uses `taskkill /T`).
   */
  detached?: boolean;
}

/**
 * A spawned child process, narrowed to the surface the core consumes.
 *
 * This is the only process-related type the core (and its tests) interacts
 * with: the concrete adapter wraps a real `ChildProcess`, while fakes script
 * output/exit deterministically. Every listener accessor returns a
 * {@link import('../util/event').IDisposable} so subscriptions are leak-free.
 */
export interface ISpawnedProcess {
  /** OS process id, or `undefined` if the spawn failed before assignment. */
  readonly pid: number | undefined;

  /**
   * Subscribes to raw stdout chunks.
   *
   * @param listener - Receives each chunk as a {@link Buffer}.
   */
  onStdout(listener: (chunk: Buffer) => void): IDisposable;

  /**
   * Subscribes to raw stderr chunks.
   *
   * @param listener - Receives each chunk as a {@link Buffer}.
   */
  onStderr(listener: (chunk: Buffer) => void): IDisposable;

  /**
   * Subscribes to process exit.
   *
   * @param listener - Receives the exit code and/or terminating signal.
   */
  onExit(listener: (code: number | null, signal: string | null) => void): IDisposable;

  /**
   * Subscribes to spawn/runtime errors (e.g. ENOENT, EACCES).
   *
   * Implementations MUST attach the underlying `error` listener eagerly so an
   * unhandled child error can never crash the host.
   *
   * @param listener - Receives the error.
   */
  onError(listener: (error: Error) => void): IDisposable;

  /**
   * Best-effort kill of the process (or its group, when spawned detached).
   *
   * Implementations wrap every underlying `process.kill` in try/catch so an
   * `ESRCH`/`EPERM` race can never throw into the host.
   *
   * @param signal - The signal to send (default `SIGTERM`).
   */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Spawns child processes for the core, without coupling it to `child_process`.
 *
 * The single seam the {@link ../task/TaskRunner} depends on for process
 * creation; tests substitute a fake that records spawn options and scripts
 * lifecycle events.
 */
export interface IProcessSpawner {
  /**
   * Spawns a child process.
   *
   * @param options - The validated spawn options.
   * @returns The spawned process handle. Implementations never throw from
   *   `spawn`; a synchronous failure surfaces via {@link ISpawnedProcess.onError}.
   */
  spawn(options: SpawnOptions): ISpawnedProcess;
}

/** A single labelled choice offered through {@link IUserInteraction.pick}. */
export interface PickItem<T> {
  /** The text shown in the quick-pick row. */
  label: string;

  /** Optional muted detail shown alongside the label. */
  description?: string;

  /** The value returned when this item is chosen. */
  value: T;
}

/** Options for an {@link IUserInteraction.prompt} input box. */
export interface PromptOptions {
  /** The prompt message shown above the input. */
  prompt?: string;

  /** Placeholder text shown in the empty input. */
  placeHolder?: string;

  /** Pre-filled value. */
  value?: string;

  /** When `true`, the typed characters are masked. */
  password?: boolean;

  /**
   * Synchronous validator: returns an error message to keep the box open, or
   * `undefined`/`null` to accept the current value.
   */
  validate?: (value: string) => string | undefined | null;
}

/**
 * A thin, testable wrapper over the VS Code user-interaction surface
 * (`showInputBox`, `showQuickPick`, `showWarningMessage`, notifications).
 *
 * Command flows depend on this seam rather than `vscode.window` directly so they
 * can be unit-tested by stubbing the prompts/answers. The concrete adapter lives
 * in `src/adapters/VsCodeUserInteraction.ts`.
 */
export interface IUserInteraction {
  /**
   * Prompts for a line of text.
   *
   * @param options - Prompt configuration (message, placeholder, validation, …).
   * @returns The entered string, or `undefined` if the user cancelled.
   */
  prompt(options: PromptOptions): Promise<string | undefined>;

  /**
   * Offers a single-select quick pick.
   *
   * @typeParam T - The value type carried by each item.
   * @param items - The choices to present.
   * @param placeHolder - Optional placeholder for the pick box.
   * @returns The chosen item's value, or `undefined` if cancelled.
   */
  pick<T>(items: PickItem<T>[], placeHolder?: string): Promise<T | undefined>;

  /**
   * Asks a yes/no question, optionally as a blocking modal.
   *
   * @param message - The question to present.
   * @param confirmLabel - Label for the affirmative action (default `Yes`).
   * @param modal - When `true`, show a blocking modal dialog.
   * @returns `true` if the user confirmed, else `false`.
   */
  confirm(message: string, confirmLabel?: string, modal?: boolean): Promise<boolean>;

  /**
   * Shows an informational notification.
   *
   * @param message - The message to display.
   */
  info(message: string): void;

  /**
   * Shows a warning notification.
   *
   * @param message - The message to display.
   */
  warn(message: string): void;

  /**
   * Shows an error notification.
   *
   * @param message - The message to display.
   */
  error(message: string): void;
}

/** How a {@link ITaskStore.query} result is ordered. */
export type TaskSort = 'name-asc' | 'name-desc' | 'recent';

/**
 * Parameters that filter and order a {@link ITaskStore.query}.
 *
 * All fields are optional; omitting one disables that aspect of the query.
 */
export interface TaskQuery {
  /** Case-insensitive substring matched against name + command. */
  search?: string;

  /** Sort order for the results. Defaults to `name-asc` when omitted. */
  sort?: TaskSort;

  /** Restrict results to a single scope. Omit for both scopes. */
  scope?: TaskScope;
}

/**
 * The canonical store of {@link TaskDefinition}s.
 *
 * Owns all definition CRUD, search/filter/sort, and global-vs-workspace
 * partitioning. Holds no knowledge of running processes. Mutations are
 * persisted to the owning scope's storage and announced via
 * {@link onDidChangeDefinitions}.
 */
export interface ITaskStore {
  /** Fires after any change to the set of definitions (add/update/delete/duplicate/run-record). */
  readonly onDidChangeDefinitions: Event<void>;

  /** @returns All definitions across both scopes, in load order. */
  getAll(): TaskDefinition[];

  /**
   * Looks up a single definition.
   *
   * @param id - The definition id.
   * @returns The definition, or `undefined` if unknown.
   */
  get(id: TaskDefinitionId): TaskDefinition | undefined;

  /**
   * Returns the scope a definition belongs to.
   *
   * @param id - The definition id.
   * @returns The owning {@link TaskScope}, or `undefined` if unknown.
   */
  getScope(id: TaskDefinitionId): TaskScope | undefined;

  /**
   * Filters and orders the definitions.
   *
   * @param query - Search/sort/scope parameters.
   * @returns A new array of matching definitions in the requested order.
   */
  query(query: TaskQuery): TaskDefinition[];

  /**
   * Creates a new definition in the given scope.
   *
   * @param input - The user-authored fields.
   * @param scope - Where to store it.
   * @returns A promise resolving to the created definition (with assigned id).
   */
  add(input: TaskDefinitionInput, scope: TaskScope): Promise<TaskDefinition>;

  /**
   * Merges a partial patch into an existing definition.
   *
   * @param id - The definition to update.
   * @param patch - Fields to overwrite.
   * @returns A promise resolving to the updated definition, or `undefined` if unknown.
   */
  update(
    id: TaskDefinitionId,
    patch: Partial<TaskDefinitionInput>
  ): Promise<TaskDefinition | undefined>;

  /**
   * Removes a definition.
   *
   * @param id - The definition to delete.
   * @returns A promise that resolves once the deletion is persisted.
   */
  delete(id: TaskDefinitionId): Promise<void>;

  /**
   * Copies a definition within the same scope, giving it a fresh id, a unique
   * "(copy)" name, and empty run history.
   *
   * @param id - The definition to duplicate.
   * @returns A promise resolving to the new definition, or `undefined` if unknown.
   */
  duplicate(id: TaskDefinitionId): Promise<TaskDefinition | undefined>;

  /**
   * Records that a definition was just started: stamps the start time and
   * appends the command to history.
   *
   * @param id - The definition that started.
   * @returns A promise that resolves once persisted.
   */
  recordRun(id: TaskDefinitionId): Promise<void>;

  /**
   * Records that a definition just stopped: stamps the stop time and exit code.
   *
   * @param id - The definition that stopped.
   * @param exitCode - The process exit code, or `null`/`undefined` if unknown.
   * @returns A promise that resolves once persisted.
   */
  recordStop(id: TaskDefinitionId, exitCode: number | null | undefined): Promise<void>;

  /** Releases resources (the change emitter). */
  dispose(): void;
}

/** Well-known keys used within an {@link ITaskStorage}. */
export const STORAGE_KEYS = {
  /** Array of {@link TaskDefinition} for the scope. */
  definitions: 'taskDashboard.definitions',
} as const;

/**
 * A chunk of output produced by a single running instance.
 *
 * Chunks are kept as raw {@link Buffer}s in the core so multibyte UTF-8
 * sequences are never split mid-character; stringification happens only at the
 * host boundary (e.g. the terminal sink).
 */
export interface InstanceOutput {
  /** The instance that produced this chunk. */
  instanceId: RunningInstanceId;

  /** The raw bytes written to stdout or stderr. */
  chunk: Buffer;
}

/**
 * The terminal-state details delivered when a running instance ends.
 */
export interface InstanceExit {
  /** The instance that ended. */
  instanceId: RunningInstanceId;

  /** Process exit code, if it exited with one. */
  exitCode?: number;

  /** Terminating signal name (e.g. `SIGTERM`), if killed by a signal. */
  signal?: string;
}

/**
 * Options controlling how an instance is stopped.
 */
export interface StopOptions {
  /** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
  graceMs?: number;
}

/**
 * Orchestration hub and single source of truth for *running* task state.
 *
 * The manager owns the `Map<instanceId, RunningTask>`, enforces
 * `allowMultipleInstances`, drives the lifecycle state machine, and owns the
 * single shared refresh timer. It re-emits process output and lifecycle
 * transitions as granular events that the view layer subscribes to.
 *
 * This is the seam the {@link ../views/OutputProvider} (and the running-task
 * tree) depend on; the concrete implementation lives in `task/TaskManager.ts`.
 */
export interface ITaskManager {
  /** Fires when a new instance is created (state `Starting`). */
  readonly onDidStartInstance: Event<RunningTask>;

  /** Fires on any state/field change to an existing instance. */
  readonly onDidUpdateInstance: Event<RunningTask>;

  /** Fires when an instance ends (after which it remains queryable but inert). */
  readonly onDidExitInstance: Event<InstanceExit>;

  /**
   * Fires when an ended instance is removed from the running list (via
   * {@link ITaskManagerControl.removeInstance} / {@link ITaskManagerControl.clearEnded}),
   * carrying the removed instance id so views and the output sink can tear down
   * any resources they hold for it.
   */
  readonly onDidRemoveInstance: Event<RunningInstanceId>;

  /** Fires for each chunk of stdout/stderr produced by a live instance. */
  readonly onDidOutput: Event<InstanceOutput>;

  /** Fires roughly once per second while at least one instance is running. */
  readonly onDidTick: Event<void>;

  /** @returns A snapshot of all known instances (live and recently ended). */
  getInstances(): RunningTask[];

  /**
   * Looks up a single instance.
   *
   * @param instanceId - The instance id.
   * @returns The instance, or `undefined` if unknown.
   */
  getInstance(instanceId: RunningInstanceId): RunningTask | undefined;

  /**
   * Returns the buffered output tail retained for an instance.
   *
   * The buffer is hard-capped (see `logRetentionBytes`); full scrollback lives
   * in the terminal renderer, not here. Used to replay recent context when an
   * output view is revealed.
   *
   * @param instanceId - The instance id.
   * @returns The retained tail as a single {@link Buffer} (empty if none).
   */
  getBufferedOutput(instanceId: RunningInstanceId): Buffer;

  /**
   * Requests a graceful stop of a single instance.
   *
   * @param instanceId - The instance to stop.
   * @param options - Optional grace-period override.
   * @returns A promise that resolves once the stop sequence has been initiated.
   */
  stop(instanceId: RunningInstanceId, options?: StopOptions): Promise<void>;

  /** Releases resources (timer, emitters, child processes). */
  dispose(): void;
}

/**
 * The launch/lifecycle-control surface of the task manager.
 *
 * {@link ITaskManager} is the read/observe seam consumed by the views and the
 * output provider. This interface extends it with the *imperative* operations
 * the command layer drives — running, restarting, and bulk run/stop. Keeping the
 * two separate lets the view layer depend only on the narrow read surface.
 */
export interface ITaskManagerControl extends ITaskManager {
  /**
   * Launches a new running instance of a definition.
   *
   * Enforces `allowMultipleInstances`: when the definition disallows concurrency
   * and a live instance already exists, the existing instance is returned rather
   * than a new one spawned.
   *
   * @param id - The definition to run.
   * @returns A promise resolving to the (new or existing) instance, or
   *   `undefined` if the definition is unknown.
   */
  run(id: TaskDefinitionId): Promise<RunningTask | undefined>;

  /**
   * Stops a running instance (if live) and launches a fresh one of the same
   * definition.
   *
   * @param instanceId - The instance to restart.
   * @param options - Optional grace-period override for the stop phase.
   * @returns A promise resolving to the new instance, or `undefined` if the
   *   instance (or its definition) is unknown.
   */
  restart(instanceId: RunningInstanceId, options?: StopOptions): Promise<RunningTask | undefined>;

  /**
   * Launches one instance of every definition that is not already running.
   *
   * @returns A promise that resolves once every launch has been initiated.
   */
  runAll(): Promise<void>;

  /**
   * Requests a graceful stop of every live instance.
   *
   * @param options - Optional grace-period override applied to each stop.
   * @returns A promise that resolves once every stop has been initiated.
   */
  stopAll(options?: StopOptions): Promise<void>;

  /**
   * Removes a single *ended* instance from the running list, firing
   * {@link ITaskManager.onDidRemoveInstance} so its terminal/output can be torn
   * down. Live instances are never removed (stop them first).
   *
   * @param instanceId - The instance to remove.
   * @returns `true` if an ended instance was removed; `false` if it is unknown
   *   or still live.
   */
  removeInstance(instanceId: RunningInstanceId): boolean;

  /**
   * Removes every *ended* (exited/failed) instance from the running list,
   * firing {@link ITaskManager.onDidRemoveInstance} once per removed instance.
   * Live instances are left untouched.
   *
   * @returns The number of instances removed.
   */
  clearEnded(): number;
}
