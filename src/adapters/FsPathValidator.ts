/**
 * Filesystem-backed {@link IPathValidator}.
 *
 * Wraps `fs/promises` so the host layer can confirm a task's working directory
 * exists and is a directory, while the pure core stays free of `fs`. Relative
 * paths are resolved against the first workspace folder (when present) so users
 * can store portable, workspace-relative working directories.
 *
 * Every method is failure-safe: any I/O error (permission denied, broken
 * symlink, ENOENT, …) resolves to `false`. Nothing here can reject, so callers
 * never need a try/catch around a validation probe.
 *
 * @remarks Host-aware adapter. Allowed to import `vscode` and `fs`.
 */

import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { IPathValidator } from '../types/contracts';

/** Implements {@link IPathValidator} over the real filesystem. */
export class FsPathValidator implements IPathValidator {
  /** @inheritdoc */
  public async exists(p: string): Promise<boolean> {
    return (await this.statOf(p)) !== undefined;
  }

  /** @inheritdoc */
  public async isDirectory(p: string): Promise<boolean> {
    const info = await this.statOf(p);
    return info?.isDirectory() ?? false;
  }

  /**
   * Resolves `p` to an absolute path, relative to the first workspace folder
   * when `p` is not already absolute (and a folder is open).
   */
  private resolve(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.resolve(root, p) : path.resolve(p);
  }

  /**
   * Stats the resolved path, returning `undefined` on any error so callers get a
   * clean boolean answer instead of a rejected promise.
   */
  private async statOf(p: string): Promise<import('node:fs').Stats | undefined> {
    if (typeof p !== 'string' || p.trim().length === 0) {
      return undefined;
    }
    try {
      return await stat(this.resolve(p));
    } catch {
      return undefined;
    }
  }
}
