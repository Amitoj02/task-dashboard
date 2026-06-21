/**
 * The dependency bundle shared by every command.
 *
 * Commands are deliberately thin: each receives this immutable bundle of seams
 * (and the two view providers it may need to drive) and orchestrates user intent
 * into core calls. Constructing the bundle once in `extension.ts` keeps the
 * command constructors uniform and the wiring in a single place.
 *
 * @remarks Host-aware command layer. May import `vscode` indirectly through the
 * concrete view/provider types it references.
 */

import type {
  ITaskManagerControl,
  ITaskStore,
  IPathValidator,
  IUserInteraction,
} from '../types/contracts';
import type { TaskDashboardConfig } from '../util/config';
import type { OutputProvider } from '../views/OutputProvider';
import type { TaskTreeProvider } from '../views/TaskTreeProvider';
import type { RunningTaskTreeProvider } from '../views/RunningTaskTreeProvider';

/**
 * Everything the command layer needs, injected from the composition root.
 */
export interface CommandDeps {
  /** The definition store (CRUD + queries). */
  readonly store: ITaskStore;

  /** The running-state hub (run/stop/restart + reads). */
  readonly manager: ITaskManagerControl;

  /** User-interaction seam (prompts, confirms, notifications). */
  readonly ui: IUserInteraction;

  /** Working-directory existence checks for the Quick Add fast path. */
  readonly pathValidator: IPathValidator;

  /** Pseudoterminal output provider (reveal/clear). */
  readonly output: OutputProvider;

  /** The definitions tree provider (search/sort/scope UI state). */
  readonly definitionsProvider: TaskTreeProvider;

  /** The running tree provider (refresh). */
  readonly runningProvider: RunningTaskTreeProvider;

  /** Live, current configuration snapshot (re-read on settings changes). */
  getConfig(): TaskDashboardConfig;

  /** Resolves the default working directory for new tasks (first workspace folder), if any. */
  defaultWorkingDirectory(): string | undefined;

  /** Opens the Task Editor webview in add or edit mode. */
  openEditor(mode: 'add' | 'edit', definitionId?: string): void;
}
