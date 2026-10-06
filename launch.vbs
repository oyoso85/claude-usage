' 위젯을 콘솔 창 없이 실행한다. 이 파일이 있는 폴더를 기준으로 경로를 잡으므로
' 폴더를 옮겨도 그대로 동작한다.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)

' VSCode 터미널 등에서 실행하면 이 변수가 설정돼 있어 Electron이 일반 Node로
' 동작해버린다. 자식 프로세스에 넘어가지 않도록 지운다.
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"

sh.Run """" & base & "\node_modules\electron\dist\electron.exe"" """ & base & """", 0, False
