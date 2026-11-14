// Protocol for the Kmart Anko Shortcut Dock (USB 0100:1008)
// (1 report-ID byte + 1024 data bytes), commands prefixed with "CRT\0\0".
const VID = 0x0100
const PID = 0x1008
const PKT = 1024
const PREFIX = Buffer.from([0x43, 0x52, 0x54, 0x00, 0x00]) // "CRT\0\0"

// hardware key code (input report byte 9) -> key number 1..15
const KEY_MAP = {
  0x01: 0x0b,
  0x02: 0x0c,
  0x03: 0x0d,
  0x04: 0x0e,
  0x05: 0x0f,
  0x06: 0x06,
  0x07: 0x07,
  0x08: 0x08,
  0x09: 0x09,
  0x0a: 0x0a,
  0x0b: 0x01,
  0x0c: 0x02,
  0x0d: 0x03,
  0x0e: 0x04,
  0x0f: 0x05,
}

function loadHID() {
  return require('node-hid')
}

class Dock {
  constructor(HID = loadHID()) {
    // Windows exposes two interfaces: a keyboard (can't be opened) and the
    // vendor one (usage page 0xFF00+) that carries icons and key presses.
    const infos = HID.devices(VID, PID).filter((d) => d.usagePage >= 0xff00)
    if (!infos.length) {
      throw new Error(
        'Dock not found (0100:1008). Is it plugged in, and is the official app closed?'
      )
    }
    this.dev = new HID.HID(infos[0].path)
    this.keyHandlers = []
    this.errorHandlers = []
    this.dev.on('data', (buf) => {
      if (buf.length > 10) {
        const key = KEY_MAP[buf[9]]
        if (key) this.keyHandlers.forEach((h) => h(key, buf[10]))
      }
    })
    this.dev.on('error', (e) => this.errorHandlers.forEach((h) => h(e)))
    this.wake()
  }

  onKey(h) {
    this.keyHandlers.push(h)
  }
  onError(h) {
    this.errorHandlers.push(h)
  }

  _write(payload) {
    const report = Buffer.alloc(PKT + 1) // byte 0 = report ID (0)
    payload.copy(report, 1, 0, Math.min(payload.length, PKT))
    this.dev.write(report)
  }

  _cmd(body) {
    this._write(Buffer.concat([PREFIX, Buffer.from(body)]))
  }

  wake() {
    this._cmd('DIS\0\0')
  }
  refresh() {
    this._cmd('STP\0\0')
  }
  brightness(v) {
    this._cmd(
      Buffer.concat([Buffer.from('LIG\0\0'), Buffer.from([Math.max(0, Math.min(100, v | 0))])])
    )
  }
  clear(key = 0xff) {
    this._cmd(Buffer.concat([Buffer.from('CLE\0\0\0'), Buffer.from([key])]))
  }

  setKey(key, jpeg) {
    jpeg = Buffer.from(jpeg)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(jpeg.length)
    this._cmd(Buffer.concat([Buffer.from('BAT'), len, Buffer.from([key])]))
    for (let i = 0; i < jpeg.length; i += PKT) this._write(jpeg.subarray(i, i + PKT))
    this.refresh()
  }

  close() {
    try {
      this.dev.close()
    } catch (_) {
      /* already closed */
    }
  }
}

// Used with DOCK_MOCK=1 so the UI can be developed without the hardware.
class MockDock {
  constructor() {
    this.keyHandlers = []
    console.log('[mock] dock connected')
  }
  onKey(h) {
    this.keyHandlers.push(h)
  }
  onError() {}
  wake() {}
  brightness(v) {
    console.log('[mock] brightness', v)
  }
  setKey(key, jpeg) {
    console.log(`[mock] setKey ${key}: ${jpeg.length} bytes`)
  }
  close() {}
}

module.exports = { Dock, MockDock, KEY_MAP, PKT, PREFIX }
