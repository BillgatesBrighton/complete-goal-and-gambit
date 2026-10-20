$ErrorActionPreference = "Continue"
Import-Module ScheduledTasks -ErrorAction SilentlyContinue
$taskName = "GOALGAMBIT Server"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds(12)
do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") })
    if (-not $listeners.Count) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq "node.exe" -and $process.CommandLine -match '(^|[\\/ ])server\.js(\s|$)') {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    } elseif ($process) {
        Write-Warning "Port 5000 is owned by another process ($($process.Name)); it was left untouched."
    }
}

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) { & $tailscale.Source funnel reset | Out-Null }
Start-Sleep -Milliseconds 500
$remaining = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
if ($remaining) {
    Write-Error "The GOAL$GAMBIT server could not be stopped cleanly."
    exit 1
}
Write-Host "GOAL$GAMBIT server stopped. Tailscale Funnel was reset. Run 'npm run server:on' to start it again."
