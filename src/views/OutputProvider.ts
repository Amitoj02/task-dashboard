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

  /**
   * Maximum number of bytes (UTF-8) of output the provider retains per instance
   * to replay when its terminal is first revealed. This is what lets a terminal
   * that is opened *after* its process has already exited still show the output
   * (including errors) the process produced — the renderer only captures writes
   * made while it is open, so the provider keeps its own bounded tail. Trimmed a
   * whole line at a time from the front when exceeded, so the retained head
   * never begins mid-line, mid-escape-sequence, or mid-character.
   */
  replayLimit: number;
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

  /**
   * `true` once the Pseudoterminal's `open` has fired, i.e. the renderer is
   * attached and live writes will be displayed. Until then, writes are only
   * retained in {@link replay} (the renderer would drop them).
   */
  opened: boolean;

  /**
   * Retained, CRLF-normalized output tail (bounded by
   * {@link OutputProviderConfig.replayLimit}). Replayed in full the first time
   * the terminal opens, so output survives even when the terminal is revealed
   * long after the process exited.
   */
  replay: string;

  /** Cached UTF-8 byte length of {@link replay}, tracked incrementally. */
  replayBytes: number;

  /** Exit code captured at exit time, used for a deferred Pseudoterminal close. */
  exitCode?: number;
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
      ),
      // An ended instance was cleared from the list → drop its terminal.
      manager.onDidRemoveInstance((instanceId) => this.disposeEntry(instanceId))
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
      opened: false,
      replay: '',
      replayBytes: 0,
    };
    this.entries.set(instanceId, entry);

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      /**
       * Called when the terminal is first shown — the only moment the renderer
       * begins capturing writes. We replay the full retained tail here (not the
       * core's buffer, which is discarded on exit) so revealing an instance —
       * even one that already exited — shows its output instead of a blank
       * screen. If the process ended before the terminal was ever opened, we
       * also fire the deferred close now so the exit status is reported.
       */
      open: () => {
        const current = this.entries.get(instanceId);
        if (!current || current.opened) {
          return;
        }
        current.opened = true;
        if (current.replay.length > 0) {
          writeEmitter.fire(current.replay);
        }
        if (current.exited) {
          closeEmitter.fire(current.exitCode);
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
        this.teardownEntry(instanceId);
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
    const text = toCrlf(chunk.toString('utf8'));
    this.appendReplay(entry, text);
    // Only the open renderer can display a write; otherwise it lives in `replay`
    // and is flushed when the terminal first opens.
    if (entry.opened) {
      entry.writeEmitter.fire(text);
    }
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
    entry.exitCode = exitCode;

    const detail = signal ? `signal ${signal}` : `code ${exitCode ?? 0}`;
    const line = toCrlf(`\n[process exited: ${detail}]\n`);
    this.appendReplay(entry, line);

    if (entry.opened) {
      entry.writeEmitter.fire(line);
      // Report the exit status, but do NOT dispose the terminal — the user can
      // keep reading the final output.
      entry.closeEmitter.fire(exitCode);
    }
    // If the terminal was never opened, the close is deferred until `open` so it
    // can never be reported before the replayed output is written.
  }

  /**
   * Appends text to an entry's retained replay tail, keeping it within the
   * configured byte budget ({@link OutputProviderConfig.replayLimit}). When the
   * budget is exceeded, whole leading lines are dropped (the output is already
   * CRLF-normalized) so the retained head never begins mid-line, mid-ANSI-escape,
   * or mid-character — only a single line longer than the entire budget falls
   * back to a byte-exact suffix.
   *
   * @param entry - The entry whose tail to extend.
   * @param text - The CRLF-normalized text to append.
   */
  private appendReplay(entry: OutputEntry, text: string): void {
    entry.replay += text;
    entry.replayBytes += Buffer.byteLength(text, 'utf8');
    const limit = Math.max(0, this.getConfig().replayLimit);
    if (entry.replayBytes <= limit) {
      return;
    }
    // Over budget: drop whole leading lines until within it, tracking the byte
    // total incrementally so we never re-measure the whole tail.
    let replay = entry.replay;
    let bytes = entry.replayBytes;
    while (bytes > limit) {
      const nl = replay.indexOf('\n');
      if (nl === -1 || nl + 1 >= replay.length) {
        // One line is itself over budget: keep its byte-exact suffix.
        replay = clampUtf8Tail(replay, limit);
        bytes = Buffer.byteLength(replay, 'utf8');
        break;
      }
      bytes -= Buffer.byteLength(replay.slice(0, nl + 1), 'utf8');
      replay = replay.slice(nl + 1);
    }
    entry.replay = replay;
    entry.replayBytes = bytes;
  }

  /**
   * Disposes everything held for an instance — its terminal and emitters — and
   * forgets it. Used when an ended instance is cleared from the running list.
   *
   * @param instanceId - The instance to drop.
   */
  private disposeEntry(instanceId: RunningInstanceId): void {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return;
    }
    const terminal = entry.terminal;
    // Forget + dispose emitters first so the terminal's own `close` callback
    // (fired by dispose) becomes a no-op rather than re-entering teardown.
    this.teardownEntry(instanceId);
    try {
      terminal.dispose();
    } catch {
      /* already disposed by the host */
    }
  }

  /**
   * Removes an entry from the map and disposes its emitters. Idempotent: a
   * second call (e.g. the terminal's `close` after {@link disposeEntry}) is a
   * no-op.
   *
   * @param instanceId - The instance to forget.
   */
  private teardownEntry(instanceId: RunningInstanceId): void {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return;
    }
    this.entries.delete(instanceId);
    entry.writeEmitter.dispose();
    entry.closeEmitter.dispose();
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

    // Snapshot ids first: disposing a terminal fires its `close` callback, which
    // mutates `entries` — never iterate the live map while it is being mutated.
    for (const instanceId of [...this.entries.keys()]) {
      this.disposeEntry(instanceId);
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

/**
 * Returns at most the trailing `maxBytes` UTF-8 bytes of `text` as a string,
 * never exceeding the budget. Used only as a last resort for a single line that
 * on its own exceeds the replay budget. The cut is advanced past any partial
 * leading multibyte character so the result decodes cleanly (dropping the
 * partial char rather than emitting a replacement char, which would itself push
 * the byte count back over budget).
 *
 * @param text - The text to clamp.
 * @param maxBytes - The maximum number of UTF-8 bytes to keep.
 * @returns The byte-bounded suffix of `text`.
 */
function clampUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return text;
  }
  let start = buf.length - maxBytes;
  // Skip UTF-8 continuation bytes (0b10xxxxxx) so we begin on a lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString('utf8');
}
