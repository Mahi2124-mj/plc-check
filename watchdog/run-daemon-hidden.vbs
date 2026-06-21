' Launches run-daemon.cmd completely hidden (no console window) and waits,
' so the Scheduled Task stays in the "Running" state while the watchdog lives.
Dim fso, sh, p
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
p = fso.GetParentFolderName(WScript.ScriptFullName) & "\run-daemon.cmd"
sh.Run """" & p & """", 0, True
