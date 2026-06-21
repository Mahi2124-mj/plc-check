# Upgrades the auto-heal watchdog task to TRUE 24x7: runs whether logged on or
# not, and starts at system boot (not just at user logon). MUST run as admin.
$ErrorActionPreference = 'Stop'
$wd  = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $wd "run-daemon-hidden.vbs"
$taskName = "PLC-Camera Auto-Heal Watchdog"
$user = "$env:USERDOMAIN\$env:USERNAME"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"') -WorkingDirectory $wd
$trigBoot  = New-ScheduledTaskTrigger -AtStartup
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# S4U = "run whether user is logged on or not", no stored password needed
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigBoot, $trigLogon) -Settings $settings -Principal $principal -Description "24x7 auto-heal watchdog for the PLC+Camera tool. Runs at boot, whether logged on or not; restarts the daemon if it dies." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host ""
Write-Host "DONE: '$taskName' is now 24x7 (runs at boot, whether logged on or not)." -ForegroundColor Green
Write-Host "It will keep :3000 alive and monitor camera + PLC even before anyone logs in."
