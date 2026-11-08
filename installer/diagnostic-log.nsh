; Temporary, explicit diagnostic builds only. Normal installers compile no logger.
!macro InstallerDiagnostic Text
!ifdef INSTALLER_DIAGNOSTICS
  Push "[단계] ${Text}"
  Call AppendInstallerDiagnostic
!endif
!macroend

!macro InstallerDiagnosticError Code Text
!ifdef INSTALLER_DIAGNOSTICS
  Push "${Text}"
  Push "${Code}"
  Call RecordInstallerDiagnosticError
!endif
!macroend

!macro InstallerDiagnosticFile Path
!ifdef INSTALLER_DIAGNOSTICS
  Push "${Path}"
  Call ProbeInstallerDiagnosticFile
!endif
!macroend

; Runs the diagnostic-only report program and copies its findings (engine startup
; log tail, open engine dialogs, Windows error records) into the Downloads log.
!macro InstallerDiagnosticEngineReport Stage Exe
!ifdef INSTALLER_DIAGNOSTICS
  Push "${Exe}"
  Push "${Stage}"
  Call RecordInstallerEngineReport
!endif
!macroend

; Engine start/stop. Normal builds run exactly the original commands; diagnostic
; builds run them through the report program so an error dialog is read while open.
!macro InstallerEngineStart Exe
!ifdef INSTALLER_DIAGNOSTICS
  Push "${Exe}"
  Call RunWatchedEngineStart
!else
  Exec '"${Exe}"'
!endif
!macroend

!macro InstallerEngineStop Stage Exe Result
!ifdef INSTALLER_DIAGNOSTICS
  Push "${Exe}"
  Push "${Stage}"
  Call RunWatchedEngineStop
  Pop ${Result}
!else
  ExecWait '"${Exe}" --stop' ${Result}
!endif
!macroend

!macro InstallerDiagnosticAbort
!ifdef INSTALLER_DIAGNOSTICS
  Push "설치 중단 / install.aborted"
  Call FinishInstallerDiagnostic
!endif
  Abort
!macroend

!ifdef INSTALLER_DIAGNOSTICS
!include "FileFunc.nsh"
!define INSTALLER_DIAGNOSTIC_SUFFIX "$\r$\n$\r$\n진단 로그: $InstallerDiagnosticPath"
Var InstallerDiagnosticPath
Var InstallerDiagnosticReady
Var InstallerDiagnosticLine
Var InstallerDiagnosticHandle
Var InstallerDiagnosticHadError
Var InstallerDiagnosticTick
Var InstallerDiagnosticSize
Var InstallerDiagnosticSequence
Var InstallerDiagnosticErrorCount
Var InstallerDiagnosticFirstError
Var InstallerDiagnosticErrorCode
Var InstallerDiagnosticErrorLine
Var InstallerDiagnosticErrorFlag
Var InstallerDiagnosticExitCode
Var InstallerDiagnosticPid
Var InstallerDiagnosticProbePath
Var InstallerDiagnosticProbeHandle
Var InstallerDiagnosticProbeSize
Var InstallerDiagnosticProbeFlag
Var InstallerDiagnosticOutcomeWritten

Function AppendInstallerDiagnostic
  Pop $InstallerDiagnosticLine
  StrCpy $InstallerDiagnosticHadError 0
  IfErrors 0 +2
  StrCpy $InstallerDiagnosticHadError 1
  IntOp $InstallerDiagnosticSequence $InstallerDiagnosticSequence + 1
  ${If} $InstallerDiagnosticReady == 1
    ClearErrors
    FileOpen $InstallerDiagnosticHandle "$InstallerDiagnosticPath" a
    IfErrors diagnostic_write_done
    FileSeek $InstallerDiagnosticHandle 0 END $InstallerDiagnosticSize
    ${If} $InstallerDiagnosticSize == 0
      FileWriteByte $InstallerDiagnosticHandle 255
      FileWriteByte $InstallerDiagnosticHandle 254
    ${EndIf}
    System::Call 'kernel32::GetTickCount() i.s'
    Pop $InstallerDiagnosticTick
    FileWriteUTF16LE $InstallerDiagnosticHandle "[시도 $InstallerDiagnosticPid / 기록 #$InstallerDiagnosticSequence tick=$InstallerDiagnosticTick] $InstallerDiagnosticLine (error_flag=$InstallerDiagnosticHadError)$\r$\n"
    FileClose $InstallerDiagnosticHandle
  ${EndIf}
diagnostic_write_done:
  ${If} $InstallerDiagnosticHadError == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
FunctionEnd

; Error reporting must not change the state that the installer uses to decide
; whether it may continue, roll back, or preserve the current program tree.
Function RecordInstallerDiagnosticError
  Pop $InstallerDiagnosticErrorCode
  Pop $InstallerDiagnosticErrorLine
  StrCpy $InstallerDiagnosticErrorFlag 0
  IfErrors 0 +2
  StrCpy $InstallerDiagnosticErrorFlag 1
  IntOp $InstallerDiagnosticErrorCount $InstallerDiagnosticErrorCount + 1
  ${If} $InstallerDiagnosticFirstError == ""
    StrCpy $InstallerDiagnosticFirstError "$InstallerDiagnosticErrorCode"
  ${EndIf}
  Push "[오류 #$InstallerDiagnosticErrorCount] $InstallerDiagnosticErrorCode : $InstallerDiagnosticErrorLine"
  ${If} $InstallerDiagnosticErrorFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Call AppendInstallerDiagnostic
FunctionEnd

Function ProbeInstallerDiagnosticFile
  Pop $InstallerDiagnosticProbePath
  StrCpy $InstallerDiagnosticProbeFlag 0
  IfErrors 0 +2
  StrCpy $InstallerDiagnosticProbeFlag 1
  ClearErrors
  FileOpen $InstallerDiagnosticProbeHandle "$InstallerDiagnosticProbePath" r
  IfErrors diagnostic_file_unreadable
  StrCpy $InstallerDiagnosticProbeSize "unknown"
  FileSeek $InstallerDiagnosticProbeHandle 0 END $InstallerDiagnosticProbeSize
  IfErrors 0 +2
  StrCpy $InstallerDiagnosticProbeSize "unknown"
  FileClose $InstallerDiagnosticProbeHandle
  Push "[실행 파일 확인] path=$InstallerDiagnosticProbePath bytes=$InstallerDiagnosticProbeSize"
  Goto diagnostic_file_report
diagnostic_file_unreadable:
  Push "[실행 파일 확인] 없거나 읽을 수 없음 path=$InstallerDiagnosticProbePath"
diagnostic_file_report:
  ${If} $InstallerDiagnosticProbeFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Call AppendInstallerDiagnostic
FunctionEnd

Function FinishInstallerDiagnostic
  Pop $InstallerDiagnosticLine
  ${If} $InstallerDiagnosticOutcomeWritten != 1
    StrCpy $InstallerDiagnosticOutcomeWritten 1
    GetErrorLevel $InstallerDiagnosticExitCode
    Push "[최종 결과] $InstallerDiagnosticLine exit=$InstallerDiagnosticExitCode errors=$InstallerDiagnosticErrorCount first-error=$InstallerDiagnosticFirstError"
    Call AppendInstallerDiagnostic
  ${EndIf}
FunctionEnd

Function InitInstallerDiagnostic
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $InstallerDiagnosticReady 0
  StrCpy $InstallerDiagnosticSequence 0
  StrCpy $InstallerDiagnosticErrorCount 0
  StrCpy $InstallerDiagnosticFirstError ""
  StrCpy $InstallerDiagnosticOutcomeWritten 0
  System::Call 'kernel32::GetCurrentProcessId() i.s'
  Pop $InstallerDiagnosticPid
!ifdef INSTALLER_DIAGNOSTIC_TEST_DIR
  ; Used only by the isolated logger regression executable.
  StrCpy $2 "${INSTALLER_DIAGNOSTIC_TEST_DIR}"
!else
  ; Resolve the real Downloads known folder, including a relocated Downloads.
  StrCpy $2 "$PROFILE\Downloads"
  System::Call 'shell32::SHGetKnownFolderPath(g "{374DE290-123F-4565-9164-39C4925E467B}", i 0, p 0, *p .r0) i.r1'
  ${If} $1 == 0
  ${AndIf} $0 != 0
    System::Call '*$0(&w${NSIS_MAX_STRLEN} .r2)'
    System::Call 'ole32::CoTaskMemFree(p r0)'
  ${EndIf}
!endif
  StrCpy $InstallerDiagnosticPath "$2\LMO-install-diagnostic.log"
  CreateDirectory "$2"
  ClearErrors
  FileOpen $InstallerDiagnosticHandle "$InstallerDiagnosticPath" a
  IfErrors diagnostic_init_failed
  FileClose $InstallerDiagnosticHandle
  StrCpy $InstallerDiagnosticReady 1
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  !insertmacro InstallerDiagnostic "=== 실행 시도 시작 / installer.begin version=${ENGINE_VERSION} date=$2-$1-$0 $4:$5:$6 ==="
  !insertmacro InstallerDiagnostic "문제가 여러 개면 [오류 #번호]가 각각 기록됩니다. 첫 오류와 후속 정리 오류를 함께 확인하세요."
  !insertmacro InstallerDiagnostic "installer.pid=$InstallerDiagnosticPid exe=$EXEPATH temp=$TEMP"
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "DisplayVersion"
  ReadEnvStr $2 "PROCESSOR_ARCHITECTURE"
  ReadEnvStr $3 "PROCESSOR_ARCHITEW6432"
  !insertmacro InstallerDiagnostic "[PC 환경] windows-build=$0 display-version=$1 architecture=$2 native-architecture=$3"
  ReadEnvStr $0 "SystemRoot"
  !insertmacro InstallerDiagnostic "[시작 환경] SystemRoot=$0 profile=$PROFILE"
  Goto diagnostic_init_done
diagnostic_init_failed:
  StrCpy $InstallerDiagnosticPath "로그 생성 실패 (다운로드 폴더 쓰기 권한 확인)"
diagnostic_init_done:
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ClearErrors
FunctionEnd

!include "TextFunc.nsh"
!define INSTALLER_ENGINE_REPORT_MAX_LINES 300
Var InstallerEngineReportStage
Var InstallerEngineReportExe
Var InstallerEngineReportFile
Var InstallerEngineReportHandle
Var InstallerEngineReportLine
Var InstallerEngineReportExit
Var InstallerEngineReportFlag
; Separate from the file reader's flag: the reader runs inside the report call.
Var InstallerEngineReportCallerFlag
Var InstallerEngineReportCount

; Copies a UTF-16LE report (one record per line, no BOM) into the diagnostic log.
Function AppendInstallerEngineReportFile
  Pop $InstallerEngineReportFile
  StrCpy $InstallerEngineReportFlag 0
  IfErrors 0 +2
  StrCpy $InstallerEngineReportFlag 1
  StrCpy $InstallerEngineReportCount 0
  ClearErrors
  FileOpen $InstallerEngineReportHandle "$InstallerEngineReportFile" r
  IfErrors engine_report_missing
engine_report_next:
  ClearErrors
  FileReadUTF16LE $InstallerEngineReportHandle $InstallerEngineReportLine
  IfErrors engine_report_close
  IntOp $InstallerEngineReportCount $InstallerEngineReportCount + 1
  ${If} $InstallerEngineReportCount > ${INSTALLER_ENGINE_REPORT_MAX_LINES}
    Push "[엔진 보고서] ${INSTALLER_ENGINE_REPORT_MAX_LINES}줄 이후 생략"
    Call AppendInstallerDiagnostic
    Goto engine_report_close
  ${EndIf}
  ${TrimNewLines} "$InstallerEngineReportLine" $InstallerEngineReportLine
  Push "$InstallerEngineReportLine"
  Call AppendInstallerDiagnostic
  Goto engine_report_next
engine_report_close:
  FileClose $InstallerEngineReportHandle
  Goto engine_report_restore
engine_report_missing:
  Push "[엔진 보고서] 결과 파일 없음 path=$InstallerEngineReportFile"
  Call AppendInstallerDiagnostic
engine_report_restore:
  ${If} $InstallerEngineReportFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
FunctionEnd

Function RecordInstallerEngineReport
  Pop $InstallerEngineReportStage
  Pop $InstallerEngineReportExe
  StrCpy $InstallerEngineReportCallerFlag 0
  IfErrors 0 +2
  StrCpy $InstallerEngineReportCallerFlag 1
  ${If} $InstallerDiagnosticReady == 1
    Push "[엔진 보고서 요청] stage=$InstallerEngineReportStage"
    Call AppendInstallerDiagnostic
    Delete "$PLUGINSDIR\engine-report.txt"
    ClearErrors
    ExecWait '"$PLUGINSDIR\barorok-installer-diagnostic-report.exe" --stage "$InstallerEngineReportStage" --engine-exe "$InstallerEngineReportExe" --output "$PLUGINSDIR\engine-report.txt"' $InstallerEngineReportExit
    IfErrors 0 +2
    StrCpy $InstallerEngineReportExit "launch_failed"
    Push "[엔진 보고서] report-exit=$InstallerEngineReportExit"
    Call AppendInstallerDiagnostic
    Push "$PLUGINSDIR\engine-report.txt"
    Call AppendInstallerEngineReportFile
  ${EndIf}
  ${If} $InstallerEngineReportCallerFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
FunctionEnd

Var InstallerEngineWatchStage
Var InstallerEngineWatchExe
Var InstallerEngineWatchExit
Var InstallerEngineWatchFlag

; Starts the engine through the report program, which returns once the engine
; answers, exits, or 20 seconds pass. The engine keeps running afterwards.
Function RunWatchedEngineStart
  Pop $InstallerEngineWatchExe
  StrCpy $InstallerEngineWatchFlag 0
  IfErrors 0 +2
  StrCpy $InstallerEngineWatchFlag 1
  Delete "$PLUGINSDIR\engine-watch.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-diagnostic-report.exe" --watch start --stage "engine.start" --engine-exe "$InstallerEngineWatchExe" --output "$PLUGINSDIR\engine-watch.txt"' $InstallerEngineWatchExit
  ${If} ${Errors}
    ; The report program itself could not run: start the engine the normal way.
    Push "[엔진 실행 관찰] 보고 프로그램 실행 실패, 일반 방식으로 시작"
    Call AppendInstallerDiagnostic
    Exec '"$InstallerEngineWatchExe"'
  ${ElseIfNot} ${FileExists} "$PLUGINSDIR\engine-watch.txt"
    ; The report program started but did not finish (onefile extraction blocked,
    ; crash). Start normally; a second engine exits on its single-instance mutex.
    Push "[엔진 실행 관찰] 보고 프로그램이 관찰을 끝내지 못함 exit=$InstallerEngineWatchExit, 일반 방식으로 시작"
    Call AppendInstallerDiagnostic
    Exec '"$InstallerEngineWatchExe"'
  ${Else}
    Push "$PLUGINSDIR\engine-watch.txt"
    Call AppendInstallerEngineReportFile
  ${EndIf}
  ${If} $InstallerEngineWatchFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
FunctionEnd

Function RunPlainEngineStop
  ClearErrors
  ExecWait '"$InstallerEngineWatchExe" --stop' $InstallerEngineWatchExit
  IfErrors 0 +2
  StrCpy $InstallerEngineWatchExit "launch_failed"
FunctionEnd

; Runs "<engine> --stop" through the report program and pushes the stop command's
; own exit code, so callers keep their ExecWait checks.
Function RunWatchedEngineStop
  Pop $InstallerEngineWatchStage
  Pop $InstallerEngineWatchExe
  StrCpy $InstallerEngineWatchFlag 0
  IfErrors 0 +2
  StrCpy $InstallerEngineWatchFlag 1
  Delete "$PLUGINSDIR\engine-watch.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-diagnostic-report.exe" --watch stop --stage "$InstallerEngineWatchStage" --engine-exe "$InstallerEngineWatchExe" --output "$PLUGINSDIR\engine-watch.txt"' $InstallerEngineWatchExit
  ${If} ${Errors}
    ; The report program itself could not run: stop the engine the normal way.
    Push "[엔진 실행 관찰] 보고 프로그램 실행 실패, 일반 방식으로 종료"
    Call AppendInstallerDiagnostic
    Call RunPlainEngineStop
  ${ElseIfNot} ${FileExists} "$PLUGINSDIR\engine-watch.txt"
    ; Started but never finished, so its exit code is not the stop command's.
    ; Repeating --stop is safe: an engine that already stopped answers 3.
    Push "[엔진 실행 관찰] 보고 프로그램이 관찰을 끝내지 못함 exit=$InstallerEngineWatchExit, 일반 방식으로 종료"
    Call AppendInstallerDiagnostic
    Call RunPlainEngineStop
  ${Else}
    Push "$PLUGINSDIR\engine-watch.txt"
    Call AppendInstallerEngineReportFile
  ${EndIf}
  ${If} $InstallerEngineWatchFlag == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Push $InstallerEngineWatchExit
FunctionEnd

Function .onInstSuccess
  Push "설치 완료 / install.success"
  Call FinishInstallerDiagnostic
FunctionEnd

Function .onInstFailed
  Push "설치 중단 / install.failed"
  Call FinishInstallerDiagnostic
FunctionEnd

Function InstallerDiagnosticCancelled
  Push "사용자가 설치 취소 / install.cancelled"
  Call FinishInstallerDiagnostic
FunctionEnd
!else
!define INSTALLER_DIAGNOSTIC_SUFFIX ""
!endif
