@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js 20 or later is required. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install || (echo Install failed. & pause & exit /b 1))
node server.js
pause
