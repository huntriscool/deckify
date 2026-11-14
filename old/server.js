'use strict';
// Local web server for the Shortcut Dock icon app. Talks to the dock with
// node-hid and serves the UI to your browser on http://localhost:4310.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { Dock, MockDock } = require('./dock');

const PORT = Number(process.env.PORT) || 4310;
const HOST = '127.0.0.1'; // never exposed to the network
const MOCK = !!process.env.DOCK_MOCK;
const TOKEN = crypto.randomBytes(16).toString('hex'); // stops other web pages driving the dock
const CFG = path.join(__dirname, 'dock_layout.json');
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
};

let dock = null;
let status = { connected: false, message: 'Starting…' };
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function setStatus(connected, message) {
  status = { connected, message };
  broadcast('status', status);
}

function connect() {
  try {
    if (dock) dock.close();
    dock = MOCK ? new MockDock() : new Dock();
    dock.onKey((key, state) => broadcast('key', { key, state }));
    dock.onError((e) => { dock = null; setStatus(false, `Lost the dock: ${e.message}`); });
    setStatus(true, '');
  } catch (e) {
    dock = null;
    setStatus(false, e.message);
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Defend against DNS-rebinding: only answer requests addressed to localhost.
  const host = req.headers.host || '';
  if (host !== `localhost:${PORT}` && host !== `${HOST}:${PORT}`) {
    res.writeHead(403); return res.end('Forbidden');
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && STATIC[url.pathname]) {
    res.writeHead(200, { 'Content-Type': STATIC[url.pathname], 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUB, url.pathname)));
  }

  if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }

  const token = req.headers['x-token'] || url.searchParams.get('t');
  if (token !== TOKEN) return json(res, 403, { ok: false, error: 'Bad token' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return undefined;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (_) { /* first run */ }
      return json(res, 200, cfg);
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req, 30e6);
      JSON.parse(body.toString('utf8')); // reject anything that isn't JSON
      fs.writeFileSync(CFG, body);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/connect') {
      connect();
      return json(res, 200, { ok: status.connected, error: status.message });
    }

    if (req.method === 'POST' && url.pathname === '/api/brightness') {
      const { value } = JSON.parse((await readBody(req, 1000)).toString('utf8'));
      if (!dock) return json(res, 409, { ok: false, error: 'Not connected' });
      dock.brightness(Number(value));
      return json(res, 200, { ok: true });
    }

    const m = req.method === 'POST' && url.pathname.match(/^\/api\/key\/(\d+)$/);
    if (m) {
      const key = Number(m[1]);
      if (key < 1 || key > 15) return json(res, 400, { ok: false, error: 'Key must be 1-15' });
      const jpeg = await readBody(req, 300e3);
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        return json(res, 400, { ok: false, error: 'Body is not a JPEG' });
      }
      if (!dock) return json(res, 409, { ok: false, error: 'Not connected' });
      dock.setKey(key, jpeg);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: 'Unknown endpoint' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Shortcut Dock icons running at ${url}${MOCK ? '  (MOCK dock)' : ''}`);
  console.log('Close the official Shortcut Dock app first. Press Ctrl+C here to quit.');
  connect();
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Is the app already running? (Set PORT=4311 to use another.)`
    : e.message);
  process.exit(1);
});
process.on('SIGINT', () => { if (dock) dock.close(); process.exit(0); });
