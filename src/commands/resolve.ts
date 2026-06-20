/**
 * Helpers for extracting domain ids from a command's invoking argument.
 *
 * A command can be triggered from a tree node (where the argument is a
 * {@link TaskDefNode}/{@link RunningNode}), from an inline/title action, or — for
 * a few — from the Command Palette with no argument at all. These helpers
 * normalize those cases into the id the command actually needs, falling back to
 * the current view selection when no argument is supplied.
 *
 * @remarks Host-aware command layer.
 */

import type { TaskDefinitionId, RunningInstanceId } from '../types/ids';
import { TaskDefNode, RunningNode } from '../views/nodes';

/**
 * Resolves a {@link TaskDefinitionId} from a command argument.
 *
 * Accepts a {@link TaskDefNode}, a raw definition object carrying an `id`, or a
 * bare id string.
 *
 * @param arg - The invoking argument.
 * @returns The definition id, or `undefined` if none could be resolved.
 */
export function resolveDefinitionId(arg: unknown): TaskDefinitionId | undefined {
  if (arg instanceof TaskDefNode) {
    return arg.definition.id;
  }
  if (typeof arg === 'string') {
    return arg as TaskDefinitionId;
  }
  if (arg && typeof arg === 'object') {
    const maybe = arg as { id?: unknown; definition?: { id?: unknown } };
    if (typeof maybe.id === 'string') {
      return maybe.id as TaskDefinitionId;
    }
    if (maybe.definition && typeof maybe.definition.id === 'string') {
      return maybe.definition.id as TaskDefinitionId;
    }
  }
  return undefined;
}

/**
 * Resolves a {@link RunningInstanceId} from a command argument.
 *
 * Accepts a {@link RunningNode}, a raw running-task object carrying an
 * `instanceId`, or a bare id string.
 *
 * @param arg - The invoking argument.
 * @returns The instance id, or `undefined` if none could be resolved.
 */
export function resolveInstanceId(arg: unknown): RunningInstanceId | undefined {
  if (arg instanceof RunningNode) {
    return arg.task.instanceId;
  }
  if (typeof arg === 'string') {
    return arg as RunningInstanceId;
  }
  if (arg && typeof arg === 'object') {
    const maybe = arg as { instanceId?: unknown; task?: { instanceId?: unknown } };
    if (typeof maybe.instanceId === 'string') {
      return maybe.instanceId as RunningInstanceId;
    }
    if (maybe.task && typeof maybe.task.instanceId === 'string') {
      return maybe.task.instanceId as RunningInstanceId;
    }
  }
  return undefined;
}
