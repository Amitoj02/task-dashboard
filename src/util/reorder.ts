/**
 * A tiny, dependency-free helper for relocating items within an ordered list.
 *
 * Used by the Task Definitions drag-and-drop controller to compute the new
 * `manual` order: given the scope's current order, the dragged ids, and the row
 * they were dropped onto, it produces the resulting order. Keeping this pure (no
 * `vscode`) lets the move arithmetic be unit-tested exhaustively in isolation.
 *
 * @remarks Host-free. Must not import `vscode` or `child_process`.
 */

/**
 * Moves `moving` items so they sit immediately before `beforeId` within `order`.
 *
 * Semantics:
 * - Items in `moving` that are not present in `order` are ignored (e.g. ids from
 *   a different scope), so a drop never injects foreign rows.
 * - `moving` items are inserted in the order given (the drag/selection order).
 * - `beforeId === undefined` appends them to the end.
 * - If `beforeId` is itself one of the moving items (a drop onto the dragged
 *   selection) or is not found in `order`, the move is treated as a no-op and a
 *   copy of `order` is returned unchanged.
 *
 * @typeParam T - The id type (e.g. a branded definition id).
 * @param order - The current ordering to move within.
 * @param moving - The ids being relocated.
 * @param beforeId - The id to insert before, or `undefined` to append.
 * @returns A new array with the moving items repositioned.
 */
export function reorderIds<T>(
  order: readonly T[],
  moving: readonly T[],
  beforeId: T | undefined
): T[] {
  const present = new Set(order);
  const movingFiltered = moving.filter((id) => present.has(id));
  if (movingFiltered.length === 0) {
    return [...order];
  }

  const movingSet = new Set(movingFiltered);

  // Dropping onto one of the moving rows is a no-op (there is no stable place to
  // insert relative to a row that is itself being lifted out).
  if (beforeId !== undefined && movingSet.has(beforeId)) {
    return [...order];
  }

  const remaining = order.filter((id) => !movingSet.has(id));
  const at = beforeId === undefined ? -1 : remaining.indexOf(beforeId);
  const insertAt = at < 0 ? remaining.length : at;

  return [...remaining.slice(0, insertAt), ...movingFiltered, ...remaining.slice(insertAt)];
}
