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

test('row-major hardware reports map to the dock printed key numbers', () => {
  const physicalLayout = [3, 6, 9, 12, 15, 2, 5, 8, 11, 14, 1, 4, 7, 10, 13];
  assert.deepEqual(Object.values(KEY_MAP), physicalLayout);
  const fake = new FakeDevice();
  const dock = new Dock({ devices: () => [{ usagePage: 0xff00, path: 'fake' }], HID: function HID() { return fake; } });
  const events = [];
  dock.onKey((key, state) => events.push({ key, state }));
  for (let key = 1; key <= 15; key++) {
    const packet = Buffer.alloc(15);
    packet[9] = key;
    packet[10] = 1;
    fake.emit('data', packet);
  }
  assert.deepEqual(events, physicalLayout.map((key) => ({ key, state: 1 }))); 
  dock.close();
});

test('HID reports have the correct fixed size and command prefix', () => {
  const fake = new FakeDevice();
  const dock = new Dock({ devices: () => [{ usagePage: 0xff00, path: 'fake' }], HID: function HID() { return fake; } });
  dock.brightness(75);
  const image = Buffer.alloc(2100, 0xfa);
  image[0] = 0xff;
  image[1] = 0xd8;
  dock.setKey(3, image);
  assert.ok(fake.writes.length >= 5);
  assert.ok(fake.writes.every((report) => report.length === PKT + 1));
  assert.equal(fake.writes[0][0], 0);
  assert.deepEqual(fake.writes[0].subarray(1, 6), PREFIX);
  dock.close();
});

test('mock dock accepts updates without USB hardware', () => {
  const dock = new MockDock();
  assert.doesNotThrow(() => dock.setKey(2, Buffer.from([0xff, 0xd8])));
});
