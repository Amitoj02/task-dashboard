/**
 * {@link ITaskStorage} backed by a VS Code {@link vscode.Memento}.
 *
 * Two instances are constructed in `extension.ts` — one over `globalState`, one
 * over `workspaceState` — giving the {@link ../task/TaskStore} its global-vs-
 * workspace partitioning with no files written into the user's repository.
 *
 * @remarks Host-aware adapter. Allowed to import `vscode`.
 */

import type * as vscode from 'vscode';

import type { ITaskStorage } from '../types/contracts';

/** Implements {@link ITaskStorage} over a `vscode.Memento`. */
export class MementoStorage implements ITaskStorage {
  /**
   * @param memento - The backing memento (`context.globalState` or
   *   `context.workspaceState`).
   */
  public constructor(private readonly memento: vscode.Memento) {}

  /** @inheritdoc */
  public get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }

  /** @inheritdoc */
  public async update(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
  }
}
