/**
 * Strongly-typed identifier helpers for the pure core.
 *
 * Identifiers are plain strings at runtime (UUIDs). The branded aliases give
 * us nominal typing at compile time so a {@link TaskDefinitionId} can never be
 * accidentally passed where a {@link RunningInstanceId} is expected, without any
 * runtime cost.
 *
 * @remarks This module is part of the host-free core and must not import
 * `vscode` or `child_process`.
 */

import { randomUUID } from 'node:crypto';

/**
 * Brand helper: tags a base type with a unique marker so structurally identical
 * types are treated as distinct by the type checker.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** Stable identifier for a persisted {@link TaskDefinition}. */
export type TaskDefinitionId = Brand<string, 'TaskDefinitionId'>;

/** Identifier for a single running instance of a task (distinct from the def id). */
export type RunningInstanceId = Brand<string, 'RunningInstanceId'>;

/**
 * Generates a fresh, globally-unique identifier.
 *
 * Uses the platform `crypto.randomUUID()` so the extension ships with zero
 * runtime dependencies (the `uuid` package is intentionally avoided).
 *
 * @typeParam T - The branded id type to produce. Defaults to a bare string.
 * @returns A new RFC 4122 v4 UUID, cast to the requested branded type.
 */
export function newId<T extends string = string>(): T {
  return randomUUID() as T;
}
