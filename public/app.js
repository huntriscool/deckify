'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN = document.querySelector('meta[name="token"]')?.content || '';
const COLS = 5;
const ROWS = 3;
const ICON_SIZE = 100;
const ALL_KEYS = Array.from({ length: 15 }, (_, i) => i + 1);
const DEFAULT_BG = '#0d111b';
const DEFAULT = () => ({ rotation: 90, brightness: 60, keys: {} });

const api = {
  async request(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, headers: { 'x-token': TOKEN, ...(options.headers || {}) } }); }
    catch { throw new Error('Cannot reach the local Deckify server. Is it still open?'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The server returned an invalid response.'); }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Server error (${response.status})`);
    return data;
  },
  post(url, body, binary = false) {
    return api.request(url, { method: 'POST', headers: { 'Content-Type': binary ? 'image/jpeg' : 'application/json' }, body: binary ? body : JSON.stringify(body) });
  },
  getConfig() { return api.request('/api/config'); },
  saveConfig(config) { return api.post('/api/config', config); },
  connect() { return api.post('/api/connect', {}); },
  brightness(value) { return api.post('/api/brightness', { value }); },
  setKey(key, jpeg) { return api.post(`/api/key/${key}`, jpeg, true); },
};

let cfg = DEFAULT();
let selected = 1;
let connected = false;
let identifyMode = false;
let busy = false;
let clipboard = null;
let undoHistory = [];
let saveTimeout = null;
let saveRevision = 0;
let saveChain = Promise.resolve();
let toastTimeout;
let lastEdit = { key: null, reason: null, time: 0 };

const pending = new Set();
const tiles = new Map();
const imgCache = new Map();
const renderRevision = new Map();
const asClone = (obj) => JSON.parse(JSON.stringify(obj));
const keyCfg = (key) => cfg.keys[key] || {};
const gridPosition = (key) => [ROWS - 1 - Math.floor((key - 1) / COLS), (key - 1) % COLS];
const positionName = (key) => {
  const [row, col] = gridPosition(key);
  return `${['Top', 'Middle', 'Bottom'][row]} ${['left', 'second', 'centre', 'fourth', 'right'][col]}`;
};

function notify(message, error = false) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, error ? 6800 : 3700);
}

function saveLabel(text) {
  const el = $('saveStatus');
  if (el) el.textContent = text;
}

function updateStatus() {
  const pendingLabel = $('pendingLabel');
  if (pendingLabel) {
    pendingLabel.classList.toggle('needs-sync', pending.size > 0);
    pendingLabel.lastChild.textContent = pending.size ? ` ${pending.size} key${pending.size === 1 ? '' : 's'} changed since last sync` : ' Changes are saved on this computer';
  }

  const keyState = $('keyState');
  if (keyState) {
    keyState.textContent = pending.has(selected) ? 'Not on dock yet' : 'Ready to edit';
    keyState.classList.toggle('changed', pending.has(selected));
  }

  updateActions();
}

function updateActions() {
  const canSend = connected && !busy && !identifyMode;
  const applyKey = $('applyKey');
  if (applyKey) applyKey.disabled = !canSend;

  const showNumbers = $('showNumbers');
  if (showNumbers) showNumbers.disabled = !connected || busy;

  const reconnect = $('reconnect');
  if (reconnect) reconnect.disabled = busy;

  for (const id of ['choose', 'clearKey', 'copyKey', 'caption', 'fit', 'background', 'flipH', 'flipV', 'rotation', 'brightness', 'exportLayout', 'importLayout']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }

  const pasteKey = $('pasteKey');
  if (pasteKey) pasteKey.disabled = busy || !clipboard;

  const undo = $('undo');
  if (undo) undo.disabled = busy || undoHistory.length === 0;
}

function markEdited(key) {
  pending.add(key);
  updateStatus();
  scheduleSave();
}

function scheduleSave() {
  const revision = ++saveRevision;
  clearTimeout(saveTimeout);
  saveLabel('Saving locally…');
  saveTimeout = setTimeout(() => { saveTimeout = null; queuePersist(revision).catch(() => {}); }, 330);
}

function queuePersist(revision) {
  const snapshot = asClone(cfg);
  saveChain = saveChain.catch(() => {}).then(async () => {
    await api.saveConfig(snapshot);
    if (revision === saveRevision) saveLabel('✓ Saved on this computer');
  }).catch((error) => {
    saveLabel('⚠ Could not save changes');
    notify(`Could not save layout: ${error.message}`, true);
    throw error;
  });
  return saveChain;
}

async function flushSave() {
  if (saveTimeout !== null) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    await queuePersist(++saveRevision);
  } else {
    await saveChain;
  }
}

function pushUndo(key, reason = 'edit') {
  const now = Date.now();
  if (!(reason === 'caption' && lastEdit.key === key && lastEdit.reason === 'caption' && now - lastEdit.time < 1200)) {
    undoHistory.push({ key, previous: asClone(keyCfg(key)) });
    if (undoHistory.length > 50) undoHistory.shift();
  }
  lastEdit = { key, reason, time: now };
}

function changeKey(key, next, reason = 'edit') {
  const old = JSON.stringify(keyCfg(key));
  if (old === JSON.stringify(next)) return;
  pushUndo(key, reason);
  cfg.keys[key] = next;
  markEdited(key);
  refreshTile(key);
  if (key === selected) drawSelected();
}

function makeCanvas(size = ICON_SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}

async function imageFor(src) {
  if (!src) return null;
  if (!imgCache.has(src)) {
    const image = new Image();
    image.src = src;
    const promise = image.decode().then(() => image).catch(() => null);
    imgCache.set(src, promise);
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(src);
}

async function fileToIcon(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > 12 * 1024 * 1024) throw new Error('That image is too large. Choose one under 12 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('That image could not be opened.');
    const scale = Math.min(1, 420 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const webp = canvas.toDataURL('image/webp', 0.85);
    const src = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
    if (src.length > 1_500_000) throw new Error('Compressed image is too large for a key.');
    return src;
  } finally { bitmap.close?.(); }
}

async function renderUpright(keyData, size = ICON_SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = keyData.background || DEFAULT_BG;
  ctx.fillRect(0, 0, size, size);

  const image = await imageFor(keyData.image);
  if (image) {
    const scale = (keyData.fit === 'contain' ? Math.min : Math.max)(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(keyData.flipH ? -1 : 1, keyData.flipV ? -1 : 1);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  const caption = (keyData.caption || '').trim();
  if (caption) {
    const h = Math.round(size * 0.27);
    ctx.fillStyle = '#000b';
    ctx.fillRect(0, size - h, size, h);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(size * 0.15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, size / 2, size - h / 2, size - 10);
  }

  return canvas;
}

async function toDockJpeg(upright, rotation) {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(upright, -ICON_SIZE / 2, -ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob) throw new Error('Could not encode the icon.');
  return new Uint8Array(await blob.arrayBuffer());
}

function numberArt(key) {
  const c = makeCanvas();
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#173e39';
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.strokeStyle = '#6de3c0';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, ICON_SIZE - 8, ICON_SIZE - 8);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 60px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(key), ICON_SIZE / 2, ICON_SIZE / 2 + 4);
  return c;
}

function buildGrid() {
  const grid = $('grid');
  if (!grid) return;
  grid.replaceChildren();
  tiles.clear();

  for (const key of ALL_KEYS) {
    const [r, c] = gridPosition(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key';
    button.style.gridRow = String(r + 1);
    button.style.gridColumn = String(c + 1);
    button.title = `Key ${key} · ${positionName(key)}`;
    button.setAttribute('aria-label', `Edit key ${key}, ${positionName(key)}`);

    const canvas = makeCanvas();
    const number = document.createElement('span');
    number.className = 'num';
    number.textContent = String(key);

    const blank = document.createElement('span');
    blank.className = 'blank-mark';
    blank.textContent = '+';
    blank.setAttribute('aria-hidden', 'true');

    button.append(canvas, blank, number);
    button.addEventListener('click', () => select(key));
    button.addEventListener('dragover', (event) => { if (!busy) event.preventDefault(); });
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      if (busy) return;
      select(key);
      const file = [...event.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (file) uploadImage(file, key);
    });

    tiles.set(key, { el: button, canvas });
    grid.append(button);
    refreshTile(key);
  }

  select(selected);
}

async function refreshTile(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  const v = (renderRevision.get(key) || 0) + 1;
  renderRevision.set(key, v);
  const data = keyCfg(key);
  tile.el.classList.toggle('has-image', !!data.image);
  tile.el.classList.toggle('has-label', !!data.caption);
  const canvas = await renderUpright(data);
  if (renderRevision.get(key) !== v) return;
  const ctx = tile.canvas.getContext('2d');
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.drawImage(canvas, 0, 0);
}

let selectedRevision = 0;

async function drawSelected() {
  const preview = $('largePreview');
  if (!preview) return;
  const v = ++selectedRevision;
  const canvas = await renderUpright(keyCfg(selected), 160);
  if (v !== selectedRevision) return;
  const ctx = preview.getContext('2d');
  ctx.clearRect(0, 0, 160, 160);
  ctx.drawImage(canvas, 0, 0);
}

function select(key) {
  selected = key;
  for (const [n, tile] of tiles) {
    tile.el.classList.toggle('selected', n === key);
    tile.el.setAttribute('aria-pressed', String(n === key));
  }

  const selTitle = $('selTitle');
  if (selTitle) selTitle.textContent = `Key ${key}`;

  const keyPosition = $('keyPosition');
  if (keyPosition) keyPosition.textContent = `${positionName(key)} · physical dock`;

  const data = keyCfg(key);
  const caption = $('caption');
  if (caption) caption.value = data.caption || '';

  const captionCount = $('captionCount');
  if (captionCount) captionCount.textContent = `${(data.caption || '').length}/12`;

  const flipH = $('flipH');
  if (flipH) flipH.checked = !!data.flipH;

  const flipV = $('flipV');
  if (flipV) flipV.checked = !!data.flipV;

  const fit = $('fit');
  if (fit) fit.value = data.fit || 'cover';

  const background = $('background');
  if (background) background.value = data.background || DEFAULT_BG;

  const backgroundValue = $('backgroundValue');
  if (backgroundValue) backgroundValue.textContent = (data.background || DEFAULT_BG).toUpperCase();

  drawSelected();
  updateStatus();
}

function currentEdited(reason = 'edit') {
  const newData = { ...keyCfg(selected) };
  newData.caption = $('caption')?.value || '';
  newData.flipH = $('flipH')?.checked || false;
  newData.flipV = $('flipV')?.checked || false;
  newData.fit = $('fit')?.value || 'cover';
  newData.background = $('background')?.value || DEFAULT_BG;

  const captionCount = $('captionCount');
  if (captionCount) captionCount.textContent = `${newData.caption.length}/12`;

  const backgroundValue = $('backgroundValue');
  if (backgroundValue) backgroundValue.textContent = newData.background.toUpperCase();

  changeKey(selected, newData, reason);
}

async function uploadImage(file, key = selected) {
  try {
    const image = await fileToIcon(file);
    changeKey(key, { ...keyCfg(key), image });
    if (selected === key) select(key);
    notify(`Image added to key ${key}. Send it to the dock when ready.`);
  } catch (error) {
    notify(error.message, true);
  }
}

function setBusy(active, title = '', detail = '') {
  busy = active;
  const overlay = $('busyOverlay');
  const titleEl = $('busyTitle');
  const detailEl = $('busyDetail');
  const bar = $('busyBar');

  if (overlay) overlay.hidden = !active;
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (bar) bar.style.width = '0%';
  updateActions();
}

async function sendKeys(keys, numbered = false) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const detailEl = $('busyDetail');
    if (detailEl) detailEl.textContent = `${numbered ? 'Showing number on' : 'Updating'} key ${key} · ${i + 1} of ${keys.length}`;
    const image = numbered ? numberArt(key) : await renderUpright(keyCfg(key));
    const jpeg = await toDockJpeg(image, cfg.rotation);
    await api.setKey(key, jpeg);
    if (!numbered) pending.delete(key);
    const bar = $('busyBar');
    if (bar) bar.style.width = `${Math.round(((i + 1) / keys.length) * 100)}%`;
  }
}

async function sync(keys, label) {
  if (!connected || busy || identifyMode) return;
  setBusy(true, label, 'Saving your layout…');
  try {
    await flushSave();
    await sendKeys(keys);
    updateStatus();
    notify(keys.length === 1 ? `Key ${keys[0]} updated on the dock.` : 'Your dock has been updated.');
  } catch (error) {
    notify(`Transfer interrupted: ${error.message} — retry the sync.`, true);
  } finally {
    setBusy(false);
    updateStatus();
  }
}

async function toggleIdentify(checked) {
  if (!connected || busy) {
    const showNumbers = $('showNumbers');
    if (showNumbers) showNumbers.checked = identifyMode;
    return;
  }

  setBusy(true, checked ? 'Showing key numbers…' : 'Restoring your icons…');
  try {
    await flushSave();
    await sendKeys(ALL_KEYS, checked);
    identifyMode = checked;
    const showNumbers = $('showNumbers');
    if (showNumbers) showNumbers.checked = checked;
    updateStatus();
    notify(checked ? 'Key numbers are showing. Turn the switch off to restore your icons.' : 'All your saved icons have been restored to the dock.');
  } catch (error) {
    identifyMode = true;
    const showNumbers = $('showNumbers');
    if (showNumbers) showNumbers.checked = true;
    notify(`Key display partly updated: ${error.message}. Turn the switch off to restore your layout.`, true);
  } finally {
    setBusy(false);
    updateStatus();
  }
}

function normalizeImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a valid Deckify layout.');
  const rotation = Number(raw.rotation ?? 90);
  const brightness = Number(raw.brightness ?? 60);
  if (![0, 90, 180, 270].includes(rotation) || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) throw new Error('Invalid brightness or rotation settings.');
  const entries = Object.entries(raw.keys || {});
  if (entries.length > 15) throw new Error('A layout can contain at most 15 keys.');
  const keys = {};
  for (const [key, value] of entries) {
    if (!/^(?:[1-9]|1[0-5])$/.test(key) || !value || typeof value !== 'object') throw new Error(`Invalid key: ${key}`);
    if (value.image && (typeof value.image !== 'string' || value.image.length > 1_500_000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.image))) throw new Error(`Unsupported image on key ${key}`);
    if (value.caption != null && (typeof value.caption !== 'string' || value.caption.length > 12)) throw new Error(`Key ${key} label is too long.`);
    if (value.fit && !['cover', 'contain'].includes(value.fit)) throw new Error(`Invalid fit on key ${key}`);
    if (value.background && !/^#[a-f\d]{6}$/i.test(value.background)) throw new Error(`Invalid background on key ${key}`);
    keys[key] = { ...value };
  }
  return { rotation, brightness, keys };
}

function exportLayout() {
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `deckify-layout-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
  notify('Layout backup exported. Keep it somewhere safe.');
}

async function importLayout(file) {
  if (file.size > 26_000_000) return notify('That layout file is too large.', true);
  if (!confirm('Replace your current saved layout with this file? Export a backup first if needed.')) return;
  try {
    const parsed = normalizeImport(JSON.parse(await file.text()));
    await flushSave();
    await api.saveConfig(parsed);
    ++saveRevision;
    cfg = parsed;
    undoHistory = [];
    pending.clear();
    imgCache.clear();
    const rotation = $('rotation');
    if (rotation) rotation.value = String(cfg.rotation);
    const brightness = $('brightness');
    if (brightness) brightness.value = String(cfg.brightness);
    const briVal = $('briVal');
    if (briVal) briVal.textContent = `${cfg.brightness}%`;
    buildGrid();
    updateStatus();
    saveLabel('✓ Imported and saved locally');
    if (connected) api.brightness(cfg.brightness).catch(() => {});
    notify('Layout imported.');
  } catch (error) {
    notify(`Could not import layout: ${error.message}`, true);
  }
}

function handleDeviceStatus(data) {
  connected = !!data.connected;
  const chip = $('deviceChip');
  if (chip) {
    chip.classList.toggle('connected', connected);
    chip.classList.toggle('offline', !connected);
  }

  const deviceText = $('deviceText');
  if (deviceText) deviceText.textContent = connected ? (data.mock ? 'Demo dock connected' : 'Dock connected') : 'Dock disconnected';
  if (chip) chip.title = data.message || '';

  updateActions();
  if (connected) api.brightness(cfg.brightness).catch(() => {});
}

function subscribe() {
  const events = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  events.addEventListener('status', (event) => handleDeviceStatus(JSON.parse(event.data)));
  events.addEventListener('key', (event) => {
    const { key, state } = JSON.parse(event.data);
    if (!state || !tiles.has(key)) return;
    select(key);
    const tile = tiles.get(key).el;
    tile.classList.add('pressed');
    setTimeout(() => tile.classList.remove('pressed'), 260);
  });

  events.onerror = () => {
    connected = false;
    const chip = $('deviceChip');
    if (chip) {
      chip.classList.remove('connected');
      chip.classList.add('offline');
    }
    const deviceText = $('deviceText');
    if (deviceText) deviceText.textContent = 'Server disconnected';
    updateActions();
  };
}

function wire() {
  const choose = $('choose');
  if (choose) choose.addEventListener('click', () => $('file')?.click());

  const fileInput = $('file');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) await uploadImage(file);
    });
  }

  const clearKey = $('clearKey');
  if (clearKey) clearKey.addEventListener('click', () => { changeKey(selected, {}); select(selected); notify(`Key ${selected} cleared in preview. Use Undo to restore it.`); });

  const flipH = $('flipH');
  if (flipH) flipH.addEventListener('change', currentEdited);

  const flipV = $('flipV');
  if (flipV) flipV.addEventListener('change', currentEdited);

  const fit = $('fit');
  if (fit) fit.addEventListener('change', currentEdited);

  const background = $('background');
  if (background) background.addEventListener('change', currentEdited);

  const caption = $('caption');
  if (caption) caption.addEventListener('input', () => currentEdited('caption'));

  const copyKey = $('copyKey');
  if (copyKey) copyKey.addEventListener('click', () => { clipboard = asClone(keyCfg(selected)); updateActions(); notify(`Key ${selected} copied. Select another key and choose Paste.`); });

  const pasteKey = $('pasteKey');
  if (pasteKey) pasteKey.addEventListener('click', () => { if (!clipboard) return; changeKey(selected, asClone(clipboard)); select(selected); notify(`Pasted settings onto key ${selected}.`); });

  const undo = $('undo');
  if (undo) undo.addEventListener('click', () => {
    const last = undoHistory.pop();
    if (!last) return;
    cfg.keys[last.key] = last.previous;
    markEdited(last.key);
    refreshTile(last.key);
    if (selected === last.key) select(selected);
    notify(`Last edit to key ${last.key} undone.`);
  });

  const applyKey = $('applyKey');
  if (applyKey) applyKey.addEventListener('click', () => sync([selected], `Updating key ${selected}…`));

  const rotation = $('rotation');
  if (rotation) rotation.addEventListener('change', () => { cfg.rotation = Number(rotation.value); ALL_KEYS.forEach((key) => pending.add(key)); updateStatus(); scheduleSave(); notify('Rotation update saved locally.'); });

  const brightness = $('brightness');
  if (brightness) {
    brightness.addEventListener('input', () => { const briVal = $('briVal'); if (briVal) briVal.textContent = `${brightness.value}%`; });
    brightness.addEventListener('change', async () => {
      cfg.brightness = Number(brightness.value);
      scheduleSave();
      if (connected) {
        try { await api.brightness(cfg.brightness); }
        catch (error) { notify(error.message, true); }
      }
    });
  }

  const reconnect = $('reconnect');
  if (reconnect) reconnect.addEventListener('click', async () => {
    reconnect.disabled = true;
    try { await api.connect(); notify('Dock connected.'); }
    catch (error) { notify(`Could not connect: ${error.message}`, true); }
    finally { updateActions(); }
  });

  const exportLayoutBtn = $('exportLayout');
  if (exportLayoutBtn) exportLayoutBtn.addEventListener('click', exportLayout);

  const importLayoutBtn = $('importLayout');
  if (importLayoutBtn) importLayoutBtn.addEventListener('click', () => $('importFile')?.click());

  const importFile = $('importFile');
  if (importFile) importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (file) await importLayout(file);
  });

  const largePreview = $('largePreview');
  if (largePreview) {
    largePreview.addEventListener('dragover', (event) => { if (!busy) event.preventDefault(); });
    largePreview.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!busy && event.dataTransfer.files[0]) uploadImage(event.dataTransfer.files[0]);
    });
  }

  const showNumbers = $('showNumbers');
  if (showNumbers) showNumbers.addEventListener('change', (event) => toggleIdentify(event.target.checked));
}

async function init() {
  try { cfg = normalizeImport(await api.getConfig()); }
  catch (error) {
    notify(`Layout could not be loaded: ${error.message}. Check the saved file before editing.`, true);
    saveLabel('⚠ Layout not loaded');
    return;
  }

  const rotation = $('rotation');
  if (rotation) rotation.value = String(cfg.rotation);

  const brightness = $('brightness');
  if (brightness) brightness.value = String(cfg.brightness);

  const briVal = $('briVal');
  if (briVal) briVal.textContent = `${cfg.brightness}%`;

  wire();
  buildGrid();
  updateStatus();
  saveLabel('✓ Saved on this computer');
  subscribe();
}

init();
