/**
 * The "Add Task" and "Quick Add Task" commands.
 *
 * `execute()` opens the rich webview Task Editor in `add` mode. `quickAdd()` is
 * the native fast path: two input boxes (name + command) with the working
 * directory defaulted to the first workspace folder, run through the same pure
 * validation and duplicate checks the editor uses, then persisted via the store.
 *
 * @remarks Host-aware command layer.
 */

import type { CommandDeps } from './CommandDeps';
import type { TaskDefinitionInput, TaskScope } from '../models/TaskDefinition';
import { hasDuplicateName, isValidName } from '../models/TaskDefinition';

/** Implements Add Task (webview) and Quick Add Task (native). */
export class AddTaskCommand {
  /** @param deps - The shared command dependency bundle. */
  public constructor(private readonly deps: CommandDeps) {}

  /**
   * Opens the Task Editor webview in `add` mode.
   */
  public execute(): void {
    this.deps.openEditor('add');
  }

  /**
   * The native Quick Add flow: prompt for name and command, validate, store.
   *
   * Cancelling either prompt aborts silently. The working directory defaults to
   * the first workspace folder; scope defaults to `workspace` (the most common
   * case for project commands).
   */
  public async quickAdd(): Promise<void> {
    const name = await this.deps.ui.prompt({
      prompt: 'Task name',
      placeHolder: 'e.g. Dev Server',
      validate: (value) => {
        if (!isValidName(value)) {
          return 'Name is required.';
        }
        if (hasDuplicateName(value, this.deps.store.getAll())) {
          return 'Another task already uses this name.';
        }
        return undefined;
      },
    });
    if (name === undefined) {
      return;
    }

    const command = await this.deps.ui.prompt({
      prompt: 'Command to run',
      placeHolder: 'e.g. npm run dev',
      validate: (value) => (value.trim().length === 0 ? 'Command is required.' : undefined),
    });
    if (command === undefined) {
      return;
    }

    const scope: TaskScope = 'workspace';
    const input: TaskDefinitionInput = {
      name: name.trim(),
      command: command.trim(),
      allowMultipleInstances: false,
    };

    const cwd = this.deps.defaultWorkingDirectory();
    if (cwd) {
      input.workingDirectory = cwd;
    }

    await this.deps.store.add(input, scope);
    if (this.deps.getConfig().notifications === 'all') {
      this.deps.ui.info(`Added task "${input.name}".`);
    }
  }
}
