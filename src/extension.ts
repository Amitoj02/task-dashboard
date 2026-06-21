/**
 * The composition root for the Task Dashboard extension.
 *
 * `activate()` is the *only* place concrete `vscode`-aware adapters are
 * constructed and the pure core is wired up. It builds the dependency graph in
 * strict order (adapters → core → views → output → commands), registers the two
 * tree views and every command, keeps cached configuration in step with the
 * user's settings, and pushes every disposable onto `context.subscriptions` so
 * teardown is automatic and leak-free.
 *
 * `deactivate()` makes a best-effort, time-bounded attempt to stop all running
 * tasks (sending SIGTERM to each process group) before the host exits, so we do
 * not orphan child processes.
 *
 * @remarks This file — and only this file plus `views/**`, `commands/**`,
 * `webview/**`, and `adapters/**` — may import `vscode`.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';

import { MementoStorage } from './adapters/MementoStorage';
import { NodeProcessSpawner } from './adapters/NodeProcessSpawner';
import { SystemClock } from './adapters/SystemClock';
import { SystemTimers } from './adapters/SystemTimers';
import { FsPathValidator } from './adapters/FsPathValidator';
import { VsCodeUserInteraction } from './adapters/VsCodeUserInteraction';

import { TaskStore } from './task/TaskStore';
import { TaskRunner } from './task/TaskRunner';
import { TaskManager } from './task/TaskManager';

import { TaskTreeProvider } from './views/TaskTreeProvider';
import { RunningTaskTreeProvider } from './views/RunningTaskTreeProvider';
import { OutputProvider, type OutputProviderConfig } from './views/OutputProvider';
import { TaskEditorPanel } from './webview/TaskEditorPanel';

import { registerCommands } from './commands/index';
import type { CommandDeps } from './commands/CommandDeps';

import { CONFIG, CONFIG_DEFAULTS, type TaskDashboardConfig } from './util/config';
import { VIEW_IDS } from './util/commandIds';
import type { TaskDefinition } from './models/TaskDefinition';
import { runningCountBadge, RunningTaskState } from './models/RunningTask';
import type { TaskDefinitionId } from './types/ids';
import { RunningNode } from './views/nodes';

/** Bounded wait for {@link deactivate}'s graceful stop, in milliseconds. */
const DEACTIVATE_STOP_BUDGET_MS = 2000;

/**
 * A minimal, test-only view onto the wired-up core, returned from
 * {@link activate}.
 *
 * VS Code ignores the value `activate` returns unless another extension (or an
 * integration test) explicitly reads it via `extension.activate()` /
 * `extension.exports`. Exposing the already-constructed `store` and `manager`
 * here lets the `@vscode/test-electron` integration suite drive the real core —
 * seeding a definition through the store, launching it through the manager, and
 * observing running instances — without weakening any production behavior. It is
 * purely additive: nothing in production reads this object.
 *
 * @remarks Deliberately narrow. It exposes only the two seams the integration
 * tests need; it does not grant any capability the public command surface lacks.
 */
export interface ExtensionTestApi {
  /** The live task-definition store (CRUD + queries). */
  readonly store: TaskStore;

  /** The live running-state hub (run/stop/restart + reads). */
  readonly manager: TaskManager;
}

/**
 * Module-scoped reference to the live manager so {@link deactivate} can ask it to
 * stop all tasks. Assigned in {@link activate}; cleared on disposal. This is the
 * one unavoidable activation-lifecycle handle (VS Code's `deactivate` takes no
 * context), not shared mutable application state.
 */
let activeManager: TaskManager | undefined;

/**
 * Activates the extension: builds the dependency graph and registers everything.
 *
 * @param context - The extension context supplied by VS Code.
 * @returns A narrow {@link ExtensionTestApi} for integration tests. VS Code
 *   ignores this in normal operation; it does not alter production behavior.
 */
export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  // -- Cached configuration ---------------------------------------------------
  let config = readConfig();

  // -- Adapters (the only concrete host bindings) -----------------------------
  const globalStorage = new MementoStorage(context.globalState);
  const workspaceStorage = new MementoStorage(context.workspaceState);
  const spawner = new NodeProcessSpawner();
  const clock = new SystemClock();
  const timers = new SystemTimers();
  const pathValidator = new FsPathValidator();
  const ui = new VsCodeUserInteraction();

  // -- Pure core --------------------------------------------------------------
  const store = new TaskStore(globalStorage, workspaceStorage, clock);

  const runner = new TaskRunner(spawner, timers, {
    logRetentionBytes: config.logRetentionBytes,
    defaultShell: config.defaultShell,
  });

  const manager = new TaskManager(store, runner, clock, timers, {
    stopGraceMs: config.stopGraceMs,
    maxRestartsPerMinute: config.maxRestartsPerMinute,
    resolveCwd: resolveWorkingDirectory,
    onCrashLoop: (def) => {
      if (config.notifications !== 'none') {
        ui.error(
          `Task Dashboard: "${def.name}" crashed repeatedly and was stopped (crash-loop breaker).`
        );
      }
    },
  });
  activeManager = manager;

  // -- Views & output ---------------------------------------------------------
  const definitionsProvider = new TaskTreeProvider(store);
  const runningProvider = new RunningTaskTreeProvider(manager, clock);
  const outputConfig = (): OutputProviderConfig => ({
    closeTerminalBehavior: config.closeTerminalBehavior,
    // Reuse the per-instance retention budget (bytes) as the replay tail size.
    replayLimit: config.logRetentionBytes,
  });
  const output = new OutputProvider(manager, outputConfig);

  const definitionsView = vscode.window.createTreeView(VIEW_IDS.definitions, {
    treeDataProvider: definitionsProvider,
    dragAndDropController: definitionsProvider,
    // Allow multi-row selection so a whole group of tasks can be dragged at once.
    canSelectMany: true,
    showCollapseAll: false,
  });
  const runningView = vscode.window.createTreeView(VIEW_IDS.running, {
    treeDataProvider: runningProvider,
    showCollapseAll: false,
  });

  // Selecting a running node reveals its terminal output (no focus steal).
  const runningSelectionSub = runningView.onDidChangeSelection((e) => {
    const node = e.selection[0];
    if (node instanceof RunningNode) {
      output.reveal(node.task.instanceId);
    }
  });

  // -- Activity-bar running-count badge --------------------------------------
  // Surface the number of currently-running tasks as a numeric badge on the
  // Task Dashboard activity-bar icon. The badge lives on the "running" view;
  // VS Code aggregates per-view badges onto the container icon. Updated only on
  // events that change the live-instance set — never on the per-second tick.
  const updateRunningBadge = (): void => {
    runningView.badge = runningCountBadge(manager.getInstances());
  };
  updateRunningBadge();
  const runningBadgeSub = vscode.Disposable.from(
    manager.onDidStartInstance(updateRunningBadge),
    manager.onDidUpdateInstance(updateRunningBadge),
    manager.onDidExitInstance(updateRunningBadge),
    manager.onDidRemoveInstance(updateRunningBadge)
  );

  // -- Task lifecycle notifications -------------------------------------------
  // Honour the `notifications` setting on task exit: surface a toast when a task
  // fails (the default `errorsOnly`, and `all`) and, only under `all`, when one
  // finishes cleanly; `none` stays silent. Auto-restart failures are summarized
  // by the crash-loop breaker (onCrashLoop above), so they are not toasted per
  // crash here, avoiding a flood during a crash loop.
  const lifecycleNotificationSub = manager.onDidExitInstance((exit) => {
    if (config.notifications === 'none') {
      return;
    }
    const instance = manager.getInstance(exit.instanceId);
    if (!instance) {
      return;
    }
    if (instance.state === RunningTaskState.Failed) {
      const autoRestartActive =
        (store.get(instance.definitionId)?.autoRestart ?? false) &&
        config.maxRestartsPerMinute > 0;
      if (autoRestartActive) {
        return;
      }
      const detail = exit.signal
        ? ` (signal ${exit.signal})`
        : typeof exit.exitCode === 'number'
          ? ` (exit code ${exit.exitCode})`
          : '';
      ui.error(`Task Dashboard: "${instance.name}" failed${detail}.`);
    } else if (config.notifications === 'all' && instance.state === RunningTaskState.Exited) {
      ui.info(`Task Dashboard: "${instance.name}" finished.`);
    }
  });

  // -- Command dependency bundle ---------------------------------------------
  const deps: CommandDeps = {
    store,
    manager,
    ui,
    pathValidator,
    output,
    definitionsProvider,
    runningProvider,
    getConfig: () => config,
    defaultWorkingDirectory: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    openEditor: (mode, definitionId) => {
      const existing =
        mode === 'edit' && definitionId ? store.get(definitionId as TaskDefinitionId) : undefined;
      TaskEditorPanel.show(context, store, pathValidator, mode, existing);
    },
  };

  const commandsDisposable = registerCommands(context, deps);

  // -- Live config reload -----------------------------------------------------
  const configSub = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG.section)) {
      return;
    }
    config = readConfig();
    // Propagate to the long-lived core where it matters going forward.
    runner.setOptions({
      logRetentionBytes: config.logRetentionBytes,
      defaultShell: config.defaultShell,
    });
    manager.setOptions({
      stopGraceMs: config.stopGraceMs,
      maxRestartsPerMinute: config.maxRestartsPerMinute,
    });
  });

  // -- Disposal (order: views/output first, then core, then store) ------------
  context.subscriptions.push(
    definitionsView,
    runningView,
    runningSelectionSub,
    runningBadgeSub,
    lifecycleNotificationSub,
    configSub,
    commandsDisposable,
    output,
    // The manager disposes the runner (and SIGTERMs children) in its own dispose.
    { dispose: () => manager.dispose() },
    definitionsProvider,
    runningProvider,
    store,
    { dispose: () => (activeManager = undefined) }
  );

  // Test-only handle (ignored by VS Code in production). See {@link ExtensionTestApi}.
  return { store, manager };
}

/**
 * Deactivates the extension, making a bounded best-effort to stop all running
 * tasks so their process groups receive SIGTERM before the host exits.
 *
 * @returns A promise that resolves once stops are initiated or the budget
 *   elapses, whichever comes first.
 */
export async function deactivate(): Promise<void> {
  const manager = activeManager;
  if (!manager) {
    return;
  }
  // Race the stop against a short budget so we never block host shutdown.
  await Promise.race([manager.stopAll(), delay(DEACTIVATE_STOP_BUDGET_MS)]);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Reads the extension's configuration into a fully-resolved
 * {@link TaskDashboardConfig}, falling back to {@link CONFIG_DEFAULTS} for any
 * missing or malformed value.
 *
 * @returns The current configuration snapshot.
 */
function readConfig(): TaskDashboardConfig {
  const c = vscode.workspace.getConfiguration(CONFIG.section);
  const num = (key: string, fallback: number): number => {
    const v = c.get<number>(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const v = c.get<string>(key);
    return typeof v === 'string' ? v : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = c.get<boolean>(key);
    return typeof v === 'boolean' ? v : fallback;
  };

  const closeTerminalBehavior = str(
    CONFIG.keys.closeTerminalBehavior,
    CONFIG_DEFAULTS.closeTerminalBehavior
  );
  const notifications = str(CONFIG.keys.notifications, CONFIG_DEFAULTS.notifications);

  return {
    // Enforce the manifest minimum: VS Code's `minimum` is advisory for the
    // settings UI only, so a hand-edited settings.json (or the config API) can
    // supply 0 — which would otherwise wipe the in-memory retention/replay tail.
    logRetentionBytes: Math.max(
      4096,
      num(CONFIG.keys.logRetentionBytes, CONFIG_DEFAULTS.logRetentionBytes)
    ),
    stopGraceMs: num(CONFIG.keys.stopGraceMs, CONFIG_DEFAULTS.stopGraceMs),
    defaultShell: str(CONFIG.keys.defaultShell, CONFIG_DEFAULTS.defaultShell),
    confirmDelete: bool(CONFIG.keys.confirmDelete, CONFIG_DEFAULTS.confirmDelete),
    closeTerminalBehavior:
      closeTerminalBehavior === 'keep' ? 'keep' : CONFIG_DEFAULTS.closeTerminalBehavior,
    maxRestartsPerMinute: num(
      CONFIG.keys.maxRestartsPerMinute,
      CONFIG_DEFAULTS.maxRestartsPerMinute
    ),
    notifications:
      notifications === 'all' || notifications === 'none'
        ? notifications
        : CONFIG_DEFAULTS.notifications,
  };
}

/**
 * Resolves a definition's working directory to an absolute path for spawning.
 *
 * An absolute path is used as-is; a relative path is resolved against the first
 * workspace folder; an empty/undefined value falls back to the first workspace
 * folder (or `undefined`, letting the child inherit the host's cwd).
 *
 * @param def - The definition whose working directory to resolve.
 * @returns The resolved absolute path, or `undefined` to inherit.
 */
function resolveWorkingDirectory(def: TaskDefinition): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const dir = def.workingDirectory?.trim();
  if (!dir) {
    return root;
  }
  if (path.isAbsolute(dir)) {
    return dir;
  }
  return root ? path.resolve(root, dir) : path.resolve(dir);
}

/**
 * Resolves after `ms` milliseconds. Used only to bound the deactivation stop.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
