/**
 * Lightweight wrapper node classes for the two tree views.
 *
 * VS Code's {@link vscode.TreeDataProvider} is generic over an element type. We
 * use dedicated wrapper classes — rather than the raw domain objects — so each
 * node can carry the view-specific metadata a `TreeItem` needs (most
 * importantly a `contextValue` that drives `when`-clause menu visibility) while
 * keeping the domain models host-free.
 *
 * The wrappers are intentionally dumb value holders: all `TreeItem`
 * construction lives in the providers so it stays in one place and can be kept
 * cheap (it runs per visible row on every tick).
 *
 * @remarks Host-aware view layer. May import `vscode`.
 */

import type { TaskDefinition, TaskScope } from '../models/TaskDefinition';
import { RunningTaskState, type RunningTask } from '../models/RunningTask';
import type { RunningInstanceId, TaskDefinitionId } from '../types/ids';

/**
 * `contextValue` for a task-definition node, varying by scope.
 *
 * The base `taskDef` value plus the `taskDef.<scope>` variant let `when`-clause
 * menus target all definitions (`viewItem =~ /^taskDef/`) or only global vs
 * workspace ones.
 */
export type TaskDefContextValue = 'taskDef.global' | 'taskDef.workspace';

/**
 * `contextValue` for a running-task node, encoding the lifecycle state.
 *
 * Menus key off the state suffix (e.g. only show "Stop" for
 * `runningTask.running`/`runningTask.stopping`).
 */
export type RunningContextValue = `runningTask.${RunningTaskState}`;

/**
 * A node in the Task Definitions tree, wrapping a {@link TaskDefinition} and the
 * {@link TaskScope} it belongs to.
 */
export class TaskDefNode {
  /**
   * @param definition - The wrapped task definition.
   * @param scope - The scope the definition lives in.
   */
  public constructor(
    public readonly definition: TaskDefinition,
    public readonly scope: TaskScope
  ) {}

  /** The wrapped definition's stable id (used for the `TreeItem.id`). */
  public get id(): TaskDefinitionId {
    return this.definition.id;
  }

  /**
   * The scope-qualified `contextValue` for `when`-clause menus.
   *
   * @returns `'taskDef.global'` or `'taskDef.workspace'`.
   */
  public get contextValue(): TaskDefContextValue {
    return `taskDef.${this.scope}`;
  }
}

/**
 * A node in the Running Tasks tree, wrapping a {@link RunningTask}.
 *
 * Holds an optional 1-based `instanceNumber` so the view can disambiguate
 * concurrent instances of the same definition (e.g. "Dev Server #2").
 */
export class RunningNode {
  /**
   * @param task - The wrapped running instance.
   * @param instanceNumber - 1-based ordinal among concurrent instances of the
   *   same definition, or `undefined` when this is the only instance.
   */
  public constructor(
    public readonly task: RunningTask,
    public readonly instanceNumber?: number
  ) {}

  /** The wrapped instance's stable id (used for the `TreeItem.id`). */
  public get id(): RunningInstanceId {
    return this.task.instanceId;
  }

  /** The instance's current lifecycle state. */
  public get state(): RunningTaskState {
    return this.task.state;
  }

  /**
   * The state-qualified `contextValue` for `when`-clause menus.
   *
   * @returns e.g. `'runningTask.running'`, `'runningTask.failed'`.
   */
  public get contextValue(): RunningContextValue {
    return `runningTask.${this.task.state}`;
  }
}
