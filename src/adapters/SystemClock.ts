/**
 * {@link IClock} backed by the system wall clock.
 *
 * The trivial production implementation; tests substitute a fake clock that
 * advances virtual time for deterministic duration/grace assertions.
 *
 * @remarks Host-aware adapter (lives outside the pure core). Imports nothing
 * from `vscode`, but is wired up only in `extension.ts`.
 */

import type { IClock } from '../types/contracts';

/** Implements {@link IClock} via `Date.now()`. */
export class SystemClock implements IClock {
  /** @inheritdoc */
  public now(): number {
    return Date.now();
  }
}
