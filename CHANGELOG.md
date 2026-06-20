# Change Log

All notable changes to the Task Dashboard extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
