/**
 * The "Delete Task" command.
 *
 * Flow: resolve the target definition → (if any of its instances are still live)
 * warn and offer to stop them first → (if `confirmDelete`) a native modal
 * confirm → delete from the store. Every step is cancellable and respects the
 * `notifications` setting for success feedback.
 *
 * @remarks Host-aware command layer.
 */

import type { CommandDeps } from './CommandDeps';
import { resolveDefinitionId } from './resolve';
import { isLive } from '../models/RunningTask';

/** Implements Delete Task. */
export class DeleteTaskCommand {
  /** @param deps - The shared command dependency bundle. */
  public constructor(private readonly deps: CommandDeps) {}

  /**
   * Deletes a definition after the appropriate confirmations.
   *
   * @param arg - The invoking tree node (or definition/id).
   */
  public async execute(arg?: unknown): Promise<void> {
    const id = resolveDefinitionId(arg);
    const def = id ? this.deps.store.get(id) : undefined;
    if (!id || !def) {
      this.deps.ui.warn('Select a task to delete.');
      return;
    }

    // If instances are still running, warn and offer to stop them first.
    const liveInstances = this.deps.manager
      .getInstances()
      .filter((t) => t.definitionId === id && isLive(t));

    if (liveInstances.length > 0) {
      const stopFirst = await this.deps.ui.confirm(
        `"${def.name}" has ${liveInstances.length} running instance(s). Stop them and delete the task?`,
        'Stop & Delete',
        true
      );
      if (!stopFirst) {
        return;
      }
      for (const instance of liveInstances) {
        await this.deps.manager.stop(instance.instanceId);
      }
    } else if (this.deps.getConfig().confirmDelete) {
      const confirmed = await this.deps.ui.confirm(
        `Delete task "${def.name}"? This cannot be undone.`,
        'Delete',
        true
      );
      if (!confirmed) {
        return;
      }
    }

    await this.deps.store.delete(id);

    if (this.deps.getConfig().notifications === 'all') {
      this.deps.ui.info(`Deleted task "${def.name}".`);
    }
  }
}
