/**
 * The value object describing a single running instance of a task, plus its
 * lifecycle state machine.
 *
 * A {@link RunningTask} is created when a {@link TaskDefinition} is launched and
 * is the single source of truth for that instance's live state. Its
 * {@link RunningTask.instanceId} is distinct from the definition's `id`: one
 * definition may have many concurrent instances (when
 * `allowMultipleInstances` is set).
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

import type { RunningInstanceId, TaskDefinitionId } from '../types/ids';

/**
 * The lifecycle state of a {@link RunningTask}.
 *
 * The happy path is `Starting → Running → Stopping → Exited`. `Failed` is
 * reached on spawn error or non-zero/signal exit that was not user-requested.
 * `Restarting` is a transient state used by the auto-restart flow.
 */
export enum RunningTaskState {
  /** Spawn requested; awaiting the OS process (and any `startupDelayMs`). */
  Starting = 'starting',
  /** Process is alive and producing output. */
  Running = 'running',
  /** A stop was requested; awaiting graceful (SIGTERM) shutdown. */
  Stopping = 'stopping',
  /** Process ended cleanly (or as the result of a requested stop). */
  Exited = 'exited',
  /** Process failed to spawn, or exited unexpectedly with an error. */
  Failed = 'failed',
  /** Transient: an auto-restart is scheduled/in flight. */
  Restarting = 'restarting',
}

/**
 * A live (or recently-ended) instance of a launched task.
 *
 * Snapshots the definition's display name at launch time so the UI keeps a
 * stable label even if the definition is later renamed or deleted.
 */
export interface RunningTask {
  /** Unique id for this instance (distinct from {@link definitionId}). */
  instanceId: RunningInstanceId;

  /** The definition this instance was launched from. */
  definitionId: TaskDefinitionId;

  /** Display name captured at launch time (e.g. for terminal titles). */
  name: string;

  /** OS process id, once spawned. Absent while `Starting` or if spawn failed. */
  pid?: number;

  /** Current lifecycle state. Mutated only via the manager's transition guard. */
  state: RunningTaskState;

  /** Epoch-millis timestamp when this instance was created. */
  startedAt: number;

  /** Epoch-millis timestamp when this instance ended, if it has. */
  endedAt?: number;

  /** Process exit code, if it exited with one. */
  exitCode?: number;

  /** Terminating signal name (e.g. `SIGTERM`), if killed by a signal. */
  signal?: string;

  /** `true` once the user has requested a stop, distinguishing exits from crashes. */
  intentToStop: boolean;
}

/** The set of states in which a {@link RunningTask}'s process is considered alive. */
const LIVE_STATES: ReadonlySet<RunningTaskState> = new Set([
  RunningTaskState.Starting,
  RunningTaskState.Running,
  RunningTaskState.Stopping,
  RunningTaskState.Restarting,
]);

/**
 * Reports whether a running task is in a live (not yet ended) state.
 *
 * @param task - The instance to inspect.
 * @returns `true` while the process is starting, running, stopping, or restarting.
 */
export function isLive(task: Pick<RunningTask, 'state'>): boolean {
  return LIVE_STATES.has(task.state);
}

/**
 * Computes how long an instance has been (or was) running, in milliseconds.
 *
 * For a live instance this is `now - startedAt`; for an ended instance it is
 * frozen at `endedAt - startedAt`. The result is clamped to be non-negative so a
 * clock skew can never yield a negative duration.
 *
 * @param task - The instance to measure.
 * @param now - The current time as epoch milliseconds (from an
 *   {@link ../types/contracts.IClock}).
 * @returns The elapsed duration in milliseconds, never negative.
 */
export function durationMs(task: Pick<RunningTask, 'startedAt' | 'endedAt'>, now: number): number {
  const end = task.endedAt ?? now;
  return Math.max(0, end - task.startedAt);
}
