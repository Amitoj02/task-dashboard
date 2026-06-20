/**
 * Unit tests for {@link splitArgv}: the lexical command-line splitter used to
 * spawn programs directly (no shell) from an untrusted command string.
 *
 * Focus areas: token separation, single/double quoting, backslash escaping, and
 * the guarantee that the splitter is purely lexical (it never expands variables,
 * runs substitutions, or honours shell metacharacters/operators — those are left
 * verbatim as ordinary characters in tokens).
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { needsShell, splitArgv } from '../../util/shlex';

describe('splitArgv (parseCommand)', () => {
  it('splits on runs of unquoted whitespace', () => {
    assert.deepEqual(splitArgv('node server.js --port 3000'), [
      'node',
      'server.js',
      '--port',
      '3000',
    ]);
    assert.deepEqual(splitArgv('  a\t b\n c \r d  '), ['a', 'b', 'c', 'd']);
  });

  it('returns [] for empty or whitespace-only input', () => {
    assert.deepEqual(splitArgv(''), []);
    assert.deepEqual(splitArgv('   \t \n '), []);
  });

  it('preserves everything inside single quotes literally', () => {
    assert.deepEqual(splitArgv("echo 'hello world'"), ['echo', 'hello world']);
    // No escapes inside single quotes: backslash is literal.
    assert.deepEqual(splitArgv("echo 'a\\nb'"), ['echo', 'a\\nb']);
    // Double quotes are literal inside single quotes.
    assert.deepEqual(splitArgv(`echo 'say "hi"'`), ['echo', 'say "hi"']);
  });

  it('preserves spaces inside double quotes', () => {
    assert.deepEqual(splitArgv('echo "hello world"'), ['echo', 'hello world']);
    // Single quotes are literal inside double quotes.
    assert.deepEqual(splitArgv(`echo "it's fine"`), ['echo', "it's fine"]);
  });

  it('honours backslash escapes only before " and \\ inside double quotes', () => {
    assert.deepEqual(splitArgv('echo "a\\"b"'), ['echo', 'a"b']);
    assert.deepEqual(splitArgv('echo "a\\\\b"'), ['echo', 'a\\b']);
    // A backslash before any other char inside double quotes stays literal.
    assert.deepEqual(splitArgv('echo "a\\nb"'), ['echo', 'a\\nb']);
  });

  it('treats an unquoted backslash as an escape of the next char', () => {
    assert.deepEqual(splitArgv('a\\ b'), ['a b']);
    assert.deepEqual(splitArgv('foo\\"bar'), ['foo"bar']);
    assert.deepEqual(splitArgv("path\\'name"), ["path'name"]);
  });

  it('joins adjacent quoted and unquoted segments into one token', () => {
    assert.deepEqual(splitArgv('a"b"c'), ['abc']);
    assert.deepEqual(splitArgv(`pre'mid'post`), ['premidpost']);
    assert.deepEqual(splitArgv('--name="My Task"'), ['--name=My Task']);
  });

  it('keeps an empty quoted string as a real (empty) token', () => {
    assert.deepEqual(splitArgv('cmd ""'), ['cmd', '']);
    assert.deepEqual(splitArgv("cmd ''"), ['cmd', '']);
  });

  it('does NOT interpret shell metacharacters — they remain literal tokens', () => {
    // Pipes, redirects, ampersands, semicolons, subshells, globs, and variable
    // sigils are all just ordinary characters to the lexical splitter.
    assert.deepEqual(splitArgv('a | b'), ['a', '|', 'b']);
    assert.deepEqual(splitArgv('a && b ; c'), ['a', '&&', 'b', ';', 'c']);
    assert.deepEqual(splitArgv('echo foo > out.txt'), ['echo', 'foo', '>', 'out.txt']);
    assert.deepEqual(splitArgv('echo $HOME'), ['echo', '$HOME']);
    assert.deepEqual(splitArgv('echo *.js'), ['echo', '*.js']);
    assert.deepEqual(splitArgv('echo $(whoami)'), ['echo', '$(whoami)']);
    assert.deepEqual(splitArgv('echo `id`'), ['echo', '`id`']);
  });

  it('handles realistic mixed-quoting command lines', () => {
    assert.deepEqual(splitArgv(`git commit -m "fix: don't crash" --author='A B'`), [
      'git',
      'commit',
      '-m',
      "fix: don't crash",
      '--author=A B',
    ]);
  });
});

describe('needsShell', () => {
  it('returns false for plain "program args" commands', () => {
    for (const cmd of [
      'pnpm dev',
      'node server.js --port 3000',
      'task air',
      'go run ./cmd/main.go',
      'echo "hello world"', // quotes alone do not require a shell
      "git commit -m 'wip'",
    ]) {
      assert.equal(needsShell(cmd), false, cmd);
    }
  });

  it('returns true when a command uses shell operators or features', () => {
    for (const cmd of [
      'pnpm build && pnpm dev',
      'a | b',
      'a || b',
      'foo; bar',
      'echo foo > out.txt',
      'cat < in.txt',
      'echo $HOME',
      'echo `id`',
      'echo $(whoami)',
      '(cd sub && make)',
      'ls *.ts',
      'cat file?.log',
      'cd ~/project',
      'line1\nline2',
    ]) {
      assert.equal(needsShell(cmd), true, cmd);
    }
  });
});
