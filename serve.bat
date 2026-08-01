@echo off
rem Local server for Maple Tooltip Scanner (getDisplayMedia needs http://localhost, not file://)
rem serve.py sends no-store so the browser never reuses a stale js module.
cd /d "%~dp0"
echo Starting local server...
echo Open http://localhost:8471/ in your browser. Press Ctrl+C to stop.
start "" http://localhost:8471/
python serve.py
pause
