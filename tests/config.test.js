'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig, readConfig, writeConfig } = require('../config');

test('a missing layout uses safe defaults', () => {
  const result = readConfig(path.join(os.tmpdir(), `missing-deckify-${process.pid}.json`));
  assert.deepEqual(result, { rotation: 90, brightness: 60, keys: {} });
});
test('old numbering layouts migrate without discarding user icons', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const result = normalizeConfig({ rotation: 180, brightness: 100, numbering: 'rows_bl', keys: { '1': { image, caption: 'Mail', flipH: true } } });
  assert.equal(result.keys[1].image, image);
  assert.equal(result.keys[1].caption, 'Mail');
  assert.equal(result.rotation, 180);
  assert.equal(result.brightness, 100);
  assert.ok(!('numbering' in result));
});
test('config validates keys, captions, rotation, brightness and image data', () => {
  const invalid = [
    { keys: { 16: {} } },
    { keys: { 1: { caption: 'thirteen chars' } } },
    { rotation: 33 },
    { brightness: -1 },
    { keys: { 1: { image: 'https://evil.example/icon.png' } } },
    { keys: { 1: { fit: 'stretch' } } },
    { keys: { 1: { background: 'red' } } },
    { keys: { 1: { flipH: 'false' } } },
  ];
  for (const data of invalid) assert.throws(() => normalizeConfig(data));
});
test('new key styles are preserved', () => {
  const clean = normalizeConfig({ keys: { 15: { background: '#123abc', fit: 'contain', flipV: true } } });
  assert.equal(clean.keys[15].fit, 'contain');
  assert.equal(clean.keys[15].background, '#123abc');
  assert.equal(clean.keys[15].flipV, true);
});
test('writeConfig replaces files atomically and can be read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckify-test-'));
  const target = path.join(dir, 'dock_layout.json');
  try {
    writeConfig(target, { rotation: 270, brightness: 25, keys: { 3: { caption: 'Hi' } } });
    assert.equal(readConfig(target).keys[3].caption, 'Hi');
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
