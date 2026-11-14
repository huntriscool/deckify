# Privacy and data handling

Deckify is designed to work offline on one computer. It does not use third-party scripts, send analytics, create an account, or upload your images to an external server.

When you choose an image, the browser reduces its size and stores it as an embedded data URL in `dock_layout.json` beside the server code. Settings and labels are stored in that same file. The local Node server listens only on `127.0.0.1` and checks a random per-launch session token before accepting API commands. The app does not use a public web endpoint.

**Take care with exported layout backups:** `.json` export files include the actual image bytes. Do not upload these to GitHub or other public sites unless you intend to share those images.
