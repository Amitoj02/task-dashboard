/**
 * The persisted shape of a user-defined task and pure helpers for validating it.
 *
 * A {@link TaskDefinition} is the canonical, serializable record stored in a
 * {@link ../types/contracts.ITaskStorage}. It carries both the user-authored
 * configuration (name, command, …) and lightweight run side-data (history, last
 * exit code/times) so the UI can show "last run" affordances without consulting
 * the process layer.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

import type { TaskDefinitionId } from '../types/ids';

/** Where a task definition lives: shared across all workspaces, or scoped to one. */
export type TaskScope = 'global' | 'workspace';

/**
 * A user-defined task and its persisted run metadata.
 *
 * Treat every field as untrusted input: it originates from user configuration
 * (or restored, possibly hand-edited, storage) and must be validated before use
 * and never evaluated.
 */
export interface TaskDefinition {
  /** Stable unique identifier, assigned on creation. */
  id: TaskDefinitionId;

  /** Human-readable display name. Required, non-empty. */
  name: string;

  /** The shell command line to run. Required, non-empty. */
  command: string;

  /**
   * Directory to run the command in. Empty/undefined means the workspace root
   * (resolved by the host layer, not the core).
   */
  workingDirectory?: string;

  /**
   * When `true`, the task may be launched multiple times concurrently; when
   * `false`, starting it again is a no-op or focuses the existing instance.
   */
  allowMultipleInstances: boolean;

  /** Extra environment variables merged over the inherited environment. */
  environmentVariables?: Record<string, string>;

  /**
   * Shell executable to run the command through. Undefined/empty spawns the
   * program directly (argv parsed, no shell); a value opts into shell execution.
   */
  shell?: string;

  /** When `true`, automatically restart the task if it crashes (guarded by a crash-loop breaker). */
  autoRestart?: boolean;

  /** Delay, in milliseconds, before the process is actually spawned. */
  startupDelayMs?: number;

  /** Optional themed icon id (e.g. a `ThemeIcon` codicon name) shown in the tree. */
  icon?: string;

  // ---- Persisted run side-data (maintained by the store, not the user) ----

  /**
   * Most recent command lines, newest last, capped to a small bound. Powers the
   * Quick Add / edit history affordance.
   */
  commandHistory: string[];

  /** Exit code of the most recent run, if it has ended. */
  lastExitCode?: number;

  /** Epoch-millis timestamp of the most recent start, if ever run. */
  lastStartTime?: number;

  /** Epoch-millis timestamp of the most recent stop, if ever run. */
  lastStopTime?: number;
}

/**
 * The user-editable subset of a {@link TaskDefinition}.
 *
 * This is what an Add/Edit flow produces; the store is responsible for
 * assigning the {@link TaskDefinition.id} and managing run side-data
 * (history, last exit code/times).
 */
export type TaskDefinitionInput = Omit<
  TaskDefinition,
  'id' | 'commandHistory' | 'lastExitCode' | 'lastStartTime' | 'lastStopTime'
>;

/** Maximum number of entries retained in {@link TaskDefinition.commandHistory}. */
export const COMMAND_HISTORY_LIMIT = 50;

/**
 * Reports whether `name` is acceptable as a task name.
 *
 * A valid name is a non-empty string once surrounding whitespace is trimmed.
 *
 * @param name - The candidate name.
 * @returns `true` if the name is non-empty after trimming.
 */
export function isValidName(name: string): boolean {
  return typeof name === 'string' && name.trim().length > 0;
}

/**
 * Reports whether `name` collides (case-insensitively) with an existing
 * definition's name, optionally excluding one definition by id.
 *
 * Use the `excludeId` parameter when validating an edit so a definition does
 * not count as a duplicate of itself.
 *
 * @param name - The candidate name to check.
 * @param existing - The current set of definitions to check against.
 * @param excludeId - A definition id to ignore during the comparison (e.g. the
 *   one being edited).
 * @returns `true` if another definition already uses this name.
 */
export function hasDuplicateName(
  name: string,
  existing: readonly TaskDefinition[],
  excludeId?: TaskDefinitionId
): boolean {
  const target = name.trim().toLowerCase();
  return existing.some((def) => def.id !== excludeId && def.name.trim().toLowerCase() === target);
}
