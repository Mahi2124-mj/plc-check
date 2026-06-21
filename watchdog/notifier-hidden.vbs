' Runs notifier.ps1 completely hidden (no window) and waits, so the Scheduled
' Task stays "Running" while the notifier lives.
Dim fso, sh, p
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
p = fso.GetParentFolderName(WScript.ScriptFullName) & "\notifier.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & p & """", 0, True
