/**
 * Tree data provider for the **Task Definitions** view.
 *
 * Renders the persisted {@link TaskDefinition}s from an {@link ITaskStore} and
 * owns the view's transient UI state — the search string, sort order, and scope
 * filter — exposing setters that the corresponding commands drive. Definition
 * changes in the store are reflected automatically via a debounced refresh.
 *
 * @remarks Host-aware view layer. May import `vscode`. Reads the store through
 * the {@link ITaskStore} seam; never touches the process layer.
 */

import * as vscode from 'vscode';

import type { ITaskStore, TaskSort } from '../types/contracts';
import type { TaskDefinition, TaskScope } from '../models/TaskDefinition';
import type { TaskDefinitionId } from '../types/ids';
import { debounce, type Debounced } from '../util/debounce';
import type { IDisposable } from '../util/event';
import { reorderIds } from '../util/reorder';
import { TaskDefNode } from './nodes';

/** The cyclic sort orders the view rotates through. Alias of the store's {@link TaskSort}. */
export type SortOrder = TaskSort;

/** Scope filter applied to the definitions list. `'all'` shows both scopes. */
export type ScopeFilter = TaskScope | 'all';

/** Order the {@link TaskTreeProvider.toggleSort} action cycles through. */
const SORT_CYCLE: readonly SortOrder[] = ['name-asc', 'name-desc', 'recent', 'manual'];

/**
 * The drag-and-drop MIME carrying dragged definition ids within the Definitions
 * tree. VS Code's convention is `application/vnd.code.tree.<lowercased view id>`;
 * matching it keeps the transfer scoped to this one tree.
 */
const DEFINITIONS_DND_MIME = 'application/vnd.code.tree.taskdashboard.definitions';

/** Quiet period (ms) for collapsing bursts of store changes into one refresh. */
const REFRESH_DEBOUNCE_MS = 50;

/** Max characters of a command shown inline in the tree description before truncation. */
const COMMAND_DESCRIPTION_MAX = 60;

/** Default tree icon when a definition specifies no custom one. */
const DEFAULT_ICON = new vscode.ThemeIcon('checklist');

/**
 * Provides {@link TaskDefNode}s for the Task Definitions tree and the UI state
 * that filters/orders them.
 *
 * Also acts as the view's drag-and-drop controller: dragging a row (or several)
 * and dropping it persists a per-scope `manual` order through the store and
 * switches the view into `manual` sort so the new arrangement is shown.
 */
export class TaskTreeProvider
  implements
    vscode.TreeDataProvider<TaskDefNode>,
    vscode.TreeDragAndDropController<TaskDefNode>,
    vscode.Disposable
{
  /** Drives `onDidChangeTreeData`; fired (debounced) on store changes and UI-state changes. */
  private readonly changeEmitter = new vscode.EventEmitter<TaskDefNode | undefined>();

  /** @inheritdoc */
  public readonly onDidChangeTreeData: vscode.Event<TaskDefNode | undefined> =
    this.changeEmitter.event;

  /** Announces sort-order changes so the host can keep its `when`-clause context key in step. */
  private readonly sortChangeEmitter = new vscode.EventEmitter<SortOrder>();

  /** Fires whenever the sort order changes (via the toggle action or a drag-and-drop reorder). */
  public readonly onDidChangeSort: vscode.Event<SortOrder> = this.sortChangeEmitter.event;

  /** MIME types this controller can accept on drop. */
  public readonly dropMimeTypes: readonly string[] = [DEFINITIONS_DND_MIME];

  /** MIME types this controller produces on drag. */
  public readonly dragMimeTypes: readonly string[] = [DEFINITIONS_DND_MIME];

  /** Current case-insensitive search needle (matched against name + command). */
  private search = '';

  /** Current sort order. */
  private sort: SortOrder = 'name-asc';

  /** Current scope filter. */
  private scopeFilter: ScopeFilter = 'all';

  /** Subscription to the store's change event. */
  private readonly storeSub: IDisposable;

  /** Debounced structural refresh used for store changes. */
  private readonly debouncedRefresh: Debounced<[]>;

  /**
   * @param store - The source of task definitions and change notifications.
   */
  public constructor(private readonly store: ITaskStore) {
    this.debouncedRefresh = debounce(() => this.changeEmitter.fire(undefined), REFRESH_DEBOUNCE_MS);
    this.storeSub = this.store.onDidChangeDefinitions(() => this.debouncedRefresh());
  }

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  /** @returns The current sort order. */
  public getSort(): SortOrder {
    return this.sort;
  }

  /** @returns The current scope filter. */
  public getScopeFilter(): ScopeFilter {
    return this.scopeFilter;
  }

  /**
   * Sets the search needle and refreshes immediately.
   *
   * @param search - The new search string (empty clears the filter).
   */
  public setSearch(search: string): void {
    this.search = search;
    this.refreshNow();
  }

  /**
   * Cycles the sort order `name-asc → name-desc → recent → manual → name-asc`
   * and refreshes immediately.
   *
   * @returns The newly selected sort order.
   */
  public toggleSort(): SortOrder {
    const next = (SORT_CYCLE.indexOf(this.sort) + 1) % SORT_CYCLE.length;
    this.setSortInternal(SORT_CYCLE[next]);
    return this.sort;
  }

  /**
   * Sets the scope filter and refreshes immediately.
   *
   * @param scope - The scope to show, or `'all'` for both.
   */
  public setScopeFilter(scope: ScopeFilter): void {
    this.scopeFilter = scope;
    this.refreshNow();
  }

  /**
   * Forces an immediate full refresh of the tree (used by the manual Refresh
   * command). Cancels any pending debounced refresh first.
   */
  public refresh(): void {
    this.refreshNow();
  }

  // ---------------------------------------------------------------------------
  // TreeDataProvider
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  public getChildren(element?: TaskDefNode): TaskDefNode[] {
    // A flat list: only the root has children.
    if (element) {
      return [];
    }
    const defs = this.store.query({
      search: this.search.trim() || undefined,
      sort: this.sort,
      scope: this.scopeFilter === 'all' ? undefined : this.scopeFilter,
    });
    return defs.map((def) => new TaskDefNode(def, this.store.getScope(def.id) ?? 'workspace'));
  }

  /** @inheritdoc */
  public getTreeItem(node: TaskDefNode): vscode.TreeItem {
    const def = node.definition;
    const item = new vscode.TreeItem(def.name, vscode.TreeItemCollapsibleState.None);

    // Stable id so selection/focus survive per-refresh rebuilds.
    item.id = def.id;
    item.description = this.describe(def);
    item.tooltip = this.tooltip(def, node.scope);
    item.iconPath = def.icon ? new vscode.ThemeIcon(def.icon) : DEFAULT_ICON;
    item.contextValue = node.contextValue;
    item.resourceUri = undefined;

    // Intentionally no `item.command`: selecting a definition must not run it.
    // Running is an explicit gesture via the inline Run (play) button or the
    // context menu, so a stray click or Enter can't launch a task by accident.

    return item;
  }

  /** @inheritdoc */
  public dispose(): void {
    this.storeSub.dispose();
    this.debouncedRefresh.dispose();
    this.changeEmitter.dispose();
    this.sortChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // TreeDragAndDropController
  // ---------------------------------------------------------------------------

  /**
   * Stashes the dragged definitions' ids on the transfer so {@link handleDrop}
   * can reorder them. Dragging is allowed in any sort mode; a successful drop
   * switches the view to `manual`.
   *
   * @param source - The rows being dragged.
   * @param dataTransfer - The drag payload to populate.
   */
  public handleDrag(source: readonly TaskDefNode[], dataTransfer: vscode.DataTransfer): void {
    const ids = source.map((node) => node.definition.id);
    dataTransfer.set(DEFINITIONS_DND_MIME, new vscode.DataTransferItem(ids));
  }

  /**
   * Applies a drop: computes the affected scope's new order (dragged rows moved
   * to just before the drop target, or to the end when dropped past the last
   * row), persists it, and switches the view to `manual` so the result is shown.
   *
   * Reordering is within a single scope: manual order is persisted per scope and
   * a drag never reassigns a task's scope. Dragged rows from a scope other than
   * the drop's are therefore ignored; only rows sharing that scope are rearranged.
   *
   * @param target - The row the payload was dropped onto, or `undefined` for the
   *   empty area past the last row.
   * @param dataTransfer - The drag payload populated by {@link handleDrag}.
   */
  public async handleDrop(
    target: TaskDefNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const transferItem = dataTransfer.get(DEFINITIONS_DND_MIME);
    if (!transferItem) {
      return;
    }
    const value: unknown = transferItem.value;
    const draggedIds = (Array.isArray(value) ? value : []).filter(
      (v): v is TaskDefinitionId => typeof v === 'string'
    );
    if (draggedIds.length === 0) {
      return;
    }

    const scope = this.dropScope(target, draggedIds);
    if (!scope) {
      return;
    }

    // Only rows already in the drop scope participate (no cross-scope move).
    const moving = draggedIds.filter((id) => this.store.getScope(id) === scope);
    if (moving.length === 0) {
      return;
    }

    // Seed from the order the user is currently looking at (the active sort,
    // unfiltered so it spans the whole scope), then relocate the dragged rows.
    // When the active sort is computed (e.g. name-asc) this captures that order
    // as the starting manual arrangement before the move.
    const base = this.store.query({ sort: this.sort, scope }).map((def) => def.id);
    const beforeId =
      target && this.store.getScope(target.definition.id) === scope
        ? target.definition.id
        : undefined;
    const next = reorderIds(base, moving, beforeId);

    // A drop that rearranges nothing (onto itself, or just before the row that
    // already follows it) must not seed a manual order or flip the view out of
    // the active sort — that would silently abandon the chosen sort with no
    // visible movement to explain it.
    if (sameOrder(base, next)) {
      return;
    }

    await this.store.reorder(scope, next);
    this.setSortInternal('manual');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Determines which scope a drop rearranges.
   *
   * A drop onto a row uses that row's scope. A drop past the last row anchors to
   * the dragged rows' own scope (it moves them to the end of their scope). That
   * is independent of the active sort and search filter — unlike anchoring to the
   * last visible row, whose scope shifts as filtering/interleaving changes the
   * view — so an empty-area drop is always deterministic.
   *
   * @param target - The dropped-onto row, or `undefined` for the empty area.
   * @param draggedIds - The ids being dragged (used to anchor an empty-area drop).
   */
  private dropScope(
    target: TaskDefNode | undefined,
    draggedIds: readonly TaskDefinitionId[]
  ): TaskScope | undefined {
    if (target) {
      return this.store.getScope(target.definition.id);
    }
    for (const id of draggedIds) {
      const scope = this.store.getScope(id);
      if (scope) {
        return scope;
      }
    }
    return undefined;
  }

  /**
   * Sets the sort order, announcing the change (only when it actually changes)
   * and refreshing immediately.
   */
  private setSortInternal(sort: SortOrder): void {
    if (this.sort !== sort) {
      this.sort = sort;
      this.sortChangeEmitter.fire(sort);
    }
    this.refreshNow();
  }

  /** Cancels any pending debounced refresh and fires one synchronously. */
  private refreshNow(): void {
    this.debouncedRefresh.cancel();
    this.changeEmitter.fire(undefined);
  }

  /**
   * Builds the inline description: a truncated command, a working-directory
   * hint, and an `∞` marker for definitions that allow multiple instances.
   */
  private describe(def: TaskDefinition): string {
    const parts: string[] = [truncate(def.command, COMMAND_DESCRIPTION_MAX)];
    if (def.workingDirectory && def.workingDirectory.trim().length > 0) {
      parts.push(`in ${def.workingDirectory}`);
    }
    if (def.allowMultipleInstances) {
      parts.push('∞');
    }
    return parts.join('  ');
  }

  /** Builds the rich hover tooltip for a definition. */
  private tooltip(def: TaskDefinition, scope: TaskScope): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**${escapeMarkdown(def.name)}**\n\n`);
    md.appendMarkdown('```\n');
    md.appendText(def.command);
    md.appendMarkdown('\n```\n');

    const rows: Array<[string, string]> = [];
    rows.push(['Scope', scope]);
    if (def.workingDirectory && def.workingDirectory.trim().length > 0) {
      rows.push(['Working dir', def.workingDirectory]);
    }
    if (def.shell && def.shell.trim().length > 0) {
      rows.push(['Shell', def.shell]);
    }
    rows.push(['Multiple instances', def.allowMultipleInstances ? 'allowed' : 'no']);
    if (def.autoRestart) {
      rows.push(['Auto-restart', 'on']);
    }
    if (def.lastExitCode !== undefined) {
      rows.push(['Last exit code', String(def.lastExitCode)]);
    }
    if (def.lastStartTime !== undefined) {
      rows.push(['Last start', new Date(def.lastStartTime).toLocaleString()]);
    }
    if (def.lastStopTime !== undefined) {
      rows.push(['Last stop', new Date(def.lastStopTime).toLocaleString()]);
    }

    for (const [label, value] of rows) {
      md.appendMarkdown(`\n**${label}:** ${escapeMarkdown(value)}  `);
    }

    return md;
  }
}

/** Reports whether two id sequences are element-for-element identical. */
function sameOrder(a: readonly TaskDefinitionId[], b: readonly TaskDefinitionId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Truncates `text` to at most `max` characters, appending an ellipsis when cut.
 *
 * @param text - The text to truncate.
 * @param max - The maximum length of the result (excluding the ellipsis).
 * @returns The original text, or a truncated copy ending in `…`.
 */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Escapes the markdown control characters that matter inside tooltip text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, (c) => `\\${c}`);
}
