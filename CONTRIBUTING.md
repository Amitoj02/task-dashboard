# Contributing to Task Dashboard

Thanks for your interest in improving **Task Dashboard** — a VS Code extension for
defining and managing custom shell tasks from a dedicated sidebar. This guide
covers everything you need to get a development build running, make a change, and
open a pull request.

## Prerequisites

| Tool       | Version            | Notes                                              |
| ---------- | ------------------ | -------------------------------------------------- |
| Node.js    | 20+ (CI uses 22)   | Needed for the build, tests, and tooling.          |
| pnpm       | 9+ (developed on 11) | The package manager for this repo. `corepack enable` will provide it. |
| VS Code    | 1.122+             | The minimum host version the extension targets.    |

This project uses **pnpm** exclusively. Please don't commit an `npm`/`yarn`
lockfile. The committed `.npmrc` and `pnpm-workspace.yaml` (which pre-approves the
native `esbuild` build) are part of the setup — a plain `pnpm install` is all you
need.

## Getting started

```bash
git clone https://github.com/Amitoj02/task-dashboard.git
cd task-dashboard
pnpm install
```

Run the extension in a development host:

1. Open the folder in VS Code.
2. Press **F5** (the "Run Extension" launch config). This builds the bundle and
   opens an Extension Development Host with the Task Dashboard activity-bar icon.
3. Use **`pnpm watch`** in a terminal for incremental rebuilds while you iterate,
   then reload the dev host (`Ctrl/Cmd+R`) to pick up changes.

## Project scripts

| Script                     | What it does                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `pnpm build`               | Production bundle via esbuild → `dist/extension.js`.                |
| `pnpm watch`               | Incremental esbuild rebuild on change.                              |
| `pnpm typecheck`           | `tsc --noEmit` (strict). esbuild does **not** type-check.           |
| `pnpm lint`                | ESLint over `src` (includes the architecture import rule).          |
| `pnpm format`              | Prettier write over `src/**/*.ts`.                                  |
| `pnpm test:unit`           | Fast, host-free unit tests (Mocha + tsx).                           |
| `pnpm test:integration`    | Integration tests in a real VS Code host (`@vscode/test-electron`). |
| `pnpm test`                | Compiles tests + bundle, then runs unit **and** integration tests. |
| `pnpm package`             | Builds a `.vsix` with `vsce` (zero runtime deps).                   |

Before pushing, the following should all pass:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build
```

`pnpm test:integration` downloads a VS Code build and needs a display (or
`xvfb-run` on headless Linux), so it may be environment-gated locally — but the
test files must still compile (`pnpm compile-tests`).

## Architecture & the one load-bearing rule

The codebase is split into a **pure core** and a **host layer**:

```
src/
  task/      models/   util/   types/     ← PURE core: NO `vscode`, NO `child_process`
  extension.ts  adapters/  views/  commands/  webview/   ← host layer (may import vscode)
```

- The **pure core** must never import `vscode` or `child_process`. All host
  capabilities (storage, spawning, the clock, timers, filesystem, user prompts)
  arrive through interfaces in `src/types/contracts.ts` and are injected via
  constructors (dependency injection). This is what keeps the core unit-testable
  without an Electron host. **An ESLint rule enforces this** — a violating import
  fails `pnpm lint`.
- The **host layer** is the only place concrete adapters are built; `extension.ts`
  is the composition root that wires everything together and registers disposables.

When adding a feature, prefer extending the core behind an existing interface and
adding a thin host adapter, rather than reaching for `vscode` inside the core.

Other invariants worth preserving:

- **Never crash the extension host.** Wrap `child_process` callbacks and every
  `process.kill` in try/catch; attach a child `error` listener first.
- **No leaks.** Anything that allocates a timer, listener, terminal, or emitter
  must `dispose()` and be pushed onto `context.subscriptions`.
- **Bounded memory.** Keep log retention in the ring buffer; let the terminal own
  scrollback. Don't hold full logs in the extension host.
- **Treat task config as untrusted.** Validate input; never `eval`.

## Tests

- **Unit tests** live in `src/test/unit/**` and use the fakes in
  `src/test/unit/fakes/` (`FakeProcessSpawner`, `FakeClock`, `FakeTimers`,
  `FakeMementoStorage`). They run with no `vscode` dependency. Add unit coverage
  for any core logic change.
- **Integration tests** live in `src/test/integration/**` and run in a real host.
  Use them for activation, command registration, tree-provider behavior, and real
  process lifecycle. Always clean up spawned processes in `afterEach`.

Please add or update tests with your change, and keep the suite green.

## Commit & PR conventions

- This repo follows **[Conventional Commits](https://www.conventionalcommits.org/)**
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, …). Keep the subject
  line under ~72 characters and explain the "why" in the body.
- Branch from `main` using a descriptive name, e.g. `feat/run-all-button` or
  `fix/windows-tree-kill`.
- Before opening a PR: run the pre-push checks above, and make sure no build
  artifacts are staged (`dist/`, `out/`, `node_modules/`, `*.vsix` are gitignored).
- Open the PR against `main` with a clear description of the change, the rationale,
  and any user-facing behavior or settings affected. Link related issues.

## Reporting bugs & proposing features

Open a GitHub issue with:

- **Bugs:** OS + VS Code version, a minimal task definition that reproduces it,
  what you expected, and what happened (include relevant terminal output).
- **Features:** the problem you're solving and, if you have one, a sketch of the
  UX. The roadmap intentionally leaves room for task groups, environment-variable
  editing, auto-start, task dependencies, log search/persistence, templates,
  Docker, remote SSH, and config export/import — proposals in those areas are
  especially welcome.

## Code of conduct

Be respectful and constructive. Assume good intent, keep discussions focused on
the work, and help make the project welcoming to newcomers.

Thanks for contributing! 🙌
