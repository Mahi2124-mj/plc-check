# Auto-Heal Notifier — runs in the user's session, watches the watchdog incident
# log and pops a Windows alert whenever a service crashes / heals / escalates.
$inc = Join-Path $PSScriptRoot "..\logs\watchdog_incidents.jsonl"
$log = Join-Path $PSScriptRoot "..\logs\notifier.log"

function Note($m) { ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $m) | Out-File -FilePath $log -Append -Encoding utf8 }

function Notify($title, $body) {
  Note ("NOTIFY: " + $title + " | " + $body)
  # primary: msg.exe dialog (reliable, no message loop needed)
  try { Start-Process -FilePath "msg.exe" -ArgumentList @("*", "/TIME:25", ($title + "  --  " + $body)) -WindowStyle Hidden -ErrorAction Stop; return } catch {}
  # fallback: tray balloon
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.ShowBalloonTip(8000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Milliseconds 1200
    $ni.Dispose()
  } catch {}
}

$seen = 0
if (Test-Path $inc) { $seen = @(Get-Content $inc).Count }
Note ("notifier started, baseline=" + $seen)

while ($true) {
  Start-Sleep -Seconds 4
  try {
    if (-not (Test-Path $inc)) { continue }
    $lines = @(Get-Content $inc)
    if ($lines.Count -lt $seen) { $seen = 0 }          # log was cleared/rotated
    if ($lines.Count -le $seen) { continue }
    for ($i = $seen; $i -lt $lines.Count; $i++) {
      try {
        $o = $lines[$i] | ConvertFrom-Json
        switch ($o.status) {
          'recovered'  { Notify ("AUTO-HEALED: " + $o.service) ("Port " + $o.port + " crashed -> new pid " + $o.replacement_pid + " in " + $o.recovery_duration_s + "s") }
          'alert_only' { Notify ("SERVICE DOWN: " + $o.service) ("Port " + $o.port + " unreachable (monitor-only)") }
          default      { if ($o.status -match 'escalat|failed') { Notify ("NEEDS ATTENTION: " + $o.service) ("status: " + $o.status) } }
        }
      } catch {}
    }
    $seen = $lines.Count
  } catch {}
}
