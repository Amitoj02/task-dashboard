/**
 * Integration: the Task Definitions view and its command layer.
 *
 * Runs inside a real VS Code host. Seeds definitions through the *real* store
 * exposed by the test API, then exercises a freshly-constructed
 * {@link TaskTreeProvider} against that store (the same class production uses) to
 * verify `getChildren`/`getTreeItem`, stable ids, `contextValue`, scope filtering,
 * and search. It also drives the command layer (`refresh`, `runAll`) and asserts
 * those commands never throw.
 *
 * @remarks Environment-gated: requires `@vscode/test-electron` (VS Code download
 * + display). All seeded definitions are removed in `afterEach`.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { activateExtension } from './helpers';
import { COMMAND_IDS } from '../../util/commandIds';
import { TaskTreeProvider } from '../../views/TaskTreeProvider';
import { TaskDefNode } from '../../views/nodes';
import type { ExtensionTestApi } from '../../extension';
import type { TaskDefinition, TaskDefinitionInput } from '../../models/TaskDefinition';

/** A minimal, valid definition input for seeding. */
function sampleInput(overrides: Partial<TaskDefinitionInput> = {}): TaskDefinitionInput {
  return {
    name: 'Sample Task',
    command: 'echo hello',
    workingDirectory: '',
    allowMultipleInstances: false,
    ...overrides,
  };
}

describe('Definitions view', () => {
  let api: ExtensionTestApi;
  const seeded: TaskDefinition[] = [];

  before(async () => {
    api = await activateExtension();
  });

  afterEach(async () => {
    // Remove anything this test seeded so specs stay independent and the user's
    // (test host's) storage is left clean.
    for (const def of seeded.splice(0)) {
      await api.store.delete(def.id);
    }
  });

  it('seeded definitions surface as TaskDefNodes with stable ids and contextValue', async () => {
    const ws = await api.store.add(sampleInput({ name: 'WS Task' }), 'workspace');
    const gl = await api.store.add(sampleInput({ name: 'GL Task' }), 'global');
    seeded.push(ws, gl);

    const provider = new TaskTreeProvider(api.store);
    try {
      const children = provider.getChildren();
      const byName = new Map(children.map((n) => [n.definition.name, n]));

      const wsNode = byName.get('WS Task');
      const glNode = byName.get('GL Task');
      assert.ok(wsNode instanceof TaskDefNode, 'workspace task should be a TaskDefNode');
      assert.ok(glNode instanceof TaskDefNode, 'global task should be a TaskDefNode');

      assert.equal(wsNode.contextValue, 'taskDef.workspace');
      assert.equal(glNode.contextValue, 'taskDef.global');

      // getTreeItem carries a stable id (the definition id) and a run command.
      const wsItem = provider.getTreeItem(wsNode);
      assert.equal(wsItem.id, ws.id, 'TreeItem.id should equal the definition id');
      assert.equal(wsItem.command?.command, COMMAND_IDS.runTask);
      assert.equal(wsItem.contextValue, 'taskDef.workspace');
    } finally {
      provider.dispose();
    }
  });

  it('scope filter narrows the rendered definitions', async () => {
    const ws = await api.store.add(sampleInput({ name: 'Only WS' }), 'workspace');
    const gl = await api.store.add(sampleInput({ name: 'Only GL' }), 'global');
    seeded.push(ws, gl);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      const names = new Set(provider.getChildren().map((n) => n.definition.name));
      assert.ok(names.has('Only WS'), 'workspace task should be shown');
      assert.ok(!names.has('Only GL'), 'global task should be filtered out');
    } finally {
      provider.dispose();
    }
  });

  it('search filters by name and command, case-insensitively', async () => {
    const a = await api.store.add(
      sampleInput({ name: 'Build Frontend', command: 'pnpm build' }),
      'workspace'
    );
    const b = await api.store.add(
      sampleInput({ name: 'Proxy', command: 'pnpm proxy' }),
      'workspace'
    );
    seeded.push(a, b);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setSearch('FRONTEND');
      let names = new Set(provider.getChildren().map((n) => n.definition.name));
      assert.ok(names.has('Build Frontend'));
      assert.ok(!names.has('Proxy'));

      // Match on the command text, too.
      provider.setSearch('proxy');
      names = new Set(provider.getChildren().map((n) => n.definition.name));
      assert.ok(names.has('Proxy'));
      assert.ok(!names.has('Build Frontend'));
    } finally {
      provider.dispose();
    }
  });

  it('toggleSort cycles name-asc -> name-desc -> recent', () => {
    const provider = new TaskTreeProvider(api.store);
    try {
      // Whatever the starting order, cycling three times returns to it.
      const start = provider.getSort();
      const seq = [provider.toggleSort(), provider.toggleSort(), provider.toggleSort()];
      assert.equal(seq[2], start, 'three toggles should return to the starting sort');
      assert.equal(new Set(['name-asc', 'name-desc', 'recent']).size, 3);
    } finally {
      provider.dispose();
    }
  });

  it('refresh and runAll commands execute without throwing', async () => {
    const def = await api.store.add(sampleInput({ name: 'Echo Once' }), 'workspace');
    seeded.push(def);

    await assert.doesNotReject(
      async () => void (await vscode.commands.executeCommand(COMMAND_IDS.refresh))
    );
    // runAll launches real (trivial) processes; clean them up immediately.
    await assert.doesNotReject(
      async () => void (await vscode.commands.executeCommand(COMMAND_IDS.runAll))
    );
    await assert.doesNotReject(
      async () => void (await vscode.commands.executeCommand(COMMAND_IDS.stopAll))
    );
  });
});
