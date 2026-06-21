/**
 * The Add / Edit Task form, hosted in a CSP-hardened {@link vscode.WebviewPanel}.
 *
 * This is the "modern UI" surface of the extension: a hand-written, framework-
 * free form (no CDN, no bundler entry) that collects the rich
 * {@link TaskDefinitionInput} fields. A single panel is reused across invocations
 * (tracked in {@link TaskEditorPanel.current}); calling {@link show} again simply
 * reveals and re-initializes the existing panel.
 *
 * Security posture (Marketplace liability is a first-class concern):
 * - `localResourceRoots` is pinned to the bundled `media/` directory.
 * - A strict `Content-Security-Policy` forbids all network, inline scripts, and
 *   `eval`; the only script/style that may run is the nonced `editor.js` /
 *   `editor.css` we ship.
 * - The webview is *purely presentational*. Every authoritative decision —
 *   required fields, numeric bounds, env-var key shape, working-directory
 *   existence, duplicate-name detection, and the final persistence — happens
 *   here in the trusted extension host. The webview only renders errors we send.
 *
 * @remarks Host-aware. Allowed to import `vscode`.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ITaskStore, IPathValidator } from '../types/contracts';
import type { TaskDefinitionId } from '../types/ids';
import {
  coerceScope,
  hasDuplicateName,
  type TaskDefinition,
  type TaskDefinitionInput,
  type TaskScope,
} from '../models/TaskDefinition';
import { hasErrors, validateInput, type FieldErrors } from '../models/validation';

/** Whether the editor is creating a new task or editing an existing one. */
export type TaskEditorMode = 'add' | 'edit';

/**
 * The raw, untrusted payload a webview message carries for the form values.
 *
 * Mirrors {@link TaskDefinitionInput} but every property is `unknown`: the host
 * never trusts the webview's typing and re-coerces everything in
 * {@link TaskEditorPanel.coerceInput}.
 */
interface RawInput {
  name?: unknown;
  command?: unknown;
  workingDirectory?: unknown;
  allowMultipleInstances?: unknown;
  environmentVariables?: unknown;
  shell?: unknown;
  autoRestart?: unknown;
  startupDelayMs?: unknown;
  icon?: unknown;
  /** The chosen scope; honored on add, ignored on edit. Re-coerced by the host. */
  scope?: unknown;
}

/** A message sent from the webview to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'browseFolder' }
  | { type: 'validate'; input: RawInput }
  | { type: 'submit'; input: RawInput }
  | { type: 'cancel' };

/** A message sent from the extension host to the webview. */
type OutboundMessage =
  | {
      type: 'init';
      mode: TaskEditorMode;
      scope: TaskScope;
      scopeLocked: boolean;
      existing: TaskDefinitionInput | null;
    }
  | { type: 'folderPicked'; path: string }
  | { type: 'errors'; errors: FieldErrors }
  | { type: 'busy'; busy: boolean };

/** The webview view type id (must be stable across reveals). */
const VIEW_TYPE = 'taskDashboard.taskEditor';

/**
 * Manages the single, reusable Task Editor webview panel.
 */
export class TaskEditorPanel {
  /** The live panel, if one is currently open; otherwise `undefined`. */
  private static current: TaskEditorPanel | undefined;

  /** Disposables tied to this panel's lifetime (message listener, dispose hook). */
  private readonly disposables: vscode.Disposable[] = [];

  /** Guards against double-disposal. */
  private disposed = false;

  /**
   * Reveals the editor, creating the panel on first use and reusing it
   * afterwards. When reused, the panel is re-initialized for the new request
   * (e.g. switching from Add to Edit).
   *
   * @param context - The extension context (supplies `extensionUri` for assets).
   * @param store - The task store; the authority for duplicate checks and writes.
   * @param pathValidator - Confirms the working directory exists and is a folder.
   * @param mode - Whether this is an Add or Edit session.
   * @param existing - In `edit` mode, the definition being edited.
   * @param defaultScope - Initial scope for `add` mode (defaults to `workspace`).
   */
  public static show(
    context: vscode.ExtensionContext,
    store: ITaskStore,
    pathValidator: IPathValidator,
    mode: TaskEditorMode,
    existing?: TaskDefinition,
    defaultScope: TaskScope = 'workspace'
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (TaskEditorPanel.current) {
      // Reuse the open panel: re-bind its session, then reveal and re-init.
      TaskEditorPanel.current.bind(store, pathValidator, mode, existing, defaultScope);
      TaskEditorPanel.current.panel.reveal(column);
      TaskEditorPanel.current.sendInit();
      return;
    }

    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      mode === 'edit' ? 'Edit Task' : 'Add Task',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Hard-pin the only directory the webview may load resources from.
        localResourceRoots: [mediaUri],
      }
    );

    TaskEditorPanel.current = new TaskEditorPanel(
      panel,
      context.extensionUri,
      store,
      pathValidator,
      mode,
      existing,
      defaultScope
    );
  }

  /**
   * @param panel - The underlying VS Code webview panel.
   * @param extensionUri - Root of the extension (for resolving `media/` assets).
   * @param store - Current task store binding.
   * @param pathValidator - Current path validator binding.
   * @param mode - Current session mode.
   * @param existing - Definition under edit (edit mode only).
   * @param defaultScope - Initial scope (add mode).
   */
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private store: ITaskStore,
    private pathValidator: IPathValidator,
    private mode: TaskEditorMode,
    private existing: TaskDefinition | undefined,
    private scope: TaskScope
  ) {
    this.panel.title = mode === 'edit' ? 'Edit Task' : 'Add Task';
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        // Never let a malformed/hostile message crash the host.
        void this.onMessage(msg).catch(() => {
          /* swallow — a failed message handler must not take down the host */
        });
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /**
   * Re-targets an existing panel at a new Add/Edit request without recreating
   * the webview (cheaper, and keeps `retainContextWhenHidden` state intact).
   */
  private bind(
    store: ITaskStore,
    pathValidator: IPathValidator,
    mode: TaskEditorMode,
    existing: TaskDefinition | undefined,
    scope: TaskScope
  ): void {
    this.store = store;
    this.pathValidator = pathValidator;
    this.mode = mode;
    this.existing = existing;
    this.scope = existing ? (store.getScope(existing.id) ?? scope) : scope;
    this.panel.title = mode === 'edit' ? 'Edit Task' : 'Add Task';
  }

  /** Routes one inbound webview message to its handler. */
  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.sendInit();
        return;
      case 'browseFolder':
        await this.handleBrowse();
        return;
      case 'validate':
        await this.handleValidate(msg.input);
        return;
      case 'submit':
        await this.handleSubmit(msg.input);
        return;
      case 'cancel':
        this.dispose();
        return;
      default:
        return;
    }
  }

  /** Sends the current session's initial state to the webview. */
  private sendInit(): void {
    const existingInput = this.existing ? this.toInput(this.existing) : null;
    this.post({
      type: 'init',
      mode: this.mode,
      scope: this.existing ? (this.store.getScope(this.existing.id) ?? this.scope) : this.scope,
      // Scope is immutable once a task exists: moving scopes is a separate action.
      scopeLocked: this.mode === 'edit',
      existing: existingInput,
    });
  }

  /** Opens a native folder picker and posts the chosen path back to the webview. */
  private async handleBrowse(): Promise<void> {
    let picked: vscode.Uri[] | undefined;
    try {
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Working Directory',
        defaultUri,
        title: 'Select Working Directory',
      });
    } catch {
      return;
    }
    const chosen = picked?.[0];
    if (chosen) {
      this.post({ type: 'folderPicked', path: chosen.fsPath });
    }
  }

  /** Runs all validation for the given values and posts the resulting errors. */
  private async handleValidate(raw: RawInput): Promise<void> {
    const { errors } = await this.validateAll(raw);
    this.post({ type: 'errors', errors });
  }

  /**
   * Validates, then — only if clean — persists the task and closes the panel.
   * Any error is posted back and the panel stays open for correction.
   */
  private async handleSubmit(raw: RawInput): Promise<void> {
    this.post({ type: 'busy', busy: true });
    try {
      const { errors, input } = await this.validateAll(raw);
      if (hasErrors(errors)) {
        this.post({ type: 'errors', errors });
        return;
      }

      if (this.mode === 'edit' && this.existing) {
        // Scope is immutable on edit: never read raw.scope here (the select is
        // disabled in the webview but a disabled control still posts a value).
        await this.store.update(this.existing.id, input);
      } else {
        // Honor the user's chosen scope, re-coercing the untrusted value and
        // falling back to the panel's default for anything unexpected.
        const scope = coerceScope(raw.scope, this.scope);
        await this.store.add(input, scope);
      }
      this.dispose();
    } catch {
      // Persistence failed unexpectedly — surface a generic, field-agnostic error.
      this.post({
        type: 'errors',
        errors: { name: 'Could not save the task. Please try again.' },
      });
    } finally {
      if (!this.disposed) {
        this.post({ type: 'busy', busy: false });
      }
    }
  }

  /**
   * The single authoritative validation pipeline: pure synchronous rules, then
   * the duplicate-name check, then the async working-directory probe.
   *
   * @returns The coerced input and the merged {@link FieldErrors}.
   */
  private async validateAll(
    raw: RawInput
  ): Promise<{ input: TaskDefinitionInput; errors: FieldErrors }> {
    const input = this.coerceInput(raw);
    const errors: FieldErrors = { ...validateInput(input) };

    // Duplicate-name check (case-insensitive), excluding self in edit mode.
    if (!errors.name) {
      const excludeId: TaskDefinitionId | undefined =
        this.mode === 'edit' ? this.existing?.id : undefined;
      if (hasDuplicateName(input.name, this.store.getAll(), excludeId)) {
        errors.name = 'Another task already uses this name.';
      }
    }

    // Working-directory probe (only when a non-empty dir was given and is valid so far).
    const dir = input.workingDirectory;
    if (!errors.workingDirectory && dir && dir.trim().length > 0) {
      const exists = await this.pathValidator.exists(dir);
      if (!exists) {
        errors.workingDirectory = 'This directory does not exist.';
      } else if (!(await this.pathValidator.isDirectory(dir))) {
        errors.workingDirectory = 'This path is not a directory.';
      }
    }

    return { input, errors };
  }

  /**
   * Coerces an untrusted webview payload into a well-typed
   * {@link TaskDefinitionInput}, dropping empties so optional fields stay
   * `undefined` rather than empty strings.
   */
  private coerceInput(raw: RawInput): TaskDefinitionInput {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const trimmedOrUndef = (v: unknown): string | undefined => {
      const s = str(v).trim();
      return s.length > 0 ? s : undefined;
    };

    const input: TaskDefinitionInput = {
      name: str(raw.name).trim(),
      command: str(raw.command).trim(),
      allowMultipleInstances: raw.allowMultipleInstances === true,
    };

    const workingDirectory = trimmedOrUndef(raw.workingDirectory);
    if (workingDirectory !== undefined) {
      input.workingDirectory = workingDirectory;
    }

    const shell = trimmedOrUndef(raw.shell);
    if (shell !== undefined) {
      input.shell = shell;
    }

    const icon = trimmedOrUndef(raw.icon);
    if (icon !== undefined) {
      input.icon = icon;
    }

    if (raw.autoRestart === true) {
      input.autoRestart = true;
    }

    const delay = this.coerceDelay(raw.startupDelayMs);
    if (delay !== undefined) {
      input.startupDelayMs = delay;
    }

    const env = this.coerceEnv(raw.environmentVariables);
    if (env) {
      input.environmentVariables = env;
    }

    return input;
  }

  /**
   * Coerces a startup-delay value. Empty/absent → `undefined`. A numeric string
   * is parsed; anything non-numeric is passed through as `NaN` so
   * {@link validateInput} can flag it rather than silently dropping the field.
   */
  private coerceDelay(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') {
      return undefined;
    }
    if (typeof v === 'number') {
      return v;
    }
    if (typeof v === 'string') {
      return Number(v.trim());
    }
    return Number.NaN;
  }

  /**
   * Coerces the env-var payload (an array of `{key,value}` rows or a plain
   * object) into a `Record<string,string>`. Rows with an empty key are dropped;
   * malformed keys are preserved so {@link validateInput} can report them.
   */
  private coerceEnv(v: unknown): Record<string, string> | undefined {
    const out: Record<string, string> = {};

    if (Array.isArray(v)) {
      for (const row of v) {
        if (row && typeof row === 'object') {
          const key =
            typeof (row as { key?: unknown }).key === 'string'
              ? (row as { key: string }).key.trim()
              : '';
          const value =
            typeof (row as { value?: unknown }).value === 'string'
              ? (row as { value: string }).value
              : '';
          if (key.length > 0) {
            out[key] = value;
          }
        }
      }
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const key = k.trim();
        if (key.length > 0) {
          out[key] = typeof val === 'string' ? val : String(val);
        }
      }
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Projects a stored {@link TaskDefinition} down to its editable subset. */
  private toInput(def: TaskDefinition): TaskDefinitionInput {
    const input: TaskDefinitionInput = {
      name: def.name,
      command: def.command,
      allowMultipleInstances: def.allowMultipleInstances,
    };
    if (def.workingDirectory !== undefined) {
      input.workingDirectory = def.workingDirectory;
    }
    if (def.environmentVariables !== undefined) {
      input.environmentVariables = { ...def.environmentVariables };
    }
    if (def.shell !== undefined) {
      input.shell = def.shell;
    }
    if (def.autoRestart !== undefined) {
      input.autoRestart = def.autoRestart;
    }
    if (def.startupDelayMs !== undefined) {
      input.startupDelayMs = def.startupDelayMs;
    }
    if (def.icon !== undefined) {
      input.icon = def.icon;
    }
    return input;
  }

  /** Type-safe `postMessage` to the webview (best-effort; ignores post failures). */
  private post(message: OutboundMessage): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /**
   * Builds the panel HTML with a strict CSP, nonced inline-free assets, and the
   * webview-safe URIs for `editor.css` / `editor.js`.
   */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = TaskEditorPanel.makeNonce();
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css')).toString();
    const codiconUri = webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'))
      .toString();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js')).toString();
    const cspSource = webview.cspSource;

    // The codicon id list for the icon picker, embedded as a non-executing JSON
    // data block (parsed by editor.js). Inlining it keeps the strict CSP intact —
    // no extra fetch/connect-src and no remote resource — and the values are
    // re-validated to `[a-z0-9-]` so the block can never break out of </script>.
    const iconNamesJson = TaskEditorPanel.readCodiconNames(mediaRoot);

    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} https:`,
      `style-src ${cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');

    // No inline event handlers, no eval, no remote/CDN. Script is nonced.
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${codiconUri}" rel="stylesheet" nonce="${nonce}" />
    <link href="${styleUri}" rel="stylesheet" nonce="${nonce}" />
    <title>Task Editor</title>
  </head>
  <body>
    <main class="editor" aria-labelledby="form-title">
      <h1 id="form-title" class="title"></h1>

      <form id="task-form" novalidate>
        <div class="field">
          <label for="name">Name <span class="req" aria-hidden="true">*</span></label>
          <input id="name" name="name" type="text" autocomplete="off" spellcheck="false"
            aria-required="true" aria-describedby="name-error" />
          <p id="name-error" class="error" role="alert" aria-live="polite"></p>
        </div>

        <div class="field">
          <label for="command">Command <span class="req" aria-hidden="true">*</span></label>
          <input id="command" name="command" type="text" autocomplete="off" spellcheck="false"
            aria-required="true" aria-describedby="command-help command-error" />
          <p id="command-help" class="hint">The shell command to run, e.g. <code>npm run dev</code>.</p>
          <p id="command-error" class="error" role="alert" aria-live="polite"></p>
        </div>

        <div class="field">
          <label for="workingDirectory">Working directory</label>
          <div class="row">
            <input id="workingDirectory" name="workingDirectory" type="text" autocomplete="off"
              spellcheck="false" aria-describedby="workingDirectory-help workingDirectory-error" />
            <button type="button" id="browse" class="secondary">Browse…</button>
          </div>
          <p id="workingDirectory-help" class="hint">Leave empty to use the workspace root.</p>
          <p id="workingDirectory-error" class="error" role="alert" aria-live="polite"></p>
        </div>

        <fieldset class="field">
          <legend>Environment variables</legend>
          <div id="env-rows" class="env-rows"></div>
          <button type="button" id="env-add" class="secondary small">
            <span aria-hidden="true">+</span> Add variable
          </button>
          <p id="environmentVariables-error" class="error" role="alert" aria-live="polite"></p>
        </fieldset>

        <div class="field-grid">
          <div class="field">
            <label for="shell">Shell</label>
            <input id="shell" name="shell" type="text" autocomplete="off" spellcheck="false"
              aria-describedby="shell-help" />
            <p id="shell-help" class="hint">Optional. Leave empty to run the program directly.</p>
          </div>

          <div class="field">
            <label for="startupDelayMs">Startup delay (ms)</label>
            <input id="startupDelayMs" name="startupDelayMs" type="number" min="0" step="100"
              inputmode="numeric" aria-describedby="startupDelayMs-error" />
            <p id="startupDelayMs-error" class="error" role="alert" aria-live="polite"></p>
          </div>
        </div>

        <div class="field">
          <label id="icon-label" for="icon-trigger">Icon</label>
          <div class="icon-picker" id="icon-picker">
            <button type="button" id="icon-trigger" class="icon-trigger" aria-haspopup="dialog"
              aria-expanded="false" aria-labelledby="icon-label icon-trigger-label"
              aria-describedby="icon-help">
              <span id="icon-trigger-glyph" class="codicon-preview is-empty" aria-hidden="true"></span>
              <span id="icon-trigger-label" class="icon-trigger-label"></span>
              <span class="codicon codicon-chevron-down icon-trigger-caret" aria-hidden="true"></span>
            </button>
            <div id="icon-popover" class="icon-popover" role="dialog" aria-label="Choose an icon" hidden>
              <div class="icon-popover-head">
                <input id="icon-search" class="icon-search" type="text" role="combobox"
                  autocomplete="off" spellcheck="false" placeholder="Search icons…"
                  aria-label="Search icons" aria-controls="icon-grid" aria-expanded="true"
                  aria-autocomplete="list" />
                <button type="button" id="icon-clear" class="secondary small icon-clear">None</button>
              </div>
              <div id="icon-grid" class="icon-grid" role="listbox" aria-label="Icons" tabindex="-1"></div>
              <p id="icon-status" class="icon-status" aria-live="polite"></p>
            </div>
            <input id="icon" name="icon" type="hidden" />
          </div>
          <p id="icon-help" class="hint">
            Pick a codicon. Leave as <strong>None</strong> to use the default <code>checklist</code>.
          </p>
        </div>

        <div class="checks">
          <label class="check">
            <input id="allowMultipleInstances" name="allowMultipleInstances" type="checkbox" />
            <span>Allow multiple instances</span>
          </label>
          <label class="check">
            <input id="autoRestart" name="autoRestart" type="checkbox" />
            <span>Auto-restart on crash</span>
          </label>
        </div>

        <div class="field">
          <label for="scope">Scope</label>
          <select id="scope" name="scope" aria-describedby="scope-help">
            <option value="workspace">Workspace (this project only)</option>
            <option value="global">Global (all projects)</option>
          </select>
          <p id="scope-help" class="hint">Scope cannot be changed after a task is created.</p>
        </div>

        <div class="actions">
          <button type="button" id="cancel" class="secondary">Cancel</button>
          <button type="submit" id="save" class="primary">Save</button>
        </div>
      </form>
    </main>
    <script type="application/json" id="codicon-names" nonce="${nonce}">${iconNamesJson}</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  /**
   * Reads the build-generated `media/codicon-names.json` and returns it as a
   * compact JSON string safe to inline in HTML. Every entry is re-validated to a
   * codicon id (`[a-z0-9-]`), so the result can never contain `<`, `>`, `&`, or a
   * `</script>` sequence. Returns `"[]"` if the file is missing or malformed —
   * the picker then degrades to accepting a typed id rather than crashing.
   */
  private static readCodiconNames(mediaRoot: vscode.Uri): string {
    try {
      const raw = readFileSync(vscode.Uri.joinPath(mediaRoot, 'codicon-names.json').fsPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const isId = /^[a-z0-9-]+$/;
      const names = Array.isArray(parsed)
        ? parsed.filter((n): n is string => typeof n === 'string' && isId.test(n))
        : [];
      return JSON.stringify(names);
    } catch {
      return '[]';
    }
  }

  /** Generates a cryptographically-random nonce for the CSP. */
  private static makeNonce(): string {
    return randomBytes(16)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '');
  }

  /**
   * Disposes the panel and all associated resources. Idempotent. Clears the
   * static `current` reference so the next {@link show} creates a fresh panel.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (TaskEditorPanel.current === this) {
      TaskEditorPanel.current = undefined;
    }

    // Dispose the panel itself (guarded — onDidDispose may have fired already).
    try {
      this.panel.dispose();
    } catch {
      /* already disposed by the host */
    }

    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
    this.disposables.length = 0;
  }
}
