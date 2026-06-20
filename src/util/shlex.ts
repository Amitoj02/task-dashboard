/**
 * A minimal, dependency-free argv splitter (a "shlex").
 *
 * When a task does not opt into shell execution, the runner spawns the program
 * directly with `shell: false` — which requires the command line split into an
 * argv array. This splitter performs that split with POSIX-like quoting rules,
 * *never* evaluating the string: it expands no variables, runs no substitutions,
 * and honours no operators. It is purely lexical, so a hostile config string can
 * do nothing beyond producing odd argv tokens.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

/**
 * Splits a command line into an argv array using POSIX-like quoting.
 *
 * Rules:
 * - Unquoted whitespace separates tokens.
 * - Single quotes preserve everything literally (no escapes inside).
 * - Double quotes preserve everything except a backslash before `"` or `\`.
 * - Outside quotes, a backslash escapes the next character.
 *
 * The split is lexical only — no expansion or evaluation of any kind occurs.
 *
 * @param command - The command line to split.
 * @returns The argv tokens. An empty/whitespace-only input yields `[]`.
 */
export function splitArgv(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;

  let mode: 'normal' | 'single' | 'double' = 'normal';
  let i = 0;
  const n = command.length;

  const pushChar = (ch: string): void => {
    current += ch;
    hasToken = true;
  };

  const endToken = (): void => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  while (i < n) {
    const ch = command[i];

    if (mode === 'single') {
      if (ch === "'") {
        mode = 'normal';
      } else {
        pushChar(ch);
      }
      i++;
      continue;
    }

    if (mode === 'double') {
      if (ch === '"') {
        mode = 'normal';
      } else if (ch === '\\' && i + 1 < n && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        pushChar(command[i + 1]);
        i++;
      } else {
        pushChar(ch);
      }
      i++;
      continue;
    }

    // mode === 'normal'
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      endToken();
    } else if (ch === "'") {
      mode = 'single';
      hasToken = true; // an empty '' is still a token
    } else if (ch === '"') {
      mode = 'double';
      hasToken = true; // an empty "" is still a token
    } else if (ch === '\\' && i + 1 < n) {
      pushChar(command[i + 1]);
      i++;
    } else {
      pushChar(ch);
    }
    i++;
  }

  endToken();
  return tokens;
}

/**
 * Heuristically detects whether a command line relies on shell features —
 * operators (`&&`, `||`, `;`), pipes (`|`), redirections (`<`, `>`), variable or
 * command substitution (`$`, backtick), subshells (`(`, `)`), brace/glob
 * expansion (`{`, `}`, `*`, `?`), home expansion (`~`), or multiple lines — and
 * therefore cannot be run by spawning a single program with a split argv.
 *
 * Detection is purely lexical; the string is never evaluated. When this returns
 * `true` and the task names no shell, the runner runs the command through the
 * platform's default shell so commands like `pnpm build && pnpm dev` work as a
 * user would expect from a terminal. Quote characters are intentionally excluded
 * — quoting is handled losslessly by {@link splitArgv} and does not require a
 * shell.
 *
 * @param command - The command line to inspect.
 * @returns `true` if the command needs a shell to execute correctly.
 */
export function needsShell(command: string): boolean {
  return /[|&;<>$`(){}*?~\n]/.test(command);
}
