# Shortcut Dock icons (browser version)

Icon customiser for the Kmart Anko Shortcut Dock (USB 0100:1008).
No Electron: a small Node server talks to the dock and the UI opens in your browser.

## Run it
1. Install Node.js (LTS) from https://nodejs.org if you haven't.
2. Close the official Shortcut Dock app (check the system tray too).
3. Double-click `start.bat`
   (or in this folder: `npm install`, then `npm start`).
4. Your browser opens http://localhost:4310 - keep the black window open while you use it.

No dock handy? `set DOCK_MOCK=1` then `npm start` runs with a fake dock.

## Notes
- Layout and icons are saved in `dock_layout.json` next to `server.js`.
- "Panel rotation fix" defaults to 90 degrees
- "Show key numbers on dock" helps you pick the matching key-numbering option.
- The server only listens on localhost, and API calls need a per-run token.
