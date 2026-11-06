' Принудительный перезапуск наблюдателя: находит все процессы node с watch.mjs,
' завершает их и запускает один новый экземпляр без окна консоли.
Option Explicit
Dim fso, shell, svc, procs, proc, dir, killed

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir

killed = 0
Set svc = GetObject("winmgmts:\\.\root\cimv2")
Set procs = svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each proc In procs
    If Not IsNull(proc.CommandLine) Then
        If InStr(LCase(proc.CommandLine), "watch.mjs") > 0 Then
            proc.Terminate()
            killed = killed + 1
        End If
    End If
Next
Set procs = Nothing
Set svc = Nothing

WScript.Sleep 3000

shell.Run "node.exe """ & dir & "\watch.mjs""", 0, False

' отметка в лог, чтобы было видно, что перезапуск сработал
Dim f
Set f = fso.OpenTextFile(dir & "\logs\restart.log", 8, True)
f.WriteLine Now & " killed=" & killed
f.Close
