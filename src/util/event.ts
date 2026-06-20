/**
 * A tiny, dependency-free event implementation modelled on the VS Code
 * `Event`/`EventEmitter` shape.
 *
 * The pure core ({@link ../task}, {@link ../models}) must not import `vscode`,
 * yet it still needs to publish change notifications. This {@link Emitter}
 * exposes the exact same `event(listener) => Disposable` contract VS Code uses,
 * so view/command layers can subscribe with no adapter, and unit tests can
 * subscribe with no host.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

/** Something that can be torn down. Structurally identical to `vscode.Disposable`. */
export interface IDisposable {
  /** Releases any resources held by this object. Must be idempotent-safe. */
  dispose(): void;
}

/**
 * A function that registers a listener for an event and returns a
 * {@link IDisposable} that removes it. Structurally identical to `vscode.Event`.
 *
 * @typeParam T - The payload delivered to listeners when the event fires.
 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

/**
 * Publishes a single {@link Event} to any number of listeners.
 *
 * Listeners are invoked synchronously in subscription order. A throwing
 * listener never prevents the remaining listeners from running and never
 * propagates out of {@link fire} — keeping a misbehaving subscriber from
 * crashing the publisher (and, in the extension, the host).
 *
 * @typeParam T - The payload type delivered on each {@link fire}.
 */
export class Emitter<T> implements IDisposable {
  /** Active listeners, in subscription order. */
  private readonly listeners = new Set<(e: T) => void>();

  /** Set once {@link dispose} runs; blocks further subscriptions and fires. */
  private disposed = false;

  /**
   * The public, subscribe-only face of this emitter.
   *
   * Pass this (never the emitter itself) to consumers so they can listen but
   * not fire.
   */
  public readonly event: Event<T> = (listener) => {
    if (this.disposed) {
      // Disposed emitter: hand back a no-op disposable rather than throwing.
      return { dispose: () => {} };
    }
    this.listeners.add(listener);
    let removed = false;
    return {
      dispose: () => {
        if (removed) {
          return;
        }
        removed = true;
        this.listeners.delete(listener);
      },
    };
  };

  /**
   * Delivers `data` to every current listener.
   *
   * Iterates over a snapshot so listeners may safely subscribe/unsubscribe from
   * within their own callback. Errors thrown by individual listeners are
   * swallowed so one bad listener cannot break the others.
   *
   * @param data - The payload to broadcast.
   */
  public fire(data: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch {
        // A listener failing must never break event delivery or the host.
      }
    }
  }

  /** Removes all listeners and prevents further subscriptions/fires. */
  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
