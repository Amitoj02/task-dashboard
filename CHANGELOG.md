# Change Log

All notable changes to the Task Dashboard extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Drag-and-drop manual ordering** for the Task Definitions list, backed by a
  new `manual` sort mode. Drag a task (or a multi-selection) onto another row to
  reorder it; the view switches to manual sort and persists the arrangement per
  scope (global and workspace tasks reorder within their own groups). The manual
  order is kept independently of the displayed sort, so toggling to Name or
  Most-recent and back preserves your arrangement. The sort toggle now cycles
  Name (A→Z) → Name (Z→A) → Most recent → Manual.
- **Clear Stopped Tasks** action in the Running Tasks title bar removes every
  exited/failed instance (and its terminal) in one click; live tasks are kept.
- Per-row **Remove from List** action on stopped instances to clear a single
  finished task and its output.

### Changed

- Clicking a task in the **Task Definitions** list no longer runs it. Selecting a
  definition now only selects the row; run a task explicitly via the inline Run
  (play) button or the context menu, so a stray click or Enter can't launch a
  task by accident.

### Fixed

- The Task editor's **icon preview** now renders the real codicon glyph (the
  bundled `@vscode/codicons` font) instead of the literal `$(id)` text.
- **Show Output** now reliably reveals a task's terminal. Output - including
  stderr and spawn failures from short-lived/failed tasks - is retained and
  replayed when the terminal is first opened, so it no longer shows a blank
  screen for a task that already exited.
- **Show Output** keeps working after a finished task's terminal tab is closed.
  The retained output now outlives the terminal, so reopening output for an
  instance that is still listed (Exited/Failed) recreates a fresh terminal and
  replays the log instead of silently doing nothing. A finished task's terminal
  is also kept open (with a `[process exited: ...]` line) until you close it or
  **Clear Stopped Tasks**, rather than vanishing the moment the process ends.

## [0.1.0] - 2026-06-20

### Added

- Initial release.
- Dedicated activity-bar container with **Task Definitions** and **Running Tasks** views.
- Create, edit, duplicate, and delete custom shell tasks (webview editor and native Quick Add).
- Run, stop, restart, run-all, and stop-all controls.
- Per-instance real terminals (Pseudoterminal-backed) with native ANSI, search, and links.
- Live status, PID, and duration for running tasks.
- Search, sort, and scope (global vs. workspace) filtering of task definitions.
- Optional auto-restart with a crash-loop breaker.
- Configurable stop grace period, log retention, notifications, and terminal-close behavior.
