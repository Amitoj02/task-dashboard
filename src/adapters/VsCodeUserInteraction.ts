/**
 * {@link IUserInteraction} backed by the `vscode.window` prompt/notification API.
 *
 * Command flows depend on the {@link IUserInteraction} seam so they can be
 * unit-tested with stubbed answers; this adapter is the single production wiring
 * to the real VS Code dialogs. Every call is defended so a host-side rejection
 * (e.g. the window closing mid-prompt) resolves cleanly rather than rejecting
 * into a command handler.
 *
 * @remarks Host-aware adapter. Allowed to import `vscode`. Wired up only in
 * `extension.ts`.
 */

import * as vscode from 'vscode';

import type { IUserInteraction, PickItem, PromptOptions } from '../types/contracts';

/** Implements {@link IUserInteraction} over `vscode.window`. */
export class VsCodeUserInteraction implements IUserInteraction {
  /** @inheritdoc */
  public async prompt(options: PromptOptions): Promise<string | undefined> {
    try {
      return await vscode.window.showInputBox({
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        value: options.value,
        password: options.password ?? false,
        ignoreFocusOut: true,
        validateInput: options.validate ? (value) => options.validate?.(value) ?? null : undefined,
      });
    } catch {
      return undefined;
    }
  }

  /** @inheritdoc */
  public async pick<T>(items: PickItem<T>[], placeHolder?: string): Promise<T | undefined> {
    type Qp = vscode.QuickPickItem & { readonly value: T };
    const quickItems: Qp[] = items.map((it) => ({
      label: it.label,
      description: it.description,
      value: it.value,
    }));
    try {
      const chosen = await vscode.window.showQuickPick(quickItems, {
        placeHolder,
        ignoreFocusOut: true,
        canPickMany: false,
      });
      return chosen?.value;
    } catch {
      return undefined;
    }
  }

  /** @inheritdoc */
  public async confirm(
    message: string,
    confirmLabel: string = 'Yes',
    modal: boolean = false
  ): Promise<boolean> {
    try {
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal },
        { title: confirmLabel }
      );
      return choice?.title === confirmLabel;
    } catch {
      return false;
    }
  }

  /** @inheritdoc */
  public info(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  /** @inheritdoc */
  public warn(message: string): void {
    void vscode.window.showWarningMessage(message);
  }

  /** @inheritdoc */
  public error(message: string): void {
    void vscode.window.showErrorMessage(message);
  }
}
