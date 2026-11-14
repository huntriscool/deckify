// Cross-platform demo, works without installing node-hid or connecting hardware.
process.env.DOCK_MOCK = '1';
require('./server');
// server.js deliberately does not start when required, so use the lightweight launcher:
const { server, connect } = require('./server');
const { exec } = require('node:child_process');
const port = Number(process.env.PORT || 4310);
server.listen(port, '127.0.0.1', () => {
  connect();
  const url = `http://localhost:${port}`;
  console.log(`Deckify demo: ${url} (no physical dock needed)`);
  if (process.env.NO_OPEN !== '1') {
    exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`, () => {});
  }
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
