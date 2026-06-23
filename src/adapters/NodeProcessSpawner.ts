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
import { statSync } from 'node:fs';

import { Emitter, type IDisposable } from '../util/event';
import {
  DEFAULT_PATHEXT,
  planWindowsSpawn,
  type WindowsSpawnPlan,
} from './windowsCommand';
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

    // On Windows, a bare `npm`/`yarn`/`composer`/… resolves to a `.cmd` shim
    // that `spawn` cannot launch without a shell (`spawn npm ENOENT`). Resolve
    // it and, when it is a batch shim, route it through `cmd.exe` with escaped
    // args. Real `.exe`/`.com` programs (and every shell-mode invocation, whose
    // command is itself `cmd.exe`/`powershell.exe`/…) are spawned unchanged.
    const plan: WindowsSpawnPlan = IS_WINDOWS
      ? this.planForWindows(options)
      : { command: options.command, args: options.args, windowsVerbatimArguments: false };

    const child = spawn(plan.command, plan.args, {
      cwd: options.cwd && options.cwd.trim().length > 0 ? options.cwd : undefined,
      env: options.env,
      windowsHide: true,
      detached,
      // No stdin; pipe stdout/stderr so we can stream them.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    return new NodeSpawnedProcess(child, detached);
  }

  /**
   * Resolves the Windows spawn plan for a command: a real executable is spawned
   * directly; a `.cmd`/`.bat` shim is rewritten to run through `cmd.exe`. Reads
   * `PATH`/`PATHEXT`/`ComSpec` from the child's resolved environment (falling
   * back to the host's), since that is the environment the command will run in.
   */
  private planForWindows(options: SpawnOptions): WindowsSpawnPlan {
    const env = options.env ?? process.env;
    const pathValue = lookupEnv(env, 'PATH') ?? '';
    const pathExtValue = lookupEnv(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
    const comspec = lookupEnv(env, 'ComSpec') ?? 'cmd.exe';
    const cwd = options.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();

    return planWindowsSpawn(options.command, options.args, {
      pathDirs: splitWindowsList(pathValue).map(stripQuotes),
      pathExt: splitWindowsList(pathExtValue).map((ext) => ext.toLowerCase()),
      cwd,
      comspec,
      fileExists: fileExistsSync,
    });
  }
}

/** `true` if a regular file exists at `candidatePath` (any I/O error → `false`). */
function fileExistsSync(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

/** Splits a Windows `;`-separated list (`PATH`/`PATHEXT`), dropping empty entries. */
function splitWindowsList(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Strips a single pair of surrounding double quotes from a `PATH` entry. */
function stripQuotes(entry: string): string {
  return entry.replace(/^"(.*)"$/, '$1');
}

/**
 * Reads an environment variable case-insensitively. Windows env vars are
 * case-insensitive, but the merged env object handed to the spawner is a plain
 * object whose keys keep their original case (often `Path`, not `PATH`), so a
 * direct lookup can miss. Falls back to the host's `process.env`.
 */
function lookupEnv(
  env: Record<string, string | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target && env[key] !== undefined) {
      return env[key];
    }
  }
  return process.env[name];
}
