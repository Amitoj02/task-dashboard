// @ts-check
/*
 * Task Editor webview controller.
 *
 * Runs inside the CSP-hardened webview. It is purely presentational: it gathers
 * the form values, ships them to the extension host, and renders whatever errors
 * the host sends back. It never decides validity itself and performs no I/O or
 * network access.
 *
 * Loaded as a nonced external script (see TaskEditorPanel.buildHtml). No inline
 * handlers, no eval.
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** Field ids that can carry a server-side error message. */
  const ERROR_FIELDS = [
    'name',
    'command',
    'workingDirectory',
    'environmentVariables',
    'startupDelayMs',
  ];

  /** Cached DOM references, resolved on load. */
  const dom = {
    /** @type {HTMLHeadingElement} */ title: /** @type {any} */ (byId('form-title')),
    /** @type {HTMLFormElement} */ form: /** @type {any} */ (byId('task-form')),
    /** @type {HTMLInputElement} */ name: input('name'),
    /** @type {HTMLInputElement} */ command: input('command'),
    /** @type {HTMLInputElement} */ workingDirectory: input('workingDirectory'),
    /** @type {HTMLInputElement} */ shell: input('shell'),
    /** @type {HTMLInputElement} */ startupDelayMs: input('startupDelayMs'),
    /** @type {HTMLInputElement} */ icon: input('icon'),
    /** @type {HTMLDivElement} */ iconPicker: /** @type {any} */ (byId('icon-picker')),
    /** @type {HTMLButtonElement} */ iconTrigger: /** @type {any} */ (byId('icon-trigger')),
    /** @type {HTMLSpanElement} */ iconTriggerGlyph: /** @type {any} */ (byId('icon-trigger-glyph')),
    /** @type {HTMLSpanElement} */ iconTriggerLabel: /** @type {any} */ (byId('icon-trigger-label')),
    /** @type {HTMLDivElement} */ iconPopover: /** @type {any} */ (byId('icon-popover')),
    /** @type {HTMLInputElement} */ iconSearch: input('icon-search'),
    /** @type {HTMLButtonElement} */ iconClear: /** @type {any} */ (byId('icon-clear')),
    /** @type {HTMLDivElement} */ iconGrid: /** @type {any} */ (byId('icon-grid')),
    /** @type {HTMLParagraphElement} */ iconStatus: /** @type {any} */ (byId('icon-status')),
    /** @type {HTMLInputElement} */ allowMultipleInstances: input('allowMultipleInstances'),
    /** @type {HTMLInputElement} */ autoRestart: input('autoRestart'),
    /** @type {HTMLSelectElement} */ scope: /** @type {any} */ (byId('scope')),
    /** @type {HTMLDivElement} */ envRows: /** @type {any} */ (byId('env-rows')),
    /** @type {HTMLButtonElement} */ envAdd: /** @type {any} */ (byId('env-add')),
    /** @type {HTMLButtonElement} */ browse: /** @type {any} */ (byId('browse')),
    /** @type {HTMLButtonElement} */ cancel: /** @type {any} */ (byId('cancel')),
    /** @type {HTMLButtonElement} */ save: /** @type {any} */ (byId('save')),
  };

  // --- Wiring --------------------------------------------------------------

  dom.form.addEventListener('submit', (e) => {
    e.preventDefault();
    post('submit', { input: collect() });
  });

  dom.cancel.addEventListener('click', () => post('cancel'));
  dom.browse.addEventListener('click', () => post('browseFolder'));
  dom.envAdd.addEventListener('click', () => {
    addEnvRow('', '');
    focusLastEnvKey();
  });

  // Re-validate on blur for snappy, non-nagging feedback.
  for (const id of ['name', 'command', 'workingDirectory', 'startupDelayMs']) {
    const el = input(id);
    el.addEventListener('blur', () => post('validate', { input: collect() }));
    // Clear a field's error as soon as the user starts fixing it.
    el.addEventListener('input', () => setError(id, ''));
  }

  initIconPicker();

  window.addEventListener('message', (event) => onMessage(event.data));

  // Tell the host we are ready to receive the initial state.
  post('ready');

  // --- Message handling ----------------------------------------------------

  /** @param {any} msg */
  function onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'init':
        applyInit(msg);
        break;
      case 'folderPicked':
        if (typeof msg.path === 'string') {
          dom.workingDirectory.value = msg.path;
          setError('workingDirectory', '');
          dom.workingDirectory.focus();
        }
        break;
      case 'errors':
        renderErrors(msg.errors || {});
        break;
      case 'busy':
        setBusy(Boolean(msg.busy));
        break;
      default:
        break;
    }
  }

  /** Applies the host-supplied initial state (mode, scope, prefilled values). */
  function applyInit(msg) {
    const isEdit = msg.mode === 'edit';
    dom.title.textContent = isEdit ? 'Edit Task' : 'Add Task';
    dom.save.textContent = isEdit ? 'Save changes' : 'Create task';

    const existing = msg.existing || {};
    dom.name.value = str(existing.name);
    dom.command.value = str(existing.command);
    dom.workingDirectory.value = str(existing.workingDirectory);
    dom.shell.value = str(existing.shell);
    dom.startupDelayMs.value =
      existing.startupDelayMs === undefined || existing.startupDelayMs === null
        ? ''
        : String(existing.startupDelayMs);
    dom.icon.value = str(existing.icon);
    dom.allowMultipleInstances.checked = existing.allowMultipleInstances === true;
    dom.autoRestart.checked = existing.autoRestart === true;

    if (msg.scope === 'global' || msg.scope === 'workspace') {
      dom.scope.value = msg.scope;
    }
    dom.scope.disabled = Boolean(msg.scopeLocked);

    renderEnvRows(existing.environmentVariables);
    closeIconPopover();
    refreshIconTrigger();
    renderErrors({});
    dom.name.focus();
  }

  // --- Collect & validate --------------------------------------------------

  /** Gathers the current form values into the host's RawInput shape. */
  function collect() {
    return {
      name: dom.name.value,
      command: dom.command.value,
      workingDirectory: dom.workingDirectory.value,
      shell: dom.shell.value,
      startupDelayMs: dom.startupDelayMs.value,
      icon: dom.icon.value,
      allowMultipleInstances: dom.allowMultipleInstances.checked,
      autoRestart: dom.autoRestart.checked,
      environmentVariables: collectEnv(),
      // The chosen scope (e.g. "global"). The host treats it as untrusted and
      // re-coerces it, and ignores it entirely in edit mode (scope is locked).
      scope: dom.scope.value,
    };
  }

  /** Reads env-var rows into an array of {key,value} objects. */
  function collectEnv() {
    /** @type {{ key: string, value: string }[]} */
    const rows = [];
    const rowEls = dom.envRows.querySelectorAll('.env-row');
    rowEls.forEach((row) => {
      const keyEl = /** @type {HTMLInputElement|null} */ (row.querySelector('.env-key'));
      const valEl = /** @type {HTMLInputElement|null} */ (row.querySelector('.env-value'));
      rows.push({ key: keyEl ? keyEl.value : '', value: valEl ? valEl.value : '' });
    });
    return rows;
  }

  // --- Environment variable rows ------------------------------------------

  /** @param {Record<string, string> | undefined} env */
  function renderEnvRows(env) {
    dom.envRows.textContent = '';
    const entries = env && typeof env === 'object' ? Object.entries(env) : [];
    if (entries.length === 0) {
      // Start with one empty row so the affordance is discoverable.
      addEnvRow('', '');
      return;
    }
    for (const [key, value] of entries) {
      addEnvRow(str(key), str(value));
    }
  }

  /**
   * Appends one key/value row with a remove button. Built via DOM APIs (never
   * innerHTML) so user values can never inject markup.
   * @param {string} key
   * @param {string} value
   */
  function addEnvRow(key, value) {
    const row = document.createElement('div');
    row.className = 'env-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'env-key';
    keyInput.value = key;
    keyInput.placeholder = 'NAME';
    keyInput.setAttribute('aria-label', 'Environment variable name');
    keyInput.spellcheck = false;
    keyInput.autocomplete = 'off';
    keyInput.addEventListener('input', () => setError('environmentVariables', ''));

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'env-value';
    valueInput.value = value;
    valueInput.placeholder = 'value';
    valueInput.setAttribute('aria-label', 'Environment variable value');
    valueInput.spellcheck = false;
    valueInput.autocomplete = 'off';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary icon-btn';
    remove.textContent = '×'; // multiplication sign ×
    remove.title = 'Remove variable';
    remove.setAttribute('aria-label', 'Remove environment variable');
    remove.addEventListener('click', () => {
      row.remove();
      if (dom.envRows.querySelectorAll('.env-row').length === 0) {
        addEnvRow('', '');
      }
    });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(remove);
    dom.envRows.appendChild(row);
  }

  function focusLastEnvKey() {
    const rows = dom.envRows.querySelectorAll('.env-row .env-key');
    const last = /** @type {HTMLInputElement|undefined} */ (rows[rows.length - 1]);
    if (last) {
      last.focus();
    }
  }

  // --- Error rendering -----------------------------------------------------

  /** @param {Record<string, string>} errors */
  function renderErrors(errors) {
    let firstInvalid = null;
    for (const field of ERROR_FIELDS) {
      const message = typeof errors[field] === 'string' ? errors[field] : '';
      setError(field, message);
      if (message && !firstInvalid) {
        firstInvalid = field;
      }
    }
    if (firstInvalid) {
      const el = document.getElementById(firstInvalid);
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
    }
  }

  /**
   * Sets (or clears) a field's error text and aria-invalid state.
   * @param {string} field
   * @param {string} message
   */
  function setError(field, message) {
    const out = document.getElementById(field + '-error');
    if (out) {
      out.textContent = message || '';
    }
    const control = document.getElementById(field);
    if (control) {
      if (message) {
        control.setAttribute('aria-invalid', 'true');
      } else {
        control.removeAttribute('aria-invalid');
      }
    }
  }

  // --- Icon picker ---------------------------------------------------------

  /** Codicon ids are lowercase words joined by dashes, e.g. `cloud-download`. */
  const CODICON_ID = /^[a-z0-9-]+$/;

  /** The id the tree falls back to when a task has no icon set. */
  const DEFAULT_ICON = 'checklist';

  /** All bundled codicon ids, loaded once from the embedded JSON data block. */
  let iconNames = /** @type {string[]} */ ([]);

  /** The grid's option cells, in display order (rebuilt on each filter). */
  let iconCells = /** @type {HTMLElement[]} */ ([]);

  /** Index of the active (keyboard-highlighted) cell, or -1 for none. */
  let iconActive = -1;

  /**
   * Wires the icon picker: loads the bundled names and binds the trigger,
   * search box, clear button, grid clicks, and outside-click dismissal.
   */
  function initIconPicker() {
    iconNames = loadIconNames();

    dom.iconTrigger.addEventListener('click', () => {
      if (isIconOpen()) {
        closeIconPopover();
      } else {
        openIconPopover();
      }
    });

    dom.iconClear.addEventListener('click', () => selectIcon(''));

    dom.iconSearch.addEventListener('input', () => renderIconGrid(dom.iconSearch.value));
    dom.iconSearch.addEventListener('keydown', onIconSearchKeydown);

    // Choose a glyph by click (delegated; cells are rebuilt on every filter).
    dom.iconGrid.addEventListener('click', (e) => {
      const cell = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (e.target).closest('[data-icon]')
      );
      if (cell) {
        selectIcon(cell.getAttribute('data-icon') || '');
      }
    });

    // Dismiss when a click lands outside the whole picker.
    document.addEventListener('mousedown', (e) => {
      if (isIconOpen() && !dom.iconPicker.contains(/** @type {Node} */ (e.target))) {
        closeIconPopover();
      }
    });

    // Dismiss when keyboard focus (Tab) leaves the picker, mirroring the
    // outside-click dismissal so a Tab-out never strands an open popover with
    // no focus inside it. `relatedTarget` is the element gaining focus.
    dom.iconPicker.addEventListener('focusout', (e) => {
      const next = /** @type {Node|null} */ (e.relatedTarget);
      if (isIconOpen() && (!next || !dom.iconPicker.contains(next))) {
        closeIconPopover();
      }
    });

    refreshIconTrigger();
  }

  /** Parses the embedded codicon id list; tolerates a missing/garbled block. */
  function loadIconNames() {
    const el = document.getElementById('codicon-names');
    if (!el || !el.textContent) {
      return [];
    }
    try {
      const parsed = JSON.parse(el.textContent);
      return Array.isArray(parsed)
        ? parsed.filter((n) => typeof n === 'string' && CODICON_ID.test(n))
        : [];
    } catch (_e) {
      return [];
    }
  }

  /** @returns {boolean} Whether the popover is currently open. */
  function isIconOpen() {
    return !dom.iconPopover.hidden;
  }

  /** Opens the popover, resets the search, and renders the full grid. */
  function openIconPopover() {
    dom.iconPopover.hidden = false;
    dom.iconTrigger.setAttribute('aria-expanded', 'true');
    dom.iconSearch.value = '';
    renderIconGrid('');
    dom.iconSearch.focus();
  }

  /** Closes the popover and clears the keyboard highlight (focus untouched). */
  function closeIconPopover() {
    dom.iconPopover.hidden = true;
    dom.iconTrigger.setAttribute('aria-expanded', 'false');
    dom.iconSearch.removeAttribute('aria-activedescendant');
    iconActive = -1;
  }

  /**
   * Rebuilds the grid filtered by `query` (case-insensitive substring). Cells are
   * glyph-only `option`s; only class names / text are ever assigned (never
   * innerHTML) so a codicon id can't inject markup. Activates the selected icon
   * if visible, else the first cell.
   * @param {string} query
   */
  function renderIconGrid(query) {
    const q = query.trim().toLowerCase();
    const matches = q ? iconNames.filter((n) => n.indexOf(q) !== -1) : iconNames;
    const current = dom.icon.value.trim();

    const frag = document.createDocumentFragment();
    iconCells = matches.map((name, i) => {
      const cell = document.createElement('div');
      cell.className = 'icon-cell';
      cell.id = 'icon-opt-' + i;
      cell.setAttribute('role', 'option');
      cell.setAttribute('data-icon', name);
      cell.title = name;
      cell.setAttribute('aria-label', name);
      if (name === current) {
        cell.setAttribute('aria-selected', 'true');
        cell.classList.add('is-selected');
      }
      const glyph = document.createElement('span');
      glyph.className = 'codicon codicon-' + name;
      glyph.setAttribute('aria-hidden', 'true');
      cell.appendChild(glyph);
      frag.appendChild(cell);
      return cell;
    });

    dom.iconGrid.textContent = '';
    dom.iconGrid.appendChild(frag);

    let active = iconCells.findIndex((c) => c.classList.contains('is-selected'));
    if (active < 0 && iconCells.length > 0) {
      active = 0;
    }
    setIconActive(active);
    updateIconStatus(matches.length, q);
  }

  /**
   * Announces the result count, or - when nothing matches but the query is a
   * valid id - that Enter will use it verbatim (forward-compat for new codicons).
   * @param {number} count
   * @param {string} q
   */
  function updateIconStatus(count, q) {
    if (count === 0) {
      dom.iconStatus.textContent =
        q && CODICON_ID.test(q)
          ? 'No matches. Press Enter to use “' + q + '”.'
          : 'No matching icons.';
      return;
    }
    dom.iconStatus.textContent = count === 1 ? '1 icon' : count + ' icons';
  }

  /**
   * Marks cell `index` active, syncing `aria-activedescendant` and scrolling it
   * into view. An out-of-range index clears the highlight.
   * @param {number} index
   */
  function setIconActive(index) {
    if (iconActive >= 0 && iconCells[iconActive]) {
      iconCells[iconActive].classList.remove('is-active');
    }
    iconActive = index >= 0 && index < iconCells.length ? index : -1;
    if (iconActive < 0) {
      dom.iconSearch.removeAttribute('aria-activedescendant');
      return;
    }
    const cell = iconCells[iconActive];
    cell.classList.add('is-active');
    dom.iconSearch.setAttribute('aria-activedescendant', cell.id);
    cell.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Keyboard model for the search box (the combobox): arrows move the active
   * cell (Left/Right by one, Up/Down by a row), Home/End jump to the ends, Enter
   * commits, Escape closes and restores focus to the trigger.
   * @param {KeyboardEvent} e
   */
  function onIconSearchKeydown(e) {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        moveIconActive(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveIconActive(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveIconActive(iconColumns());
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveIconActive(-iconColumns());
        break;
      case 'Home':
        if (iconCells.length > 0) {
          e.preventDefault();
          setIconActive(0);
        }
        break;
      case 'End':
        if (iconCells.length > 0) {
          e.preventDefault();
          setIconActive(iconCells.length - 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        commitIconFromKeyboard();
        break;
      case 'Escape':
        e.preventDefault();
        closeIconPopover();
        dom.iconTrigger.focus();
        break;
      default:
        break;
    }
  }

  /**
   * Shifts the active cell by `delta`, clamping within the grid (never wraps).
   * From no selection, any move lands on the first cell.
   * @param {number} delta
   */
  function moveIconActive(delta) {
    if (iconCells.length === 0) {
      return;
    }
    const base = iconActive < 0 ? 0 : iconActive + delta;
    setIconActive(Math.max(0, Math.min(iconCells.length - 1, base)));
  }

  /** Commits the active cell, or a typed-but-unlisted valid id (forward-compat). */
  function commitIconFromKeyboard() {
    if (iconActive >= 0 && iconCells[iconActive]) {
      selectIcon(iconCells[iconActive].getAttribute('data-icon') || '');
      return;
    }
    const raw = dom.iconSearch.value.trim();
    if (raw && CODICON_ID.test(raw)) {
      selectIcon(raw);
    }
  }

  /** @returns {number} The grid's current column count (>= 1). */
  function iconColumns() {
    const cols = getComputedStyle(dom.iconGrid).gridTemplateColumns;
    const n = cols ? cols.split(' ').filter((s) => s.length > 0).length : 0;
    return n > 0 ? n : 1;
  }

  /**
   * Commits a chosen icon: stores the raw value (empty = default), refreshes the
   * trigger, closes the popover, and returns focus to the trigger.
   * @param {string} value
   */
  function selectIcon(value) {
    dom.icon.value = value;
    refreshIconTrigger();
    closeIconPopover();
    dom.iconTrigger.focus();
  }

  /**
   * Reflects the current hidden value on the trigger: the chosen glyph + name,
   * or the default `checklist` glyph + label when unset. Only class names / text
   * are assigned (never innerHTML), so values stay inert.
   */
  function refreshIconTrigger() {
    const id = dom.icon.value.trim();
    if (id && CODICON_ID.test(id)) {
      dom.iconTriggerGlyph.className = 'codicon-preview codicon codicon-' + id;
      dom.iconTriggerLabel.textContent = id;
      dom.iconTriggerLabel.classList.remove('is-default');
    } else {
      // Empty/invalid: preview the default the tree will actually render.
      dom.iconTriggerGlyph.className = 'codicon-preview codicon codicon-' + DEFAULT_ICON;
      dom.iconTriggerLabel.textContent = 'Default (' + DEFAULT_ICON + ')';
      dom.iconTriggerLabel.classList.add('is-default');
    }
  }

  // --- Misc ----------------------------------------------------------------

  /** @param {boolean} busy */
  function setBusy(busy) {
    dom.save.disabled = busy;
    dom.cancel.disabled = busy;
  }

  /**
   * Posts a message to the host.
   * @param {string} type
   * @param {Record<string, unknown>} [extra]
   */
  function post(type, extra) {
    vscode.postMessage(Object.assign({ type: type }, extra || {}));
  }

  /** @param {unknown} v */
  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  /** @param {string} id */
  function byId(id) {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error('Missing element: ' + id);
    }
    return el;
  }

  /**
   * @param {string} id
   * @returns {HTMLInputElement}
   */
  function input(id) {
    return /** @type {HTMLInputElement} */ (byId(id));
  }
})();
