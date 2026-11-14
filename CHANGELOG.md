# Changelog

## 2.0.0 — 14 November 2026

### Improved dock workflow
- Replaced the one-shot "Show key numbers on dock" button with a true ON/OFF switch: OFF restores all 15 saved icons.
- Removed the confusing "Key numbering" selector; the grid now always reflects the hardware's fixed key mapping.
- Replaced unclear "Apply ALL to dock" with "Sync entire layout" and clear explanation that it sends all 15 previews (including blank keys).
- Kept a separate "Update this key on dock" action for individual changes.
- Prevented icon updates while identification labels are active.
- Added real progress updates, disabled conflicting actions while sending, and clearer connection/transfer errors.

### Added
- Responsive, accessible new editor and dock visualisation.
- Fill/crop vs fit image setting and background colour for each key.
- Drag/drop uploads, copy/paste between keys and Undo.
- JSON export and import with preservation of old layouts.
- Local autosave and "changed since sync" indicator.
- Demo mode without HID dependencies, cross-platform startup helpers, validation, atomic config saves, test suite and release documentation.

### Safety and reliability
- Hardened API validation and session protection; local-only binding retained.
- Prevented stale HID errors from disconnecting a newly opened device.
- Prevented async preview races from showing outdated images.
- Isolated personal `dock_layout.json` from public source distribution.

## 1.x — Original prototype
- Initial browser-based image editor with manual apply actions.
