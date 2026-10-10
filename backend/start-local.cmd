@echo off
setlocal
set "BACKEND_DIR=%~dp0"
set "DOTENV_CONFIG_PATH=%BACKEND_DIR%..\..\.env"
if exist "%BACKEND_DIR%.env" set "DOTENV_CONFIG_PATH=%BACKEND_DIR%.env"
set "HOST=127.0.0.1"
set "PORT=5000"
set "NODE_ENV=production"
set "ALLOWED_ORIGINS=https://billgatesbrighton.github.io"
set "ALLOW_TEST_DEPOSITS=false"
set "TEST_WALLET_MODE=false"
set "MPESA_CALLBACK_URL="

if not exist "%DOTENV_CONFIG_PATH%" (
    echo Missing environment file. Create backend\.env from backend\.env.example or place the existing Desktop .env at the expected location.
    pause
    exit /b 1
)

cd /d "%BACKEND_DIR%"
if not exist "node_modules" (
    echo Installing backend packages...
    call npm ci --ignore-scripts --no-audit --no-fund
    if errorlevel 1 exit /b 1
)

echo Starting GOAL$GAMBIT on this PC. Keep this window open while the website is in use.
call npm start
pause
