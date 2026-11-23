// SPDX-License-Identifier: GPL-3.0-or-later

const extensions = ['.dxf', '.dwg'];
const revision = /^[a-f0-9]{64}$/;
const tabId = /^[0-9]+$/;
const basename = path => path.split('/').at(-1);
const extension = name => extensions.find(ext => name.toLowerCase().endsWith(ext));

function filename(value) {
  if (!value || value === '.' || value === '..' || /[\\/:\u0000-\u001f]/.test(value)) {
    throw Error('Enter a file name without slashes or control characters.');
  }
  return value;
}

function workspacePath(value, allowRoot = false) {
  if (typeof value !== 'string') throw Error('Choose a location in My files.');
  const path = value.replace(/^(?:webos:)?\//, '');
  if (allowRoot && path === '') return path;
  path.split('/').forEach(filename);
  if (path === '.app' || path.startsWith('.app/')) throw Error('Choose a location outside app settings.');
  return path;
}

export function mount(host) {
  const owner = host.storage.workspaceOwner();
  const session = host.session();
  const abort = new AbortController();
  const {signal} = abort;
  const tabs = new Map();
  const started = Promise.withResolvers();
  let context, releaseWriter, opening, activeTab, bound;
  let nextOpen = 0;
  let dirty = false, saving = false, writing = false, transferring = false;
  let picking = false;

  const element = document.createElement('section');
  element.className = 'window-content opencadstudio-workspace';
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('./workspace.css', import.meta.url).href;
  const frame = document.createElement('iframe');
  frame.title = 'OpenCADStudio editor';
  const footer = document.createElement('footer');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.textContent = 'Starting OpenCADStudio…';
  const source = document.createElement('a');
  source.href = new URL('./legal/opencadstudio-browser-source.tar.xz', import.meta.url).href;
  source.download = '';
  source.textContent = 'Source';
  footer.append(status, source);
  element.append(style, frame, footer);

  function workspace() {
    if (signal.aborted || owner !== host.storage.workspaceOwner() || session !== host.session() || !context?.valid()) {
      throw new DOMException('This Files workspace ended.', 'AbortError');
    }
    if (transferring) throw Error('Files are being transferred.');
    return context.files;
  }

  function send(type, fields, transfer = []) {
    if (signal.aborted) return;
    frame.contentWindow?.postMessage({source: 'opencadstudio-host', type, ...fields}, location.origin, transfer);
  }

  function report(message) {
    if (!signal.aborted) status.textContent = message;
  }

  function bindActive() {
    workspace();
    const selected = tabs.get(activeTab);
    if (selected === bound) return;
    host.desktop.updateAccountFileBinding(host.w, {
      owner,
      path: selected?.path ?? null,
      sha256: selected?.sha256 ?? null,
    });
    bound = selected;
  }

  async function pick(foldersOnly = false) {
    workspace();
    const value = await host.storage.pickWorkspaceFile({
      extensions: foldersOnly ? [] : extensions,
      foldersOnly,
      signal,
    });
    workspace();
    return value == null ? null : workspacePath(value, foldersOnly);
  }

  async function open(path, expected) {
    if (!extension(path)) throw Error('Choose a DXF or DWG drawing.');
    const {data, sha256} = await workspace().read(path, {signal});
    workspace();
    if (!revision.test(sha256)) throw Error('Files returned an invalid revision.');
    if (expected && expected !== sha256) throw Error('The drawing changed in Files. Open its current revision.');
    const requestId = String(++nextOpen);
    const name = basename(path);
    const buffer = data.slice().buffer;
    opening = {requestId, path, sha256};
    report('Opening ' + name + '…');
    send('ocs:open', {name, buffer, requestId, readOnly: false}, [buffer]);
  }

  async function selectDrawing() {
    if (picking || opening || saving || writing) return;
    picking = true;
    try {
      const path = await pick();
      if (path != null) await open(path);
    } finally {
      picking = false;
      if (!signal.aborted) frame.focus();
    }
  }

  async function save({buffer, format, name, tabId: tab, saveAs}) {
    const ext = '.' + format;
    if (!extensions.includes(ext) || !(buffer instanceof ArrayBuffer) || !buffer.byteLength || !tabId.test(tab)) {
      throw Error('The editor returned an invalid drawing.');
    }
    const previous = tabs.get(tab);
    let path = previous?.path;
    let expected = previous?.sha256;
    if (saveAs || !path || extension(path) !== ext) {
      const folder = await pick(true);
      if (folder == null) throw Error('Save cancelled.');
      const value = name.replace(/\.(dxf|dwg)$/i, '') + (saveAs && previous ? '-copy' : '') + ext;
      const chosen = await host.ui.prompt('File name', {
        title: 'Save OpenCADStudio drawing',
        value,
        confirmLabel: 'Save',
        signal,
      });
      workspace();
      if (chosen == null) throw Error('Save cancelled.');
      const leaf = filename(chosen.trim());
      if (extension(leaf) && extension(leaf) !== ext) throw Error('Use the ' + ext + ' extension for this format.');
      if (leaf.toLowerCase() === ext) throw Error('Enter a name before the extension.');
      const target = extension(leaf) ? leaf : leaf + ext;
      path = folder ? folder + '/' + target : target;
      path = workspacePath(path);
      expected = null;
    }
    let result;
    try {
      result = await workspace().write(path, new Uint8Array(buffer), expected, {signal});
    } catch (error) {
      if (error.status === 409) {
        throw Error(expected ? 'The drawing changed in Files. Use Save As to preserve your edit.' :
          'A drawing already has that name. Choose another name.');
      }
      throw error;
    }
    workspace();
    if (!revision.test(result.sha256)) throw Error('Files did not confirm the save.');
    tabs.set(tab, {path, sha256: result.sha256});
    return basename(path);
  }

  async function acceptSave(message) {
    if (writing || typeof message.saveId !== 'string') return;
    writing = true;
    let name;
    try {
      name = await save(message);
    } catch (error) {
      send('ocs:saved', {saveId: message.saveId, ok: false, error: error.message});
      report(error.message);
    } finally {
      writing = false;
      if (!signal.aborted) frame.focus();
    }
    if (name) {
      send('ocs:saved', {saveId: message.saveId, ok: true, name});
      report('Saved ' + name + ' in Files.');
      try { bindActive(); } catch (error) { report(error.message); }
    }
  }

  function onMessage(event) {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data?.source !== 'opencadstudio-embed') return;
    switch (data.type) {
      case 'ocs:ready':
        started.resolve();
        break;
      case 'ocs:state':
        activeTab = data.tabId;
        dirty = data.dirty === true;
        saving = data.saving === true;
        if (!opening) bindActive();
        break;
      case 'ocs:request-open':
        selectDrawing().catch(error => report(error.message));
        break;
      case 'ocs:loaded':
        if (opening && opening.requestId === data.requestId && tabId.test(data.tabId)) {
          tabs.set(data.tabId, {path: opening.path, sha256: opening.sha256});
          opening = null;
          activeTab = data.tabId;
          report('Opened ' + data.name + ' from Files.');
          bindActive();
        }
        break;
      case 'ocs:open-ended':
        if (opening && opening.requestId === data.requestId) {
          opening = null;
          bindActive();
        }
        break;
      case 'ocs:save':
        void acceptSave(data);
        break;
      case 'ocs:error':
        if (typeof data.message === 'string') report(data.message);
        break;
    }
  }

  window.addEventListener('message', event => {
    try { onMessage(event); } catch (error) { report(error.message); }
  }, {signal});
  const timer = setTimeout(() => started.reject(Error('OpenCADStudio did not start.')), 90000);
  started.promise.catch(() => {});
  signal.addEventListener('abort', () => started.reject(signal.reason), {once: true});
  const busy = () => picking || opening || saving || writing || transferring;
  window.addEventListener('beforeunload', event => {
    if (!dirty && !busy()) return;
    event.preventDefault();
    event.returnValue = '';
  }, {signal});

  const ready = (async () => {
    context = await host.storage.workspaceFileContext();
    if (context.owner !== owner) throw Error('OpenCADStudio belongs to another Files workspace.');
    workspace();
    releaseWriter = context.registerFileWriter?.(async () => {
      if (dirty || busy()) throw Error('Finish saving the CAD drawing before transferring Files.');
      transferring = true;
      frame.inert = true;
      return () => { frame.inert = false; transferring = false; };
    });
    frame.src = new URL('./native/index.html?embed=1&workspace=1', import.meta.url).href;
    await started.promise;
    workspace();
    report('OpenCADStudio is ready.');
    const launch = host.w.launchContext;
    if (launch) {
      if (launch.storage !== 'account' || launch.owner !== owner) throw Error('Open the drawing from My files.');
      await open(workspacePath(launch.path), launch.restore ? undefined : launch.sha256);
    }
  })().finally(() => clearTimeout(timer));
  ready.catch(error => report(error.message));

  return {
    element,
    ready,
    focus: () => frame.focus(),
    async requestClose() {
      if (busy()) {
        report('Finish opening or saving the drawing before closing.');
        return false;
      }
      return !dirty || host.ui.confirm('Discard unsaved changes to the CAD drawings?', {confirmLabel: 'Discard', signal});
    },
    dispose() {
      abort.abort();
      releaseWriter?.();
      tabs.clear();
    },
  };
}
