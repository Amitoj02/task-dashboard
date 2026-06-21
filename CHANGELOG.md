# Change Log

All notable changes to the Task Dashboard extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-06-21

Initial public release.

### Added

- Dedicated activity-bar container with **Task Definitions** and **Running Tasks**
  views.
- Create, edit, duplicate, and delete custom shell tasks - through a hardened
  webview editor (command, working directory, environment variables, shell, icon,
  and restart policy) or the native **Quick Add** prompt for the fast path.
- Run controls: Run, Stop, Restart, Run All, and Stop All. Graceful stop
  (SIGTERM → SIGKILL) with whole-process-group / tree kill so nothing is orphaned.
- Per-instance real terminals (Pseudoterminal-backed) with native ANSI colors,
  search, clickable links, copy, and auto-scroll. Output from short-lived and
  failed tasks is retained and replayed when the terminal is opened.
- Live status, PID, and duration for every running instance.
- Search, sort, and scope (global vs. workspace) filtering of task definitions,
  plus **drag-and-drop manual ordering** - drag a task or multi-selection onto
  another row to reorder it; the arrangement persists per scope. The sort toggle
  cycles Name (A→Z) → Name (Z→A) → Most recent → Manual.
- **Clear Stopped Tasks** and per-row **Remove from List** actions to clear
  finished instances and their output from the Running Tasks view.
- Optional auto-restart on crash, guarded by a crash-loop breaker.
- Configurable stop grace period, log retention, notifications, default shell,
  delete confirmation, and terminal-close behavior.
- Persisted, file-free storage - task definitions live in VS Code state, not in
  stray files in your repository.

### Security

- Task commands are never `eval`'d. By default a command is parsed into an argv
  vector and the program is spawned directly; shell execution is opt-in and
  passes the command as a single argument to the shell.
