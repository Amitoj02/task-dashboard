/**
 * Shared helpers for the `@vscode/test-electron` integration suite.
 *
 * These run *inside* a real VS Code extension-development host, so they may
 * import `vscode`. They centralize the few fiddly bits every spec needs:
 * locating and activating the extension under test, reading its test-only API,
 * polling for an asynchronous condition without flaking, and building a
 * cross-platform "long-running" command.
 *
 * @remarks Host-aware test code. These specs require downloading a VS Code build
 * and a display/headless renderer, so the integration suite is environment-gated
 * (it will not run in a bare CI container without `@vscode/test-electron`'s
 * download step and an `xvfb`/headless display).
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import type { ExtensionTestApi } from '../../extension';

/**
 * The published extension id, i.e. `<publisher>.<name>` from `package.json`
 * (`task-dashboard` + `task-dashboard`). Used to look the extension up in the
 * host's registry.
 */
export const EXTENSION_ID = 'task-dashboard.task-dashboard';

/**
 * Activates the extension under test and returns its {@link ExtensionTestApi}.
 *
 * Idempotent: VS Code caches activation, so repeated calls return the same wired
 * core. Asserts the extension is present and that activation yielded the
 * narrow test API (a regression guard for the `activate()` return contract).
 *
 * @returns The live `store`/`manager` handle the specs drive.
 */
export async function activateExtension(): Promise<ExtensionTestApi> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(extension, `Extension "${EXTENSION_ID}" should be installed in the test host`);

  const api = await extension.activate();
  assert.ok(extension.isActive, 'Extension should report active after activate()');
  assert.ok(api, 'activate() should return the ExtensionTestApi handle for tests');
  assert.ok(typeof api.store === 'object', 'Test API should expose the store');
  assert.ok(typeof api.manager === 'object', 'Test API should expose the manager');
  return api;
}

/**
 * Builds a trivial, cross-platform long-running command line.
 *
 * Uses the host's own Node binary (`process.execPath`) running an inline script
 * that idles forever, so the command is portable across Windows/macOS/Linux and
 * needs no shell, no PATH lookup, and no extra files. Spawned directly (no shell)
 * by the runner, it stays alive until killed — perfect for exercising the
 * spawn → running → stop lifecycle.
 *
 * @returns A command string of the form `"<node>" -e "setInterval(...)"`.
 */
export function longRunningCommand(): string {
  // Quote the executable path (it can contain spaces) so the shlex splitter in
  // the runner keeps it as a single argv element; the inline script is also
  // quoted as one element.
  return `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
}

/**
 * Polls `predicate` until it returns `true` or the timeout elapses.
 *
 * Integration timing is inherently slow and racy (real OS processes, a real
 * renderer); polling with a generous deadline is far more robust than fixed
 * sleeps.
 *
 * @param predicate - Condition to await; may be sync or async.
 * @param options - Optional `timeoutMs` (default 15000) and `intervalMs`
 *   (default 100) and a `description` used in the failure message.
 * @returns A promise that resolves once the predicate holds.
 * @throws If the predicate never holds within `timeoutMs`.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<void> {
  const { timeoutMs = 15000, intervalMs = 100, description = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await delay(intervalMs);
  }
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
