'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN = document.querySelector('meta[name="token"]').content;
const ICON_SIZE = 100;
const ALL_KEYS = Array.from({ length: 15 }, (_, i) => i + 1);
const PHYSICAL_LAYOUT = [3, 6, 9, 12, 15, 2, 5, 8, 11, 14, 1, 4, 7, 10, 13];
const DEFAULT_BG = '#0d111b';
const DEFAULT = () => ({ rotation: 90, brightness: 60, keys: {} });

const api = {
  async request(url, options = {}) {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { 'x-token': TOKEN, ...(options.headers || {}) } });
    } catch {
      throw new Error('Cannot reach the local Deckify server. Is it still open?');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The server returned an invalid response.'); }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Server error (${response.status})`);
    return data;
  },
  post(url, body, binary = false) {
    return api.request(url, {
      method: 'POST',
      headers: { 'Content-Type': binary ? 'image/jpeg' : 'application/json' },
      body: binary ? body : JSON.stringify(body),
    });
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
let lastCaptionEdit = { key: null, time: 0 };
const pending = new Set();
const tiles = new Map();
const images = new Map();
const renderRevision = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
const keyConfig = (key) => cfg.keys[key] || {};

function gridPosition(key) {
  const index = PHYSICAL_LAYOUT.indexOf(key);
  return [Math.floor(index / 5), index % 5];
}
function positionName(key) {
  const [row, col] = gridPosition(key);
  return `${['Top', 'Middle', 'Bottom'][row]} ${['left', 'second', 'centre', 'fourth', 'right'][col]}`;
}
function notify(message, error = false) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, error ? 6800 : 3700);
}
function saveLabel(message) {
  const status = $('saveStatus');
  if (status) status.textContent = message;
}
function updateStatus() {
  const pendingLabel = $('pendingLabel');
  if (pendingLabel) {
    pendingLabel.classList.toggle('needs-sync', pending.size > 0);
    pendingLabel.lastChild.textContent = pending.size
      ? ` ${pending.size} key${pending.size === 1 ? '' : 's'} changed since last sync`
      : ' Changes are saved on this computer';
  }
  const state = $('keyState');
  if (state) {
    state.textContent = pending.has(selected) ? 'Not on dock yet' : 'Ready to edit';
    state.classList.toggle('changed', pending.has(selected));
  }
  updateActions();
}
function updateActions() {
  const apply = $('applyKey');
  if (apply) apply.disabled = !connected || busy || identifyMode;
  const numbers = $('showNumbers');
  if (numbers) numbers.disabled = !connected || busy;
  const reconnect = $('reconnect');
  if (reconnect) reconnect.disabled = busy;
  for (const id of ['choose', 'clearKey', 'copyKey', 'caption', 'fit', 'background', 'flipH', 'flipV', 'rotation', 'brightness', 'exportLayout', 'importLayout']) {
    const control = $(id);
    if (control) control.disabled = busy;
  }
  const paste = $('pasteKey');
  if (paste) paste.disabled = busy || !clipboard;
  const undo = $('undo');
  if (undo) undo.disabled = busy || undoHistory.length === 0;
}
function scheduleSave() {
  const revision = ++saveRevision;
  clearTimeout(saveTimeout);
  saveLabel('Saving locally…');
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    persist(revision).catch(() => {});
  }, 330);
}
function persist(revision) {
  const snapshot = clone(cfg);
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
    await persist(++saveRevision);
  } else {
    await saveChain;
  }
}
function editKey(key, value, reason = 'edit') {
  if (JSON.stringify(keyConfig(key)) === JSON.stringify(value)) return;
  const now = Date.now();
  if (!(reason === 'caption' && lastCaptionEdit.key === key && now - lastCaptionEdit.time < 1200)) {
    undoHistory.push({ key, previous: clone(keyConfig(key)) });
    if (undoHistory.length > 40) undoHistory.shift();
  }
  if (reason === 'caption') lastCaptionEdit = { key, time: now };
  cfg.keys[key] = value;
  pending.add(key);
  updateStatus();
  scheduleSave();
  renderTile(key);
  if (key === selected) drawSelected();
}
function makeCanvas(size = ICON_SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}
async function imageFor(src) {
  if (!src) return null;
  if (!images.has(src)) {
    const image = new Image();
    image.src = src;
    images.set(src, image.decode().then(() => image).catch(() => null));
  }
  return images.get(src);
}
async function renderKey(data, size = ICON_SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = data.background || DEFAULT_BG;
  ctx.fillRect(0, 0, size, size);
  const image = await imageFor(data.image);
  if (image) {
    const scale = (data.fit === 'contain' ? Math.min : Math.max)(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(data.flipH ? -1 : 1, data.flipV ? -1 : 1);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.restore();
  }
  const caption = (data.caption || '').trim();
  if (caption) {
    const height = Math.round(size * 0.27);
    ctx.fillStyle = '#000b';
    ctx.fillRect(0, size - height, size, height);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(size * 0.15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, size / 2, size - height / 2, size - 10);
  }
  return canvas;
}
function buildGrid() {
  const grid = $('grid');
  if (!grid) return;
  grid.replaceChildren();
  tiles.clear();
  for (const key of ALL_KEYS) {
    const [row, col] = gridPosition(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key';
    button.style.gridRow = String(row + 1);
    button.style.gridColumn = String(col + 1);
    button.title = `Key ${key} · ${positionName(key)}`;
    button.setAttribute('aria-label', `Edit key ${key}, ${positionName(key)}`);
    const canvas = makeCanvas();
    canvas.setAttribute('aria-hidden', 'true');
    const number = document.createElement('span');
    number.className = 'num';
    number.textContent = String(key);
    button.append(canvas, number);
    button.addEventListener('click', () => selectKey(key));
    button.addEventListener('dragover', (event) => { if (!busy) event.preventDefault(); });
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      if (busy) return;
      selectKey(key);
      const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
      if (file) uploadImage(file, key);
    });
    tiles.set(key, { el: button, canvas });
    grid.append(button);
    renderTile(key);
  }
  selectKey(selected);
}
async function renderTile(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  const revision = (renderRevision.get(key) || 0) + 1;
  renderRevision.set(key, revision);
  const data = keyConfig(key);
  const canvas = await renderKey(data);
  if (renderRevision.get(key) !== revision) return;
  const context = tile.canvas.getContext('2d');
  context.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  context.drawImage(canvas, 0, 0);
}
let previewRevision = 0;
async function drawSelected() {
  const preview = $('largePreview');
  if (!preview) return;
  const revision = ++previewRevision;
  const canvas = await renderKey(keyConfig(selected), 160);
  if (revision !== previewRevision) return;
  const context = preview.getContext('2d');
  context.clearRect(0, 0, 160, 160);
  context.drawImage(canvas, 0, 0);
}
function selectKey(key) {
  selected = key;
  for (const [id, tile] of tiles) {
    tile.el.classList.toggle('selected', id === key);
    tile.el.setAttribute('aria-pressed', String(id === key));
  }
  const title = $('selTitle');
  if (title) title.textContent = `Key ${key}`;
  const position = $('keyPosition');
  if (position) position.textContent = `${positionName(key)} · physical dock`;
  const data = keyConfig(key);
  if ($('caption')) $('caption').value = data.caption || '';
  if ($('captionCount')) $('captionCount').textContent = `${(data.caption || '').length}/12`;
  if ($('flipH')) $('flipH').checked = !!data.flipH;
  if ($('flipV')) $('flipV').checked = !!data.flipV;
  if ($('fit')) $('fit').value = data.fit || 'cover';
  if ($('background')) $('background').value = data.background || DEFAULT_BG;
  if ($('backgroundValue')) $('backgroundValue').textContent = (data.background || DEFAULT_BG).toUpperCase();
  drawSelected();
  updateStatus();
}
function readEditor(reason = 'edit') {
  const data = {
    ...keyConfig(selected),
    caption: $('caption').value,
    flipH: $('flipH').checked,
    flipV: $('flipV').checked,
    fit: $('fit').value,
    background: $('background').value,
  };
  $('captionCount').textContent = `${data.caption.length}/12`;
  $('backgroundValue').textContent = data.background.toUpperCase();
  editKey(selected, data, reason);
}
async function uploadImage(file, key = selected) {
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
    if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image under 12 MB.');
    const bitmap = await createImageBitmap(file);
    let image;
    try {
      const scale = Math.min(1, 420 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      image = canvas.toDataURL('image/webp', 0.85);
      if (!image.startsWith('data:image/webp')) image = canvas.toDataURL('image/png');
      if (image.length > 1_500_000) throw new Error('Compressed image is too large for a key.');
    } finally { bitmap.close?.(); }
    editKey(key, { ...keyConfig(key), image });
    if (key === selected) selectKey(key);
    notify(`Image added to key ${key}. Send it to the dock when ready.`);
  } catch (error) { notify(error.message, true); }
}
function validateLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a valid Deckify layout.');
  const rotation = Number(raw.rotation ?? 90);
  const brightness = Number(raw.brightness ?? 60);
  if (![0, 90, 180, 270].includes(rotation) || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) throw new Error('Invalid brightness or rotation settings.');
  const keys = {};
  for (const [key, value] of Object.entries(raw.keys || {})) {
    if (!/^(?:[1-9]|1[0-5])$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid key: ${key}`);
    if (value.image && (typeof value.image !== 'string' || value.image.length > 1_500_000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.image))) throw new Error(`Unsupported image on key ${key}`);
    if (value.caption != null && (typeof value.caption !== 'string' || value.caption.length > 12)) throw new Error(`Key ${key} label is too long.`);
    if (value.fit && !['cover', 'contain'].includes(value.fit)) throw new Error(`Invalid fit on key ${key}`);
    if (value.background && !/^#[a-f\d]{6}$/i.test(value.background)) throw new Error(`Invalid background on key ${key}`);
    keys[key] = { ...value };
  }
  return { rotation, brightness, keys };
}
function numberArt(key) {
  const canvas = makeCanvas();
  const context = canvas.getContext('2d');
  context.fillStyle = '#173e39';
  context.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  context.strokeStyle = '#6de3c0';
  context.lineWidth = 3;
  context.strokeRect(4, 4, ICON_SIZE - 8, ICON_SIZE - 8);
  context.fillStyle = '#fff';
  context.font = 'bold 60px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(key), ICON_SIZE / 2, ICON_SIZE / 2 + 4);
  return canvas;
}
async function toJpeg(source) {
  const canvas = makeCanvas();
  const context = canvas.getContext('2d');
  context.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  context.rotate(cfg.rotation * Math.PI / 180);
  context.drawImage(source, -ICON_SIZE / 2, -ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob) throw new Error('Could not encode the icon.');
  return new Uint8Array(await blob.arrayBuffer());
}
function setBusy(active, title = '', detail = '') {
  busy = active;
  const overlay = $('busyOverlay');
  if (overlay) overlay.hidden = !active;
  if ($('busyTitle')) $('busyTitle').textContent = title;
  if ($('busyDetail')) $('busyDetail').textContent = detail;
  if ($('busyBar')) $('busyBar').style.width = '0%';
  updateActions();
}
async function sendKeys(keys, numbered = false) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if ($('busyDetail')) $('busyDetail').textContent = `${numbered ? 'Showing number on' : 'Updating'} key ${key} · ${i + 1} of ${keys.length}`;
    const art = numbered ? numberArt(key) : await renderKey(keyConfig(key));
    await api.setKey(key, await toJpeg(art));
    if (!numbered) pending.delete(key);
    if ($('busyBar')) $('busyBar').style.width = `${Math.round(((i + 1) / keys.length) * 100)}%`;
  }
}
async function applySelectedKey() {
  if (!connected || busy || identifyMode) return;
  setBusy(true, `Updating key ${selected}…`, 'Saving your layout…');
  try {
    await flushSave();
    await sendKeys([selected]);
    updateStatus();
    notify(`Key ${selected} updated on the dock.`);
  } catch (error) { notify(`Transfer interrupted: ${error.message} — retry the update.`, true); }
  finally { setBusy(false); updateStatus(); }
}
async function toggleNumbers(checked) {
  if (!connected || busy) {
    $('showNumbers').checked = identifyMode;
    return;
  }
  setBusy(true, checked ? 'Showing key numbers…' : 'Restoring your icons…');
  try {
    await flushSave();
    await sendKeys(ALL_KEYS, checked);
    identifyMode = checked;
    $('showNumbers').checked = checked;
    notify(checked ? 'Key numbers are showing. Turn the switch off to restore your icons.' : 'Your saved icons have been restored to the dock.');
  } catch (error) {
    identifyMode = true;
    $('showNumbers').checked = true;
    notify(`Number display partly updated: ${error.message}. Turn the switch off to restore your layout.`, true);
  } finally { setBusy(false); updateStatus(); }
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
  notify('Layout backup exported.');
}
async function importLayout(file) {
  if (file.size > 26_000_000) return notify('That layout file is too large.', true);
  if (!confirm('Replace your current saved layout with this file? Export a backup first if needed.')) return;
  try {
    const imported = validateLayout(JSON.parse(await file.text()));
    await flushSave();
    await api.saveConfig(imported);
    ++saveRevision;
    cfg = imported;
    undoHistory = [];
    pending.clear();
    ALL_KEYS.forEach((key) => pending.add(key));
    images.clear();
    $('rotation').value = String(cfg.rotation);
    $('brightness').value = cfg.brightness;
    $('briVal').textContent = `${cfg.brightness}%`;
    buildGrid();
    updateStatus();
    saveLabel('✓ Imported and saved locally');
    if (connected) api.brightness(cfg.brightness).catch(() => {});
    notify('Layout imported. Use “Update this key on dock” to send keys.');
  } catch (error) { notify(`Could not import layout: ${error.message}`, true); }
}
function setConnectionStatus(data) {
  connected = !!data.connected;
  const chip = $('deviceChip');
  chip.classList.toggle('connected', connected);
  chip.classList.toggle('offline', !connected);
  $('deviceText').textContent = connected ? (data.mock ? 'Demo dock connected' : 'Dock connected') : 'Dock disconnected';
  chip.title = data.message || '';
  updateActions();
  if (connected) api.brightness(cfg.brightness).catch(() => {});
}
function subscribe() {
  const events = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  events.addEventListener('status', (event) => setConnectionStatus(JSON.parse(event.data)));
  events.addEventListener('key', (event) => {
    const { key, state } = JSON.parse(event.data);
    if (!state || !tiles.has(key)) return;
    selectKey(key);
    const tile = tiles.get(key).el;
    tile.classList.add('pressed');
    setTimeout(() => tile.classList.remove('pressed'), 260);
  });
  events.onerror = () => {
    connected = false;
    $('deviceChip').classList.remove('connected');
    $('deviceChip').classList.add('offline');
    $('deviceText').textContent = 'Server disconnected';
    updateActions();
  };
}
function wire() {
  $('choose').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    const file = $('file').files[0];
    $('file').value = '';
    if (file) await uploadImage(file);
  });
  $('clearKey').addEventListener('click', () => {
    editKey(selected, {});
    selectKey(selected);
    notify(`Key ${selected} cleared in preview. Use Undo to restore it.`);
  });
  for (const id of ['flipH', 'flipV', 'fit', 'background']) $(id).addEventListener('change', () => readEditor());
  $('caption').addEventListener('input', () => readEditor('caption'));
  $('copyKey').addEventListener('click', () => {
    clipboard = clone(keyConfig(selected));
    updateActions();
    notify(`Key ${selected} copied. Select another key and choose Paste.`);
  });
  $('pasteKey').addEventListener('click', () => {
    if (!clipboard) return;
    editKey(selected, clone(clipboard));
    selectKey(selected);
    notify(`Pasted settings onto key ${selected}.`);
  });
  $('undo').addEventListener('click', () => {
    const last = undoHistory.pop();
    if (!last) return;
    cfg.keys[last.key] = last.previous;
    pending.add(last.key);
    scheduleSave();
    renderTile(last.key);
    if (selected === last.key) selectKey(last.key);
    updateActions();
    notify(`Last edit to key ${last.key} undone.`);
  });
  $('applyKey').addEventListener('click', applySelectedKey);
  $('showNumbers').addEventListener('change', (event) => toggleNumbers(event.target.checked));
  $('rotation').addEventListener('change', () => {
    cfg.rotation = Number($('rotation').value);
    ALL_KEYS.forEach((key) => pending.add(key));
    updateStatus();
    scheduleSave();
    notify('Rotation setting saved. Update each key to apply it to the dock.');
  });
  $('brightness').addEventListener('input', () => { $('briVal').textContent = `${$('brightness').value}%`; });
  $('brightness').addEventListener('change', async () => {
    cfg.brightness = Number($('brightness').value);
    scheduleSave();
    if (connected) {
      try { await api.brightness(cfg.brightness); }
      catch (error) { notify(error.message, true); }
    }
  });
  $('reconnect').addEventListener('click', async () => {
    $('reconnect').disabled = true;
    try {
      const status = await api.connect();
      setConnectionStatus(status);
      notify('Dock connected.');
    } catch (error) { notify(`Could not connect: ${error.message}`, true); }
    finally { updateActions(); }
  });
  $('exportLayout').addEventListener('click', exportLayout);
  $('importLayout').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (file) await importLayout(file);
  });
  $('largePreview').addEventListener('dragover', (event) => { if (!busy) event.preventDefault(); });
  $('largePreview').addEventListener('drop', (event) => {
    event.preventDefault();
    if (!busy && event.dataTransfer.files[0]) uploadImage(event.dataTransfer.files[0]);
  });
}
async function init() {
  try { cfg = validateLayout(await api.getConfig()); }
  catch (error) {
    notify(`Layout could not be loaded: ${error.message}. Check the saved file before editing.`, true);
    saveLabel('⚠ Layout not loaded');
    return;
  }
  $('rotation').value = String(cfg.rotation);
  $('brightness').value = String(cfg.brightness);
  $('briVal').textContent = `${cfg.brightness}%`;
  wire();
  buildGrid();
  updateStatus();
  saveLabel('✓ Saved on this computer');
  subscribe();
}

init();
