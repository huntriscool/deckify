'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN = document.querySelector('meta[name="token"]').content;
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
    try { data = await response.json(); } catch { throw new Error('The server returned an invalid response.'); }
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

// Physical dock layout matches the device numbering exactly:
//  3  6  9 12 15
//  2  5  8 11 14
//  1  4  7 10 13
const gridPosition = (key) => {
  const row = key === 1 || key === 2 || key === 3 ? 2
    : key >= 4 && key <= 6 ? 1
    : 0;
  const col = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2].indexOf(key);
  const mapped = [3, 6, 9, 12, 15, 2, 5, 8, 11, 14, 1, 4, 7, 10, 13];
  const idx = mapped.indexOf(key);
  return [Math.floor(idx / COLS), idx % COLS];
};

function renderKeyPositions() {
  const mapping = [3, 6, 9, 12, 15, 2, 5, 8, 11, 14, 1, 4, 7, 10, 13];
  return mapping;
}

const positionName = (key) => {
  const mapping = renderKeyPositions();
  const idx = mapping.indexOf(key);
  const row = Math.floor(idx / 5);
  const col = idx % 5;
  const rows = ['Top', 'Middle', 'Bottom'];
  const cols = ['left', 'second', 'third', 'fourth', 'right'];
  return `${rows[2 - row]} ${cols[col]}`;
};

function notify(message, error = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, error ? 6800 : 3700);
}
function saveLabel(text) { $('saveStatus').textContent = text; }
function updateStatus() {
  const pendingLabel = $('pendingLabel');
  const keyState = $('keyState');
  pendingLabel.classList.toggle('needs-sync', pending.size > 0);
  pendingLabel.lastChild.textContent = pending.size ? ` ${pending.size} key${pending.size === 1 ? '' : 's'} changed since last sync` : ' Changes are saved on this computer';
  keyState.textContent = pending.has(selected) ? 'Not on dock yet' : 'Ready to edit';
  keyState.classList.toggle('changed', pending.has(selected));
  updateActions();
}
function updateActions() {
  const canSend = connected && !busy && !identifyMode;
  $('applyKey').disabled = !canSend;
  $('syncAll').disabled = !canSend;
  $('showNumbers').disabled = !connected || busy;
  $('reconnect').disabled = busy;
  $('pasteKey').disabled = busy || !clipboard;
  $('undo').disabled = busy || undoHistory.length === 0;
}

function markEdited(key) { pending.add(key); updateStatus(); scheduleSave(); }
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
    if (undoHistory.length > 30) undoHistory.shift();
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
function buildGrid() {
  const grid = $('grid');
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
    button.append(canvas, number);
    button.addEventListener('click', () => select(key));
    tiles.set(key, { el: button, canvas });
    grid.append(button);
    refreshTile(key);
  }
  select(selected);
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
    ctx.fillStyle = '#000b';
    ctx.fillRect(0, size - 26, size, 26);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(size * .15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, size / 2, size - 13, size - 10);
  }
  return canvas;
}
async function refreshTile(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  const v = (renderRevision.get(key) || 0) + 1;
  renderRevision.set(key, v);
  const data = keyCfg(key);
  const canvas = await renderUpright(data);
  if (renderRevision.get(key) !== v) return;
  const ctx = tile.canvas.getContext('2d');
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.drawImage(canvas, 0, 0);
}
let selectedRevision = 0;
async function drawSelected() {
  const v = ++selectedRevision;
  const canvas = await renderUpright(keyCfg(selected), 160);
  if (v !== selectedRevision) return;
  const ctx = $('largePreview').getContext('2d');
  ctx.clearRect(0, 0, 160, 160);
  ctx.drawImage(canvas, 0, 0);
}
function select(key) {
  selected = key;
  for (const [n, tile] of tiles) {
    tile.el.classList.toggle('selected', n === key);
    tile.el.setAttribute('aria-pressed', String(n === key));
  }
  $('selTitle').textContent = `Key ${key}`;
  $('keyPosition').textContent = positionName(key);
  const data = keyCfg(key);
  $('caption').value = data.caption || '';
  $('captionCount').textContent = `${$('caption').value.length}/12`;
  $('flipH').checked = !!data.flipH;
  $('flipV').checked = !!data.flipV;
  $('fit').value = data.fit || 'cover';
  $('background').value = data.background || DEFAULT_BG;
  $('backgroundValue').textContent = $('background').value.toUpperCase();
  drawSelected();
  updateStatus();
}

function normalizeImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a valid Deckify layout.');
  const rotation = Number(raw.rotation ?? 90);
  const brightness = Number(raw.brightness ?? 60);
  if (![0, 90, 180, 270].includes(rotation) || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) throw new Error('Invalid brightness or rotation settings.');
  const keys = {};
  for (const [key, value] of Object.entries(raw.keys || {})) {
    if (!/^(?:[1-9]|1[0-5])$/.test(key) || !value || typeof value !== 'object') throw new Error(`Invalid key: ${key}`);
    if (value.image && (typeof value.image !== 'string' || value.image.length > 1_500_000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.image))) throw new Error(`Unsupported image on key ${key}`);
    if (value.caption != null && (typeof value.caption !== 'string' || value.caption.length > 12)) throw new Error(`Key ${key} label is too long.`);
    if (value.fit && !['cover', 'contain'].includes(value.fit)) throw new Error(`Invalid fit on key ${key}`);
    if (value.background && !/^#[a-f\d]{6}$/i.test(value.background)) throw new Error(`Invalid background on key ${key}`);
    keys[key] = { ...value };
  }
  return { rotation, brightness, keys };
}

async function init() {
  try { cfg = normalizeImport(await api.getConfig()); }
  catch (error) { notify(`Layout could not be loaded: ${error.message}. Check the saved file before editing.`, true); saveLabel('⚠ Layout not loaded'); return; }
  $('rotation').value = String(cfg.rotation);
  $('brightness').value = String(cfg.brightness);
  $('briVal').textContent = `${cfg.brightness}%`;
  buildGrid();
  updateStatus();
  saveLabel('✓ Saved on this computer');
}

init();
