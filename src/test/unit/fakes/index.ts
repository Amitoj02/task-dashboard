/**
 * Barrel re-exporting the host-free test fakes.
 *
 * @remarks Test-only. Must not import `vscode` or `child_process`.
 */

export { FakeMementoStorage } from './FakeMementoStorage';
export { FakeClock } from './FakeClock';
export { FakeTimers } from './FakeTimers';
export { FakeProcessSpawner, FakeSpawnedProcess } from './FakeProcessSpawner';
