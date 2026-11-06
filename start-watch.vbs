' Runs the Detector AERO watcher without a console window and keeps it alive.
Option Explicit
Dim fso, shell, dir, cmd, svc, procs, proc, running

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
cmd = "node.exe """ & dir & "\watch.mjs"""

Do
    running = False
    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
    For Each proc In procs
        If Not IsNull(proc.CommandLine) Then
            If InStr(LCase(proc.CommandLine), "watch.mjs") > 0 Then running = True
        End If
    Next
    Set procs = Nothing
    Set svc = Nothing

    If Not running Then
        shell.Run cmd, 0, True
    End If

    WScript.Sleep 30000
Loop
