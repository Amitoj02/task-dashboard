# Change Log

All notable changes to the Task Dashboard extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2026-06-23

### Fixed

- Windows: tasks whose command is a batch-style CLI shim - `npm`, `npx`, `yarn`,
  `pnpm`, `composer`, `tsc`, and friends are all installed as `.cmd`/`.bat` files -
  no longer fail to start with `spawn npm ENOENT`. The runner now resolves the
  command against `PATH`/`PATHEXT` and routes a batch shim through `cmd.exe` (the
  way a terminal does), while still spawning real `.exe`/`.com` programs directly.
  Arguments are escaped so they reach the program literally, with no shell
  interpretation, and no runtime dependency is added.

## [1.0.1] - 2026-06-21

### Fixed

- Task-failure notifications now actually fire. With the default `errorsOnly`
  setting (and `all`), a failed task surfaces a notification; previously the
  setting was honored nowhere. Auto-restart failures remain summarized by the
  crash-loop breaker so a crash loop does not flood you with notifications.
- Windows: native program and argument paths containing backslashes
  (e.g. `C:\tools\app.exe`) are no longer mangled when a task runs without a shell.
- Windows: stopping a task now attempts a graceful tree termination before force-
  killing, so the stop grace period has real effect, and the kill no longer
  blocks the extension host.
- Deleting a task now prunes it from the persisted manual sort order instead of
  leaving a stale entry behind.

### Changed

- The editor's **Startup delay** field is now labelled **Auto-restart delay**,
  with a hint clarifying that it applies before each automatic restart - matching
  what the setting has always done.

### Security

- Updated dev/test dependencies and added overrides to clear all `pnpm audit`
  advisories (serialize-javascript, jsdiff). These are test-only tools and are
  never shipped in the extension, which has zero runtime dependencies.

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
