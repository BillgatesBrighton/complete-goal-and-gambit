param(
    [switch]$UseNodemon,
    [switch]$ScheduledTask
)

$ErrorActionPreference = "Stop"
$backendDir = $PSScriptRoot
$scheduledTaskLog = Join-Path $backendDir "server-task.log"
$transcriptStarted = $false
if ($ScheduledTask) {
    try {
        if ((Test-Path -LiteralPath $scheduledTaskLog) -and (Get-Item -LiteralPath $scheduledTaskLog).Length -gt 5MB) {
            Move-Item -LiteralPath $scheduledTaskLog -Destination (Join-Path $backendDir "server-task.previous.log") -Force
        }
        Start-Transcript -LiteralPath $scheduledTaskLog -Append -Force | Out-Null
        $transcriptStarted = $true
    } catch {
        Write-Warning "Could not start the server task log: $($_.Exception.Message)"
    }
}
$backendEnvFile = Join-Path $backendDir ".env"
$desktopEnvFile = [IO.Path]::GetFullPath((Join-Path $backendDir "..\..\.env"))
$envFile = if (Test-Path -LiteralPath $backendEnvFile) { $backendEnvFile } else { $desktopEnvFile }

if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Error "The Desktop .env file was not found. Keep it on the Desktop and try again."
    exit 1
}

$webPushEnvFile = Join-Path $backendDir ".env.webpush"
if (-not (Test-Path -LiteralPath $webPushEnvFile)) {
    Write-Error "Web Push VAPID settings are missing. Configure backend\.env.webpush before enabling the public site."
    exit 1
}
$webPushConfig = Get-Content -LiteralPath $webPushEnvFile -Raw
if ($webPushConfig -notmatch "(?m)^\s*VAPID_PUBLIC_KEY=\S+" -or $webPushConfig -notmatch "(?m)^\s*VAPID_PRIVATE_KEY=\S+") {
    Write-Error "Web Push VAPID settings are incomplete. The private key must remain local."
    exit 1
}

$startupMutex = New-Object System.Threading.Mutex($false, "Global\GOALGAMBIT-Server-Startup")
$startupMutexAcquired = $false
try {
    $startupMutexAcquired = $startupMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    # The previous launcher exited unexpectedly. This process now owns the lock.
    $startupMutexAcquired = $true
}

if (-not $startupMutexAcquired) {
    Write-Host "Another GOAL`$GAMBIT startup is already running. Waiting for its health check instead of starting a second database initializer."
    $startupDeadline = (Get-Date).AddSeconds(75)
    do {
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 3 -UseBasicParsing
            if ([int]$health.StatusCode -eq 200) {
                Write-Host "GOAL`$GAMBIT is online. The existing server is being reused."
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $startupDeadline)

    Write-Error "The other startup did not pass its health check. Check backend\server-task.log before retrying."
    exit 1
}

$tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscaleCommand) {
    Write-Error "Install Tailscale for Windows, sign in, and enable Funnel before starting this script."
    exit 1
}

$activeListener = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
if ($activeListener) {
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 5 -UseBasicParsing
        if ([int]$health.StatusCode -eq 200) {
            $statusJson = & $tailscaleCommand.Source funnel status --json
            $statusExitCode = $LASTEXITCODE
            $statusText = $statusJson -join "`n"
            $hostMatch = [regex]::Match($statusText, '(?i)([a-z0-9][a-z0-9.-]*\.ts\.net)(?::\d+)?')
            $hasExpectedProxy = $statusText -match '"Proxy"\s*:\s*"http://127\.0\.0\.1:5000"'
            if ($statusExitCode -ne 0 -or -not $hostMatch.Success -or -not $hasExpectedProxy) {
                & $tailscaleCommand.Source funnel --bg 5000
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
                $statusJson = & $tailscaleCommand.Source funnel status --json
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
                $statusText = $statusJson -join "`n"
                $hostMatch = [regex]::Match($statusText, '(?i)([a-z0-9][a-z0-9.-]*\.ts\.net)(?::\d+)?')
            }
            if (-not $hostMatch.Success) {
                Write-Error "The backend is healthy locally, but Tailscale did not return its public HTTPS hostname."
                exit 1
            }
            Write-Host "GOAL`$GAMBIT is already online at https://$($hostMatch.Groups[1].Value.TrimEnd('.')). The existing server is being reused."
            exit 0
        }
    } catch {
        Write-Error "Port 5000 is occupied by a server that did not pass the GOAL`$GAMBIT health check."
        exit 1
    }
    Write-Error "Port 5000 is occupied by a server that did not pass the GOAL`$GAMBIT health check."
    exit 1
}

& $tailscaleCommand.Source funnel --bg 5000
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$statusJson = & $tailscaleCommand.Source funnel status --json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$statusText = $statusJson -join "`n"
$hostMatch = [regex]::Match($statusText, '(?i)([a-z0-9][a-z0-9.-]*\.ts\.net)(?::\d+)?')
if (-not $hostMatch.Success) {
    Write-Error "Tailscale did not return a public HTTPS hostname. Check Funnel status and try again."
    exit 1
}
$hostName = $hostMatch.Groups[1].Value.TrimEnd('.')

$publicBase = "https://$($hostName.TrimEnd('.'))"
$env:PUBLIC_BASE_URL = $publicBase
$env:MPESA_CALLBACK_URL = ""
$env:HOST = "127.0.0.1"
$env:PORT = "5000"
$env:NODE_ENV = "production"
$env:ALLOWED_ORIGINS = "https://billgatesbrighton.github.io"
$env:ALLOW_TEST_DEPOSITS = "false"
$env:TEST_WALLET_MODE = "false"
$env:DOTENV_CONFIG_PATH = $envFile

# Keep PUBLIC_BASE_URL and the other online-only routing values in this process.
# The existing .env and database configuration are never rewritten here.


Write-Host "Public API: $publicBase"
Write-Host "Callback: $publicBase/api/payments/callback"
Write-Host "Starting GOAL$GAMBIT. Keep this window and Tailscale running."

Push-Location $backendDir
$serverExitCode = 0
try {
    if (-not (Test-Path (Join-Path $backendDir "node_modules"))) {
        npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if ($UseNodemon) {
        npm run dev:local
    } else {
        npm start
        $serverExitCode = $LASTEXITCODE
        if ($serverExitCode -eq 0) { $serverExitCode = 1 }
    }
} finally {
    Pop-Location
    & $tailscaleCommand.Source funnel reset
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}

if ($ScheduledTask) { exit $serverExitCode }
