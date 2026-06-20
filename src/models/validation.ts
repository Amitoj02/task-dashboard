/**
 * Pure, host-free validation of {@link TaskDefinitionInput}.
 *
 * The webview Task Editor is purely presentational: every rule that decides
 * whether a task may be saved runs here (and in the extension host that calls
 * this), never in the untrusted webview. The webview only *displays* the
 * {@link FieldErrors} this module produces.
 *
 * These helpers are synchronous and depend on nothing outside the value being
 * validated. Checks that require I/O (does the working directory exist?) or the
 * full definition set (is the name a duplicate?) live in the host layer, which
 * merges their results into the same {@link FieldErrors} shape.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

import { isValidName, type TaskDefinitionInput } from './TaskDefinition';

/**
 * The set of form fields that can carry a validation error.
 *
 * Mirrors the editable fields rendered by the Task Editor so the webview can map
 * each error straight onto its input.
 */
export type TaskField =
  | 'name'
  | 'command'
  | 'workingDirectory'
  | 'environmentVariables'
  | 'startupDelayMs';

/**
 * Field-keyed validation messages.
 *
 * A field is present only when it has an error; an empty object means "valid".
 * The same shape is produced by the pure {@link validateInput} and by the
 * host's async checks, so the two can be merged with a simple spread.
 */
export type FieldErrors = Partial<Record<TaskField, string>>;

/**
 * The largest accepted {@link TaskDefinitionInput.startupDelayMs}.
 *
 * Caps the spawn delay at one hour so a hand-edited or fat-fingered value cannot
 * wedge a task in the "Starting" state effectively forever.
 */
export const MAX_STARTUP_DELAY_MS = 60 * 60 * 1000;

/** Matches a POSIX-style environment variable name (letters, digits, underscore; no leading digit). */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates the self-contained, synchronous rules of a task input.
 *
 * Covers everything decidable from the input alone:
 * - `name` is required (non-empty after trimming).
 * - `command` is required (non-empty after trimming).
 * - `startupDelayMs`, when present, is a finite, non-negative integer no larger
 *   than {@link MAX_STARTUP_DELAY_MS}.
 * - `environmentVariables` keys are non-empty and well-formed.
 *
 * It intentionally does *not* check working-directory existence (I/O) or
 * duplicate names (needs the full store); the host merges those in.
 *
 * @param input - The candidate task input, treated as untrusted.
 * @returns A {@link FieldErrors} map; empty when every synchronous rule passes.
 */
export function validateInput(input: TaskDefinitionInput): FieldErrors {
  const errors: FieldErrors = {};

  if (!isValidName(input.name)) {
    errors.name = 'Name is required.';
  }

  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    errors.command = 'Command is required.';
  }

  const delay = input.startupDelayMs;
  if (delay !== undefined) {
    if (!Number.isFinite(delay) || !Number.isInteger(delay) || delay < 0) {
      errors.startupDelayMs = 'Startup delay must be a whole number of milliseconds (0 or more).';
    } else if (delay > MAX_STARTUP_DELAY_MS) {
      errors.startupDelayMs = `Startup delay must be at most ${MAX_STARTUP_DELAY_MS} ms (1 hour).`;
    }
  }

  const envError = validateEnvironmentVariables(input.environmentVariables);
  if (envError) {
    errors.environmentVariables = envError;
  }

  return errors;
}

/**
 * Reports whether a {@link FieldErrors} map contains any error.
 *
 * @param errors - The map to inspect.
 * @returns `true` if at least one field carries an error.
 */
export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Validates the keys of an environment-variable map.
 *
 * Returns the first problem found (so the form can surface one clear message),
 * or `undefined` when every key is acceptable. An absent map is valid.
 */
function validateEnvironmentVariables(env: Record<string, string> | undefined): string | undefined {
  if (!env) {
    return undefined;
  }
  for (const key of Object.keys(env)) {
    if (key.trim().length === 0) {
      return 'Environment variable names cannot be empty.';
    }
    if (!ENV_KEY_PATTERN.test(key)) {
      return `Invalid environment variable name "${key}": use letters, digits, and underscores (not starting with a digit).`;
    }
  }
  return undefined;
}
