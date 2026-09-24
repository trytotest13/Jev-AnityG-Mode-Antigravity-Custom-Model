' Jev AnityG-Mode - runs open-dashboard.bat with no console window flash.
' The desktop shortcut targets this script.
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\open-dashboard.bat""", 0, False
