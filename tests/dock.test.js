'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Dock, MockDock, KEY_MAP, PKT, PREFIX } = require('../dock');
class FakeDevice extends EventEmitter {
  constructor() { super(); this.writes = []; }
  write(data) { this.writes.push(Buffer.from(data)); }
  close() {}
}
test('hardware key mapping spans 15 unique positions', () => {
  assert.deepEqual(Object.values(KEY_MAP).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
});
test('HID reports have the correct fixed size and command prefix', () => {
  const fake = new FakeDevice();
  const dock = new Dock({ devices: () => [{ usagePage: 0xff00, path: 'fake' }], HID: function HID() { return fake; } });
  dock.brightness(75);
  const image = Buffer.alloc(2100, 0xfa); image[0] = 0xff; image[1] = 0xd8;
  dock.setKey(3, image);
  assert.ok(fake.writes.length >= 5);
  assert.ok(fake.writes.every((r) => r.length === PKT + 1));
  assert.equal(fake.writes[0][0], 0);
  assert.deepEqual(fake.writes[0].subarray(1, 6), PREFIX);
  assert.equal(fake.writes.at(-1).subarray(1, 6).toString('ascii'), 'CRT\u0000\u0000');
  dock.close();
});
test('hardware events map codes into visual key IDs', () => {
  const fake = new FakeDevice();
  const dock = new Dock({ devices: () => [{ usagePage: 0xff00, path: 'fake' }], HID: function HID() { return fake; } });
  let event;
  dock.onKey((key, state) => { event = { key, state }; });
  const packet = Buffer.alloc(15); packet[9] = 1; packet[10] = 1;
  fake.emit('data', packet);
  assert.deepEqual(event, { key: 11, state: 1 });
});
test('mock dock does not require real USB hardware', () => {
  const dock = new MockDock();
  assert.doesNotThrow(() => dock.setKey(2, Buffer.from([0xff, 0xd8])));
});
