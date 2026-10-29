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
