'use strict';

const fs = require('node:fs');
const path = require('node:path');
const DEFAULTS = Object.freeze({ rotation: 90, brightness: 60, keys: {} });
const MAX_ICON_CHARS = 1_500_000;
const IMAGE_PREFIX = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;

function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Layout must be a JSON object');
  const rotation = input.rotation === undefined ? DEFAULTS.rotation : Number(input.rotation);
  const brightness = input.brightness === undefined ? DEFAULTS.brightness : Number(input.brightness);
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('Rotation must be 0, 90, 180 or 270 degrees');
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) throw new Error('Brightness must be from 0 to 100');
  const keys = {};
  const incoming = input.keys === undefined ? {} : input.keys;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Invalid keys');
  if (Object.keys(incoming).length > 15) throw new Error('Layout has too many keys');
  for (const [id, value] of Object.entries(incoming)) {
    if (!/^(?:[1-9]|1[0-5])$/.test(id)) throw new Error(`Invalid key number: ${id}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid data for key ${id}`);
    const image = value.image || '';
    if (typeof image !== 'string' || image.length > MAX_ICON_CHARS || (image && !IMAGE_PREFIX.test(image))) {
      throw new Error(`Invalid image for key ${id}`);
    }
    const caption = value.caption ?? '';
    const background = value.background ?? '#0d111b';
    const fit = value.fit ?? 'cover';
    if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)) throw new Error(`Invalid background on key ${id}`);
    if (!['cover', 'contain'].includes(fit)) throw new Error(`Invalid image fit on key ${id}`);
    if (typeof caption !== 'string' || caption.length > 12) throw new Error(`Caption on key ${id} must be 12 characters or fewer`);
    if (typeof value.flipH !== 'undefined' && typeof value.flipH !== 'boolean') throw new Error(`Invalid horizontal flip for key ${id}`);
    if (typeof value.flipV !== 'undefined' && typeof value.flipV !== 'boolean') throw new Error(`Invalid vertical flip for key ${id}`);
    keys[id] = { ...(image ? { image } : {}), ...(caption ? { caption } : {}), ...(value.flipH ? { flipH: true } : {}), ...(value.flipV ? { flipV: true } : {}), ...(background !== '#0d111b' ? { background } : {}), ...(fit !== 'cover' ? { fit } : {}) };
  }
  // Old layout's numbering value intentionally disappears. Hardware mapping is fixed.
  return { rotation, brightness, keys };
}

function readConfig(filename) {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(filename, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS, keys: {} };
    throw error;
  }
}

function writeConfig(filename, config) {
  const clean = normalizeConfig(config);
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
  return clean;
}
module.exports = { normalizeConfig, readConfig, writeConfig, DEFAULTS };
