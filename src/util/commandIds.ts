/**
 * Centralized, type-safe identifiers for the extension's commands and views.
 *
 * Command and view ids appear in three places that must agree exactly: the
 * `package.json` `contributes` manifest, the `registerCommand` calls, and the
 * `TreeItem.command`/`when`-clause references. Defining them once here removes
 * the stringly-typed drift between those sites.
 *
 * @remarks Plain string constants with no host dependency, so this module is
 * safe to import from the pure core as well as the VS Code layer. It does not
 * import `vscode` or `child_process`.
 */

/**
 * Fully-qualified command ids contributed by the extension.
 *
 * Every value mirrors a `contributes.commands[].command` entry in
 * `package.json`. Keep the two in lockstep.
 */
export const COMMAND_IDS = {
  /** Open the webview Task Editor to create a task. */
  addTask: 'taskDashboard.addTask',
  /** Create a task via the native QuickPick fast path. */
  quickAddTask: 'taskDashboard.quickAddTask',
  /** Open the webview Task Editor for an existing task. */
  editTask: 'taskDashboard.editTask',
  /** Delete a task definition (with optional modal confirm). */
  deleteTask: 'taskDashboard.deleteTask',
  /** Duplicate a task definition within its scope. */
  duplicateTask: 'taskDashboard.duplicateTask',
  /** Launch a new running instance of a task. */
  runTask: 'taskDashboard.runTask',
  /** Gracefully stop a running instance. */
  stopTask: 'taskDashboard.stopTask',
  /** Stop and relaunch a running instance. */
  restartTask: 'taskDashboard.restartTask',
  /** Run every defined task. */
  runAll: 'taskDashboard.runAll',
  /** Stop every running instance. */
  stopAll: 'taskDashboard.stopAll',
  /** Reveal the terminal for a running instance. */
  showOutput: 'taskDashboard.showOutput',
  /** Clear the terminal for a running instance. */
  clearOutput: 'taskDashboard.clearOutput',
  /** Prompt for a search string to filter the definitions tree. */
  searchTasks: 'taskDashboard.searchTasks',
  /** Cycle the definitions tree sort order. */
  toggleSort: 'taskDashboard.toggleSort',
  /** Filter the definitions tree by scope. */
  filterScope: 'taskDashboard.filterScope',
  /** Force a refresh of the trees. */
  refresh: 'taskDashboard.refresh',
} as const;

/** Union of all contributed command ids. */
export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

/**
 * Ids of the contributed tree views.
 *
 * Mirrors `contributes.views.taskDashboard[].id` in `package.json`.
 */
export const VIEW_IDS = {
  /** The Task Definitions tree. */
  definitions: 'taskDashboard.definitions',
  /** The Running Tasks tree. */
  running: 'taskDashboard.running',
} as const;

/** Union of all contributed view ids. */
export type ViewId = (typeof VIEW_IDS)[keyof typeof VIEW_IDS];

/**
 * `when`-clause context keys the extension sets at runtime.
 *
 * These let title-bar/menu items reflect transient UI state (the active sort
 * order and scope filter) without persisting it in the manifest.
 */
export const CONTEXT_KEYS = {
  /** Current definitions sort order (`name-asc` | `name-desc` | `recent`). */
  sortOrder: 'taskDashboard.sortOrder',
  /** Current definitions scope filter (`all` | `global` | `workspace`). */
  scopeFilter: 'taskDashboard.scopeFilter',
  /** Whether a definitions search filter is active. */
  searchActive: 'taskDashboard.searchActive',
} as const;
