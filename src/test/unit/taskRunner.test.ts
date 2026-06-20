/**
 * Unit tests for {@link TaskRunner}: the pure process engine.
 *
 * Covers: building correct {@link SpawnOptions} (direct argv vs shell execution,
 * environment merge, platform-dependent `detached`), output streaming and ring-
 * buffer retention, exit/error cleanup, and the graceful stop sequence —
 * SIGTERM now, SIGKILL after the grace window only if the child is still alive,
 * and NO SIGKILL when the child exits during the grace window.
 *
 * Driven entirely by {@link FakeProcessSpawner}/{@link FakeSpawnedProcess} and
 * {@link FakeTimers}; no real processes or wall-clock timers.
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import { TaskRunner, type TaskRunnerOptions } from '../../task/TaskRunner';
import { type TaskDefinition } from '../../models/TaskDefinition';
import type { RunningInstanceId, TaskDefinitionId } from '../../types/ids';
import type { RunnerExit, RunnerOutput, RunnerError } from '../../task/TaskRunner';
import { FakeProcessSpawner } from './fakes/FakeProcessSpawner';
import { FakeTimers } from './fakes/FakeTimers';

const INSTANCE = 'inst-1' as RunningInstanceId;

/** Builds a definition, overridable per field. */
function def(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'def-1' as TaskDefinitionId,
    name: 'Task',
    command: 'node server.js --port 3000',
    allowMultipleInstances: false,
    commandHistory: [],
    ...overrides,
  };
}

/** Standard runner harness. */
function makeRunner(opts: Partial<TaskRunnerOptions> = {}) {
  const spawner = new FakeProcessSpawner();
  const timers = new FakeTimers();
  const options: TaskRunnerOptions = {
    logRetentionBytes: 1024,
    defaultShell: '',
    ...opts,
  };
  const runner = new TaskRunner(spawner, timers, options);
  return { runner, spawner, timers, options };
}

describe('TaskRunner spawn options', () => {
  it('direct execution: splits the command into argv and spawns the program (shell:false path)', () => {
    const { runner, spawner } = makeRunner();
    runner.start(INSTANCE, def({ command: 'node server.js --port 3000' }), '/work');

    const req = spawner.lastRequest!;
    assert.equal(req.command, 'node');
    assert.deepEqual(req.args, ['server.js', '--port', '3000']);
    assert.equal(req.cwd, '/work');
    runner.dispose();
  });

  it('shell execution (POSIX): runs `<shell> -c <command>` as a single argv element', () => {
    const { runner, spawner } = makeRunner();
    runner.start(INSTANCE, def({ shell: '/bin/bash', command: 'a | b && c' }), undefined);

    const req = spawner.lastRequest!;
    assert.equal(req.command, '/bin/bash');
    assert.deepEqual(req.args, ['-c', 'a | b && c']);
    runner.dispose();
  });

  it('shell execution (cmd): uses /d /s /c with the command as one element', () => {
    const { runner, spawner } = makeRunner();
    runner.start(
      INSTANCE,
      def({ shell: 'C:\\Windows\\System32\\cmd.exe', command: 'dir & echo hi' }),
      undefined
    );

    const req = spawner.lastRequest!;
    assert.deepEqual(req.args, ['/d', '/s', '/c', 'dir & echo hi']);
    runner.dispose();
  });

  it('shell execution (pwsh/powershell): uses -Command with the command as one element', () => {
    const { runner, spawner } = makeRunner();
    runner.start(
      INSTANCE,
      def({ shell: 'pwsh', command: 'Get-Process | Stop-Process' }),
      undefined
    );

    assert.deepEqual(spawner.lastRequest!.args, ['-Command', 'Get-Process | Stop-Process']);
    runner.dispose();
  });

  it('falls back to defaultShell when the definition names no shell', () => {
    const { runner, spawner } = makeRunner({ defaultShell: '/bin/zsh' });
    runner.start(INSTANCE, def({ command: 'echo hi' }), undefined);

    const req = spawner.lastRequest!;
    assert.equal(req.command, '/bin/zsh');
    assert.deepEqual(req.args, ['-c', 'echo hi']);
    runner.dispose();
  });

  it('auto-uses the platform default shell when the command has shell operators and no shell is configured', () => {
    const { runner, spawner } = makeRunner(); // defaultShell: ''
    runner.start(INSTANCE, def({ command: 'pnpm build && pnpm dev' }), undefined);

    const req = spawner.lastRequest!;
    // Went through a shell: the command is passed verbatim as the final argv
    // element (never split), and the program is NOT the first bare token.
    assert.notEqual(req.command, 'pnpm', 'should spawn a shell, not the program directly');
    assert.equal(req.args[req.args.length - 1], 'pnpm build && pnpm dev');
    runner.dispose();
  });

  it('keeps direct execution for a plain command with no shell features', () => {
    const { runner, spawner } = makeRunner(); // defaultShell: ''
    runner.start(INSTANCE, def({ command: 'pnpm dev' }), undefined);

    const req = spawner.lastRequest!;
    assert.equal(req.command, 'pnpm', 'plain commands stay shell-free');
    assert.deepEqual(req.args, ['dev']);
    runner.dispose();
  });

  it("prefers the definition's shell over defaultShell", () => {
    const { runner, spawner } = makeRunner({ defaultShell: '/bin/zsh' });
    runner.start(INSTANCE, def({ shell: '/bin/bash', command: 'echo hi' }), undefined);

    assert.equal(spawner.lastRequest!.command, '/bin/bash');
    runner.dispose();
  });

  it('merges environmentVariables over the inherited process.env', () => {
    const probeKey = '__TASK_DASHBOARD_PROBE__';
    process.env[probeKey] = 'inherited';
    try {
      const { runner, spawner } = makeRunner();
      runner.start(
        INSTANCE,
        def({ environmentVariables: { CUSTOM: 'x', [probeKey]: 'overridden' } }),
        undefined
      );

      const env = spawner.lastRequest!.env!;
      assert.equal(env.CUSTOM, 'x');
      assert.equal(env[probeKey], 'overridden', 'definition env should override inherited');
      assert.equal(env.PATH, process.env.PATH, 'inherited vars should still be present');
      runner.dispose();
    } finally {
      delete process.env[probeKey];
    }
  });

  it('sets detached according to the platform (true on POSIX, false on Windows)', () => {
    const { runner, spawner } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    assert.equal(spawner.lastRequest!.detached, process.platform !== 'win32');
    runner.dispose();
  });

  it('ignores a duplicate start for the same instance id', () => {
    const { runner, spawner } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    runner.start(INSTANCE, def(), undefined);
    assert.equal(spawner.requests.length, 1);
    runner.dispose();
  });
});

describe('TaskRunner output streaming + ring buffer', () => {
  it('re-emits stdout and stderr chunks via onDidOutput', () => {
    const { runner, spawner } = makeRunner();
    const seen: RunnerOutput[] = [];
    runner.onDidOutput((o) => seen.push(o));

    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;
    proc.emitStdout('out-1');
    proc.emitStderr('err-1');

    assert.equal(seen.length, 2);
    assert.equal(seen[0].instanceId, INSTANCE);
    assert.equal(seen[0].chunk.toString('utf8'), 'out-1');
    assert.equal(seen[1].chunk.toString('utf8'), 'err-1');
    runner.dispose();
  });

  it('retains a bounded tail in the per-instance ring buffer', () => {
    const { runner, spawner } = makeRunner({ logRetentionBytes: 8 });
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;

    proc.emitStdout('AAAA'); // 4
    proc.emitStdout('BBBB'); // 8
    proc.emitStdout('CCCC'); // 12 -> trims oldest to fit 8 bytes

    assert.equal(runner.getBufferedOutput(INSTANCE).toString('utf8'), 'BBBBCCCC');
    runner.dispose();
  });

  it('reports an empty buffer for an unknown instance', () => {
    const { runner } = makeRunner();
    assert.equal(runner.getBufferedOutput('ghost' as RunningInstanceId).length, 0);
    runner.dispose();
  });
});

describe('TaskRunner exit / error cleanup', () => {
  it('emits a single exit (requested:false) and removes the process from the live set', () => {
    const { runner, spawner } = makeRunner();
    const exits: RunnerExit[] = [];
    runner.onDidExit((e) => exits.push(e));

    runner.start(INSTANCE, def(), undefined);
    assert.equal(runner.isRunning(INSTANCE), true);

    spawner.lastSpawned!.emitExit(0, null);
    assert.equal(exits.length, 1);
    assert.deepEqual(
      {
        id: exits[0].instanceId,
        code: exits[0].code,
        signal: exits[0].signal,
        requested: exits[0].requested,
      },
      { id: INSTANCE, code: 0, signal: undefined, requested: false }
    );
    assert.equal(runner.isRunning(INSTANCE), false);
    runner.dispose();
  });

  it('marks an exit as requested:true when a stop was initiated first', () => {
    const { runner, spawner, timers } = makeRunner();
    const exits: RunnerExit[] = [];
    runner.onDidExit((e) => exits.push(e));

    runner.start(INSTANCE, def(), undefined);
    runner.stop(INSTANCE, 5000);
    spawner.lastSpawned!.emitExit(null, 'SIGTERM');

    assert.equal(exits[0].requested, true);
    assert.equal(exits[0].signal, 'SIGTERM');
    // No SIGKILL escalation should fire after a clean exit during grace.
    timers.advance(5000);
    assert.equal(spawner.lastSpawned!.forceKilled(), false);
    runner.dispose();
  });

  it('routes a spawn/runtime error to onDidError and cleans up (no exit event)', () => {
    const { runner, spawner } = makeRunner();
    const errors: RunnerError[] = [];
    let exitCount = 0;
    runner.onDidError((e) => errors.push(e));
    runner.onDidExit(() => exitCount++);

    runner.start(INSTANCE, def(), undefined);
    spawner.lastSpawned!.emitError(new Error('spawn ENOENT'));

    assert.equal(errors.length, 1);
    assert.match(errors[0].error.message, /ENOENT/);
    assert.equal(exitCount, 0);
    assert.equal(runner.isRunning(INSTANCE), false);
    runner.dispose();
  });

  it('ignores output after the process has ended', () => {
    const { runner, spawner } = makeRunner();
    let outputs = 0;
    runner.onDidOutput(() => outputs++);

    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;
    proc.emitExit(0);
    proc.emitStdout('late'); // process already gone → dropped

    assert.equal(outputs, 0);
    runner.dispose();
  });
});

describe('TaskRunner stop sequence (SIGTERM then SIGKILL after grace)', () => {
  it('sends SIGTERM immediately, then SIGKILL after the grace window if still alive', () => {
    const { runner, spawner, timers } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;

    runner.stop(INSTANCE, 5000);
    assert.equal(proc.terminated(), true, 'SIGTERM should be sent immediately');
    assert.equal(proc.forceKilled(), false, 'SIGKILL must wait for the grace window');

    // Not yet due.
    timers.advance(4999);
    assert.equal(proc.forceKilled(), false);

    // Grace elapses → escalate.
    timers.advance(1);
    assert.equal(proc.forceKilled(), true);
    assert.deepEqual(proc.killSignals, ['SIGTERM', 'SIGKILL']);
    runner.dispose();
  });

  it('does NOT send SIGKILL if the process exits during the grace window', () => {
    const { runner, spawner, timers } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;

    runner.stop(INSTANCE, 5000);
    assert.equal(proc.terminated(), true);

    // Process exits before the grace elapses.
    proc.emitExit(null, 'SIGTERM');

    // Advancing past the grace window must not escalate to SIGKILL.
    timers.advance(10_000);
    assert.equal(proc.forceKilled(), false);
    assert.deepEqual(proc.killSignals, ['SIGTERM']);
    runner.dispose();
  });

  it('uses the default grace (5000ms) when none is supplied', () => {
    const { runner, spawner, timers } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;

    runner.stop(INSTANCE);
    timers.advance(4999);
    assert.equal(proc.forceKilled(), false);
    timers.advance(1);
    assert.equal(proc.forceKilled(), true);
    runner.dispose();
  });

  it('stop() on an unknown / already-ended instance is a harmless no-op', () => {
    const { runner, spawner, timers } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;
    proc.emitExit(0);

    // Already ended: stop must not send any signal, nor schedule a kill timer.
    runner.stop(INSTANCE, 1000);
    runner.stop('ghost' as RunningInstanceId, 1000);
    timers.advance(5000);
    assert.equal(proc.killSignals.length, 0);
    runner.dispose();
  });

  it('repeated stop() calls reset the grace timer rather than stacking kills', () => {
    const { runner, spawner, timers } = makeRunner();
    runner.start(INSTANCE, def(), undefined);
    const proc = spawner.lastSpawned!;

    runner.stop(INSTANCE, 5000);
    timers.advance(3000);
    runner.stop(INSTANCE, 5000); // resets the grace window
    timers.advance(3000); // 6000 total, but only 3000 since the reset
    assert.equal(proc.forceKilled(), false);
    timers.advance(2000); // now 5000 since the reset
    assert.equal(proc.forceKilled(), true);
    // Two SIGTERMs (one per stop) and exactly one SIGKILL.
    assert.equal(proc.terminateCount, 2);
    assert.equal(proc.forceKillCount, 1);
    runner.dispose();
  });
});

describe('TaskRunner dispose', () => {
  it('SIGTERMs every live child and stops emitting', () => {
    const { runner, spawner } = makeRunner();
    runner.start('a' as RunningInstanceId, def(), undefined);
    runner.start('b' as RunningInstanceId, def(), undefined);
    const [p1, p2] = spawner.spawned;

    runner.dispose();
    assert.equal(p1.terminated(), true);
    assert.equal(p2.terminated(), true);

    // After dispose, new starts are refused.
    runner.start('c' as RunningInstanceId, def(), undefined);
    assert.equal(spawner.requests.length, 2);
  });
});
