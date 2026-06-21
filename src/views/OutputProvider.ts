/**
 * Pseudoterminal-backed output rendering for running task instances.
 *
 * Each instance gets a real VS Code terminal driven by a custom
 * {@link vscode.Pseudoterminal}. Output flows from the pure core
 * ({@link ITaskManager.onDidOutput}) into the terminal's write emitter, so we
 * inherit the renderer's native ANSI handling, search, links, copy, and
 * auto-scroll for free — and the full scrollback lives in the renderer rather
 * than in the extension host, keeping host memory bounded.
 *
 * The live terminal is *decoupled* from the per-instance bookkeeping: an
 * {@link OutputEntry} (with its retained replay tail) outlives the terminal it
 * is currently bound to. The terminal is attached on start, torn down when the
 * user closes its tab, and recreated on demand by {@link OutputProvider.reveal}.
 * That is what lets "Show Output" keep working after a finished task's terminal
 * has been closed — the entry survives until the instance is cleared from the
 * Running Tasks list, so a fresh terminal can always replay the retained output.
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
   * to replay whenever its terminal is opened. This is what lets a terminal show
   * output (including errors) that a process produced before the terminal was
   * attached — whether because the process had already exited when first
   * revealed, or because the terminal was closed and later reopened. The renderer
   * only captures writes made while it is open, so the provider keeps its own
   * bounded tail. Trimmed a whole line at a time from the front when exceeded, so
   * the retained head never begins mid-line, mid-escape-sequence, or
   * mid-character.
   */
  replayLimit: number;
}

/**
 * The disposable, host-owned half of an entry: the terminal currently presenting
 * an instance's output and the emitters that drive its Pseudoterminal.
 *
 * This is recreated each time output is revealed after the previous terminal was
 * closed, so it is deliberately separate from the durable {@link OutputEntry}.
 */
interface LiveTerminal {
  /** The VS Code terminal presenting this instance's output. */
  terminal: vscode.Terminal;

  /** Feeds bytes into the terminal (its Pseudoterminal `onDidWrite`). */
  writeEmitter: vscode.EventEmitter<string>;

  /**
   * The Pseudoterminal's `onDidClose` source. Required by the pty contract but
   * intentionally never fired: signalling close would make the host drop the
   * terminal from `window.terminals` and render it unrevealable. The terminal is
   * instead torn down only by an explicit {@link vscode.Terminal.dispose} (user
   * close or {@link OutputProvider.disposeEntry}).
   */
  closeEmitter: vscode.EventEmitter<number | void>;

  /**
   * `true` once the Pseudoterminal's `open` has fired, i.e. the renderer is
   * attached and live writes will be displayed. Until then, writes are only
   * retained in {@link OutputEntry.replay} (the renderer would drop them).
   */
  opened: boolean;
}

/**
 * Durable per-instance bookkeeping. Outlives any single {@link LiveTerminal}: it
 * persists after the process exits *and* after the terminal is closed, until the
 * instance is removed from the Running Tasks list. Holding the replay tail here —
 * rather than on the terminal — is what makes output revealable again after a
 * close.
 */
interface OutputEntry {
  /**
   * The terminal title (`name #N`), assigned once at start so a terminal that is
   * recreated by {@link OutputProvider.reveal} keeps the same stable name rather
   * than bumping the per-name counter again.
   */
  title: string;

  /**
   * `true` once the process has exited. The terminal is intentionally left open
   * (never signalled to close) so it stays revealable; this only gates the
   * close-time stop policy so closing an already-finished task never re-stops it.
   */
  exited: boolean;

  /**
   * Retained, CRLF-normalized output tail (bounded by
   * {@link OutputProviderConfig.replayLimit}). Replayed in full every time a
   * terminal opens, so output survives both a process that exited before its
   * terminal was ever shown and a terminal that was closed and later reopened.
   */
  replay: string;

  /** Cached UTF-8 byte length of {@link replay}, tracked incrementally. */
  replayBytes: number;

  /**
   * The terminal currently bound to this instance, or `undefined` when none is
   * open (never revealed, or closed by the user). Recreated on demand by
   * {@link OutputProvider.reveal}.
   */
  live?: LiveTerminal;
}

/**
 * Owns a durable {@link OutputEntry} per running instance and binds it to a
 * Pseudoterminal-backed {@link vscode.Terminal} that is created on start,
 * recreated on demand, and bridges core output/lifecycle events to the renderer.
 */
export class OutputProvider implements IDisposable {
  /**
   * Durable entries keyed by instance id. An entry outlives its terminal and is
   * removed only when the instance is cleared from the Running Tasks list.
   */
  private readonly entries = new Map<RunningInstanceId, OutputEntry>();

  /** Per-definition counters used to number terminals (`name #1`, `name #2`, …). */
  private readonly instanceCounters = new Map<string, number>();

  /** Subscriptions to the manager's events; disposed in {@link dispose}. */
  private readonly subscriptions: IDisposable[] = [];

  /** Set once {@link dispose} runs; guards against post-dispose work. */
  private disposed = false;

  /**
   * @param manager - The running-state source of truth (lifecycle events + stop).
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
      // An ended instance was cleared from the list → drop its entry + terminal.
      manager.onDidRemoveInstance((instanceId) => this.disposeEntry(instanceId))
    );
  }

  /**
   * Reveals the terminal for an instance without stealing focus, recreating it
   * first if the previous terminal was closed.
   *
   * This is the fix for "Show Output does nothing after the terminal is closed":
   * because the {@link OutputEntry} outlives its terminal, a closed terminal can
   * be rebuilt and the retained output replayed, instead of silently no-opping.
   *
   * @param instanceId - The instance whose terminal to show.
   */
  public reveal(instanceId: RunningInstanceId): void {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      // Unknown instance, or one already cleared from the Running Tasks list.
      return;
    }
    if (!entry.live) {
      // The terminal was closed but the instance is still listed — exited and
      // browsable, or (under `keep`) running headless. Recreate a fresh
      // pty-backed terminal; its `open` replays the retained tail (including the
      // `[process exited]` line for a finished instance).
      this.attachTerminal(instanceId, entry);
    }
    // `show(true)` preserves the user's current focus (preserveFocus).
    entry.live?.terminal.show(true);
  }

  /**
   * Handles a new instance: creates the durable entry and attaches a terminal.
   *
   * @param instanceId - The new instance's id.
   * @param name - The instance's display name (used for the terminal title).
   */
  private handleStart(instanceId: RunningInstanceId, name: string): void {
    if (this.disposed || this.entries.has(instanceId)) {
      return;
    }

    const entry: OutputEntry = {
      title: `${name} #${this.nextInstanceNumber(name)}`,
      exited: false,
      replay: '',
      replayBytes: 0,
    };
    this.entries.set(instanceId, entry);
    this.attachTerminal(instanceId, entry);
  }

  /**
   * Builds the {@link LiveTerminal} half of an entry: fresh emitters, a
   * Pseudoterminal, and a terminal. Used both at start and when {@link reveal}
   * recreates a terminal that the user had closed.
   *
   * @param instanceId - The owning instance.
   * @param entry - The durable entry to bind the new terminal to. Its existing
   *   {@link OutputEntry.replay}/{@link OutputEntry.exited} state drives what the
   *   terminal shows once opened.
   */
  private attachTerminal(instanceId: RunningInstanceId, entry: OutputEntry): void {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    const live: LiveTerminal = {
      terminal: undefined as never,
      writeEmitter,
      closeEmitter,
      opened: false,
    };
    entry.live = live;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      /**
       * Called when the terminal is first shown — the only moment the renderer
       * begins capturing writes. We replay the full retained tail here (not the
       * core's buffer, which is discarded on exit) so opening a terminal — even
       * for an instance that already exited, or one being reopened after a close
       * — shows its output (including the `[process exited]` line) instead of a
       * blank screen.
       */
      open: () => {
        // Ignore a late `open` from a terminal we have already detached/replaced.
        if (entry.live !== live || live.opened) {
          return;
        }
        live.opened = true;
        if (entry.replay.length > 0) {
          writeEmitter.fire(entry.replay);
        }
      },
      /**
       * Called when the terminal is closed (by the user or by us). If the
       * instance is still alive and policy says so, stop it. Either way only the
       * live terminal is dropped — the durable entry (and its replay tail) is
       * kept so the output stays revealable.
       */
      close: () => {
        // Ignore a stale close from a terminal we have already detached/replaced,
        // or one whose entry was removed (disposeEntry forgets it first).
        if (!this.entries.has(instanceId) || entry.live !== live) {
          return;
        }
        // Only stop on user-initiated close while the process is still alive.
        if (!entry.exited && this.getConfig().closeTerminalBehavior === 'stop') {
          // The stop is best-effort; never let a rejection escape into the host.
          void this.manager.stop(instanceId).catch(() => {
            /* stop failures are surfaced by the manager's own error handling */
          });
        }
        // Drop only the live terminal; the entry persists until the instance is
        // cleared from the list (onDidRemoveInstance → disposeEntry), so reveal()
        // can recreate a terminal and replay the retained output later.
        this.detachLiveTerminal(entry);
      },
      // handleInput intentionally omitted in v1: terminals are output-only.
    };

    const terminal = vscode.window.createTerminal({
      name: entry.title,
      pty,
      iconPath: new vscode.ThemeIcon('terminal'),
      isTransient: true,
    });
    live.terminal = terminal;
  }

  /**
   * Forwards a chunk of process output to the matching terminal, always retaining
   * it in the replay tail so it survives a later terminal close/reopen.
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
    // Only an open renderer can display a write; otherwise it lives in `replay`
    // and is flushed when a terminal next opens.
    if (entry.live?.opened) {
      entry.live.writeEmitter.fire(text);
    }
  }

  /**
   * Handles an instance exit: writes a final status line and marks the entry
   * exited, while keeping the terminal open so the output stays browsable.
   *
   * Crucially it does *not* signal the Pseudoterminal to close. Firing
   * `onDidClose` makes the host treat the terminal as finished and drop it from
   * `window.terminals` — after which it can never be re-shown, and the pty's
   * `close` callback never fires either, so a closed tab could not be detected.
   * Leaving it a live, output-complete terminal (the `[process exited]` line
   * conveys the status) is what makes {@link reveal} reliable afterwards and
   * gives the pty `close` callback a chance to run when the user closes the tab.
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
    const line = toCrlf(`\n[process exited: ${detail}]\n`);
    this.appendReplay(entry, line);

    // Only an open renderer can display the line now; otherwise it lives in
    // `replay` and is flushed when a terminal next opens.
    if (entry.live?.opened) {
      entry.live.writeEmitter.fire(line);
    }
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
   * Detaches and disposes only the live terminal's emitters, keeping the durable
   * entry. The terminal itself is not disposed here: this runs *in response to*
   * the terminal already being closed (by the user or the host). Idempotent.
   *
   * @param entry - The entry whose live terminal to detach.
   */
  private detachLiveTerminal(entry: OutputEntry): void {
    const live = entry.live;
    if (!live) {
      return;
    }
    entry.live = undefined;
    live.writeEmitter.dispose();
    live.closeEmitter.dispose();
  }

  /**
   * Disposes everything held for an instance — its terminal and emitters — and
   * forgets the entry. Used when an ended instance is cleared from the running
   * list (and during {@link dispose}).
   *
   * @param instanceId - The instance to drop.
   */
  private disposeEntry(instanceId: RunningInstanceId): void {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return;
    }
    // Forget first so the terminal's own `close` callback (fired by the dispose
    // below) sees no entry and becomes a no-op rather than re-entering teardown.
    this.entries.delete(instanceId);
    // Capture the terminal, then reuse detachLiveTerminal for the emitter teardown
    // (it deliberately leaves the terminal itself alone), and dispose it here:
    // the one extra step that makes "dispose" drop the terminal too.
    const terminal = entry.live?.terminal;
    this.detachLiveTerminal(entry);
    if (terminal) {
      try {
        terminal.dispose();
      } catch {
        /* already disposed by the host */
      }
    }
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
