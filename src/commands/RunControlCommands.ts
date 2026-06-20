/**
 * The run/lifecycle and view-control commands, grouped into one cohesive class.
 *
 * Covers: run / stop / restart / duplicate a single task, run-all / stop-all,
 * show / clear output, and the definitions-view controls (search, sort cycle,
 * scope filter, refresh). Each method orchestrates the relevant seam(s) and keeps
 * the corresponding `when`-clause context keys in sync where applicable.
 *
 * @remarks Host-aware command layer.
 */

import type { CommandDeps } from './CommandDeps';
import { resolveDefinitionId, resolveInstanceId } from './resolve';
import type { ScopeFilter } from '../views/TaskTreeProvider';
import { CONTEXT_KEYS } from '../util/commandIds';

/** Human-readable labels for each sort order, shown after toggling. */
const SORT_LABELS: Record<string, string> = {
  'name-asc': 'Name (A→Z)',
  'name-desc': 'Name (Z→A)',
  recent: 'Most recent',
};

/** Implements the run-control and view-control command surface. */
export class RunControlCommands {
  /** @param deps - The shared command dependency bundle. */
  public constructor(private readonly deps: CommandDeps) {}

  // ---------------------------------------------------------------------------
  // Single-task lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Runs a task (a new instance, or focuses the existing one when concurrency is
   * disallowed). Reveals its output terminal.
   *
   * @param arg - The invoking definition node (or id).
   */
  public async run(arg?: unknown): Promise<void> {
    const id = resolveDefinitionId(arg);
    if (!id) {
      this.deps.ui.warn('Select a task to run.');
      return;
    }
    const task = await this.deps.manager.run(id);
    if (task) {
      this.deps.output.reveal(task.instanceId);
    }
  }

  /**
   * Stops a running instance.
   *
   * @param arg - The invoking running node (or instance id).
   */
  public async stop(arg?: unknown): Promise<void> {
    const instanceId = resolveInstanceId(arg);
    if (!instanceId) {
      this.deps.ui.warn('Select a running task to stop.');
      return;
    }
    await this.deps.manager.stop(instanceId);
  }

  /**
   * Restarts a running (or ended) instance and reveals the fresh terminal.
   *
   * @param arg - The invoking running node (or instance id).
   */
  public async restart(arg?: unknown): Promise<void> {
    const instanceId = resolveInstanceId(arg);
    if (!instanceId) {
      this.deps.ui.warn('Select a task to restart.');
      return;
    }
    const task = await this.deps.manager.restart(instanceId);
    if (task) {
      this.deps.output.reveal(task.instanceId);
    }
  }

  /**
   * Duplicates a definition within its scope.
   *
   * @param arg - The invoking definition node (or id).
   */
  public async duplicate(arg?: unknown): Promise<void> {
    const id = resolveDefinitionId(arg);
    if (!id) {
      this.deps.ui.warn('Select a task to duplicate.');
      return;
    }
    const copy = await this.deps.store.duplicate(id);
    if (copy && this.deps.getConfig().notifications === 'all') {
      this.deps.ui.info(`Duplicated as "${copy.name}".`);
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk lifecycle
  // ---------------------------------------------------------------------------

  /** Runs one instance of every definition not already running. */
  public async runAll(): Promise<void> {
    if (this.deps.store.getAll().length === 0) {
      this.deps.ui.warn('No tasks to run.');
      return;
    }
    await this.deps.manager.runAll();
  }

  /** Stops every live instance. */
  public async stopAll(): Promise<void> {
    await this.deps.manager.stopAll();
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  /**
   * Reveals the terminal for a running instance.
   *
   * @param arg - The invoking running node (or instance id).
   */
  public showOutput(arg?: unknown): void {
    const instanceId = resolveInstanceId(arg);
    if (!instanceId) {
      return;
    }
    this.deps.output.reveal(instanceId);
  }

  /**
   * Clears the terminal for a running instance (or the active one).
   *
   * @param arg - The invoking running node (or instance id), if any.
   */
  public clearOutput(arg?: unknown): void {
    const instanceId = resolveInstanceId(arg);
    this.deps.output.clear(instanceId);
  }

  // ---------------------------------------------------------------------------
  // Definitions view controls
  // ---------------------------------------------------------------------------

  /** Prompts for a search string and applies it to the definitions tree. */
  public async searchTasks(): Promise<void> {
    const search = await this.deps.ui.prompt({
      prompt: 'Filter tasks',
      placeHolder: 'Type to filter by name or command (empty clears)',
    });
    if (search === undefined) {
      return; // cancelled — leave the current filter as-is
    }
    const trimmed = search.trim();
    this.deps.definitionsProvider.setSearch(trimmed);
    this.deps.setContext(CONTEXT_KEYS.searchActive, trimmed.length > 0);
  }

  /** Cycles the definitions sort order and updates the context key. */
  public toggleSort(): void {
    const next = this.deps.definitionsProvider.toggleSort();
    this.deps.setContext(CONTEXT_KEYS.sortOrder, next);
    if (this.deps.getConfig().notifications === 'all') {
      this.deps.ui.info(`Sorting by ${SORT_LABELS[next] ?? next}.`);
    }
  }

  /** Quick-picks a scope filter (all / global / workspace) and applies it. */
  public async filterScope(): Promise<void> {
    const choice = await this.deps.ui.pick<ScopeFilter>(
      [
        { label: 'All tasks', value: 'all' },
        { label: 'Global tasks', description: 'Shared across all projects', value: 'global' },
        { label: 'Workspace tasks', description: 'This project only', value: 'workspace' },
      ],
      'Filter tasks by scope'
    );
    if (choice === undefined) {
      return;
    }
    this.deps.definitionsProvider.setScopeFilter(choice);
    this.deps.setContext(CONTEXT_KEYS.scopeFilter, choice);
  }

  /** Forces a refresh of both trees. */
  public refresh(): void {
    this.deps.definitionsProvider.refresh();
    this.deps.runningProvider.refresh();
  }
}
