/**
 * A deterministic {@link IClock} whose "now" is fully controlled by the test.
 *
 * The core stamps timestamps and measures the crash-loop window through an
 * injected clock; substituting this fake makes every time-dependent assertion
 * exact. Time only moves when the test moves it (via {@link set} or
 * {@link advance}).
 *
 * @remarks Test-only. Part of the host-free test surface; must not import
 * `vscode` or `child_process`.
 */

import type { IClock } from '../../../types/contracts';

/**
 * A settable, monotonic-by-default virtual clock.
 */
export class FakeClock implements IClock {
  /** The current virtual time, in epoch milliseconds. */
  private current: number;

  /**
   * @param start - The initial virtual time (epoch ms). Defaults to `0`.
   */
  public constructor(start = 0) {
    this.current = start;
  }

  /** @inheritdoc */
  public now(): number {
    return this.current;
  }

  /**
   * Sets the virtual clock to an absolute time.
   *
   * @param ms - The new current time, in epoch milliseconds.
   */
  public set(ms: number): void {
    this.current = ms;
  }

  /**
   * Advances the virtual clock by a relative amount.
   *
   * Note: this only moves the {@link IClock} reading; it does NOT fire scheduled
   * timers. Use {@link FakeTimers.advance} (typically with the same delta) to fire
   * due callbacks.
   *
   * @param ms - Milliseconds to add to the current time.
   */
  public advance(ms: number): void {
    this.current += ms;
  }
}
