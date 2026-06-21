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
import { debounce, type Debounced } from '../util/debounce';
import type { IDisposable } from '../util/event';
import { TaskDefNode } from './nodes';

/** The cyclic sort orders the view rotates through. Alias of the store's {@link TaskSort}. */
export type SortOrder = TaskSort;

/** Scope filter applied to the definitions list. `'all'` shows both scopes. */
export type ScopeFilter = TaskScope | 'all';

/** Order the {@link TaskTreeProvider.toggleSort} action cycles through. */
const SORT_CYCLE: readonly SortOrder[] = ['name-asc', 'name-desc', 'recent'];

/** Quiet period (ms) for collapsing bursts of store changes into one refresh. */
const REFRESH_DEBOUNCE_MS = 50;

/** Max characters of a command shown inline in the tree description before truncation. */
const COMMAND_DESCRIPTION_MAX = 60;

/** Default tree icon when a definition specifies no custom one. */
const DEFAULT_ICON = new vscode.ThemeIcon('checklist');

/**
 * Provides {@link TaskDefNode}s for the Task Definitions tree and the UI state
 * that filters/orders them.
 */
export class TaskTreeProvider implements vscode.TreeDataProvider<TaskDefNode>, vscode.Disposable {
  /** Drives `onDidChangeTreeData`; fired (debounced) on store changes and UI-state changes. */
  private readonly changeEmitter = new vscode.EventEmitter<TaskDefNode | undefined>();

  /** @inheritdoc */
  public readonly onDidChangeTreeData: vscode.Event<TaskDefNode | undefined> =
    this.changeEmitter.event;

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
   * Cycles the sort order `name-asc → name-desc → recent → name-asc` and
   * refreshes immediately.
   *
   * @returns The newly selected sort order.
   */
  public toggleSort(): SortOrder {
    const next = (SORT_CYCLE.indexOf(this.sort) + 1) % SORT_CYCLE.length;
    this.sort = SORT_CYCLE[next];
    this.refreshNow();
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
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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
