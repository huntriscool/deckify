#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then echo 'Install Node.js 20+ from https://nodejs.org'; exit 1; fi
if [ ! -d node_modules ]; then npm install || exit 1; fi
node server.js
