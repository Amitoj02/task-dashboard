/**
 * Tree data provider for the **Running Tasks** view.
 *
 * Renders the live (and recently-ended) instances owned by an
 * {@link ITaskManager}, newest first, with a status icon and PID; the elapsed
 * duration is shown in the row only once an instance has *ended* (frozen) and,
 * for live instances, in the lazily-resolved hover tooltip.
 *
 * Refreshes are driven purely by structural change events (start/update/exit/
 * remove), debounced into a single update. The view deliberately does **not**
 * re-render rows on the manager's per-second tick: a timed refresh of a live row
 * tears down its open hover and its inline action buttons mid-interaction (see
 * microsoft/vscode#153982), which is why a hover used to vanish and the Stop
 * button needed several clicks while a task was running. Trading the live
 * ticking duration in the row for a stable hover and reliable single-click
 * actions is the intended behavior.
 *
 * @remarks Host-aware view layer. May import `vscode`. Reads running state
 * through the {@link ITaskManager} seam and time through the {@link IClock} seam;
 * never spawns or kills processes itself.
 */

import * as vscode from 'vscode';

import type { IClock, ITaskManager } from '../types/contracts';
import { RunningTaskState, durationMs, type RunningTask } from '../models/RunningTask';
import { COMMAND_IDS } from '../util/commandIds';
import { formatDuration } from '../util/duration';
import { debounce, type Debounced } from '../util/debounce';
import type { IDisposable } from '../util/event';
import { RunningNode } from './nodes';

/** Quiet period (ms) for collapsing bursts of structural changes into one refresh. */
const REFRESH_DEBOUNCE_MS = 50;

/**
 * Per-state presentation: codicon id and an optional theme color.
 *
 * Kept as a static table so {@link RunningTaskTreeProvider.getTreeItem} (called
 * per visible row each tick) does no per-call allocation beyond the `ThemeIcon`.
 */
const STATE_PRESENTATION: Readonly<
  Record<RunningTaskState, { readonly icon: string; readonly color?: string }>
> = {
  [RunningTaskState.Starting]: { icon: 'loading~spin', color: 'charts.yellow' },
  [RunningTaskState.Running]: { icon: 'loading~spin', color: 'charts.green' },
  [RunningTaskState.Stopping]: { icon: 'sync~spin', color: 'charts.orange' },
  [RunningTaskState.Restarting]: { icon: 'loading~spin', color: 'charts.yellow' },
  [RunningTaskState.Exited]: { icon: 'check', color: 'disabledForeground' },
  [RunningTaskState.Failed]: { icon: 'error', color: 'charts.red' },
};

/** Human-readable label for each lifecycle state, shown in the row description. */
const STATE_LABEL: Readonly<Record<RunningTaskState, string>> = {
  [RunningTaskState.Starting]: 'Starting',
  [RunningTaskState.Running]: 'Running',
  [RunningTaskState.Stopping]: 'Stopping',
  [RunningTaskState.Restarting]: 'Restarting',
  [RunningTaskState.Exited]: 'Exited',
  [RunningTaskState.Failed]: 'Failed',
};

/**
 * Provides {@link RunningNode}s for the Running Tasks tree.
 */
export class RunningTaskTreeProvider
  implements vscode.TreeDataProvider<RunningNode>, vscode.Disposable
{
  /** Drives `onDidChangeTreeData`. */
  private readonly changeEmitter = new vscode.EventEmitter<RunningNode | undefined>();

  /** @inheritdoc */
  public readonly onDidChangeTreeData: vscode.Event<RunningNode | undefined> =
    this.changeEmitter.event;

  /** Subscriptions to manager lifecycle/tick events. */
  private readonly subscriptions: IDisposable[] = [];

  /** Debounced structural refresh used for start/update/exit events. */
  private readonly debouncedRefresh: Debounced<[]>;

  /**
   * @param manager - The source of running-task state and lifecycle events.
   * @param clock - Time source used to compute live durations.
   */
  public constructor(
    private readonly manager: ITaskManager,
    private readonly clock: IClock
  ) {
    this.debouncedRefresh = debounce(() => this.changeEmitter.fire(undefined), REFRESH_DEBOUNCE_MS);

    // Structural changes: coalesce into one debounced refresh. The manager's
    // per-second tick is intentionally NOT subscribed here — see the class doc:
    // a timed refresh of a live row dismisses its hover and drops inline-action
    // clicks. Rows therefore update only when their state actually changes.
    this.subscriptions.push(
      this.manager.onDidStartInstance(() => this.debouncedRefresh()),
      this.manager.onDidUpdateInstance(() => this.debouncedRefresh()),
      this.manager.onDidExitInstance(() => this.debouncedRefresh()),
      this.manager.onDidRemoveInstance(() => this.debouncedRefresh())
    );
  }

  /**
   * Forces an immediate full refresh of the tree (used by the manual Refresh
   * command). Cancels any pending debounced refresh first.
   */
  public refresh(): void {
    this.debouncedRefresh.cancel();
    this.changeEmitter.fire(undefined);
  }

  // ---------------------------------------------------------------------------
  // TreeDataProvider
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  public getChildren(element?: RunningNode): RunningNode[] {
    if (element) {
      return [];
    }

    const instances = this.manager.getInstances();

    // Count instances per definition so we only number when there are siblings.
    const perDefinition = new Map<string, number>();
    for (const task of instances) {
      perDefinition.set(task.definitionId, (perDefinition.get(task.definitionId) ?? 0) + 1);
    }

    // Assign a stable 1-based ordinal per definition, in start order.
    const ordinal = new Map<string, number>();
    const numbered = new Map<string, number | undefined>();
    const inStartOrder = [...instances].sort((a, b) => a.startedAt - b.startedAt);
    for (const task of inStartOrder) {
      const total = perDefinition.get(task.definitionId) ?? 1;
      if (total > 1) {
        const n = (ordinal.get(task.definitionId) ?? 0) + 1;
        ordinal.set(task.definitionId, n);
        numbered.set(task.instanceId, n);
      } else {
        numbered.set(task.instanceId, undefined);
      }
    }

    // Display newest first.
    return [...instances]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((task) => new RunningNode(task, numbered.get(task.instanceId)));
  }

  /** @inheritdoc */
  public getTreeItem(node: RunningNode): vscode.TreeItem {
    const task = node.task;
    const label =
      node.instanceNumber !== undefined ? `${task.name} #${node.instanceNumber}` : task.name;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = task.instanceId;
    item.description = this.describe(task);
    // Tooltip is resolved lazily in resolveTreeItem (on hover): building it here
    // on every structural refresh is wasted work, and a lazy tooltip keeps the
    // hover stable.
    item.iconPath = this.icon(task.state);
    item.contextValue = node.contextValue;

    // Selecting a node reveals its terminal output.
    item.command = {
      command: COMMAND_IDS.showOutput,
      title: 'Show Output',
      arguments: [node],
    };

    return item;
  }

  /**
   * Lazily fills in the rich hover tooltip when a row is hovered.
   *
   * VS Code calls this only on hover (and once per {@link vscode.TreeItem}), so
   * the live duration is computed at hover time rather than on a timer — giving
   * an accurate, stable hover without the per-second refresh that would dismiss
   * it.
   *
   * @param item - The tree item produced by {@link getTreeItem}.
   * @param node - The running node being hovered.
   * @returns The same item with its `tooltip` populated.
   *
   * @remarks VS Code also passes a `CancellationToken` as a third argument at
   * runtime; it is omitted from the signature because the tooltip is built
   * synchronously. This still satisfies the optional `resolveTreeItem` contract.
   */
  public resolveTreeItem(item: vscode.TreeItem, node: RunningNode): vscode.TreeItem {
    item.tooltip = this.tooltip(node.task);
    return item;
  }

  /** @inheritdoc */
  public dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
    this.debouncedRefresh.dispose();
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Resolves the themed status icon for a state. */
  private icon(state: RunningTaskState): vscode.ThemeIcon {
    const { icon, color } = STATE_PRESENTATION[state];
    return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
  }

  /**
   * Builds the inline description: status + PID, plus the final (frozen)
   * duration once an instance has ended.
   *
   * A live instance deliberately shows no duration in the row: a ticking value
   * would require a per-second refresh, which dismisses hovers and drops
   * inline-action clicks. The live elapsed time is available in the hover tooltip
   * ({@link resolveTreeItem}) instead.
   */
  private describe(task: RunningTask): string {
    const parts: string[] = [STATE_LABEL[task.state]];
    if (task.pid !== undefined) {
      parts.push(`PID ${task.pid}`);
    }
    if (task.endedAt !== undefined) {
      parts.push(formatDuration(durationMs(task, this.clock.now())));
    }
    return parts.join(' · ');
  }

  /** Builds the rich hover tooltip for a running instance. */
  private tooltip(task: RunningTask): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**${escapeMarkdown(task.name)}**\n`);

    const rows: Array<[string, string]> = [];
    rows.push(['Status', STATE_LABEL[task.state]]);
    if (task.pid !== undefined) {
      rows.push(['PID', String(task.pid)]);
    }
    rows.push(['Started', new Date(task.startedAt).toLocaleString()]);
    rows.push(['Duration', formatDuration(durationMs(task, this.clock.now()))]);
    if (task.endedAt !== undefined) {
      rows.push(['Ended', new Date(task.endedAt).toLocaleString()]);
    }
    if (task.exitCode !== undefined) {
      rows.push(['Exit code', String(task.exitCode)]);
    }
    if (task.signal) {
      rows.push(['Signal', task.signal]);
    }

    for (const [label, value] of rows) {
      md.appendMarkdown(`\n**${label}:** ${escapeMarkdown(value)}  `);
    }

    return md;
  }
}

// Re-exported from the host-free util so existing importers (and tests) can keep
// referencing it from here; the implementation lives in `../util/duration`.
export { formatDuration } from '../util/duration';

/** Escapes the markdown control characters that matter inside tooltip text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, (c) => `\\${c}`);
}
