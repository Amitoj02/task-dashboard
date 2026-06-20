/**
 * The "Edit Task" command.
 *
 * Opens the webview Task Editor in `edit` mode for the definition identified by
 * the invoking tree node (or, when invoked without one, the current selection /
 * a quick pick — resolved upstream). The editor receives the existing definition
 * so it can pre-fill every field.
 *
 * @remarks Host-aware command layer.
 */

import type { CommandDeps } from './CommandDeps';
import { resolveDefinitionId } from './resolve';

/** Implements Edit Task. */
export class EditTaskCommand {
  /** @param deps - The shared command dependency bundle. */
  public constructor(private readonly deps: CommandDeps) {}

  /**
   * Opens the Task Editor for an existing definition.
   *
   * @param arg - The invoking tree node (or definition/id). When it cannot be
   *   resolved, the command surfaces a gentle warning rather than failing.
   */
  public execute(arg?: unknown): void {
    const id = resolveDefinitionId(arg);
    if (!id || !this.deps.store.get(id)) {
      this.deps.ui.warn('Select a task to edit.');
      return;
    }
    this.deps.openEditor('edit', id);
  }
}
