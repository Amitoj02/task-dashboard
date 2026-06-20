/**
 * {@link ITimers} backed by Node's ambient `setTimeout`/`setInterval`.
 *
 * Wraps each scheduled callback so that a throwing callback can never escape into
 * the host's uncaught-exception path, and so handles are uniformly cancellable
 * and idempotent. Tests substitute a fake timers implementation driving virtual
 * time.
 *
 * @remarks Host-aware adapter (lives outside the pure core). Uses Node globals
 * available in the extension host. Wired up only in `extension.ts`.
 */

import type { ITimerHandle, ITimers } from '../types/contracts';

/** A cancellable handle over a Node timer. Cancellation is idempotent. */
class TimerHandle implements ITimerHandle {
  private cancelled = false;

  /**
   * @param timer - The underlying Node timer object.
   * @param clear - The matching clear function (`clearTimeout`/`clearInterval`).
   */
  public constructor(
    private readonly timer: ReturnType<typeof setTimeout>,
    private readonly clear: (t: ReturnType<typeof setTimeout>) => void
  ) {}

  /** @inheritdoc */
  public cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.clear(this.timer);
  }
}

/** Implements {@link ITimers} over Node's timer functions. */
export class SystemTimers implements ITimers {
  /** @inheritdoc */
  public setTimeout(callback: () => void, delayMs: number): ITimerHandle {
    const timer = setTimeout(() => guard(callback), delayMs);
    return new TimerHandle(timer, clearTimeout);
  }

  /** @inheritdoc */
  public setInterval(callback: () => void, intervalMs: number): ITimerHandle {
    const timer = setInterval(() => guard(callback), intervalMs);
    return new TimerHandle(timer, clearInterval);
  }
}

/** Runs a timer callback, swallowing any throw so it cannot crash the host. */
function guard(callback: () => void): void {
  try {
    callback();
  } catch {
    /* a misbehaving timer callback must never take down the extension host */
  }
}
