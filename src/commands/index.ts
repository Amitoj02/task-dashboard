/**
 * Command registration: the single bridge between `package.json`'s contributed
 * command ids and the thin command classes that implement them.
 *
 * {@link registerCommands} instantiates each command, maps every
 * {@link COMMAND_IDS} entry to its handler, and registers them through
 * `vscode.commands.registerCommand`. Every handler is wrapped so that:
 * - synchronous throws and rejected promises are caught (a command must never
 *   crash the extension host); and
 * - the failure is surfaced via {@link IUserInteraction.error}, subject to the
 *   `notifications` setting (`none` suppresses even errors).
 *
 * @remarks Host-aware command layer. Imports `vscode`.
 */

import * as vscode from 'vscode';

import { COMMAND_IDS } from '../util/commandIds';
import type { CommandDeps } from './CommandDeps';
import { AddTaskCommand } from './AddTaskCommand';
import { EditTaskCommand } from './EditTaskCommand';
import { DeleteTaskCommand } from './DeleteTaskCommand';
import { RunControlCommands } from './RunControlCommands';

/**
 * Registers every contributed command and returns a single {@link vscode.Disposable}
 * that unregisters them all. The same disposable is also pushed onto
 * `context.subscriptions` so disposal happens on deactivation regardless.
 *
 * @param context - The extension context (for `subscriptions`).
 * @param deps - The shared command dependency bundle.
 * @returns A disposable that unregisters all commands registered here.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps
): vscode.Disposable {
  const add = new AddTaskCommand(deps);
  const edit = new EditTaskCommand(deps);
  const del = new DeleteTaskCommand(deps);
  const ctl = new RunControlCommands(deps);

  /** Maps each command id to its raw (possibly async) handler. */
  const handlers: Record<string, (arg?: unknown) => unknown> = {
    [COMMAND_IDS.addTask]: () => add.execute(),
    [COMMAND_IDS.quickAddTask]: () => add.quickAdd(),
    [COMMAND_IDS.editTask]: (arg) => edit.execute(arg),
    [COMMAND_IDS.deleteTask]: (arg) => del.execute(arg),
    [COMMAND_IDS.duplicateTask]: (arg) => ctl.duplicate(arg),
    [COMMAND_IDS.runTask]: (arg) => ctl.run(arg),
    [COMMAND_IDS.stopTask]: (arg) => ctl.stop(arg),
    [COMMAND_IDS.restartTask]: (arg) => ctl.restart(arg),
    [COMMAND_IDS.runAll]: () => ctl.runAll(),
    [COMMAND_IDS.stopAll]: () => ctl.stopAll(),
    [COMMAND_IDS.showOutput]: (arg) => ctl.showOutput(arg),
    [COMMAND_IDS.clearOutput]: (arg) => ctl.clearOutput(arg),
    [COMMAND_IDS.searchTasks]: () => ctl.searchTasks(),
    [COMMAND_IDS.toggleSort]: () => ctl.toggleSort(),
    [COMMAND_IDS.filterScope]: () => ctl.filterScope(),
    [COMMAND_IDS.refresh]: () => ctl.refresh(),
  };

  const registrations: vscode.Disposable[] = [];
  for (const [id, handler] of Object.entries(handlers)) {
    const disposable = vscode.commands.registerCommand(id, (arg?: unknown) =>
      runSafely(deps, id, () => handler(arg))
    );
    registrations.push(disposable);
    context.subscriptions.push(disposable);
  }

  return vscode.Disposable.from(...registrations);
}

/**
 * Invokes a command handler, catching every synchronous throw and async
 * rejection so it can be surfaced as a notification instead of crashing the
 * host.
 *
 * @param deps - Command dependencies (for the UI seam and notification policy).
 * @param id - The command id (for the diagnostic message).
 * @param handler - The handler to run; its result may be a promise.
 */
async function runSafely(deps: CommandDeps, id: string, handler: () => unknown): Promise<void> {
  try {
    await handler();
  } catch (err) {
    // `none` suppresses all notifications, including errors.
    if (deps.getConfig().notifications !== 'none') {
      const message = err instanceof Error ? err.message : String(err);
      deps.ui.error(`Task Dashboard: ${shortCommand(id)} failed — ${message}`);
    }
  }
}

/** Strips the `taskDashboard.` prefix for a tidier error message. */
function shortCommand(id: string): string {
  return id.startsWith('taskDashboard.') ? id.slice('taskDashboard.'.length) : id;
}
