@echo off
title Jianan - OCD Support
cd /d "%~dp0"

echo.
echo   ============================================
echo     Jianan is starting...
echo     Browser: http://localhost:3000
echo.
echo     KEEP THIS WINDOW OPEN while using Jianan.
echo     To stop: close this window (or Ctrl+C)
echo   ============================================
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18 or newer:
  echo   https://nodejs.org/
  echo.
  pause
)
