// Anko Shortcut Dock hardware protocol (USB 0100:1008).
const VID = 0x0100;
const PID = 0x1008;
const PKT = 1024;
const PREFIX = Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00]);

// Hardware reports use 0x01..0x0f in row-major visual order. App key IDs
// use the physical labels 1..15; the preview handles their physical layout.
const KEY_MAP = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + 1, i + 1]));

function loadHID() { return require('node-hid'); }

class Dock {
  constructor(HID = loadHID()) {
    const infos = HID.devices(VID, PID).filter((device) => device.usagePage >= 0xff00);
    if (!infos.length) throw new Error('Dock not found (0100:1008). Is it plugged in, and is the official app closed?');
    this.dev = new HID.HID(infos[0].path);
    this.keyHandlers = [];
    this.errorHandlers = [];
    this.dev.on('data', (buf) => {
      if (buf.length > 10) {
        const key = KEY_MAP[buf[9]];
        if (key) this.keyHandlers.forEach((handler) => handler(key, buf[10]));
      }
    });
    this.dev.on('error', (error) => this.errorHandlers.forEach((handler) => handler(error)));
    this.wake();
  }
  onKey(handler) { this.keyHandlers.push(handler); }
  onError(handler) { this.errorHandlers.push(handler); }
  _write(payload) {
    const report = Buffer.alloc(PKT + 1);
    payload.copy(report, 1, 0, Math.min(payload.length, PKT));
    this.dev.write(report);
  }
  _cmd(body) { this._write(Buffer.concat([PREFIX, Buffer.from(body)])); }
  wake() { this._cmd('DIS\0\0'); }
  refresh() { this._cmd('STP\0\0'); }
  brightness(value) {
    this._cmd(Buffer.concat([Buffer.from('LIG\0\0'), Buffer.from([Math.max(0, Math.min(100, value | 0))])]));
  }
  clear(key = 0xff) { this._cmd(Buffer.concat([Buffer.from('CLE\0\0\0'), Buffer.from([key])])); }
  setKey(key, jpeg) {
    if (!Number.isInteger(key) || key < 1 || key > 15) throw new RangeError('Key must be between 1 and 15');
    jpeg = Buffer.from(jpeg);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(jpeg.length);
    this._cmd(Buffer.concat([Buffer.from('BAT'), length, Buffer.from([key])]));
    for (let i = 0; i < jpeg.length; i += PKT) this._write(jpeg.subarray(i, i + PKT));
    this.refresh();
  }
  close() {
    try { this.dev.close(); } catch { /* already closed */ }
  }
}

class MockDock {
  constructor() { this.keyHandlers = []; console.log('[mock] dock connected'); }
  onKey(handler) { this.keyHandlers.push(handler); }
  onError() {}
  wake() {}
  brightness(value) { console.log('[mock] brightness', value); }
  setKey(key, jpeg) { console.log(`[mock] setKey ${key}: ${jpeg.length} bytes`); }
  close() {}
}

module.exports = { Dock, MockDock, KEY_MAP, PKT, PREFIX };
