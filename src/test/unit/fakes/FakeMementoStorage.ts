/**
 * A `Map`-backed {@link ITaskStorage} for unit tests.
 *
 * Mimics a `vscode.Memento` closely enough for the store's needs: values are kept
 * in an in-memory map and deep-cloned on read and write so a test can construct a
 * brand-new {@link TaskStore} over the SAME storage instance and observe true
 * persistence (a second store must not share live object references with the
 * first). The clone also models the JSON round-trip the real Memento performs.
 *
 * @remarks Test-only. Part of the host-free test surface; must not import
 * `vscode` or `child_process`.
 */

import type { ITaskStorage } from '../../../types/contracts';

/**
 * In-memory, persistence-faithful {@link ITaskStorage}.
 */
export class FakeMementoStorage implements ITaskStorage {
  /** The backing key/value map, holding already-cloned values. */
  private readonly data = new Map<string, unknown>();

  /**
   * Records how many times {@link update} has been awaited, so tests can assert a
   * mutation actually persisted (and how often).
   */
  public updateCount = 0;

  /**
   * @param seed - Optional initial entries (cloned on ingestion).
   */
  public constructor(seed?: Record<string, unknown>) {
    if (seed) {
      for (const [key, value] of Object.entries(seed)) {
        this.data.set(key, clone(value));
      }
    }
  }

  /** @inheritdoc */
  public get<T>(key: string): T | undefined {
    if (!this.data.has(key)) {
      return undefined;
    }
    // Clone on read so callers can never mutate the stored copy in place.
    return clone(this.data.get(key)) as T;
  }

  /** @inheritdoc */
  public update(key: string, value: unknown): Promise<void> {
    this.updateCount++;
    if (value === undefined) {
      this.data.delete(key);
    } else {
      // Clone on write so later caller mutations do not leak into storage.
      this.data.set(key, clone(value));
    }
    return Promise.resolve();
  }

  /** @returns The raw stored keys (test inspection helper). */
  public keys(): string[] {
    return [...this.data.keys()];
  }
}

/**
 * Deep-clones a JSON-serializable value, modelling the Memento's JSON round-trip.
 *
 * `undefined` is passed through unchanged (it is never stored). Everything else is
 * cloned via `structuredClone` so nested arrays/objects are fully detached.
 */
function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}
