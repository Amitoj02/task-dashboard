/**
 * Unit tests for {@link windowsCommand}: the Windows direct-spawn resolution that
 * fixes `spawn npm ENOENT`.
 *
 * Covers: PATH/PATHEXT resolution of bare names, relative, and absolute commands;
 * the exe-vs-batch-shim decision; the `cmd.exe` wrapping plan (including verbatim
 * args and the `node_modules/.bin` double-escape); and the ported `cross-spawn`
 * escaping. The logic is pure (`path.win32` + an injected file probe), so these
 * run identically on any host OS.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import {
  escapeCmdArgument,
  escapeCmdCommand,
  planWindowsSpawn,
  resolveWindowsCommandPath,
  type WindowsResolveDeps,
} from '../../adapters/windowsCommand';

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const NODEJS_DIR = 'C:\\Program Files\\nodejs';
const BIN_DIR = 'C:\\proj\\node_modules\\.bin';

/** Builds resolve deps over a fixed set of "present" files. */
function deps(present: string[], pathDirs: string[] = [NODEJS_DIR, 'C:\\Windows\\System32']) {
  const set = new Set(present);
  const base: WindowsResolveDeps & { comspec: string } = {
    pathDirs,
    pathExt: ['.com', '.exe', '.bat', '.cmd'],
    cwd: 'C:\\proj',
    comspec: COMSPEC,
    fileExists: (p) => set.has(p),
  };
  return base;
}

describe('escapeCmdCommand / escapeCmdArgument', () => {
  it('leaves a clean program token unquoted and only escapes meta-characters', () => {
    assert.equal(escapeCmdCommand('npm'), 'npm');
    assert.equal(escapeCmdCommand('a&b'), 'a^&b');
  });

  it('quotes an argument and escapes the surrounding quotes', () => {
    assert.equal(escapeCmdArgument('hello'), '^"hello^"');
  });

  it('escapes spaces and shell meta-characters so they reach the program literally', () => {
    assert.equal(escapeCmdArgument('hello world'), '^"hello^ world^"');
    assert.equal(escapeCmdArgument('a&b'), '^"a^&b^"');
  });

  it('keeps an empty argument as an explicit empty quoted token', () => {
    assert.equal(escapeCmdArgument(''), '^"^"');
  });

  it('double-escapes meta-characters for nested cmd shims', () => {
    const single = escapeCmdArgument('a&b', false);
    const double = escapeCmdArgument('a&b', true);
    assert.notEqual(single, double);
    assert.equal(double, '^^^"a^^^&b^^^"');
  });
});

describe('resolveWindowsCommandPath', () => {
  it('resolves a bare name across PATH using PATHEXT (npm -> npm.cmd)', () => {
    const d = deps([`${NODEJS_DIR}\\npm.cmd`]);
    assert.equal(resolveWindowsCommandPath('npm', d), `${NODEJS_DIR}\\npm.cmd`);
  });

  it('prefers an earlier PATHEXT entry when several candidates exist', () => {
    const d = deps([`${NODEJS_DIR}\\node.exe`, `${NODEJS_DIR}\\node.cmd`]);
    assert.equal(resolveWindowsCommandPath('node', d), `${NODEJS_DIR}\\node.exe`);
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(resolveWindowsCommandPath('ghost', deps([])), undefined);
  });

  it('resolves a relative path against the cwd, not PATH', () => {
    const d = deps(['C:\\proj\\scripts\\run.bat']);
    assert.equal(resolveWindowsCommandPath('.\\scripts\\run.bat', d), 'C:\\proj\\scripts\\run.bat');
  });

  it('honours an absolute command path as-is', () => {
    const d = deps(['C:\\tools\\app.exe']);
    assert.equal(resolveWindowsCommandPath('C:\\tools\\app.exe', d), 'C:\\tools\\app.exe');
  });
});

describe('planWindowsSpawn', () => {
  it('wraps a .cmd shim through cmd.exe with verbatim, escaped args', () => {
    const plan = planWindowsSpawn('npm', ['run', 'start'], deps([`${NODEJS_DIR}\\npm.cmd`]));
    assert.equal(plan.command, COMSPEC);
    assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(plan.windowsVerbatimArguments, true);
    const line = plan.args[3];
    assert.ok(line.startsWith('"') && line.endsWith('"'), 'the cmd line is wrapped in quotes');
    assert.match(line, /npm /, 'the program name leads the wrapped command line');
  });

  it('spawns a real .exe directly, unchanged, with literal args', () => {
    const plan = planWindowsSpawn('node', ['server.js'], deps([`${NODEJS_DIR}\\node.exe`]));
    assert.deepEqual(plan, {
      command: 'node',
      args: ['server.js'],
      windowsVerbatimArguments: false,
    });
  });

  it('spawns an unresolved command directly so a genuine miss still ENOENTs', () => {
    const plan = planWindowsSpawn('ghost', ['x'], deps([]));
    assert.deepEqual(plan, { command: 'ghost', args: ['x'], windowsVerbatimArguments: false });
  });

  it('leaves a shell binary (cmd.exe / powershell.exe) untouched', () => {
    // The shell-execution path spawns cmd.exe/powershell.exe directly; those are
    // real .exe images and must never be double-wrapped.
    const cmdPlan = planWindowsSpawn(COMSPEC, ['/d', '/s', '/c', 'dir & echo hi'], deps([COMSPEC]));
    assert.equal(cmdPlan.command, COMSPEC);
    assert.equal(cmdPlan.windowsVerbatimArguments, false);

    const psPlan = planWindowsSpawn(
      'powershell',
      ['-Command', 'Get-Process'],
      deps(['C:\\Windows\\System32\\powershell.exe'], ['C:\\Windows\\System32'])
    );
    assert.equal(psPlan.command, 'powershell');
    assert.equal(psPlan.windowsVerbatimArguments, false);
  });

  it('double-escapes args for a node_modules/.bin/*.cmd shim', () => {
    const local = planWindowsSpawn('eslint', ['a&b'], deps([`${BIN_DIR}\\eslint.cmd`], [BIN_DIR]));
    const global = planWindowsSpawn('npm', ['a&b'], deps([`${NODEJS_DIR}\\npm.cmd`]));
    // Both wrap through cmd.exe, but the local bin shim escapes meta-chars twice.
    assert.equal(local.command, COMSPEC);
    assert.equal(global.command, COMSPEC);
    assert.match(local.args[3], /a\^\^\^&b/, 'local .bin shim arg is double-escaped');
    assert.match(global.args[3], /a\^&b/, 'global shim arg is single-escaped');
    assert.notEqual(local.args[3], global.args[3]);
  });
});
