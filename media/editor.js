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
    /** @type {HTMLSpanElement} */ iconPreview: /** @type {any} */ (byId('icon-preview')),
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

  dom.icon.addEventListener('input', updateIconPreview);

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
    updateIconPreview();
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

  // --- Misc ----------------------------------------------------------------

  function updateIconPreview() {
    const id = dom.icon.value.trim();
    dom.iconPreview.textContent = id ? '$(' + id + ')' : '';
  }

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
