/**
 * {@link IProcessSpawner} backed by `child_process.spawn`.
 *
 * This is the highest-risk adapter in the extension: a mishandled child process
 * can orphan grandchildren or crash the extension host. It therefore:
 * - attaches an `error` listener **before anything else** (an unhandled child
 *   `error` event throws and would crash the host);
 * - spawns POSIX children `detached` so the whole process *group* can be killed
 *   with a negative pid, and kills the *tree* on Windows via `taskkill /T`
 *   (graceful for SIGTERM, `/F` only for the SIGKILL escalation);
 * - runs `taskkill` through the async, non-blocking `spawn` so a stop never
 *   stalls the extension-host event loop;
 * - wraps every `process.kill`/`taskkill` in try/catch (or an `error` listener)
 *   so an `ESRCH`/`EPERM` race (the child already exited) can never throw.
 *
 * @remarks Host-aware adapter. Allowed to import `child_process`. Wired up only
 * in `extension.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { Emitter, type IDisposable } from '../util/event';
import type { IProcessSpawner, ISpawnedProcess, SpawnOptions } from '../types/contracts';

/** `true` on Windows, where group-kill is unavailable and `taskkill /T` is used. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * A live child process exposing only the narrow {@link ISpawnedProcess} surface.
 */
class NodeSpawnedProcess implements ISpawnedProcess {
  private readonly stdoutEmitter = new Emitter<Buffer>();
  private readonly stderrEmitter = new Emitter<Buffer>();
  private readonly exitEmitter = new Emitter<{ code: number | null; signal: string | null }>();
  private readonly errorEmitter = new Emitter<Error>();

  /** `true` once the child has exited or errored (guards kills/double-emits). */
  private ended = false;

  /** Whether this child was spawned in its own process group (POSIX group-kill). */
  private readonly detached: boolean;

  /**
   * @param child - The underlying spawned process.
   * @param detached - Whether the child leads its own group (set at spawn time).
   */
  public constructor(
    private readonly child: ChildProcess,
    detached: boolean
  ) {
    this.detached = detached && !IS_WINDOWS;

    // CRITICAL: attach 'error' first so a synchronous spawn failure (ENOENT) is
    // captured rather than thrown as an unhandled error that crashes the host.
    child.on('error', (err: Error) => {
      if (this.ended) {
        return;
      }
      this.ended = true;
      this.errorEmitter.fire(err);
    });

    child.stdout?.on('data', (chunk: Buffer) => this.stdoutEmitter.fire(asBuffer(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => this.stderrEmitter.fire(asBuffer(chunk)));

    child.on('exit', (code, signal) => {
      if (this.ended) {
        return;
      }
      this.ended = true;
      this.exitEmitter.fire({ code, signal });
    });
  }

  /** @inheritdoc */
  public get pid(): number | undefined {
    return this.child.pid;
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
  public kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.ended) {
      return;
    }
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }

    if (IS_WINDOWS) {
      this.killWindows(pid, signal);
      return;
    }
    this.killPosix(pid, signal);
  }

  /**
   * POSIX kill: target the whole process group with a negative pid (requires the
   * `detached` spawn). Falls back to killing just the child if the group kill
   * races/fails, and tolerates `ESRCH`/`EPERM` silently.
   */
  private killPosix(pid: number, signal: NodeJS.Signals): void {
    if (this.detached) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        /* group already gone or not permitted — fall back to the child below */
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      /* ESRCH/EPERM race: the child is already gone */
    }
  }

  /**
   * Windows kill via `taskkill /T` over the whole process tree (the only reliable
   * way to avoid orphaned grandchildren). SIGTERM requests a graceful tree
   * termination; SIGKILL adds `/F` to force it, so the runner's SIGTERM, grace,
   * then SIGKILL escalation has real meaning on Windows instead of always force-killing.
   *
   * Runs through the async `spawn` (never the blocking `spawnSync`) so a stop
   * cannot stall the host event loop. The child's own `exit` event still drives
   * lifecycle; this only sends the kill. A `taskkill` that is missing or races the
   * child's exit falls back to terminating just the child.
   */
  private killWindows(pid: number, signal: NodeJS.Signals): void {
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') {
      args.push('/F');
    }
    try {
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      // An async failure (taskkill missing, or the child already gone) must never
      // surface as an unhandled 'error' that crashes the host.
      killer.on('error', () => {
        try {
          this.child.kill();
        } catch {
          /* already gone */
        }
      });
    } catch {
      /* spawn itself threw - best-effort fall back to the child kill */
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Coerces a stream chunk to a {@link Buffer} (data may arrive as a string). */
function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
}

/** Implements {@link IProcessSpawner} over `child_process.spawn`. */
export class NodeProcessSpawner implements IProcessSpawner {
  /** @inheritdoc */
  public spawn(options: SpawnOptions): ISpawnedProcess {
    const detached = options.detached ?? !IS_WINDOWS;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd && options.cwd.trim().length > 0 ? options.cwd : undefined,
      env: options.env,
      windowsHide: true,
      detached,
      // No stdin; pipe stdout/stderr so we can stream them.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    return new NodeSpawnedProcess(child, detached);
  }
}
