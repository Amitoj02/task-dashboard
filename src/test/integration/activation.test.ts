/**
 * Integration: extension activation and command registration.
 *
 * Runs inside a real VS Code extension-development host (so it imports `vscode`).
 * Verifies that the extension activates, that activation exposes the test API,
 * and that *every* contributed command id is actually registered with the host.
 * This is the cheapest, highest-signal smoke test: a typo between `package.json`,
 * `COMMAND_IDS`, and the `registerCommand` calls is caught immediately.
 *
 * @remarks Environment-gated: requires downloading a VS Code build and a
 * display/headless renderer via `@vscode/test-electron`.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { activateExtension, EXTENSION_ID } from './helpers';
import { COMMAND_IDS, VIEW_IDS } from '../../util/commandIds';

describe('Activation', () => {
  it('the extension is present and activates with a test API', async () => {
    const api = await activateExtension();
    assert.ok(api.store, 'store should be exposed');
    assert.ok(api.manager, 'manager should be exposed');
  });

  it('every contributed command id is registered', async () => {
    await activateExtension();

    // `true` includes built-in commands; we filter to ours.
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = Object.values(COMMAND_IDS).filter((id) => !registered.has(id));
    assert.deepEqual(
      missing,
      [],
      `All Task Dashboard commands should be registered; missing: ${missing.join(', ')}`
    );
  });

  it('package.json command contributions match COMMAND_IDS exactly', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed');

    const contributed = extractContributedCommandIds(extension.packageJSON);
    const declared = new Set<string>(Object.values(COMMAND_IDS));

    // Every COMMAND_IDS entry must be contributed in the manifest...
    for (const id of declared) {
      assert.ok(
        contributed.has(id),
        `Command "${id}" is in COMMAND_IDS but missing from package.json contributes.commands`
      );
    }
    // ...and every contributed command must be a known COMMAND_IDS value.
    for (const id of contributed) {
      assert.ok(
        declared.has(id),
        `Command "${id}" is contributed in package.json but absent from COMMAND_IDS`
      );
    }
  });

  it('both tree views are contributed under the activity-bar container', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed');

    const manifest = extension.packageJSON as {
      contributes?: { views?: { taskDashboard?: Array<{ id: string }> } };
    };
    const views = manifest.contributes?.views?.taskDashboard;
    assert.ok(Array.isArray(views), 'taskDashboard views should be an array');
    const viewIds = new Set(views.map((v) => v.id));
    assert.ok(viewIds.has(VIEW_IDS.definitions), 'definitions view should be contributed');
    assert.ok(viewIds.has(VIEW_IDS.running), 'running view should be contributed');
  });

  it('view-control commands execute without throwing on an empty workspace', async () => {
    await activateExtension();

    // These are safe to invoke with no selection/args; they must never throw
    // into the host (the command wrapper swallows handler errors, but refresh
    // in particular touches both providers directly).
    await assert.doesNotReject(
      async () => void (await vscode.commands.executeCommand(COMMAND_IDS.refresh)),
      'refresh should not throw'
    );
    await assert.doesNotReject(
      async () => void (await vscode.commands.executeCommand(COMMAND_IDS.toggleSort)),
      'toggleSort should not throw'
    );
  });
});

/**
 * Extracts the set of contributed command ids from a parsed `package.json`.
 *
 * @param packageJSON - The extension's manifest object.
 * @returns A set of every `contributes.commands[].command` id.
 */
function extractContributedCommandIds(packageJSON: unknown): Set<string> {
  const ids = new Set<string>();
  const commands = (packageJSON as { contributes?: { commands?: Array<{ command?: unknown }> } })
    ?.contributes?.commands;
  if (Array.isArray(commands)) {
    for (const entry of commands) {
      if (typeof entry.command === 'string') {
        ids.add(entry.command);
      }
    }
  }
  return ids;
}
