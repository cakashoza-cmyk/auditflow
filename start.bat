@echo off
echo.
echo  AuditFlow -- Starting...
echo.

where node >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
  echo  ERROR: Node.js is not installed.
  echo  Please download and install it from: https://nodejs.org
  echo  Choose the LTS version, install, then run this file again.
  pause
  exit /b
)

if exist node_modules\better-sqlite3 (
  echo  Removing old dependencies...
  rmdir /s /q node_modules
)

if not exist node_modules (
  echo  Installing dependencies (takes about 30 seconds)...
  npm install
  echo.
)

echo  Starting server...
echo  -----------------------------------------------
echo  Open your browser at: http://localhost:3000
echo  -----------------------------------------------
echo.
echo  Demo login (password: demo1234)
echo    Banker  : banker@demo.com
echo    CA      : ca@demo.com
echo    Borrower: borrower@demo.com
echo.
echo  Press Ctrl+C to stop.
echo.
node server.js
pause
