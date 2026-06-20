/**
 * In-memory, persistence-backed store of {@link TaskDefinition}s.
 *
 * `TaskStore` is the single source of truth for task *definitions* (not running
 * processes). It owns CRUD, search/filter/sort, and the split between
 * `global`- and `workspace`-scoped tasks, each backed by its own injected
 * {@link ITaskStorage}. Every mutation is persisted to the owning scope and then
 * announced via {@link onDidChangeDefinitions}.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`. All collaborators arrive through the constructor (dependency
 * injection); there is no module-level mutable state.
 */

import { Emitter, type Event } from '../util/event';
import { newId } from '../types/ids';
import type { TaskDefinitionId } from '../types/ids';
import {
  COMMAND_HISTORY_LIMIT,
  type TaskDefinition,
  type TaskDefinitionInput,
  type TaskScope,
} from '../models/TaskDefinition';
import {
  STORAGE_KEYS,
  type IClock,
  type ITaskStorage,
  type ITaskStore,
  type TaskQuery,
} from '../types/contracts';

/** The two scopes, in the order they are loaded and persisted. */
const SCOPES: readonly TaskScope[] = ['global', 'workspace'];

/**
 * Implements {@link ITaskStore} over two scope-partitioned storages.
 */
export class TaskStore implements ITaskStore {
  /** All definitions keyed by id, in load/insertion order. */
  private readonly definitions = new Map<TaskDefinitionId, TaskDefinition>();

  /** The owning scope of every known definition. */
  private readonly scopes = new Map<TaskDefinitionId, TaskScope>();

  /** Broadcasts after any change to the set of definitions. */
  private readonly changeEmitter = new Emitter<void>();

  /** @inheritdoc */
  public readonly onDidChangeDefinitions: Event<void> = this.changeEmitter.event;

  /**
   * @param globalStorage - Backing store for `global`-scoped definitions.
   * @param workspaceStorage - Backing store for `workspace`-scoped definitions.
   * @param clock - Time source used to stamp run/stop timestamps.
   */
  public constructor(
    private readonly globalStorage: ITaskStorage,
    private readonly workspaceStorage: ITaskStorage,
    private readonly clock: IClock
  ) {
    // Load global before workspace so getAll() has a stable, intuitive order.
    for (const scope of SCOPES) {
      for (const def of this.load(scope)) {
        this.definitions.set(def.id, def);
        this.scopes.set(def.id, scope);
      }
    }
  }

  /** @inheritdoc */
  public getAll(): TaskDefinition[] {
    return [...this.definitions.values()];
  }

  /** @inheritdoc */
  public get(id: TaskDefinitionId): TaskDefinition | undefined {
    return this.definitions.get(id);
  }

  /** @inheritdoc */
  public getScope(id: TaskDefinitionId): TaskScope | undefined {
    return this.scopes.get(id);
  }

  /** @inheritdoc */
  public query(query: TaskQuery): TaskDefinition[] {
    const { search, sort = 'name-asc', scope } = query;
    const needle = search?.trim().toLowerCase();

    let results = this.getAll();

    if (scope) {
      results = results.filter((def) => this.scopes.get(def.id) === scope);
    }

    if (needle) {
      results = results.filter(
        (def) =>
          def.name.toLowerCase().includes(needle) || def.command.toLowerCase().includes(needle)
      );
    }

    return this.sort(results, sort);
  }

  /** @inheritdoc */
  public async add(input: TaskDefinitionInput, scope: TaskScope): Promise<TaskDefinition> {
    const def: TaskDefinition = {
      ...input,
      id: newId<TaskDefinitionId>(),
      commandHistory: [input.command],
    };

    this.definitions.set(def.id, def);
    this.scopes.set(def.id, scope);

    await this.persist(scope);
    this.changeEmitter.fire();
    return def;
  }

  /** @inheritdoc */
  public async update(
    id: TaskDefinitionId,
    patch: Partial<TaskDefinitionInput>
  ): Promise<TaskDefinition | undefined> {
    const existing = this.definitions.get(id);
    const scope = this.scopes.get(id);
    if (!existing || !scope) {
      return undefined;
    }

    const updated: TaskDefinition = { ...existing, ...patch, id };
    this.definitions.set(id, updated);

    await this.persist(scope);
    this.changeEmitter.fire();
    return updated;
  }

  /** @inheritdoc */
  public async delete(id: TaskDefinitionId): Promise<void> {
    const scope = this.scopes.get(id);
    if (!scope) {
      return;
    }

    this.definitions.delete(id);
    this.scopes.delete(id);

    await this.persist(scope);
    this.changeEmitter.fire();
  }

  /** @inheritdoc */
  public async duplicate(id: TaskDefinitionId): Promise<TaskDefinition | undefined> {
    const source = this.definitions.get(id);
    const scope = this.scopes.get(id);
    if (!source || !scope) {
      return undefined;
    }

    const copy: TaskDefinition = {
      ...source,
      id: newId<TaskDefinitionId>(),
      name: this.uniqueCopyName(source.name),
      commandHistory: [source.command],
      // A copy has not run yet — drop the source's run side-data.
      lastExitCode: undefined,
      lastStartTime: undefined,
      lastStopTime: undefined,
    };

    this.definitions.set(copy.id, copy);
    this.scopes.set(copy.id, scope);

    await this.persist(scope);
    this.changeEmitter.fire();
    return copy;
  }

  /** @inheritdoc */
  public async recordRun(id: TaskDefinitionId): Promise<void> {
    const def = this.definitions.get(id);
    const scope = this.scopes.get(id);
    if (!def || !scope) {
      return;
    }

    def.lastStartTime = this.clock.now();
    this.pushHistory(def, def.command);

    await this.persist(scope);
    this.changeEmitter.fire();
  }

  /** @inheritdoc */
  public async recordStop(
    id: TaskDefinitionId,
    exitCode: number | null | undefined
  ): Promise<void> {
    const def = this.definitions.get(id);
    const scope = this.scopes.get(id);
    if (!def || !scope) {
      return;
    }

    def.lastStopTime = this.clock.now();
    def.lastExitCode = exitCode ?? undefined;

    await this.persist(scope);
    this.changeEmitter.fire();
  }

  /** @inheritdoc */
  public dispose(): void {
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Resolves the backing storage for a scope. */
  private storageFor(scope: TaskScope): ITaskStorage {
    return scope === 'global' ? this.globalStorage : this.workspaceStorage;
  }

  /**
   * Loads and defensively validates the persisted definitions for a scope.
   *
   * Missing or corrupt data (anything that is not an array of well-formed
   * definitions) yields an empty list rather than throwing — restored state is
   * untrusted and must never crash construction.
   */
  private load(scope: TaskScope): TaskDefinition[] {
    let raw: unknown;
    try {
      raw = this.storageFor(scope).get(STORAGE_KEYS.definitions);
    } catch {
      return [];
    }

    if (!Array.isArray(raw)) {
      return [];
    }

    const out: TaskDefinition[] = [];
    for (const entry of raw as unknown[]) {
      const def = this.coerce(entry);
      if (def) {
        out.push(def);
      }
    }
    return out;
  }

  /**
   * Normalizes one persisted entry into a valid {@link TaskDefinition}, or
   * returns `undefined` if it is unusable.
   *
   * Repairs minor drift (missing `commandHistory`, missing
   * `allowMultipleInstances`) so legitimately persisted records survive schema
   * tweaks, while discarding entries lacking a usable id/name/command.
   */
  private coerce(entry: unknown): TaskDefinition | undefined {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const e = entry as Partial<TaskDefinition>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.command !== 'string') {
      return undefined;
    }

    return {
      ...(e as TaskDefinition),
      id: e.id,
      name: e.name,
      command: e.command,
      allowMultipleInstances: Boolean(e.allowMultipleInstances),
      commandHistory: Array.isArray(e.commandHistory)
        ? e.commandHistory.filter((c): c is string => typeof c === 'string')
        : [],
    };
  }

  /** Writes the full definition array for a single scope back to its storage. */
  private async persist(scope: TaskScope): Promise<void> {
    const forScope = this.getAll().filter((def) => this.scopes.get(def.id) === scope);
    await this.storageFor(scope).update(STORAGE_KEYS.definitions, forScope);
  }

  /**
   * Appends `command` to a definition's bounded history.
   *
   * Skips the append when it would duplicate the most recent entry, and trims
   * the oldest entries once the {@link COMMAND_HISTORY_LIMIT} is exceeded.
   */
  private pushHistory(def: TaskDefinition, command: string): void {
    const history = def.commandHistory;
    if (history.length > 0 && history[history.length - 1] === command) {
      return;
    }
    history.push(command);
    if (history.length > COMMAND_HISTORY_LIMIT) {
      history.splice(0, history.length - COMMAND_HISTORY_LIMIT);
    }
  }

  /**
   * Derives a unique "(copy)" name from `baseName`, bumping a numeric suffix
   * until no existing definition (case-insensitively) collides.
   *
   * Examples: `"Build"` → `"Build (copy)"` → `"Build (copy) (2)"`.
   */
  private uniqueCopyName(baseName: string): string {
    const taken = new Set(this.getAll().map((def) => def.name.trim().toLowerCase()));

    const first = `${baseName} (copy)`;
    if (!taken.has(first.trim().toLowerCase())) {
      return first;
    }
    for (let n = 2; ; n++) {
      const candidate = `${baseName} (copy) (${n})`;
      if (!taken.has(candidate.trim().toLowerCase())) {
        return candidate;
      }
    }
  }

  /** Returns a new array of `defs` ordered per the requested sort. */
  private sort(defs: TaskDefinition[], sort: TaskQuery['sort']): TaskDefinition[] {
    const sorted = [...defs];
    switch (sort) {
      case 'name-desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'recent':
        // Most recently started first; never-started (undefined) sink to the end.
        sorted.sort((a, b) => {
          const at = a.lastStartTime;
          const bt = b.lastStartTime;
          if (at === undefined && bt === undefined) {
            return a.name.localeCompare(b.name);
          }
          if (at === undefined) {
            return 1;
          }
          if (bt === undefined) {
            return -1;
          }
          return bt - at;
        });
        break;
      case 'name-asc':
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return sorted;
  }
}
