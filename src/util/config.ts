/**
 * Centralized configuration schema, keys, and defaults for the extension.
 *
 * The settings declared in `package.json`'s `contributes.configuration` are
 * mirrored here once so the strongly-typed read path in `extension.ts` cannot
 * drift from the manifest. Defining the section name, each key, and the default
 * values in a single place keeps the host's `readConfig()` helper honest.
 *
 * @remarks Host-free: plain string/number constants with no `vscode` dependency,
 * so the pure core may reference the resolved {@link TaskDashboardConfig} shape
 * even though only the host reads the live values.
 */

/** The configuration section root, matching `package.json` property prefixes. */
export const CONFIG = {
  /** The `contributes.configuration` section prefix. */
  section: 'taskDashboard',

  /** Individual setting keys (relative to {@link CONFIG.section}). */
  keys: {
    /** Per-instance in-memory output tail size, in bytes. */
    logRetentionBytes: 'logRetentionBytes',
    /** Milliseconds between SIGTERM and the SIGKILL escalation. */
    stopGraceMs: 'stopGraceMs',
    /** Shell executable used when a task opts into shell execution without naming one. */
    defaultShell: 'defaultShell',
    /** Whether deleting a task asks for confirmation. */
    confirmDelete: 'confirmDelete',
    /** What happens to a live task when its terminal is closed. */
    closeTerminalBehavior: 'closeTerminalBehavior',
    /** Crash-loop breaker threshold within a one-minute window. */
    maxRestartsPerMinute: 'maxRestartsPerMinute',
    /** Which notifications the extension surfaces. */
    notifications: 'notifications',
  },
} as const;

/** How a closed terminal affects its still-running task. */
export type CloseTerminalBehavior = 'stop' | 'keep';

/** Which task notifications the extension surfaces. */
export type NotificationLevel = 'errorsOnly' | 'all' | 'none';

/**
 * The fully-resolved configuration the extension runs against.
 *
 * Produced by the host's `readConfig()` from `vscode.workspace.getConfiguration`
 * with {@link CONFIG_DEFAULTS} as the fallback, then handed (as plain values)
 * into the core constructors so the core never reads settings itself.
 */
export interface TaskDashboardConfig {
  /** Per-instance in-memory output tail size, in bytes. */
  logRetentionBytes: number;
  /** Milliseconds between SIGTERM and the SIGKILL escalation. */
  stopGraceMs: number;
  /** Shell executable used when a task opts into shell execution without naming one. */
  defaultShell: string;
  /** Whether deleting a task asks for confirmation. */
  confirmDelete: boolean;
  /** What happens to a live task when its terminal is closed. */
  closeTerminalBehavior: CloseTerminalBehavior;
  /** Crash-loop breaker threshold within a one-minute window. */
  maxRestartsPerMinute: number;
  /** Which notifications the extension surfaces. */
  notifications: NotificationLevel;
}

/**
 * Default configuration values, matching the manifest's declared defaults.
 *
 * Used as the fallback in `readConfig()` so a missing or malformed setting can
 * never leave a field `undefined`.
 */
export const CONFIG_DEFAULTS: TaskDashboardConfig = {
  logRetentionBytes: 262144,
  stopGraceMs: 5000,
  defaultShell: '',
  confirmDelete: true,
  closeTerminalBehavior: 'stop',
  maxRestartsPerMinute: 5,
  notifications: 'errorsOnly',
};
