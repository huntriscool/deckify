'use strict';

const TOKEN = document.querySelector('meta[name="token"]').content;
const api = {
  post: async (url, body, raw) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-token': TOKEN, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });
    return r.json();
  },
  connect: () => api.post('/api/connect', {}),
  setKey: (key, jpeg) => api.post(`/api/key/${key}`, jpeg, true),
  setBrightness: (value) => api.post('/api/brightness', { value }),
  saveConfig: (cfg) => api.post('/api/config', cfg),
  loadConfig: () => fetch('/api/config', { headers: { 'x-token': TOKEN } }).then((r) => r.json()),
};

const COLS = 5;
const ROWS = 3;
const SIZE = 100; // icon size sent to the dock
const NUMBERINGS = {
  rows_bl: 'Rows, starting bottom-left',
  rows_tl: 'Rows, starting top-left',
  cols_bl: 'Columns, starting bottom-left',
  cols_tl: 'Columns, starting top-left',
};

const $ = (id) => document.getElementById(id);
let cfg = { rotation: 90, brightness: 60, numbering: 'rows_bl', keys: {} };
let sel = 1;
let loading = false;
const imgCache = new Map();
const tiles = {}; // key -> { el, canvas }

// ---------- layout
function gridPos(key, mode) {
  const i = key - 1;
  let r, c;
  if (mode.startsWith('rows')) { r = Math.floor(i / COLS); c = i % COLS; }
  else { c = Math.floor(i / ROWS); r = i % ROWS; }
  if (mode.endsWith('bl')) r = ROWS - 1 - r;
  return [r, c];
}

const keyCfg = (key) => (cfg.keys[key] ??= {});
let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveConfig(cfg), 200);
};
const say = (msg) => { $('status').textContent = msg; };

// ---------- rendering (canvas -> JPEG)
async function loadImg(src) {
  if (!src) return null;
  if (imgCache.has(src)) return imgCache.get(src);
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return null; }
  imgCache.set(src, img);
  return img;
}

// Shrink a chosen file to a 200x200 square data URL so the saved layout stays small.
async function fileToIcon(file) {
  const bmp = await createImageBitmap(file);
  const S = 200;
  const c = newCanvas(S);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const s = Math.max(S / bmp.width, S / bmp.height);
  g.drawImage(bmp, (S - bmp.width * s) / 2, (S - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  return c.toDataURL('image/png');
}

function newCanvas(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// The icon exactly as you want to SEE it on the dock.
async function renderUpright(k) {
  const c = newCanvas();
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  const img = await loadImg(k.image);
  if (img) {
    const s = Math.max(SIZE / img.width, SIZE / img.height); // fill the square, crop the rest
    const w = img.width * s;
    const h = img.height * s;
    g.save();
    g.translate(SIZE / 2, SIZE / 2);
    g.scale(k.flipH ? -1 : 1, k.flipV ? -1 : 1);
    g.drawImage(img, -w / 2, -h / 2, w, h);
    g.restore();
  }
  const cap = (k.caption || '').trim();
  if (cap) {
    g.fillStyle = 'rgba(0,0,0,0.67)';
    g.fillRect(0, SIZE - 24, SIZE, 24);
    g.fillStyle = '#fff';
    g.font = '16px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(cap.slice(0, 12), SIZE / 2, SIZE - 12);
  }
  return c;
}

// Pre-rotate clockwise so the panel's own rotation cancels out, then JPEG-encode.
async function toDockJpeg(upright, rotation) {
  const c = newCanvas();
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  g.translate(SIZE / 2, SIZE / 2);
  g.rotate((rotation * Math.PI) / 180); // canvas rotate() is clockwise
  g.drawImage(upright, -SIZE / 2, -SIZE / 2);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 1));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- grid
function buildGrid() {
  const grid = $('grid');
  grid.textContent = '';
  for (let key = 1; key <= 15; key++) {
    const [r, c] = gridPos(key, cfg.numbering);
    const el = document.createElement('button');
    el.className = 'key';
    el.style.gridRow = r + 1;
    el.style.gridColumn = c + 1;
    const canvas = newCanvas();
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = key;
    el.append(canvas, num);
    el.addEventListener('click', () => select(key));
    grid.append(el);
    tiles[key] = { el, canvas };
    refreshTile(key);
  }
  select(sel);
}

async function refreshTile(key) {
  const up = await renderUpright(keyCfg(key));
  const g = tiles[key].canvas.getContext('2d');
  g.clearRect(0, 0, SIZE, SIZE);
  g.drawImage(up, 0, 0);
}

function select(key) {
  sel = key;
  for (const [k, t] of Object.entries(tiles)) t.el.classList.toggle('selected', Number(k) === key);
  const k = keyCfg(key);
  loading = true;
  $('selTitle').textContent = `Key ${key}`;
  $('flipH').checked = !!k.flipH;
  $('flipV').checked = !!k.flipV;
  $('caption').value = k.caption || '';
  loading = false;
}

// ---------- editing
function edited() {
  if (loading) return;
  const k = keyCfg(sel);
  k.flipH = $('flipH').checked;
  k.flipV = $('flipV').checked;
  k.caption = $('caption').value;
  refreshTile(sel);
  save();
}

async function apply(keys) {
  try {
    for (const key of keys) {
      const jpeg = await toDockJpeg(await renderUpright(keyCfg(key)), cfg.rotation);
      const r = await api.setKey(key, jpeg);
      if (!r.ok) return say(`Could not send: ${r.error}`);
    }
    say('Sent to dock.');
  } catch (e) { say(`Error: ${e.message}`); }
}

async function showNumbers() {
  for (let key = 1; key <= 15; key++) {
    const c = newCanvas();
    const g = c.getContext('2d');
    g.fillStyle = '#000050';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#fff';
    g.font = 'bold 60px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(key), SIZE / 2, SIZE / 2 + 4);
    const r = await api.setKey(key, await toDockJpeg(c, cfg.rotation));
    if (!r.ok) return say(`Could not send: ${r.error}`);
  }
  say('Numbers shown on dock. Pick the numbering option that matches, then Apply ALL.');
}

// ---------- wiring
function init() {
  for (const [v, label] of Object.entries(NUMBERINGS)) {
    $('numbering').add(new Option(label, v));
  }
  $('rotation').value = String(cfg.rotation);
  $('numbering').value = cfg.numbering;
  $('brightness').value = cfg.brightness;
  $('briVal').textContent = cfg.brightness;

  $('choose').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const f = $('file').files[0];
    $('file').value = '';
    if (!f) return;
    try { keyCfg(sel).image = await fileToIcon(f); refreshTile(sel); save(); }
    catch { say('Could not read that image.'); }
  };
  $('clearKey').onclick = () => { cfg.keys[sel] = {}; select(sel); refreshTile(sel); save(); };
  for (const id of ['flipH', 'flipV']) $(id).onchange = edited;
  $('caption').oninput = edited;
  $('applyKey').onclick = () => apply([sel]);
  $('applyAll').onclick = () => apply(Array.from({ length: 15 }, (_, i) => i + 1));
  $('showNumbers').onclick = showNumbers;
  $('reconnect').onclick = () => api.connect();
  $('rotation').onchange = () => { cfg.rotation = Number($('rotation').value); save(); };
  $('numbering').onchange = () => { cfg.numbering = $('numbering').value; save(); buildGrid(); };
  $('brightness').oninput = () => { $('briVal').textContent = $('brightness').value; };
  $('brightness').onchange = () => {
    cfg.brightness = Number($('brightness').value);
    save();
    api.setBrightness(cfg.brightness);
  };

  const onStatus = ({ connected, message }) => {
    if (connected) {
      say('Connected to dock. Press a dock key to select it here.');
      api.setBrightness(cfg.brightness);
    } else {
      say(`Not connected: ${message} Close the official app, then press Reconnect.`);
    }
  };
  const events = new EventSource(`/api/events?t=${TOKEN}`);
  events.addEventListener('status', (e) => onStatus(JSON.parse(e.data)));
  events.addEventListener('key', (e) => {
    const { key, state } = JSON.parse(e.data);
    if (!state) return;
    select(key);
    tiles[key].el.classList.add('pressed');
    setTimeout(() => tiles[key].el.classList.remove('pressed'), 250);
  });
  events.onerror = () => say('Lost contact with the local server. Is the black window still running?');

  buildGrid();
}

(async () => {
  const saved = await api.loadConfig();
  if (saved) cfg = { ...cfg, ...saved };
  init();
})();
