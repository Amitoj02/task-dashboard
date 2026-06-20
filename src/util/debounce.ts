/**
 * A tiny, dependency-free debounce helper used to coalesce bursty refreshes.
 *
 * The tree providers can be asked to refresh many times in quick succession
 * (e.g. several instances starting at once, or a flurry of store mutations).
 * Debouncing collapses each burst into a single `fire`, keeping the UI smooth
 * even with 50+ tasks.
 *
 * @remarks Host-free. Must not import `vscode` or `child_process`. Uses Node's
 * ambient timer functions, which are available in the extension host.
 */

import type { IDisposable } from './event';

/**
 * A debounced wrapper around a function, plus controls to flush/cancel it.
 *
 * @typeParam A - The argument tuple of the wrapped function.
 */
export interface Debounced<A extends unknown[]> extends IDisposable {
  /** Invoke the debounced function; the underlying call fires after the quiet period. */
  (...args: A): void;

  /** Cancel any pending invocation without calling the wrapped function. */
  cancel(): void;

  /** Immediately invoke any pending call (using the most recent arguments) and clear the timer. */
  flush(): void;
}

/**
 * Wraps `fn` so that rapid successive calls collapse into a single invocation,
 * fired `waitMs` after the last call. The most recent arguments win.
 *
 * The returned wrapper is itself an {@link IDisposable}; disposing (or
 * {@link Debounced.cancel | cancelling}) clears any pending timer so no callback
 * runs after teardown — important for leak-free provider disposal.
 *
 * @typeParam A - The argument tuple of `fn`.
 * @param fn - The function to debounce.
 * @param waitMs - The quiet period, in milliseconds, before `fn` runs.
 * @returns A {@link Debounced} wrapper over `fn`.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: A | undefined;

  const run = (): void => {
    timer = undefined;
    const args = pendingArgs;
    pendingArgs = undefined;
    if (args) {
      fn(...args);
    }
  };

  const debounced = ((...args: A): void => {
    pendingArgs = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingArgs = undefined;
  };

  debounced.flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      run();
    }
  };

  debounced.dispose = (): void => {
    debounced.cancel();
  };

  return debounced;
}
