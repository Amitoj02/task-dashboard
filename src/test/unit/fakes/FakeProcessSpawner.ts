/**
 * Scriptable fakes for the process seam: {@link FakeProcessSpawner} records every
 * {@link SpawnOptions} it is handed and returns a {@link FakeSpawnedProcess} the
 * test drives directly — emitting stdout/stderr/exit/error and asserting which
 * kill signals were delivered.
 *
 * This is the ONLY process-related surface the core (and these tests) touch, so a
 * deterministic fake here exercises the full {@link TaskRunner}/{@link TaskManager}
 * lifecycle with no real `child_process`.
 *
 * The runner stops a process by calling {@link ISpawnedProcess.kill}: `SIGTERM`
 * for a graceful terminate and `SIGKILL` for a force kill. The fake records both
 * the raw signals and convenient {@link FakeSpawnedProcess.terminateCount} /
 * {@link FakeSpawnedProcess.forceKillCount} tallies, and flips
 * {@link FakeSpawnedProcess.killed} on the first kill.
 *
 * @remarks Test-only. Part of the host-free test surface; must not import
 * `vscode` or `child_process`.
 */

import type { Event, IDisposable } from '../../../util/event';
import { Emitter } from '../../../util/event';
import type { ISpawnedProcess, IProcessSpawner, SpawnOptions } from '../../../types/contracts';

/**
 * A scripted {@link ISpawnedProcess}.
 *
 * Tests push lifecycle events through `emit*` and inspect the recorded kill
 * activity. Listener accessors return real {@link Emitter}-backed disposables so
 * the runner's subscription/teardown is exercised faithfully.
 */
export class FakeSpawnedProcess implements ISpawnedProcess {
  private readonly stdoutEmitter = new Emitter<Buffer>();
  private readonly stderrEmitter = new Emitter<Buffer>();
  private readonly exitEmitter = new Emitter<{ code: number | null; signal: string | null }>();
  private readonly errorEmitter = new Emitter<Error>();

  /** OS process id; settable so tests can model a synchronous pid or its absence. */
  public pid: number | undefined;

  /** Every signal passed to {@link kill}, in call order (e.g. `['SIGTERM','SIGKILL']`). */
  public readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  /** `true` once {@link kill} has been called at least once. */
  public killed = false;

  /** `true` once {@link emitExit} or {@link emitError} has run (the child has ended). */
  public exited = false;

  /**
   * @param pid - Initial pid (default `1234`). Pass `undefined` to model a spawn
   *   whose pid is not known synchronously.
   */
  public constructor(pid: number | undefined = 1234) {
    this.pid = pid;
  }

  /** @inheritdoc */
  public onStdout(listener: (chunk: Buffer) => void): IDisposable {
    return this.stdoutEmitter.event(listener);
  }

  /** @inheritdoc */
  public onStderr(listener: (chunk: Buffer) => void): IDisposable {
    return this.stderrEmitter.event(listener);
  }

  /** @inheritdoc */
  public onExit(listener: (code: number | null, signal: string | null) => void): IDisposable {
    return this.exitEmitter.event(({ code, signal }) => listener(code, signal));
  }

  /** @inheritdoc */
  public onError(listener: (error: Error) => void): IDisposable {
    return this.errorEmitter.event(listener);
  }

  /** @inheritdoc */
  public kill(signal?: NodeJS.Signals): void {
    this.killSignals.push(signal);
    this.killed = true;
  }

  // -- Convenience accessors for assertions ----------------------------------

  /** Number of graceful-terminate signals delivered (`SIGTERM`, or no explicit signal). */
  public get terminateCount(): number {
    return this.killSignals.filter((s) => s === 'SIGTERM' || s === undefined).length;
  }

  /** Number of force-kill signals delivered (`SIGKILL`). */
  public get forceKillCount(): number {
    return this.killSignals.filter((s) => s === 'SIGKILL').length;
  }

  /** `true` if the runner asked for a graceful terminate (`SIGTERM`). */
  public terminated(): boolean {
    return this.terminateCount > 0;
  }

  /** `true` if the runner escalated to a force kill (`SIGKILL`). */
  public forceKilled(): boolean {
    return this.forceKillCount > 0;
  }

  // -- Scripting (drive the lifecycle from a test) ---------------------------

  /** Emits a chunk on stdout. */
  public emitStdout(chunk: Buffer | string): void {
    this.stdoutEmitter.fire(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }

  /** Emits a chunk on stderr. */
  public emitStderr(chunk: Buffer | string): void {
    this.stderrEmitter.fire(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }

  /**
   * Emits process exit (idempotent: a second call after the child has ended is
   * ignored, mirroring a real child that exits/errors exactly once).
   *
   * @param code - Exit code, or `null` if killed by a signal.
   * @param signal - Terminating signal, or `null` on a normal exit.
   */
  public emitExit(code: number | null = 0, signal: string | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitEmitter.fire({ code, signal });
  }

  /**
   * Emits a spawn/runtime error (idempotent once ended).
   *
   * @param error - The error to deliver (default an ENOENT-flavoured Error).
   */
  public emitError(error: Error = new Error('spawn ENOENT')): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.errorEmitter.fire(error);
  }

  /** Disposes the underlying emitters (called by tests that want a clean teardown). */
  public dispose(): void {
    this.stdoutEmitter.dispose();
    this.stderrEmitter.dispose();
    this.exitEmitter.dispose();
    this.errorEmitter.dispose();
  }
}

/**
 * A scriptable {@link IProcessSpawner}.
 *
 * Records every {@link SpawnOptions} and hands back a {@link FakeSpawnedProcess}.
 * By default each spawn produces a fresh process with an auto-incrementing pid; a
 * test can instead enqueue specific processes via {@link enqueue} (e.g. to model
 * a pid-less spawn, or a process it wants a reference to before spawning).
 */
export class FakeProcessSpawner implements IProcessSpawner {
  /** Every spawn request, in call order. */
  public readonly requests: SpawnOptions[] = [];

  /** Every process handed out, in spawn order (parallel to {@link requests}). */
  public readonly spawned: FakeSpawnedProcess[] = [];

  /** Pre-seeded processes returned (FIFO) before the auto-pid fallback kicks in. */
  private readonly queue: FakeSpawnedProcess[] = [];

  /** Source for auto-assigned pids when the queue is empty. */
  private nextPid = 1000;

  /**
   * Enqueues a specific process to return on the next spawn(s), in order.
   *
   * @param proc - The process to hand out next.
   * @returns The same process, for convenient capture at the call site.
   */
  public enqueue(proc: FakeSpawnedProcess): FakeSpawnedProcess {
    this.queue.push(proc);
    return proc;
  }

  /** @inheritdoc */
  public spawn(options: SpawnOptions): ISpawnedProcess {
    this.requests.push(options);
    const proc = this.queue.shift() ?? new FakeSpawnedProcess(this.nextPid++);
    this.spawned.push(proc);
    return proc;
  }

  /** @returns The most recent spawn request, or `undefined` if none. */
  public get lastRequest(): SpawnOptions | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** @returns The most recently spawned process, or `undefined` if none. */
  public get lastSpawned(): FakeSpawnedProcess | undefined {
    return this.spawned[this.spawned.length - 1];
  }
}

/** Re-export of {@link Event} kept handy for fakes that surface their own events. */
export type { Event };
