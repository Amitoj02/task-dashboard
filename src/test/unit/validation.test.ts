/**
 * Unit tests for the pure validation helpers:
 * {@link isValidName}, {@link hasDuplicateName} (models/TaskDefinition) and
 * {@link validateInput}/{@link hasErrors} (models/validation).
 *
 * @remarks Host-free unit test (mocha + tsx, no `vscode`).
 */

import assert from 'node:assert/strict';
import {
  hasDuplicateName,
  isValidName,
  type TaskDefinition,
  type TaskDefinitionInput,
} from '../../models/TaskDefinition';
import { hasErrors, validateInput, MAX_STARTUP_DELAY_MS } from '../../models/validation';
import type { TaskDefinitionId } from '../../types/ids';

/** Builds a minimal valid {@link TaskDefinitionInput}, overridable per field. */
function input(overrides: Partial<TaskDefinitionInput> = {}): TaskDefinitionInput {
  return {
    name: 'Build',
    command: 'npm run build',
    allowMultipleInstances: false,
    ...overrides,
  };
}

/** Builds a persisted {@link TaskDefinition} with a caller-chosen id and name. */
function def(id: string, name: string): TaskDefinition {
  return {
    id: id as TaskDefinitionId,
    name,
    command: 'echo',
    allowMultipleInstances: false,
    commandHistory: [],
  };
}

describe('isValidName', () => {
  it('accepts a non-empty name', () => {
    assert.equal(isValidName('Build'), true);
    assert.equal(isValidName('  trimmed-to-content  '), true);
  });

  it('rejects empty / whitespace-only names', () => {
    assert.equal(isValidName(''), false);
    assert.equal(isValidName('   '), false);
    assert.equal(isValidName('\t\n'), false);
  });

  it('rejects non-string input defensively', () => {
    assert.equal(isValidName(undefined as unknown as string), false);
    assert.equal(isValidName(null as unknown as string), false);
  });
});

describe('hasDuplicateName', () => {
  const existing = [def('1', 'Build'), def('2', 'Test'), def('3', 'Deploy')];

  it('detects a case-insensitive duplicate', () => {
    assert.equal(hasDuplicateName('build', existing), true);
    assert.equal(hasDuplicateName('BUILD', existing), true);
    assert.equal(hasDuplicateName('  Build  ', existing), true);
  });

  it('returns false for a genuinely new name', () => {
    assert.equal(hasDuplicateName('Lint', existing), false);
  });

  it('excludes the definition being edited via excludeId', () => {
    // Editing def '1' (Build) and keeping its name is NOT a duplicate of itself.
    assert.equal(hasDuplicateName('Build', existing, '1' as TaskDefinitionId), false);
    // But colliding with a *different* definition still trips, even with excludeId.
    assert.equal(hasDuplicateName('Test', existing, '1' as TaskDefinitionId), true);
  });

  it('returns false against an empty set', () => {
    assert.equal(hasDuplicateName('Anything', []), false);
  });
});

describe('validateInput', () => {
  it('passes a well-formed input (no errors)', () => {
    const errors = validateInput(input());
    assert.deepEqual(errors, {});
    assert.equal(hasErrors(errors), false);
  });

  it('requires a name', () => {
    const errors = validateInput(input({ name: '   ' }));
    assert.ok(errors.name, 'expected a name error');
    assert.equal(hasErrors(errors), true);
  });

  it('requires a command', () => {
    const errors = validateInput(input({ command: '' }));
    assert.ok(errors.command, 'expected a command error');
  });

  it('flags both name and command when both are missing', () => {
    const errors = validateInput(input({ name: '', command: '   ' }));
    assert.ok(errors.name);
    assert.ok(errors.command);
  });

  it('rejects a negative, fractional, or non-finite startup delay', () => {
    assert.ok(validateInput(input({ startupDelayMs: -1 })).startupDelayMs);
    assert.ok(validateInput(input({ startupDelayMs: 1.5 })).startupDelayMs);
    assert.ok(validateInput(input({ startupDelayMs: Number.NaN })).startupDelayMs);
    assert.ok(validateInput(input({ startupDelayMs: Number.POSITIVE_INFINITY })).startupDelayMs);
  });

  it('accepts a valid startup delay and 0', () => {
    assert.equal(validateInput(input({ startupDelayMs: 0 })).startupDelayMs, undefined);
    assert.equal(validateInput(input({ startupDelayMs: 2000 })).startupDelayMs, undefined);
    assert.equal(
      validateInput(input({ startupDelayMs: MAX_STARTUP_DELAY_MS })).startupDelayMs,
      undefined
    );
  });

  it('rejects a startup delay beyond the maximum', () => {
    assert.ok(validateInput(input({ startupDelayMs: MAX_STARTUP_DELAY_MS + 1 })).startupDelayMs);
  });

  it('rejects malformed environment variable names', () => {
    assert.ok(validateInput(input({ environmentVariables: { '1BAD': 'x' } })).environmentVariables);
    assert.ok(
      validateInput(input({ environmentVariables: { 'has space': 'x' } })).environmentVariables
    );
    assert.ok(validateInput(input({ environmentVariables: { '': 'x' } })).environmentVariables);
  });

  it('accepts well-formed environment variable names', () => {
    const errors = validateInput(
      input({ environmentVariables: { NODE_ENV: 'production', _PRIVATE: '1', PORT2: '80' } })
    );
    assert.equal(errors.environmentVariables, undefined);
  });
});

describe('hasErrors', () => {
  it('is false for an empty map and true otherwise', () => {
    assert.equal(hasErrors({}), false);
    assert.equal(hasErrors({ name: 'Name is required.' }), true);
  });
});
