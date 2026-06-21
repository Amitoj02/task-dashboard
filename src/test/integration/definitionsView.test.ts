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

      // getTreeItem carries a stable id (the definition id) but NO click command:
      // selecting a definition must not run it (running is via the inline play
      // button or the context menu only).
      const wsItem = provider.getTreeItem(wsNode);
      assert.equal(wsItem.id, ws.id, 'TreeItem.id should equal the definition id');
      assert.equal(wsItem.command, undefined, 'selecting a definition must not run it');
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

  it('toggleSort cycles name-asc -> name-desc -> recent -> manual', () => {
    const provider = new TaskTreeProvider(api.store);
    try {
      // Whatever the starting order, cycling all four steps returns to it, and
      // each step is announced via onDidChangeSort.
      const announced: string[] = [];
      const sub = provider.onDidChangeSort((s) => announced.push(s));
      const start = provider.getSort();
      const seq = [
        provider.toggleSort(),
        provider.toggleSort(),
        provider.toggleSort(),
        provider.toggleSort(),
      ];
      sub.dispose();

      assert.equal(seq[3], start, 'four toggles should return to the starting sort');
      assert.deepEqual(new Set(seq), new Set(['name-asc', 'name-desc', 'recent', 'manual']));
      assert.deepEqual(announced, seq, 'every toggle fires onDidChangeSort with the new order');
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

  // The MIME the tree's drag-and-drop controller advertises. VS Code's
  // convention is `application/vnd.code.tree.<lowercased view id>`; the test
  // pins the exact wire format the controller and host must agree on.
  const DND_MIME = 'application/vnd.code.tree.taskdashboard.definitions';

  /** Looks up the rendered node for a definition id in the provider's children. */
  function nodeFor(provider: TaskTreeProvider, id: string): TaskDefNode {
    const node = provider.getChildren().find((n) => n.definition.id === id);
    assert.ok(node, `expected a rendered node for ${id}`);
    return node;
  }

  /** Names of our seeded ids in render order (ignoring any other host state). */
  function orderOf(provider: TaskTreeProvider, ids: string[]): string[] {
    const wanted = new Set(ids);
    return provider
      .getChildren()
      .filter((n) => wanted.has(n.definition.id))
      .map((n) => n.definition.name);
  }

  it('handleDrag stashes the dragged definition ids on the tree MIME', async () => {
    const a = await api.store.add(sampleInput({ name: 'Drag A' }), 'workspace');
    const b = await api.store.add(sampleInput({ name: 'Drag B' }), 'workspace');
    seeded.push(a, b);

    const provider = new TaskTreeProvider(api.store);
    try {
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, a.id), nodeFor(provider, b.id)], transfer);

      const item = transfer.get(DND_MIME);
      assert.ok(item, 'expected the dragged ids on the tree MIME');
      assert.deepEqual(item.value, [a.id, b.id]);
    } finally {
      provider.dispose();
    }
  });

  it('handleDrop reorders the scope and switches the view to manual sort', async () => {
    const a = await api.store.add(sampleInput({ name: 'DnD AAA' }), 'workspace');
    const b = await api.store.add(sampleInput({ name: 'DnD BBB' }), 'workspace');
    const c = await api.store.add(sampleInput({ name: 'DnD CCC' }), 'workspace');
    seeded.push(a, b, c);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      assert.equal(provider.getSort(), 'name-asc', 'starts in a computed sort');

      let announced: string | undefined;
      const sub = provider.onDidChangeSort((s) => (announced = s));

      // Drag CCC and drop it onto AAA -> CCC lands just before AAA.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, c.id)], transfer);
      await provider.handleDrop(nodeFor(provider, a.id), transfer);
      sub.dispose();

      assert.equal(provider.getSort(), 'manual', 'a drop switches the view to manual');
      assert.equal(announced, 'manual', 'the switch is announced via onDidChangeSort');
      assert.deepEqual(orderOf(provider, [a.id, b.id, c.id]), ['DnD CCC', 'DnD AAA', 'DnD BBB']);

      // The arrangement is persisted: a fresh provider in manual sort sees it.
      const reloaded = new TaskTreeProvider(api.store);
      try {
        reloaded.setScopeFilter('workspace');
        while (reloaded.getSort() !== 'manual') {
          reloaded.toggleSort();
        }
        assert.deepEqual(orderOf(reloaded, [a.id, b.id, c.id]), [
          'DnD CCC',
          'DnD AAA',
          'DnD BBB',
        ]);
      } finally {
        reloaded.dispose();
      }
    } finally {
      provider.dispose();
    }
  });

  it('handleDrop past the last row appends the dragged rows to the end of the scope', async () => {
    const a = await api.store.add(sampleInput({ name: 'End AAA' }), 'workspace');
    const b = await api.store.add(sampleInput({ name: 'End BBB' }), 'workspace');
    const c = await api.store.add(sampleInput({ name: 'End CCC' }), 'workspace');
    seeded.push(a, b, c);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      // Drag AAA and drop into the empty area (no target) -> AAA goes last.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, a.id)], transfer);
      await provider.handleDrop(undefined, transfer);

      assert.equal(provider.getSort(), 'manual');
      assert.deepEqual(orderOf(provider, [a.id, b.id, c.id]), ['End BBB', 'End CCC', 'End AAA']);
    } finally {
      provider.dispose();
    }
  });

  it('handleDrop ignores a cross-scope drop (no scope reassignment)', async () => {
    const g = await api.store.add(sampleInput({ name: 'Cross Global' }), 'global');
    const w = await api.store.add(sampleInput({ name: 'Cross Workspace' }), 'workspace');
    seeded.push(g, w);

    const provider = new TaskTreeProvider(api.store);
    try {
      // Drag the global task onto the workspace task: different scopes, so the
      // drop is a no-op for ordering and never moves the task between scopes.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, g.id)], transfer);
      await provider.handleDrop(nodeFor(provider, w.id), transfer);

      assert.equal(api.store.getScope(g.id), 'global', 'global task stays global');
      assert.equal(api.store.getScope(w.id), 'workspace', 'workspace task stays workspace');
    } finally {
      provider.dispose();
    }
  });

  it('handleDrop moves a multi-row selection, preserving the dragged order', async () => {
    const a = await api.store.add(sampleInput({ name: 'Multi AAA' }), 'workspace');
    const b = await api.store.add(sampleInput({ name: 'Multi BBB' }), 'workspace');
    const c = await api.store.add(sampleInput({ name: 'Multi CCC' }), 'workspace');
    const d = await api.store.add(sampleInput({ name: 'Multi DDD' }), 'workspace');
    seeded.push(a, b, c, d);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      // Drag DDD then BBB (selection order) and drop them before AAA.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, d.id), nodeFor(provider, b.id)], transfer);
      await provider.handleDrop(nodeFor(provider, a.id), transfer);

      // Both land before AAA in the dragged order; CCC keeps its place.
      assert.deepEqual(orderOf(provider, [a.id, b.id, c.id, d.id]), [
        'Multi DDD',
        'Multi BBB',
        'Multi AAA',
        'Multi CCC',
      ]);
    } finally {
      provider.dispose();
    }
  });

  it('handleDrop seeds the manual order from the displayed sort, not the stored one', async () => {
    // Insertion order BBB, AAA, CCC.
    const b = await api.store.add(sampleInput({ name: 'Seed BBB' }), 'workspace');
    const a = await api.store.add(sampleInput({ name: 'Seed AAA' }), 'workspace');
    const c = await api.store.add(sampleInput({ name: 'Seed CCC' }), 'workspace');
    seeded.push(b, a, c);

    // Pre-establish a manual order that differs from name-asc.
    await api.store.reorder('workspace', [b.id, a.id, c.id]);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      assert.equal(provider.getSort(), 'name-asc', 'displayed order is name-asc: AAA, BBB, CCC');

      // Drop CCC onto AAA while viewing name-asc.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, c.id)], transfer);
      await provider.handleDrop(nodeFor(provider, a.id), transfer);

      // Seeded from the displayed name-asc order [AAA, BBB, CCC] -> CCC before
      // AAA -> [CCC, AAA, BBB]. Had it (wrongly) seeded from the stored manual
      // order [BBB, AAA, CCC], the result would be [CCC, BBB, AAA].
      assert.deepEqual(orderOf(provider, [a.id, b.id, c.id]), [
        'Seed CCC',
        'Seed AAA',
        'Seed BBB',
      ]);
    } finally {
      provider.dispose();
    }
  });

  it('a no-op drop (onto itself) does not switch the view out of its sort', async () => {
    const a = await api.store.add(sampleInput({ name: 'Noop AAA' }), 'workspace');
    const b = await api.store.add(sampleInput({ name: 'Noop BBB' }), 'workspace');
    seeded.push(a, b);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setScopeFilter('workspace');
      assert.equal(provider.getSort(), 'name-asc');
      let announced = false;
      const sub = provider.onDidChangeSort(() => (announced = true));

      // Drop AAA onto AAA: order is unchanged, so the sort must not switch.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, a.id)], transfer);
      await provider.handleDrop(nodeFor(provider, a.id), transfer);
      sub.dispose();

      assert.equal(provider.getSort(), 'name-asc', 'a no-op drop keeps the current sort');
      assert.equal(announced, false, 'a no-op drop fires no sort change');
    } finally {
      provider.dispose();
    }
  });

  it('empty-area drop targets the dragged row’s scope, even with all scopes shown and a search active', async () => {
    // Global "Zeta" sorts last alphabetically; anchoring an empty-area drop to
    // the last visible row would mis-resolve to global and silently no-op.
    const g = await api.store.add(
      sampleInput({ name: 'Zeta Global', command: 'match-me' }),
      'global'
    );
    const w1 = await api.store.add(
      sampleInput({ name: 'Alpha WS', command: 'match-me' }),
      'workspace'
    );
    const w2 = await api.store.add(
      sampleInput({ name: 'Beta WS', command: 'match-me' }),
      'workspace'
    );
    seeded.push(g, w1, w2);

    const provider = new TaskTreeProvider(api.store);
    try {
      provider.setSearch('match-me');
      assert.equal(provider.getScopeFilter(), 'all');

      // Drag the workspace row Alpha WS and drop into the empty area.
      const transfer = new vscode.DataTransfer();
      provider.handleDrag([nodeFor(provider, w1.id)], transfer);
      await provider.handleDrop(undefined, transfer);

      // The drop reordered the workspace scope (moving Alpha WS to the end) and
      // switched to manual - not a silent no-op against the global scope.
      assert.equal(provider.getSort(), 'manual');
      assert.deepEqual(orderOf(provider, [w1.id, w2.id]), ['Beta WS', 'Alpha WS']);
    } finally {
      provider.dispose();
    }
  });
});
