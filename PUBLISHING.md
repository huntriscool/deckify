# Public release checklist — Deckify

The source distribution can be published on GitHub or shared as a ZIP, subject to the hardware checks below. It is **not** a signed Windows/macOS binary installer and **not** a static web-hostable service. Deployment to a public website would not grant USB-HID access.

## Before tagging a public release

1. Run `npm run check` (runs syntax checks and the Node test suite).
2. Run `npm run demo` and manually test all the UI flows, including identify ON/OFF, import/export, clearing and undo, 15-key sync, disconnected UI and mobile layout.
3. On a real Anko dock (USB `0100:1008`), check connection/reconnect, brightness, button presses and **actual hardware key numbering**. Verify images are upright at 0/90/180/270 degrees as applicable.
4. Verify a full sync of 15 images, a key-only update, an intentionally empty key and **number-label OFF restoration**. Disconnect midway through an operation and check that reconnect/retry works.
5. Test Windows startup, Node dependency installation and the correct HID interface. macOS/Linux support is not hardware-verified.
6. Confirm `dock_layout.json`, `node_modules`, exported layouts, private images, screenshots of personal data and credentials are **not** in the publication ZIP or tracked by Git.
7. Update release notes/version and publish the **sanitised source distribution**. Document remaining hardware/OS limitations rather than calling them tested.

## CI

`.github/workflows/ci.yml` runs the hardware-free test suite on Node 20 and 22. Actual HID hardware tests remain manual.

## Node-HID setup

The native `node-hid` module may need OS-specific compilation tools and USB permissions. The project intentionally delays requiring `node-hid` until a real dock is opened, so `npm test` and `npm run demo` work without installing it.

## Technical boundaries

- The source USB frame format and key mapping come from the supplied Deckify prototype; they were not reverse-engineered or tested on physical hardware in this environment.
- No installer, code signing, automatic software update, or system tray/background service is provided.
- The local server needs to remain running in order to change the dock's icons or settings.
- Icon display editing does not configure keyboard macros or system-wide shortcuts.
