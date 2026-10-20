$ErrorActionPreference = "Stop"
Import-Module ScheduledTasks

$taskName = "GOALGAMBIT Server"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$startScript = Join-Path $PSScriptRoot "start-online.ps1"
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$startScript`" -ScheduledTask"

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = @(
    (New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30))
    (New-ScheduledTaskTrigger -AtLogOn -User $identity)
)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Runs the GOAL$GAMBIT API at startup or sign-in, outside a terminal, and retries after unexpected exits." `
    -Force | Out-Null

Write-Host "Installed the GOAL$GAMBIT background server task for $identity."
$listener = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
if ($listener) {
    Write-Host "Port 5000 is already in use. The current server was left running. Use 'npm run server:off' followed by 'npm run server:on' to move it under background management."
} else {
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Started the background server task."
}
