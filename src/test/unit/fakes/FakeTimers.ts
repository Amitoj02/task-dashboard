/**
 * A deterministic {@link ITimers} that fires scheduled callbacks only when the
 * test advances virtual time.
 *
 * The core schedules its SIGKILL grace window, auto-restart delays, and the
 * single shared refresh tick through this seam. Replacing it with this fake makes
 * every timer-driven path exact and free of real wall-clock timers:
 *
 * - {@link setTimeout} registers a one-shot callback that fires once when virtual
 *   time reaches its due point, then is removed.
 * - {@link setInterval} registers a repeating callback that fires once for every
 *   whole interval crossed by an {@link advance}.
 * - Each returns an {@link ITimerHandle} whose `cancel()` unschedules it (safe to
 *   call after it has fired).
 *
 * @remarks Test-only. Part of the host-free test surface; must not import
 * `vscode` or `child_process`.
 */

import type { ITimerHandle, ITimers } from '../../../types/contracts';

/** One scheduled callback the fake is tracking. */
interface Scheduled {
  /** Unique id for cancellation/identity. */
  id: number;

  /** The callback to invoke when due. */
  callback: () => void;

  /** For one-shots: absolute virtual time it is due. For intervals: next due time. */
  nextDue: number;

  /** Repeat interval in ms, or `undefined` for a one-shot. */
  intervalMs?: number;

  /** Cleared when cancelled or (for one-shots) after firing. */
  active: boolean;
}

/**
 * A virtual-time {@link ITimers}.
 */
export class FakeTimers implements ITimers {
  /** All scheduled callbacks (active and recently inactive), by insertion id. */
  private readonly scheduled = new Map<number, Scheduled>();

  /** The current virtual time, in milliseconds since this fake was created. */
  private currentMs = 0;

  /** Monotonic id source. */
  private nextId = 1;

  /** @inheritdoc */
  public setTimeout(callback: () => void, delayMs: number): ITimerHandle {
    const id = this.nextId++;
    const item: Scheduled = {
      id,
      callback,
      nextDue: this.currentMs + Math.max(0, delayMs),
      active: true,
    };
    this.scheduled.set(id, item);
    return this.handleFor(id);
  }

  /** @inheritdoc */
  public setInterval(callback: () => void, intervalMs: number): ITimerHandle {
    const id = this.nextId++;
    const interval = Math.max(1, intervalMs);
    const item: Scheduled = {
      id,
      callback,
      nextDue: this.currentMs + interval,
      intervalMs: interval,
      active: true,
    };
    this.scheduled.set(id, item);
    return this.handleFor(id);
  }

  /**
   * Advances virtual time by `ms`, firing every callback that becomes due.
   *
   * Callbacks fire in due-time order. A repeating timer fires once per whole
   * interval crossed. Callbacks scheduled *during* an advance with a due time
   * still within the advanced window are also fired (so a chain of timeouts can
   * resolve in a single call). The number of callbacks fired is returned for
   * convenient assertions.
   *
   * @param ms - Milliseconds of virtual time to advance (0 fires nothing new
   *   beyond already-due timers; negative is treated as 0).
   * @returns The total number of callback invocations made.
   */
  public advance(ms: number): number {
    const target = this.currentMs + Math.max(0, ms);
    let fired = 0;

    // Loop until no active callback is due at-or-before the target time. New
    // callbacks scheduled by a fired callback are picked up on the next pass.
    for (;;) {
      const next = this.earliestDue(target);
      if (!next) {
        break;
      }
      // Move virtual time forward to the callback's due point before invoking it,
      // so re-reads inside the callback see a consistent "now".
      this.currentMs = next.nextDue;

      if (next.intervalMs !== undefined) {
        // Repeating: schedule the following tick before firing.
        next.nextDue += next.intervalMs;
      } else {
        // One-shot: deactivate before firing so re-entrancy cannot double-fire it.
        next.active = false;
        this.scheduled.delete(next.id);
      }

      fired++;
      try {
        next.callback();
      } catch {
        // A throwing callback must not abort the rest of the advance.
      }
    }

    this.currentMs = target;
    return fired;
  }

  /** @returns The current virtual time (ms since creation). */
  public get now(): number {
    return this.currentMs;
  }

  /** @returns The number of currently-active scheduled callbacks. */
  public get pendingCount(): number {
    let count = 0;
    for (const item of this.scheduled.values()) {
      if (item.active) {
        count++;
      }
    }
    return count;
  }

  /**
   * Finds the earliest active callback due at-or-before `limit`.
   *
   * @param limit - The upper bound (inclusive) on due time.
   * @returns The earliest due scheduled item, or `undefined` if none.
   */
  private earliestDue(limit: number): Scheduled | undefined {
    let best: Scheduled | undefined;
    for (const item of this.scheduled.values()) {
      if (!item.active || item.nextDue > limit) {
        continue;
      }
      if (
        !best ||
        item.nextDue < best.nextDue ||
        (item.nextDue === best.nextDue && item.id < best.id)
      ) {
        best = item;
      }
    }
    return best;
  }

  /** Builds an {@link ITimerHandle} that cancels the scheduled item with `id`. */
  private handleFor(id: number): ITimerHandle {
    return {
      cancel: () => {
        const item = this.scheduled.get(id);
        if (item) {
          item.active = false;
          this.scheduled.delete(id);
        }
      },
    };
  }
}
