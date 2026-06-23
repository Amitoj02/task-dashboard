/**
 * Windows command resolution for the direct-spawn path.
 *
 * On Windows, `child_process.spawn(file, args)` with `shell: false` can only
 * launch real executable images (`.exe`/`.com`). It **cannot** run the batch
 * shims (`.cmd`/`.bat`) that almost every Node/PHP/etc. CLI installs — `npm`,
 * `npx`, `yarn`, `pnpm`, `composer`, `tsc`, `eslint`, … are all `*.cmd` files.
 * Spawning `npm` directly therefore fails with `spawn npm ENOENT`, even though
 * the very same command runs fine in a terminal (a terminal is a shell, which
 * resolves `PATHEXT` and hands `.cmd` files to `cmd.exe`).
 *
 * This module reproduces, dependency-free, the minimal slice of what a shell
 * does: it resolves a bare command against `PATH`/`PATHEXT`, and when the match
 * is a batch shim it rewrites the spawn to run through `cmd.exe /d /s /c` with
 * every token escaped so the arguments still arrive **literally** (no shell
 * interpretation). A real `.exe`/`.com` is still spawned directly, preserving
 * the extension's documented "parse to argv, spawn the program directly" model.
 *
 * The escaping algorithm is ported from the battle-tested `cross-spawn`
 * (MIT-licensed) so quoting and `cmd.exe` meta-character handling match a tool
 * that npm, jest, and webpack rely on — without taking on a runtime dependency.
 *
 * The logic is pure: all filesystem access arrives through an injected
 * {@link FileExists} probe, so it is fully unit-testable on any OS (it always
 * uses `path.win32` semantics regardless of the host platform).
 *
 * @remarks Host-aware adapter helper. Must not be imported by the pure core.
 */

import * as path from 'node:path';

/** `cmd.exe` meta-characters that must be `^`-escaped (see the cross-spawn notes). */
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Extensions that name a real executable image, runnable without a shell. */
const EXECUTABLE_EXTS = new Set(['.exe', '.com']);

/**
 * Matches a local npm bin-shim (`node_modules/.bin/<name>.cmd`). Such shims
 * re-invoke a nested `cmd.exe`, so their arguments need meta-characters escaped
 * twice — exactly as `cross-spawn` does.
 */
const NODE_BIN_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * The default Windows `PATHEXT` list, used when the environment does not provide
 * one. Order is significant: a bare `foo` resolves to the first `foo<ext>` found.
 */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Probes whether a regular file exists at `candidatePath`. Injected so the
 * resolver can be exercised deterministically in tests without touching disk.
 */
export type FileExists = (candidatePath: string) => boolean;

/** Injected inputs for {@link resolveWindowsCommandPath}. */
export interface WindowsResolveDeps {
  /** Directories from `PATH`, in search order (already split/trimmed). */
  pathDirs: string[];

  /** Executable extensions from `PATHEXT`, lower-cased and including the dot. */
  pathExt: string[];

  /** Working directory used to resolve a command given as a relative path. */
  cwd: string;

  /** File-existence probe. */
  fileExists: FileExists;
}

/** The concrete `command`/`args` (and Node spawn flag) to hand to `spawn`. */
export interface WindowsSpawnPlan {
  /** The program to spawn: the original command, or `cmd.exe` when wrapped. */
  command: string;

  /** The argument vector (the original args, or the `cmd.exe /c` invocation). */
  args: string[];

  /**
   * `true` only for the `cmd.exe` wrapper: the args are already fully escaped,
   * so Node must pass them verbatim rather than re-quoting them.
   */
  windowsVerbatimArguments: boolean;
}

/**
 * Reports whether `ext` names a directly-spawnable executable image.
 *
 * @param ext - A file extension including the leading dot (any case).
 * @returns `true` for `.exe`/`.com`, else `false`.
 */
export function isWindowsExecutableExt(ext: string): boolean {
  return EXECUTABLE_EXTS.has(ext.toLowerCase());
}

/**
 * Resolves a command to the concrete file `cmd.exe`/`CreateProcess` would run,
 * mirroring Windows lookup rules: an explicit extension is trusted; a command
 * with a path separator is resolved against `cwd`; a bare name is searched
 * across `PATH`, trying each `PATHEXT` extension in order.
 *
 * @param command - The program token (bare name, or relative/absolute path).
 * @param deps - Injected `PATH`/`PATHEXT`, cwd, and the file probe.
 * @returns The resolved absolute/relative file path, or `undefined` if nothing
 *   matches (in which case the caller spawns the command as-is so a genuine
 *   "not found" still surfaces as `ENOENT`).
 */
export function resolveWindowsCommandPath(
  command: string,
  deps: WindowsResolveDeps
): string | undefined {
  const w = path.win32;
  const hasExplicitExt = w.extname(command) !== '';

  // Candidates for a given base path: the bare base (only when it already names
  // an extension), followed by base + each PATHEXT entry.
  const candidates = (base: string): string[] => {
    const list: string[] = [];
    if (hasExplicitExt) {
      list.push(base);
    }
    for (const ext of deps.pathExt) {
      list.push(base + ext);
    }
    return list;
  };

  const firstExisting = (bases: string[]): string | undefined => {
    for (const base of bases) {
      for (const candidate of candidates(base)) {
        if (deps.fileExists(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  };

  // A path (absolute or containing a separator) is resolved against the cwd and
  // never searched on PATH.
  if (w.isAbsolute(command) || /[\\/]/.test(command)) {
    const base = w.isAbsolute(command) ? command : w.resolve(deps.cwd, command);
    return firstExisting([base]);
  }

  // A bare name is searched across each PATH directory in order.
  return firstExisting(deps.pathDirs.map((dir) => w.join(dir, command)));
}

/**
 * Builds the {@link WindowsSpawnPlan} for a direct-spawn command on Windows.
 *
 * A command that resolves to a real `.exe`/`.com` (or that cannot be resolved at
 * all) is spawned unchanged, so genuine executables keep their literal argv and
 * a missing command still fails with `ENOENT`. A command that resolves to a
 * batch shim (`.cmd`/`.bat`, …) is rewritten to run through `cmd.exe`.
 *
 * @param command - The program token from the split command line.
 * @param args - The remaining argv tokens.
 * @param deps - Resolution inputs plus the `cmd.exe` path (`comspec`).
 * @returns The command/args to spawn and whether they are pre-escaped.
 */
export function planWindowsSpawn(
  command: string,
  args: string[],
  deps: WindowsResolveDeps & { comspec: string }
): WindowsSpawnPlan {
  const resolved = resolveWindowsCommandPath(command, deps);

  // Not found, or a real executable image: spawn exactly as requested.
  if (resolved === undefined || isWindowsExecutableExt(path.win32.extname(resolved))) {
    return { command, args, windowsVerbatimArguments: false };
  }

  // A batch shim: route through cmd.exe with fully-escaped tokens so the args
  // are delivered literally (no shell interpretation of metacharacters).
  const doubleEscape = NODE_BIN_CMD_SHIM.test(resolved);
  const line = [escapeCmdCommand(command), ...args.map((arg) => escapeCmdArgument(arg, doubleEscape))].join(
    ' '
  );
  return {
    command: deps.comspec,
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Escapes the program token of a `cmd.exe` command line: `cmd.exe`
 * meta-characters are `^`-escaped (the program name is never quoted).
 *
 * @param token - The program token.
 * @returns The escaped token.
 */
export function escapeCmdCommand(token: string): string {
  return token.replace(META_CHARS, '^$1');
}

/**
 * Escapes a single argument for a `cmd.exe` command line so it is delivered to
 * the target program as one literal argument. Ported from `cross-spawn`'s
 * `escapeArgument` (which is in turn based on https://qntm.org/cmd):
 *
 * 1. double any run of backslashes that precedes a `"`, then escape the `"`;
 * 2. double any trailing backslashes (they would otherwise escape the closing `"`);
 * 3. wrap the whole argument in double quotes;
 * 4. `^`-escape `cmd.exe` meta-characters — twice when the target is a nested
 *    `node_modules/.bin/*.cmd` shim.
 *
 * @param token - The raw argument.
 * @param doubleEscapeMetaChars - Escape meta-characters a second time (for local
 *   npm bin shims that re-invoke `cmd.exe`).
 * @returns The escaped, quoted argument.
 */
export function escapeCmdArgument(token: string, doubleEscapeMetaChars = false): string {
  let arg = `${token}`;

  // Backslashes before a quote, and trailing backslashes, must be doubled.
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  arg = arg.replace(/(\\*)$/, '$1$1');

  // Quote the whole argument, then escape cmd.exe meta-characters.
  arg = `"${arg}"`;
  arg = arg.replace(META_CHARS, '^$1');
  if (doubleEscapeMetaChars) {
    arg = arg.replace(META_CHARS, '^$1');
  }

  return arg;
}
