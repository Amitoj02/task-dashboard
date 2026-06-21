/**
 * Unit tests for {@link TaskStore}: definition CRUD, duplication, persistence
 * across a fresh store over the same storage, global-vs-workspace partitioning,
 * query (search/sort/scope), and the run/stop side-data (history cap, timestamps,
 * exit code).
 *
 * Everything runs against {@link FakeMementoStorage} (two instances, one per
 * scope) and a {@link FakeClock}, so timestamps and persistence are exact.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { TaskStore } from '../../task/TaskStore';
import { COMMAND_HISTORY_LIMIT, type TaskDefinitionInput } from '../../models/TaskDefinition';
import { STORAGE_KEYS } from '../../types/contracts';
import { FakeMementoStorage } from './fakes/FakeMementoStorage';
import { FakeClock } from './fakes/FakeClock';

/** Builds a minimal valid input, overridable per field. */
function input(overrides: Partial<TaskDefinitionInput> = {}): TaskDefinitionInput {
  return {
    name: 'Build',
    command: 'npm run build',
    allowMultipleInstances: false,
    ...overrides,
  };
}

/** A small harness bundling a store with its backing fakes. */
function makeStore(start = 1000) {
  const globalStorage = new FakeMementoStorage();
  const workspaceStorage = new FakeMementoStorage();
  const clock = new FakeClock(start);
  const store = new TaskStore(globalStorage, workspaceStorage, clock);
  return { store, globalStorage, workspaceStorage, clock };
}

describe('TaskStore CRUD', () => {
  it('add() assigns an id, seeds history with the command, and is retrievable', async () => {
    const { store } = makeStore();
    const def = await store.add(input({ name: 'A', command: 'cmd-a' }), 'workspace');

    assert.ok(def.id, 'expected an assigned id');
    assert.deepEqual(def.commandHistory, ['cmd-a']);
    assert.equal(store.get(def.id)?.name, 'A');
    assert.equal(store.getScope(def.id), 'workspace');
    assert.equal(store.getAll().length, 1);
  });

  it('update() merges a patch and keeps the id stable', async () => {
    const { store } = makeStore();
    const def = await store.add(input({ name: 'A' }), 'global');

    const updated = await store.update(def.id, { name: 'A2', command: 'new-cmd' });
    assert.ok(updated);
    assert.equal(updated?.id, def.id);
    assert.equal(updated?.name, 'A2');
    assert.equal(updated?.command, 'new-cmd');
    assert.equal(store.get(def.id)?.name, 'A2');
  });

  it('update() of an unknown id resolves undefined and changes nothing', async () => {
    const { store } = makeStore();
    const result = await store.update('nope' as never, { name: 'x' });
    assert.equal(result, undefined);
  });

  it('delete() removes the definition and its scope mapping', async () => {
    const { store } = makeStore();
    const def = await store.add(input(), 'workspace');
    await store.delete(def.id);

    assert.equal(store.get(def.id), undefined);
    assert.equal(store.getScope(def.id), undefined);
    assert.equal(store.getAll().length, 0);
  });

  it('duplicate() copies fields, assigns a new id, a unique name, and clears run data', async () => {
    const { store } = makeStore();
    const original = await store.add(input({ name: 'Build', command: 'make' }), 'workspace');
    // Give the original some run side-data to prove the copy drops it.
    await store.recordRun(original.id);
    await store.recordStop(original.id, 0);

    const copy = await store.duplicate(original.id);
    assert.ok(copy);
    assert.notEqual(copy?.id, original.id);
    assert.equal(copy?.name, 'Build (copy)');
    assert.equal(copy?.command, 'make');
    assert.equal(store.getScope(copy.id), 'workspace');
    assert.deepEqual(copy?.commandHistory, ['make']);
    assert.equal(copy?.lastExitCode, undefined);
    assert.equal(copy?.lastStartTime, undefined);
    assert.equal(copy?.lastStopTime, undefined);
  });

  it('duplicate() bumps a numeric suffix when "(copy)" is taken', async () => {
    const { store } = makeStore();
    const original = await store.add(input({ name: 'Build' }), 'workspace');
    const copy1 = await store.duplicate(original.id);
    const copy2 = await store.duplicate(original.id);

    assert.equal(copy1?.name, 'Build (copy)');
    assert.equal(copy2?.name, 'Build (copy) (2)');
  });

  it('duplicate() of an unknown id resolves undefined', async () => {
    const { store } = makeStore();
    assert.equal(await store.duplicate('nope' as never), undefined);
  });

  it('fires onDidChangeDefinitions on every mutation', async () => {
    const { store } = makeStore();
    let count = 0;
    const sub = store.onDidChangeDefinitions(() => count++);

    const def = await store.add(input(), 'workspace'); // 1
    await store.update(def.id, { name: 'X' }); // 2
    await store.duplicate(def.id); // 3
    await store.recordRun(def.id); // 4
    await store.recordStop(def.id, 1); // 5
    await store.delete(def.id); // 6

    assert.equal(count, 6);
    sub.dispose();
  });
});

describe('TaskStore persistence across a NEW store over the SAME storage', () => {
  it('reloads definitions, scopes, and side-data from storage', async () => {
    const globalStorage = new FakeMementoStorage();
    const workspaceStorage = new FakeMementoStorage();
    const clock = new FakeClock(5000);

    const store1 = new TaskStore(globalStorage, workspaceStorage, clock);
    const g = await store1.add(input({ name: 'Global' }), 'global');
    const w = await store1.add(input({ name: 'Workspace' }), 'workspace');
    await store1.recordRun(w.id);
    store1.dispose();

    // A brand-new store over the SAME storage must see the same definitions.
    const store2 = new TaskStore(globalStorage, workspaceStorage, clock);
    assert.equal(store2.getAll().length, 2);
    assert.equal(store2.get(g.id)?.name, 'Global');
    assert.equal(store2.getScope(g.id), 'global');
    assert.equal(store2.get(w.id)?.name, 'Workspace');
    assert.equal(store2.getScope(w.id), 'workspace');
    assert.equal(store2.get(w.id)?.lastStartTime, 5000);
  });

  it('does not share live object references between stores (true persistence)', async () => {
    const globalStorage = new FakeMementoStorage();
    const workspaceStorage = new FakeMementoStorage();
    const clock = new FakeClock();

    const store1 = new TaskStore(globalStorage, workspaceStorage, clock);
    const def = await store1.add(input({ name: 'A' }), 'workspace');

    const store2 = new TaskStore(globalStorage, workspaceStorage, clock);
    // Mutating store1's copy must not leak into store2's reload.
    await store1.update(def.id, { name: 'CHANGED-IN-1' });
    assert.equal(store2.get(def.id)?.name, 'A');
  });

  it('survives corrupt/missing persisted data without throwing', () => {
    const globalStorage = new FakeMementoStorage({
      [STORAGE_KEYS.definitions]: 'not-an-array',
    });
    const workspaceStorage = new FakeMementoStorage({
      [STORAGE_KEYS.definitions]: [{ junk: true }, null, { id: 'x', name: 'ok', command: 'c' }],
    });
    const clock = new FakeClock();

    const store = new TaskStore(globalStorage, workspaceStorage, clock);
    // The corrupt global array is dropped; only the well-formed workspace entry loads.
    assert.equal(store.getAll().length, 1);
    assert.equal(store.getAll()[0].name, 'ok');
    assert.equal(store.getAll()[0].allowMultipleInstances, false);
    assert.deepEqual(store.getAll()[0].commandHistory, []);
  });
});

describe('TaskStore global-vs-workspace partitioning', () => {
  it('persists each scope to its own storage only', async () => {
    const { store, globalStorage, workspaceStorage } = makeStore();
    await store.add(input({ name: 'G' }), 'global');
    await store.add(input({ name: 'W' }), 'workspace');

    const g = globalStorage.get<unknown[]>(STORAGE_KEYS.definitions) ?? [];
    const w = workspaceStorage.get<unknown[]>(STORAGE_KEYS.definitions) ?? [];
    assert.equal(g.length, 1);
    assert.equal(w.length, 1);
    assert.equal((g[0] as { name: string }).name, 'G');
    assert.equal((w[0] as { name: string }).name, 'W');
  });

  it('deleting from one scope leaves the other scope untouched', async () => {
    const { store, globalStorage } = makeStore();
    const g = await store.add(input({ name: 'G' }), 'global');
    await store.add(input({ name: 'W' }), 'workspace');

    await store.delete(g.id);
    assert.equal((globalStorage.get<unknown[]>(STORAGE_KEYS.definitions) ?? []).length, 0);
    assert.equal(store.getAll().length, 1);
    assert.equal(store.getAll()[0].name, 'W');
  });
});

describe('TaskStore query (search / sort / scope)', () => {
  /** Seeds a store with a known set, stamping distinct start times for "recent". */
  async function seeded() {
    const h = makeStore();
    const beta = await h.store.add(input({ name: 'Beta', command: 'run beta' }), 'global');
    const alpha = await h.store.add(input({ name: 'Alpha', command: 'run alpha' }), 'workspace');
    const gamma = await h.store.add(input({ name: 'Gamma', command: 'lint' }), 'workspace');

    // Distinct last-start times: gamma newest, then beta, then alpha.
    h.clock.set(100);
    await h.store.recordRun(alpha.id);
    h.clock.set(200);
    await h.store.recordRun(beta.id);
    h.clock.set(300);
    await h.store.recordRun(gamma.id);
    return { ...h, alpha, beta, gamma };
  }

  it('defaults to name-asc ordering', async () => {
    const { store } = await seeded();
    assert.deepEqual(
      store.query({}).map((d) => d.name),
      ['Alpha', 'Beta', 'Gamma']
    );
  });

  it('sorts name-desc', async () => {
    const { store } = await seeded();
    assert.deepEqual(
      store.query({ sort: 'name-desc' }).map((d) => d.name),
      ['Gamma', 'Beta', 'Alpha']
    );
  });

  it('sorts recent (most-recently-started first)', async () => {
    const { store } = await seeded();
    assert.deepEqual(
      store.query({ sort: 'recent' }).map((d) => d.name),
      ['Gamma', 'Beta', 'Alpha']
    );
  });

  it('searches case-insensitively across name and command', async () => {
    const { store } = await seeded();
    assert.deepEqual(
      store.query({ search: 'ALPHA' }).map((d) => d.name),
      ['Alpha']
    );
    // Matches against the command field too ('run' appears in two commands).
    assert.deepEqual(
      store.query({ search: 'run' }).map((d) => d.name),
      ['Alpha', 'Beta']
    );
  });

  it('filters by scope', async () => {
    const { store } = await seeded();
    assert.deepEqual(
      store.query({ scope: 'workspace' }).map((d) => d.name),
      ['Alpha', 'Gamma']
    );
    assert.deepEqual(
      store.query({ scope: 'global' }).map((d) => d.name),
      ['Beta']
    );
  });

  it('combines scope + search + sort', async () => {
    const { store } = await seeded();
    const result = store.query({ scope: 'workspace', search: 'a', sort: 'name-desc' });
    assert.deepEqual(
      result.map((d) => d.name),
      ['Gamma', 'Alpha']
    );
  });
});

describe('TaskStore manual order (reorder + manual sort)', () => {
  it('manual sort defaults to insertion order until reordered', async () => {
    const { store } = makeStore();
    await store.add(input({ name: 'Beta' }), 'workspace');
    await store.add(input({ name: 'Alpha' }), 'workspace');
    await store.add(input({ name: 'Gamma' }), 'workspace');

    // No manual order recorded yet: fall back to insertion (add) order.
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['Beta', 'Alpha', 'Gamma']
    );
  });

  it('reorder() persists a scope order that manual sort then reflects', async () => {
    const { store } = makeStore();
    const a = await store.add(input({ name: 'A' }), 'workspace');
    const b = await store.add(input({ name: 'B' }), 'workspace');
    const c = await store.add(input({ name: 'C' }), 'workspace');

    await store.reorder('workspace', [c.id, a.id, b.id]);
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['C', 'A', 'B']
    );
  });

  it('appends never-positioned definitions to the end in insertion order', async () => {
    const { store } = makeStore();
    await store.add(input({ name: 'A' }), 'workspace');
    const b = await store.add(input({ name: 'B' }), 'workspace');

    // Only B is positioned; A and any later additions trail in insertion order.
    await store.reorder('workspace', [b.id]);
    await store.add(input({ name: 'C' }), 'workspace');
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['B', 'A', 'C']
    );
  });

  it('drops deleted ids from the manual order at read time', async () => {
    const { store } = makeStore();
    const a = await store.add(input({ name: 'A' }), 'workspace');
    const b = await store.add(input({ name: 'B' }), 'workspace');
    const c = await store.add(input({ name: 'C' }), 'workspace');

    await store.reorder('workspace', [c.id, b.id, a.id]);
    await store.delete(b.id);
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['C', 'A']
    );
  });

  it('orders each scope independently, global block before workspace block', async () => {
    const { store } = makeStore();
    const g1 = await store.add(input({ name: 'G1' }), 'global');
    const g2 = await store.add(input({ name: 'G2' }), 'global');
    const w1 = await store.add(input({ name: 'W1' }), 'workspace');
    const w2 = await store.add(input({ name: 'W2' }), 'workspace');

    await store.reorder('global', [g2.id, g1.id]);
    await store.reorder('workspace', [w2.id, w1.id]);

    // scope: all -> global (in its order) then workspace (in its order).
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['G2', 'G1', 'W2', 'W1']
    );
    // A single-scope query yields just that scope's order.
    assert.deepEqual(
      store.query({ sort: 'manual', scope: 'workspace' }).map((d) => d.name),
      ['W2', 'W1']
    );
  });

  it('manual sort composes with search (subset stays in manual order)', async () => {
    const { store } = makeStore();
    const a = await store.add(input({ name: 'Apple', command: 'x' }), 'workspace');
    const b = await store.add(input({ name: 'Banana', command: 'x' }), 'workspace');
    const c = await store.add(input({ name: 'Avocado', command: 'x' }), 'workspace');

    await store.reorder('workspace', [c.id, b.id, a.id]);
    assert.deepEqual(
      store.query({ sort: 'manual', search: 'a' }).map((d) => d.name),
      ['Avocado', 'Banana', 'Apple']
    );
  });

  it('reorder() sanitizes: foreign-scope, unknown, and duplicate ids are dropped', async () => {
    const { store } = makeStore();
    const w = await store.add(input({ name: 'W' }), 'workspace');
    const g = await store.add(input({ name: 'G' }), 'global');

    // Feed the workspace order a global id, an unknown id, and a duplicate.
    await store.reorder('workspace', [w.id, g.id, 'nope' as never, w.id]);
    assert.deepEqual(
      store.query({ sort: 'manual', scope: 'workspace' }).map((d) => d.name),
      ['W']
    );
    // The global scope was untouched by the workspace reorder.
    assert.equal(store.getScope(g.id), 'global');
  });

  it('reorder() fires onDidChangeDefinitions', async () => {
    const { store } = makeStore();
    const a = await store.add(input({ name: 'A' }), 'workspace');
    let count = 0;
    const sub = store.onDidChangeDefinitions(() => count++);
    await store.reorder('workspace', [a.id]);
    assert.equal(count, 1);
    sub.dispose();
  });

  it('persists the manual order across a new store over the same storage', async () => {
    const globalStorage = new FakeMementoStorage();
    const workspaceStorage = new FakeMementoStorage();
    const clock = new FakeClock();

    const store1 = new TaskStore(globalStorage, workspaceStorage, clock);
    const a = await store1.add(input({ name: 'A' }), 'workspace');
    const b = await store1.add(input({ name: 'B' }), 'workspace');
    const c = await store1.add(input({ name: 'C' }), 'workspace');
    await store1.reorder('workspace', [c.id, a.id, b.id]);
    store1.dispose();

    const store2 = new TaskStore(globalStorage, workspaceStorage, clock);
    assert.deepEqual(
      store2.query({ sort: 'manual' }).map((d) => d.name),
      ['C', 'A', 'B']
    );
  });

  it('survives a corrupt persisted manual order without throwing', () => {
    const workspaceStorage = new FakeMementoStorage({
      [STORAGE_KEYS.manualOrder]: 'not-an-array',
      [STORAGE_KEYS.definitions]: [{ id: 'x', name: 'Only', command: 'c' }],
    });
    const store = new TaskStore(new FakeMementoStorage(), workspaceStorage, new FakeClock());
    // Corrupt order is ignored; the definition still loads and sorts.
    assert.deepEqual(
      store.query({ sort: 'manual' }).map((d) => d.name),
      ['Only']
    );
  });
});

describe('TaskStore run/stop side-data', () => {
  it('recordRun stamps lastStartTime and appends to history', async () => {
    const { store, clock } = makeStore();
    const def = await store.add(input({ command: 'cmd' }), 'workspace');

    clock.set(7777);
    await store.update(def.id, { command: 'cmd-v2' });
    await store.recordRun(def.id);

    const after = store.get(def.id)!;
    assert.equal(after.lastStartTime, 7777);
    assert.deepEqual(after.commandHistory, ['cmd', 'cmd-v2']);
  });

  it('recordRun does not duplicate consecutive identical commands', async () => {
    const { store } = makeStore();
    const def = await store.add(input({ command: 'same' }), 'workspace');
    await store.recordRun(def.id);
    await store.recordRun(def.id);

    assert.deepEqual(store.get(def.id)?.commandHistory, ['same']);
  });

  it('caps command history at COMMAND_HISTORY_LIMIT, keeping the newest', async () => {
    const { store } = makeStore();
    const def = await store.add(input({ command: 'c0' }), 'workspace');

    // Drive history well past the cap with distinct commands.
    const total = COMMAND_HISTORY_LIMIT + 10;
    for (let i = 1; i <= total; i++) {
      await store.update(def.id, { command: `c${i}` });
      await store.recordRun(def.id);
    }

    const history = store.get(def.id)!.commandHistory;
    assert.equal(history.length, COMMAND_HISTORY_LIMIT);
    // Oldest entries trimmed; the very newest command is retained at the tail.
    assert.equal(history[history.length - 1], `c${total}`);
    assert.equal(history.includes('c0'), false);
  });

  it('recordStop stamps lastStopTime and lastExitCode', async () => {
    const { store, clock } = makeStore();
    const def = await store.add(input(), 'workspace');

    clock.set(9000);
    await store.recordStop(def.id, 137);
    assert.equal(store.get(def.id)?.lastStopTime, 9000);
    assert.equal(store.get(def.id)?.lastExitCode, 137);
  });

  it('recordStop maps null/undefined exit code to undefined', async () => {
    const { store } = makeStore();
    const def = await store.add(input(), 'workspace');
    await store.recordStop(def.id, null);
    assert.equal(store.get(def.id)?.lastExitCode, undefined);
  });

  it('recordRun/recordStop on an unknown id are no-ops', async () => {
    const { store } = makeStore();
    await store.recordRun('nope' as never);
    await store.recordStop('nope' as never, 0);
    assert.equal(store.getAll().length, 0);
  });
});
