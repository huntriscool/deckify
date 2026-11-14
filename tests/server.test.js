'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function getPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test('mock server serves UI and protects API / validates layout and JPEG', { timeout: 15000 }, async () => {
  const port = await getPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckify-server-'));
  const config = path.join(dir, 'layout.json');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'demo.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), NO_OPEN: '1', DECKIFY_CONFIG_PATH: config },
  });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 80; i++) {
      try { const response = await fetch(base); if (response.ok) return response; } catch { /* server starting */ }
      await new Promise((r) => setTimeout(r, 70));
    }
    throw new Error('Mock server did not start');
  };
  try {
    const response = await wait();
    const html = await response.text();
    assert.ok(html.includes('deckify'));
    const token = html.match(/name="token" content="([0-9a-f]+)"/)[1];
    const unauthorized = await fetch(`${base}/api/config`);
    assert.equal(unauthorized.status, 403);
    const headers = { 'x-token': token, 'Content-Type': 'application/json' };
    const invalid = await fetch(`${base}/api/config`, { method: 'POST', headers, body: JSON.stringify({ brightness: 101 }) });
    assert.equal(invalid.status, 400);
    const saved = await fetch(`${base}/api/config`, { method: 'POST', headers, body: JSON.stringify({ brightness: 47, keys: { 3: { caption: 'Music' } } }) });
    assert.equal(saved.status, 200);
    assert.equal(fs.existsSync(config), true);
    const loaded = await fetch(`${base}/api/config`, { headers });
    assert.equal((await loaded.json()).keys[3].caption, 'Music');
    const badJpeg = await fetch(`${base}/api/key/1`, { method: 'POST', headers, body: Buffer.from('not-an-image') });
    assert.equal(badJpeg.status, 400);
    const jpeg = await fetch(`${base}/api/key/1`, { method: 'POST', headers, body: Buffer.from([0xff,0xd8,0xff,0xd9]) });
    assert.equal(jpeg.status, 200);
    const bright = await fetch(`${base}/api/brightness`, { method: 'POST', headers, body: JSON.stringify({ value: 42 }) });
    assert.equal(bright.status, 200);
    const badBright = await fetch(`${base}/api/brightness`, { method: 'POST', headers, body: JSON.stringify({ value: 1000 }) });
    assert.equal(badBright.status, 400);
  } finally { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); }
});
