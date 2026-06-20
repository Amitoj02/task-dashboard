/**
 * The pure process engine: spawns, observes, and stops child processes for one
 * running instance at a time, keyed by {@link RunningInstanceId}.
 *
 * `TaskRunner` knows nothing about the lifecycle state machine, definitions, or
 * the store — it is a thin, testable layer over {@link IProcessSpawner} that:
 * builds spawn options from a validated definition, retains a bounded output
 * tail per instance, re-emits stdout/stderr/exit/error, and runs the graceful
 * stop sequence (SIGTERM, then SIGKILL after a grace window; group-kill on POSIX
 * via `detached` spawn, `taskkill` tree-kill is the spawner's concern). Every
 * spawner callback is defended so a misbehaving child can never crash the host.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`. All collaborators arrive via the constructor.
 */

import { Emitter, type Event, type IDisposable } from '../util/event';
import { RingBuffer } from '../util/RingBuffer';
import { needsShell, splitArgv } from '../util/shlex';
import type {
  IProcessSpawner,
  ISpawnedProcess,
  ITimerHandle,
  ITimers,
  SpawnOptions,
} from '../types/contracts';
import type { RunningInstanceId } from '../types/ids';
import type { TaskDefinition } from '../models/TaskDefinition';

/** Tuning knobs for the runner, sourced from configuration. */
export interface TaskRunnerOptions {
  /** Per-instance in-memory output tail size, in bytes. */
  logRetentionBytes: number;

  /** Shell used when a task opts into shell execution without naming its own. */
  defaultShell: string;
}

/** Output produced by a running instance. */
export interface RunnerOutput {
  /** The producing instance. */
  instanceId: RunningInstanceId;

  /** The raw bytes (stdout or stderr). */
  chunk: Buffer;
}

/** Terminal status delivered when a process ends. */
export interface RunnerExit {
  /** The instance that ended. */
  instanceId: RunningInstanceId;

  /** Exit code, if it exited with one. */
  code?: number;

  /** Terminating signal name, if killed by a signal. */
  signal?: string;

  /** `true` when the exit followed a user/owner-requested stop. */
  requested: boolean;
}

/** Spawn-time failure (ENOENT/EACCES, …) delivered before any `running`. */
export interface RunnerError {
  /** The instance that failed to start (or errored at runtime). */
  instanceId: RunningInstanceId;

  /** The underlying error. */
  error: Error;
}

/** Reports that a process is confirmed alive with a pid. */
export interface RunnerStarted {
  /** The now-running instance. */
  instanceId: RunningInstanceId;

  /** The OS process id. */
  pid: number;
}

/** Internal per-instance bookkeeping the runner owns. */
interface ProcessEntry {
  /** The spawned child. */
  proc: ISpawnedProcess;

  /** Bounded retained output tail. */
  buffer: RingBuffer;

  /** Subscriptions to the child's stdout/stderr/exit/error events. */
  subscriptions: IDisposable[];

  /** Pending SIGKILL-escalation timer, if a stop is in flight. */
  killTimer?: ITimerHandle;

  /** `true` once a stop has been requested for this instance. */
  intentToStop: boolean;

  /** `true` once the child's exit/error has been processed (guards double-emit). */
  ended: boolean;
}

/** Default grace before SIGKILL when none is supplied. */
const DEFAULT_GRACE_MS = 5000;

/**
 * Spawns and supervises child processes on behalf of the {@link TaskManager}.
 */
export class TaskRunner implements IDisposable {
  /** Live (and stopping) child processes, keyed by instance id. */
  private readonly processes = new Map<RunningInstanceId, ProcessEntry>();

  /** Emits one event per stdout/stderr chunk. */
  private readonly outputEmitter = new Emitter<RunnerOutput>();

  /** Emits once a child is confirmed spawned (has a pid). */
  private readonly startedEmitter = new Emitter<RunnerStarted>();

  /** Emits once per process exit. */
  private readonly exitEmitter = new Emitter<RunnerExit>();

  /** Emits on spawn/runtime error. */
  private readonly errorEmitter = new Emitter<RunnerError>();

  /** Set once disposed; blocks further spawns. */
  private disposed = false;

  /** Fires for each chunk of stdout/stderr produced by a live instance. */
  public readonly onDidOutput: Event<RunnerOutput> = this.outputEmitter.event;

  /** Fires once a child is confirmed spawned with a pid. */
  public readonly onDidStart: Event<RunnerStarted> = this.startedEmitter.event;

  /** Fires once per process exit. */
  public readonly onDidExit: Event<RunnerExit> = this.exitEmitter.event;

  /** Fires on spawn/runtime error (the process never reaches `running`). */
  public readonly onDidError: Event<RunnerError> = this.errorEmitter.event;

  /**
   * @param spawner - The process-creation seam.
   * @param timers - Scheduler used for the SIGKILL grace window.
   * @param options - Tuning knobs (retention size, default shell).
   */
  public constructor(
    private readonly spawner: IProcessSpawner,
    private readonly timers: ITimers,
    private options: TaskRunnerOptions
  ) {}

  /**
   * Updates runner options at runtime (e.g. after a settings change). Only
   * affects subsequently-spawned instances.
   *
   * @param options - The new options.
   */
  public setOptions(options: TaskRunnerOptions): void {
    this.options = options;
  }

  /**
   * Spawns a child for `instanceId` from a validated definition.
   *
   * The `error` listener is attached *first* so a synchronous spawn failure can
   * never escape as an unhandled error. Returns the OS pid if one was assigned
   * synchronously, else `undefined` (the pid still arrives via {@link onDidStart}).
   *
   * @param instanceId - The instance this process belongs to.
   * @param def - The definition to run (treated as untrusted).
   * @param resolvedCwd - The already-resolved working directory, or `undefined`.
   * @returns The pid if known synchronously, else `undefined`.
   */
  public start(
    instanceId: RunningInstanceId,
    def: TaskDefinition,
    resolvedCwd: string | undefined
  ): number | undefined {
    if (this.disposed || this.processes.has(instanceId)) {
      return undefined;
    }

    const spawnOptions = this.buildSpawnOptions(def, resolvedCwd);
    const proc = this.spawner.spawn(spawnOptions);

    const entry: ProcessEntry = {
      proc,
      buffer: new RingBuffer(this.options.logRetentionBytes),
      subscriptions: [],
      intentToStop: false,
      ended: false,
    };
    this.processes.set(instanceId, entry);

    // Attach error handling BEFORE anything else (unhandled child 'error' throws).
    entry.subscriptions.push(
      proc.onError((error) => this.handleError(instanceId, error)),
      proc.onStdout((chunk) => this.handleOutput(instanceId, chunk)),
      proc.onStderr((chunk) => this.handleOutput(instanceId, chunk)),
      proc.onExit((code, signal) => this.handleExit(instanceId, code, signal))
    );

    if (typeof proc.pid === 'number') {
      this.startedEmitter.fire({ instanceId, pid: proc.pid });
    }
    return proc.pid;
  }

  /**
   * Initiates a graceful stop: SIGTERM now, escalating to SIGKILL after the
   * grace window if the process is still alive.
   *
   * Safe to call repeatedly and on unknown ids. The actual SIGTERM/SIGKILL calls
   * are made through {@link ISpawnedProcess.kill}, which is itself try/catch
   * wrapped against ESRCH/EPERM races.
   *
   * @param instanceId - The instance to stop.
   * @param graceMs - Milliseconds to wait before SIGKILL (default 5000).
   */
  public stop(instanceId: RunningInstanceId, graceMs: number = DEFAULT_GRACE_MS): void {
    const entry = this.processes.get(instanceId);
    if (!entry || entry.ended) {
      return;
    }
    entry.intentToStop = true;

    entry.proc.kill('SIGTERM');

    // Escalate to SIGKILL if it has not exited within the grace window.
    if (entry.killTimer) {
      entry.killTimer.cancel();
    }
    const grace = Math.max(0, graceMs);
    entry.killTimer = this.timers.setTimeout(() => {
      const current = this.processes.get(instanceId);
      if (current && !current.ended) {
        current.proc.kill('SIGKILL');
      }
    }, grace);
  }

  /**
   * Returns the retained output tail for an instance.
   *
   * @param instanceId - The instance id.
   * @returns A copy of the retained bytes (empty if unknown).
   */
  public getBufferedOutput(instanceId: RunningInstanceId): Buffer {
    return this.processes.get(instanceId)?.buffer.toBuffer() ?? Buffer.alloc(0);
  }

  /**
   * Reports whether an instance currently has a live child process.
   *
   * @param instanceId - The instance id.
   * @returns `true` while the process exists and has not yet ended.
   */
  public isRunning(instanceId: RunningInstanceId): boolean {
    const entry = this.processes.get(instanceId);
    return !!entry && !entry.ended;
  }

  /** Disposes the runner: SIGTERMs every live child and tears down all listeners. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const [, entry] of this.processes) {
      entry.killTimer?.cancel();
      for (const sub of entry.subscriptions) {
        sub.dispose();
      }
      // Best-effort terminate so we never orphan children on host shutdown.
      entry.proc.kill('SIGTERM');
    }
    this.processes.clear();

    this.outputEmitter.dispose();
    this.startedEmitter.dispose();
    this.exitEmitter.dispose();
    this.errorEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Buffers and re-emits a chunk of process output. */
  private handleOutput(instanceId: RunningInstanceId, chunk: Buffer): void {
    const entry = this.processes.get(instanceId);
    if (!entry) {
      return;
    }
    entry.buffer.append(chunk);
    this.outputEmitter.fire({ instanceId, chunk });
  }

  /** Handles a spawn/runtime error: cleans up and emits a single error event. */
  private handleError(instanceId: RunningInstanceId, error: Error): void {
    const entry = this.processes.get(instanceId);
    if (!entry || entry.ended) {
      return;
    }
    entry.ended = true;
    this.cleanup(instanceId, entry);
    this.errorEmitter.fire({ instanceId, error });
  }

  /** Handles process exit: cleans up and emits a single exit event. */
  private handleExit(
    instanceId: RunningInstanceId,
    code: number | null,
    signal: string | null
  ): void {
    const entry = this.processes.get(instanceId);
    if (!entry || entry.ended) {
      return;
    }
    entry.ended = true;
    const requested = entry.intentToStop;
    this.cleanup(instanceId, entry);
    this.exitEmitter.fire({
      instanceId,
      code: code ?? undefined,
      signal: signal ?? undefined,
      requested,
    });
  }

  /**
   * Tears down listeners and the pending kill timer for an instance and removes
   * it from the live map. The ring buffer is intentionally *not* preserved here:
   * once the process is gone, the terminal renderer holds the scrollback.
   */
  private cleanup(instanceId: RunningInstanceId, entry: ProcessEntry): void {
    entry.killTimer?.cancel();
    entry.killTimer = undefined;
    for (const sub of entry.subscriptions) {
      sub.dispose();
    }
    entry.subscriptions = [];
    this.processes.delete(instanceId);
  }

  /**
   * Builds spawn options from a definition.
   *
   * Shell execution is used when the definition names a shell, when configuration
   * provides a default shell, or when the command itself relies on shell features
   * ({@link needsShell}) — in which case the platform's default shell is used so
   * commands like `pnpm build && pnpm dev` work without extra configuration. In
   * shell mode the binary is spawned with the command as a single argv element
   * via the platform's "run this string" flag — never string-concatenated, never
   * evaluated. Otherwise (a plain `program args` command) the command is split
   * into argv via a lexical splitter and the program is spawned directly.
   */
  private buildSpawnOptions(def: TaskDefinition, resolvedCwd: string | undefined): SpawnOptions {
    const env = this.buildEnv(def);
    const detached = process.platform !== 'win32';

    const explicitShell = (def.shell && def.shell.trim()) || this.options.defaultShell.trim();
    const shell = explicitShell || (needsShell(def.command) ? platformDefaultShell() : '');
    if (shell) {
      return {
        command: shell,
        args: shellArgsFor(shell, def.command),
        cwd: resolvedCwd,
        env,
        detached,
      };
    }

    const argv = splitArgv(def.command);
    const [program, ...args] = argv.length > 0 ? argv : [def.command];
    return {
      command: program,
      args,
      cwd: resolvedCwd,
      env,
      detached,
    };
  }

  /** Merges the definition's env vars over the inherited process environment. */
  private buildEnv(def: TaskDefinition): Record<string, string | undefined> {
    return { ...process.env, ...(def.environmentVariables ?? {}) };
  }
}

/**
 * The platform's default shell, used when a command needs shell features but the
 * task and configuration name no shell. Honours the user's `SHELL`/`ComSpec`
 * environment, falling back to `/bin/sh` (POSIX) or `cmd.exe` (Windows).
 *
 * @returns The shell executable path or name.
 */
function platformDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

/**
 * Chooses the correct "run this command string" argv for a given shell binary,
 * passing the command as a single element so it is never re-parsed by us.
 *
 * @param shell - The shell executable path or name.
 * @param command - The command line to run inside the shell.
 * @returns The argv to pass alongside the shell binary.
 */
function shellArgsFor(shell: string, command: string): string[] {
  const lower = shell.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh')) {
    return ['-Command', command];
  }
  if (lower.includes('cmd')) {
    return ['/d', '/s', '/c', command];
  }
  // POSIX shells (sh/bash/zsh/fish/...) and anything else: -c "<command>".
  return ['-c', command];
}
