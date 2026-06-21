/**
 * Pure, host-free duration formatting.
 *
 * Extracted from the running-task view so it can be unit-tested without pulling
 * in `vscode` (importing the view module would, since it imports `vscode` at the
 * top level).
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

/**
 * Formats a millisecond duration as `mm:ss`, or `h:mm:ss` once it reaches an
 * hour.
 *
 * @param ms - The duration in milliseconds. Negative values are clamped to 0.
 * @returns A compact, zero-padded clock-style string.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  const mm = String(minutes).padStart(2, '0');
  return `${mm}:${ss}`;
}
