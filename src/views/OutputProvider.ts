/**
 * Pseudoterminal-backed output rendering for running task instances.
 *
 * Each live instance gets one real VS Code terminal driven by a custom
 * {@link vscode.Pseudoterminal}. Output flows from the pure core
 * ({@link ITaskManager.onDidOutput}) into the terminal's write emitter, so we
 * inherit the renderer's native ANSI handling, search, links, copy, and
 * auto-scroll for free — and the full scrollback lives in the renderer rather
 * than in the extension host, keeping host memory bounded.
 *
 * @remarks
 * This class sits behind a conceptual `IOutputSink` seam: nothing in the core
 * knows that output is rendered via Pseudoterminals. A future
 * `OutputChannelSink` or webview-based sink could replace this provider without
 * touching {@link ITaskManager} or any pure-core code, because the only contract
 * it consumes is the manager's event surface. (The seam is left conceptual for
 * now — there is exactly one implementation — to avoid speculative abstraction.)
 *
 * VS Code-aware layer: this file is permitted to import `vscode`.
 */

import * as vscode from 'vscode';
import type { ITaskManager } from '../types/contracts';
import type { RunningInstanceId } from '../types/ids';
import type { IDisposable } from '../util/event';

/** Configuration consumed by the provider, read lazily so live edits apply. */
export interface OutputProviderConfig {
  /**
   * What to do when the user closes a terminal whose instance is still alive:
   * `stop` terminates the instance; `keep` leaves it running headless.
   */
  closeTerminalBehavior: 'stop' | 'keep';
}

/**
 * Internal per-instance bookkeeping: the terminal, the emitters that drive its
 * Pseudoterminal, and whether the underlying process has already exited.
 */
interface OutputEntry {
  /** The VS Code terminal presenting this instance's output. */
  terminal: vscode.Terminal;

  /** Feeds bytes into the terminal (its Pseudoterminal `onDidWrite`). */
  writeEmitter: vscode.EventEmitter<string>;

  /** Signals the Pseudoterminal to close (its `onDidClose`). */
  closeEmitter: vscode.EventEmitter<number | void>;

  /** `true` once the process has exited; the terminal is then kept read-only. */
  exited: boolean;
}

/** ANSI escape sequence that clears the screen and scrollback and homes the cursor. */
const CLEAR_SEQUENCE = '\x1b[2J\x1b[3J\x1b[H';

/**
 * Owns one Pseudoterminal-backed {@link vscode.Terminal} per running instance and
 * bridges core output/lifecycle events to it.
 */
export class OutputProvider implements IDisposable {
  /** Live entries keyed by instance id. Entries persist after exit (read-only). */
  private readonly entries = new Map<RunningInstanceId, OutputEntry>();

  /** Per-definition counters used to number terminals (`name #1`, `name #2`, …). */
  private readonly instanceCounters = new Map<string, number>();

  /** Subscriptions to the manager's events; disposed in {@link dispose}. */
  private readonly subscriptions: IDisposable[] = [];

  /** Set once {@link dispose} runs; guards against post-dispose work. */
  private disposed = false;

  /**
   * @param manager - The running-state source of truth (events + buffered output + stop).
   * @param getConfig - Reads current provider config; called lazily so changes
   *   to `closeTerminalBehavior` take effect without re-instantiation.
   */
  constructor(
    private readonly manager: ITaskManager,
    private readonly getConfig: () => OutputProviderConfig
  ) {
    this.subscriptions.push(
      manager.onDidStartInstance((task) => this.handleStart(task.instanceId, task.name)),
      manager.onDidOutput((output) => this.handleOutput(output.instanceId, output.chunk)),
      manager.onDidExitInstance((exit) =>
        this.handleExit(exit.instanceId, exit.exitCode, exit.signal)
      )
    );
  }

  /**
   * Reveals the terminal for an instance without stealing focus.
   *
   * @param instanceId - The instance whose terminal to show.
   */
  public reveal(instanceId: RunningInstanceId): void {
    const entry = this.entries.get(instanceId);
    // `show(true)` preserves the user's current focus (preserveFocus).
    entry?.terminal.show(true);
  }

  /**
   * Clears a terminal's screen and scrollback.
   *
   * @param instanceId - The instance whose terminal to clear. When omitted, the
   *   currently active terminal is cleared if it is one we own.
   */
  public clear(instanceId?: RunningInstanceId): void {
    if (instanceId !== undefined) {
      this.entries.get(instanceId)?.writeEmitter.fire(CLEAR_SEQUENCE);
      return;
    }
    // Fall back to clearing whichever of our terminals is currently active.
    const active = vscode.window.activeTerminal;
    if (!active) {
      return;
    }
    for (const entry of this.entries.values()) {
      if (entry.terminal === active) {
        entry.writeEmitter.fire(CLEAR_SEQUENCE);
        return;
      }
    }
  }

  /**
   * Handles a new instance: creates emitters, a Pseudoterminal, and a terminal.
   *
   * @param instanceId - The new instance's id.
   * @param name - The instance's display name (used for the terminal title).
   */
  private handleStart(instanceId: RunningInstanceId, name: string): void {
    if (this.disposed || this.entries.has(instanceId)) {
      return;
    }

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    const entry: OutputEntry = {
      terminal: undefined as never,
      writeEmitter,
      closeEmitter,
      exited: false,
    };
    this.entries.set(instanceId, entry);

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      /**
       * Called when the terminal is first shown. Replays the core's buffered
       * tail so revealing an in-flight (or finished) instance shows recent
       * context, not a blank screen.
       */
      open: () => {
        const buffered = this.manager.getBufferedOutput(instanceId);
        if (buffered.length > 0) {
          writeEmitter.fire(toCrlf(buffered.toString('utf8')));
        }
      },
      /**
       * Called when the terminal is closed (by the user or by us). If the
       * instance is still alive and policy says so, stop it.
       */
      close: () => {
        const current = this.entries.get(instanceId);
        // Only stop on user-initiated close while the process is still alive.
        if (current && !current.exited && this.getConfig().closeTerminalBehavior === 'stop') {
          // The stop is best-effort; never let a rejection escape into the host.
          void this.manager.stop(instanceId).catch(() => {
            /* stop failures are surfaced by the manager's own error handling */
          });
        }
        this.entries.delete(instanceId);
        writeEmitter.dispose();
        closeEmitter.dispose();
      },
      // handleInput intentionally omitted in v1: terminals are output-only.
    };

    const terminal = vscode.window.createTerminal({
      name: `${name} #${this.nextInstanceNumber(name)}`,
      pty,
      iconPath: new vscode.ThemeIcon('terminal'),
      isTransient: true,
    });
    entry.terminal = terminal;
  }

  /**
   * Forwards a chunk of process output to the matching terminal.
   *
   * @param instanceId - The producing instance.
   * @param chunk - Raw output bytes from the core.
   */
  private handleOutput(instanceId: RunningInstanceId, chunk: Buffer): void {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return;
    }
    entry.writeEmitter.fire(toCrlf(chunk.toString('utf8')));
  }

  /**
   * Handles an instance exit: writes a final status line, signals the
   * Pseudoterminal to close, and marks the entry read-only while keeping the
   * terminal so the output stays browsable.
   *
   * @param instanceId - The instance that ended.
   * @param exitCode - The process exit code, if any.
   * @param signal - The terminating signal, if any.
   */
  private handleExit(
    instanceId: RunningInstanceId,
    exitCode: number | undefined,
    signal: string | undefined
  ): void {
    const entry = this.entries.get(instanceId);
    if (!entry || entry.exited) {
      return;
    }
    entry.exited = true;

    const detail = signal ? `signal ${signal}` : `code ${exitCode ?? 0}`;
    entry.writeEmitter.fire(toCrlf(`\n[process exited: ${detail}]\n`));
    // Fire the close emitter so the Pseudoterminal reports the exit status, but
    // do NOT dispose the terminal — the user can keep reading the final output.
    entry.closeEmitter.fire(exitCode);
  }

  /**
   * Returns the next 1-based instance number for a given task name, so multiple
   * concurrent instances get distinct, stable terminal titles.
   *
   * @param name - The task display name.
   * @returns The next sequence number for that name.
   */
  private nextInstanceNumber(name: string): number {
    const next = (this.instanceCounters.get(name) ?? 0) + 1;
    this.instanceCounters.set(name, next);
    return next;
  }

  /**
   * Disposes every terminal, emitter, and event subscription this provider owns.
   *
   * Idempotent: safe to call more than once.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;

    for (const entry of this.entries.values()) {
      entry.terminal.dispose();
      entry.writeEmitter.dispose();
      entry.closeEmitter.dispose();
    }
    this.entries.clear();
    this.instanceCounters.clear();
  }
}

/**
 * Translates lone `\n` line endings to `\r\n` for Pseudoterminal output, the
 * classic pty newline fix, without double-translating existing `\r\n`.
 *
 * @param text - The text to normalize.
 * @returns The text with every `\n` not already preceded by `\r` expanded to `\r\n`.
 */
function toCrlf(text: string): string {
  // Match a `\n` only when it is not immediately preceded by a `\r`.
  return text.replace(/(?<!\r)\n/g, '\r\n');
}
