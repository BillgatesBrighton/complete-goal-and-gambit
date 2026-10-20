$ErrorActionPreference = "Stop"
Import-Module ScheduledTasks
$taskName = "GOALGAMBIT Server"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Error "Background server task is not installed. Run 'npm run server:install' first."
    exit 1
}

$listener = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
if ($listener) {
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 5 -UseBasicParsing
        if ([int]$health.StatusCode -eq 200) {
            Write-Host "GOAL$GAMBIT is already online at http://127.0.0.1:5000."
            exit 0
        }
    } catch { }
    Write-Error "Port 5000 is occupied by a server that did not pass the GOAL$GAMBIT health check."
    exit 1
}

if ($task.State -ne "Running") {
    Start-ScheduledTask -TaskName $taskName
} else {
    Write-Host "The background server task is already running; waiting for the health check."
}
$deadline = (Get-Date).AddSeconds(75)
do {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 3 -UseBasicParsing
        if ([int]$health.StatusCode -eq 200) {
            Write-Host "GOAL$GAMBIT is online."
            exit 0
        }
    } catch { }
    $task = Get-ScheduledTask -TaskName $taskName
} while ((Get-Date) -lt $deadline -and $task.State -eq "Running")

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Error "The server did not pass its health check yet. Task result: $($info.LastTaskResult). Check backend\server-task.log."
exit 1
