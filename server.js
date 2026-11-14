'use strict';
// Deckify is a LOCAL desktop companion; no public network access or cloud service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { Dock, MockDock } = require('./dock');
const { normalizeConfig, readConfig, writeConfig } = require('./config');

const PORT = Number(process.env.PORT || 4310);
const HOST = '127.0.0.1';
const MOCK = process.env.DOCK_MOCK === '1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const CFG = process.env.DECKIFY_CONFIG_PATH || path.join(__dirname, 'dock_layout.json');
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
};

let dock = null;
let status = { connected: false, mock: MOCK, message: 'Starting…' };
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}
function setStatus(connected, message = '') {
  status = { connected, mock: MOCK, message };
  broadcast('status', status);
}
function connect() {
  try {
    if (dock) dock.close();
    const device = MOCK ? new MockDock() : new Dock();
    dock = device;
    device.onKey((key, state) => { if (dock === device) broadcast('key', { key, state }); });
    device.onError((error) => {
      if (dock !== device) return; // old device errors must not disconnect a new one
      try { device.close(); } catch { /* disconnected already */ }
      dock = null;
      setStatus(false, `Connection lost: ${error.message}`);
    });
    setStatus(true);
  } catch (error) {
    dock = null;
    setStatus(false, error.message);
  }
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function serve(req, res) {
  return (async () => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const host = req.headers.host || '';
    if (host !== `localhost:${PORT}` && host !== `${HOST}:${PORT}`) return json(res, 403, { ok: false, error: 'Forbidden host' });
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    }
    if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
      res.writeHead(200, { 'Content-Type': STATIC[url.pathname], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(path.join(PUB, url.pathname.slice(1))));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'Not found' });
    const token = req.headers['x-token'] || url.searchParams.get('t');
    if (token !== TOKEN) return json(res, 403, { ok: false, error: 'Invalid session token' });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, readConfig(CFG));
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const data = JSON.parse((await readBody(req, 26e6)).toString('utf8'));
      const cfg = writeConfig(CFG, data);
      return json(res, 200, { ok: true, rotation: cfg.rotation, brightness: cfg.brightness });
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      connect();
      return json(res, status.connected ? 200 : 409, { ok: status.connected, error: status.message, ...status });
    }
    if (req.method === 'POST' && url.pathname === '/api/brightness') {
      const { value } = JSON.parse((await readBody(req, 500)).toString('utf8'));
      if (!Number.isInteger(value) || value < 0 || value > 100) return json(res, 400, { ok: false, error: 'Brightness must be 0–100' });
      if (!dock) return json(res, 409, { ok: false, error: 'Dock not connected' });
      dock.brightness(value);
      return json(res, 200, { ok: true });
    }
    const match = req.method === 'POST' && url.pathname.match(/^\/api\/key\/(\d+)$/);
    if (match) {
      const key = Number(match[1]);
      if (!Number.isInteger(key) || key < 1 || key > 15) return json(res, 400, { ok: false, error: 'Key must be between 1 and 15' });
      const jpeg = await readBody(req, 300000);
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
        return json(res, 400, { ok: false, error: 'A JPEG image is required' });
      }
      if (!dock) return json(res, 409, { ok: false, error: 'Dock not connected' });
      dock.setKey(key, jpeg);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'Unknown endpoint' });
  })().catch((error) => json(res, error.statusCode || (error instanceof SyntaxError ? 400 : 400), { ok: false, error: error.message }));
}

const server = http.createServer(serve);
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`Deckify: ${url}${MOCK ? ' (DEMO MODE)' : ''}`);
    console.log('Close the official dock app first. Ctrl+C to stop.');
    connect();
    if (process.env.NO_OPEN !== '1') {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is occupied. Another Deckify may already be running.` : error.message);
    process.exitCode = 1;
  });
  const stop = () => { if (dock) dock.close(); for (const c of clients) c.end(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { server, connect, serve };
