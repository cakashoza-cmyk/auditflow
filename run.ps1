Write-Host ""
Write-Host "  AuditFlow Setup & Launch" -ForegroundColor Cyan
Write-Host "  ========================" -ForegroundColor Cyan
Write-Host ""

# Check Node
$nodeVersion = node --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Node.js not found in PATH." -ForegroundColor Red
    Write-Host "  Please install from https://nodejs.org (LTS version)" -ForegroundColor Yellow
    Read-Host "  Press Enter to exit"
    exit 1
}
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green

# Clean old broken node_modules (had better-sqlite3)
if (Test-Path "node_modules\better-sqlite3") {
    Write-Host "  Removing old incompatible packages..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force "node_modules"
}

# Install if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing packages (30-60 seconds)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  npm install FAILED. Error above." -ForegroundColor Red
        Read-Host "  Press Enter to exit"
        exit 1
    }
    Write-Host "  Packages installed OK." -ForegroundColor Green
}

Write-Host ""
Write-Host "  ─────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  Open browser at: http://localhost:3000" -ForegroundColor White
Write-Host "  ─────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  Demo password: demo1234" -ForegroundColor Gray
Write-Host "  banker@demo.com  |  ca@demo.com  |  borrower@demo.com" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop the server." -ForegroundColor Gray
Write-Host ""

node server.js
Read-Host "Server stopped. Press Enter to close"
