# Registers + starts the two logon Scheduled Tasks (auto-heal daemon + notifier).
# No admin needed (logon-level). For boot-level 24x7 use install-24x7-boot.cmd.
$ErrorActionPreference = 'Stop'
$wd = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = $env:USERNAME

function RegTask($name, $vbs, $desc) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  $action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + (Join-Path $wd $vbs) + '"') -WorkingDirectory $wd
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $desc | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host ("  registered + started: " + $name) -ForegroundColor Green
}

RegTask "PLC-Camera Auto-Heal Watchdog" "run-daemon-hidden.vbs" "Auto-heal watchdog: :3000 auto-restart; camera + PLC monitor; self-restart."
RegTask "PLC-Camera Auto-Heal Notifier" "notifier-hidden.vbs"   "Pops a Windows alert on every crash / heal / down event."
Write-Host ""
Write-Host "Auto-heal + alerts are now live and will auto-start at every logon." -ForegroundColor Cyan
