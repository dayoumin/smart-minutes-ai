Unicode True
RequestExecutionLevel user
SetCompressor zlib

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef ARTIFACT_DIR
  !error "ARTIFACT_DIR is required"
!endif
!ifndef HELPER_PATH
  !error "HELPER_PATH is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef ENGINE_EXE_NAME
  !error "ENGINE_EXE_NAME is required"
!endif
!ifndef ENGINE_VERSION
  !error "ENGINE_VERSION is required"
!endif
!ifndef ICON_PATH
  !error "ICON_PATH is required"
!endif
; Brand from configs\brand.json, passed by scripts\build_web_local_engine_installer_poc.ps1.
; It appears only in the connect shortcut and the publisher; the program name stays unbranded.
!ifndef BRAND_NAME
  !error "BRAND_NAME is required"
!endif

; The program name carries no brand. Brand text comes only from BRAND_NAME,
; which the build script passes, so a brand change needs no edit here.
!define PRODUCT_NAME "음성 분석"
; PRODUCT_KEY, install folders and the engine exe keep their original names so
; upgrades still find and replace earlier installs.
!define PRODUCT_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BarorokLocalEngine"
!define START_MENU_DIR "음성 분석"
; Start menu folder and shortcut names used by releases up to
; 0.1.8-beta-20261020. They are historical file names, not the current brand.
!define LEGACY_START_MENU_DIR "바로록 로컬 엔진"
!define INSTALL_MARKER ".barorok-install-owned"
!define TRANSACTION_MARKER ".barorok-transaction-pending"
!define UNINSTALL_MARKER ".barorok-uninstall-pending"
!define INSTALLER_MUTEX "Local\BarorokLocalEngineInstaller"

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Barorok\LocalEngine"
Icon "${ICON_PATH}"
UninstallIcon "${ICON_PATH}"
ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Var StageDir
Var RollbackDir
Var EngineExe
Var PreflightResult
Var PreflightDecision
Var PreflightExit
Var PreflightAction
Var PreflightFreeSpaceGb
Var PreflightFreeSpaceDrive
Var RequestGeneration
Var HadPreviousInstall
Var ReadinessAttempts
Var PreflightAttempts
Var PreviousMoved
Var StageActivated
Var InstallerMutex
Var InstalledHelper
Var CleanupTarget
Var CleanupExit
Var CleanupManifest

!macro RemoveLegacyStartMenuEntries
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_DIR}\로컬 엔진 시작.lnk"
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_DIR}\바로록 연결.lnk"
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_DIR}\로컬 엔진 종료.lnk"
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_DIR}\제거.lnk"
  RMDir "$SMPROGRAMS\${LEGACY_START_MENU_DIR}"
!macroend

; The connect shortcut carries the brand, which can change between releases,
; so each install records the exact name and later runs remove only that file
; ("음성 분석" is a common folder name another program might also use).
!macro RemoveRecordedConnectShortcut
  ReadRegStr $2 HKCU "${PRODUCT_KEY}" "ConnectShortcut"
  StrCpy $3 $2 "" -7
  ${If} $3 == " 연결.lnk"
    Delete "$SMPROGRAMS\${START_MENU_DIR}\$2"
  ${EndIf}
!macroend

Function AcquireInstallerMutex
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALLER_MUTEX}") p.r0'
  StrCpy $InstallerMutex $0
  System::Call 'kernel32::GetLastError() i.r1'
  ${If} $InstallerMutex == 0
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "설치 잠금을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
    Abort
  ${EndIf}
  ${If} $1 == 183
    SetErrorLevel 20
    MessageBox MB_OK|MB_ICONSTOP "다른 설치 또는 제거가 진행 중입니다. 완료된 뒤 다시 실행해 주세요."
    Abort
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ${If} $InstallerMutex != 0
    System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
  ${EndIf}
FunctionEnd

Function RunInstallerPreflight
  Delete "$PreflightResult"
  Delete "$PreflightDecision"
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --manifest "$PLUGINSDIR\poc-manifest.json" --result-json "$PreflightResult" --decision-ini "$PreflightDecision" --request-generation $RequestGeneration' $PreflightExit
  StrCpy $PreflightAction "none"
  StrCpy $PreflightFreeSpaceGb ""
  StrCpy $PreflightFreeSpaceDrive ""
  IfErrors 0 +3
  StrCpy $PreflightExit "launch_failed"
  Goto done
  IfFileExists "$PreflightDecision" 0 done
  ReadINIStr $PreflightAction "$PreflightDecision" "preflight" "primary_action"
  ReadINIStr $PreflightFreeSpaceGb "$PreflightDecision" "preflight" "free_space_gb"
  ReadINIStr $PreflightFreeSpaceDrive "$PreflightDecision" "preflight" "free_space_drive"
  ; Optional keys are absent on most runs; do not leave their error flag behind.
  ClearErrors
done:
FunctionEnd

Function StopInstalledEngine
  IfFileExists "$EngineExe" 0 done
  ExecWait '"$EngineExe" --stop' $0
  ${If} $0 != 0
  ${AndIf} $0 != 3
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "실행 중인 음성 분석 프로그램을 안전하게 종료하지 못했습니다. 잠시 후 다시 실행하고, 계속되면 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
    Abort
  ${EndIf}
  ${If} $0 == 0
    Call WaitForEngineStopped
  ${EndIf}
done:
FunctionEnd

Function WaitForEngineStopped
  StrCpy $0 0
wait_retry:
  IntOp $0 $0 + 1
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --probe-stopped-engine' $1
  IfErrors 0 +2
  StrCpy $1 "launch_failed"
  ${If} $1 == 0
    Return
  ${EndIf}
  ${If} $0 >= 20
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "음성 분석 프로그램 종료가 완료되지 않았습니다. 잠시 후 다시 실행하고, 계속되면 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
    Abort
  ${EndIf}
  Sleep 250
  Goto wait_retry
FunctionEnd

Function CleanupOwnedTree
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --cleanup-owned-tree "$CleanupTarget" --manifest "$CleanupManifest"' $CleanupExit
  IfErrors 0 +2
  StrCpy $CleanupExit "launch_failed"
FunctionEnd

Function ValidateOwnedTree
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --validate-owned-tree "$CleanupTarget" --manifest "$CleanupManifest"' $CleanupExit
  IfErrors 0 +2
  StrCpy $CleanupExit "launch_failed"
FunctionEnd

Function ValidateCompleteStage
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --validate-owned-tree "$CleanupTarget" --manifest "$CleanupManifest" --require-complete-tree --require-transaction-marker' $CleanupExit
  IfErrors 0 +2
  StrCpy $CleanupExit "launch_failed"
FunctionEnd

Function RecoverInterruptedTransaction
  IfFileExists "$INSTDIR\${UNINSTALL_MARKER}" 0 recovery_check_stage
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --cleanup-uninstall-tombstone "$INSTDIR"' $CleanupExit
  IfErrors 0 +2
  StrCpy $CleanupExit "launch_failed"
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}

recovery_check_stage:
  ClearErrors
  RMDir "$StageDir"
  RMDir "$RollbackDir"
  RMDir "$INSTDIR"
  ClearErrors
  IfFileExists "$StageDir\*.*" 0 recovery_check_current
  IfFileExists "$StageDir\${INSTALL_MARKER}" 0 recovery_unsafe_stage
  StrCpy $CleanupTarget "$StageDir"
  StrCpy $CleanupManifest "$PLUGINSDIR\poc-manifest.json"
  IfFileExists "$StageDir\poc-manifest.json" 0 +2
  StrCpy $CleanupManifest "$StageDir\poc-manifest.json"
  Call ValidateOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_unsafe_stage
  ${EndIf}
  Call CleanupOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}

recovery_check_current:
  IfFileExists "$INSTDIR\*.*" 0 recovery_check_rollback
  IfFileExists "$INSTDIR\${INSTALL_MARKER}" 0 recovery_unsafe_current
  StrCpy $CleanupTarget "$INSTDIR"
  StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
  Call ValidateOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_unsafe_current
  ${EndIf}

recovery_check_rollback:
  IfFileExists "$RollbackDir\*.*" 0 recovery_pending_without_rollback
  IfFileExists "$RollbackDir\${INSTALL_MARKER}" 0 recovery_unsafe_rollback
  StrCpy $CleanupTarget "$RollbackDir"
  StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
  Call ValidateOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_unsafe_rollback
  ${EndIf}
  IfFileExists "$INSTDIR\*.*" recovery_current_and_rollback recovery_restore_only

recovery_restore_only:
  Rename "$RollbackDir" "$INSTDIR"
  IfErrors recovery_failed
  Goto recovery_done

recovery_current_and_rollback:
  IfFileExists "$INSTDIR\${TRANSACTION_MARKER}" recovery_restore_interrupted recovery_cleanup_committed_rollback

recovery_restore_interrupted:
  Call StopInstalledEngine
  StrCpy $CleanupTarget "$INSTDIR"
  StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
  Call CleanupOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}
  StrCpy $CleanupTarget "$RollbackDir"
  StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
  Call ValidateOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}
  Rename "$RollbackDir" "$INSTDIR"
  IfErrors recovery_failed
  Goto recovery_done

recovery_cleanup_committed_rollback:
  StrCpy $CleanupTarget "$RollbackDir"
  StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
  Call CleanupOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}
  Goto recovery_done

recovery_pending_without_rollback:
  IfFileExists "$INSTDIR\${TRANSACTION_MARKER}" 0 recovery_done
  Call StopInstalledEngine
  StrCpy $CleanupTarget "$INSTDIR"
  StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
  Call CleanupOwnedTree
  ${If} $CleanupExit != 0
    Goto recovery_failed
  ${EndIf}
  Goto recovery_done

recovery_unsafe_stage:
  MessageBox MB_OK|MB_ICONSTOP "이전 임시 설치 폴더의 소유권을 확인할 수 없어 설치를 중단했습니다."
  Goto recovery_abort
recovery_unsafe_current:
  MessageBox MB_OK|MB_ICONSTOP "설치 위치에 이 설치 프로그램이 만들지 않은 파일이 있어 덮어쓰지 않았습니다."
  Goto recovery_abort
recovery_unsafe_rollback:
  MessageBox MB_OK|MB_ICONSTOP "이전 복구 폴더의 소유권을 확인할 수 없어 설치를 중단했습니다."
  Goto recovery_abort
recovery_failed:
  MessageBox MB_OK|MB_ICONSTOP "이전 설치의 복구 상태를 안전하게 확인하지 못했습니다. 설치 파일을 변경하지 않고 중단했습니다."
recovery_abort:
  SetErrorLevel 30
  Abort
recovery_done:
FunctionEnd

Function .onInit
  SetShellVarContext current
  Call AcquireInstallerMutex
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Barorok\LocalEngine"
  StrCpy $StageDir "$LOCALAPPDATA\Programs\Barorok\.LocalEngine-stage"
  StrCpy $RollbackDir "$LOCALAPPDATA\Programs\Barorok\.LocalEngine-rollback"
  StrCpy $EngineExe "$INSTDIR\engine\${ENGINE_EXE_NAME}"
  StrCpy $RequestGeneration 1
  StrCpy $HadPreviousInstall 0
  StrCpy $PreflightAttempts 0
  StrCpy $PreviousMoved 0
  StrCpy $StageActivated 0

  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=barorok-installer-preflight.exe "${HELPER_PATH}"
  File /oname=poc-manifest.json "${ARTIFACT_DIR}\poc-manifest.json"
  StrCpy $PreflightResult "$PLUGINSDIR\preflight-result.json"
  StrCpy $PreflightDecision "$PLUGINSDIR\preflight-decision.ini"
  Call RecoverInterruptedTransaction

preflight_retry:
  IntOp $PreflightAttempts $PreflightAttempts + 1
  ${If} $PreflightAttempts > 10
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "실행 중인 음성 분석 프로그램을 종료하지 못했습니다. 잠시 후 다시 실행하고, 계속되면 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
    Abort
  ${EndIf}
  Call RunInstallerPreflight
  ${If} $PreflightExit == 0
    Goto preflight_ready
  ${ElseIf} $PreflightExit == 10
    ${If} $PreflightAction == "stop_local_engine_and_retry"
      IfFileExists "$EngineExe" 0 running_engine_missing
      Call StopInstalledEngine
      IntOp $RequestGeneration $RequestGeneration + 1
      Sleep 250
      Goto preflight_retry
    ${EndIf}
    IfSilent preflight_ready
    ${If} $PreflightAction == "free_space_and_retry"
      ${If} $PreflightFreeSpaceDrive == ""
        StrCpy $PreflightFreeSpaceDrive "사용자 폴더가 있는"
      ${EndIf}
      ${If} $PreflightFreeSpaceGb != ""
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "음성 분석에 필요한 모델과 회의 작업 파일을 저장할 공간이 부족합니다.$\r$\n$\r$\n$PreflightFreeSpaceDrive 드라이브에서 약 $PreflightFreeSpaceGb GB를 비워 주세요. 설치는 지금 계속하고, 모델을 받거나 회의를 분석하기 전에 비워도 됩니다.$\r$\n$\r$\n설치를 계속할까요? ‘아니요’를 누르면 설치를 멈춥니다." IDYES preflight_ready
      ${Else}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "음성 분석에 필요한 모델과 회의 작업 파일을 저장할 공간이 부족합니다.$\r$\n$\r$\n$PreflightFreeSpaceDrive 드라이브에서 쓰지 않는 파일을 정리해 주세요. 설치는 지금 계속하고, 모델을 받거나 회의를 분석하기 전에 비워도 됩니다.$\r$\n$\r$\n설치를 계속할까요? ‘아니요’를 누르면 설치를 멈춥니다." IDYES preflight_ready
      ${EndIf}
    ${Else}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "설치 전 점검 중 일부를 마치지 못했습니다. 설치는 계속할 수 있고, 저장 공간은 모델을 받거나 회의를 분석할 때 다시 확인합니다.$\r$\n$\r$\n설치를 계속할까요?" IDYES preflight_ready
    ${EndIf}
    SetErrorLevel 10
    Abort
  ${ElseIf} $PreflightExit == 20
    SetErrorLevel 20
    ${If} $PreflightAction == "close_conflicting_app_and_retry"
      MessageBox MB_OK|MB_ICONSTOP "다른 프로그램이 음성 분석 프로그램의 연결(포트 17863)을 쓰고 있습니다. ${BRAND_NAME} 데스크톱 앱 등 열린 프로그램을 닫거나 컴퓨터를 다시 시작한 뒤 다시 실행해 주세요."
    ${ElseIf} $PreflightAction == "free_space_and_retry"
      ${If} $PreflightFreeSpaceDrive == ""
        StrCpy $PreflightFreeSpaceDrive "사용자 폴더가 있는"
      ${EndIf}
      ${If} $PreflightFreeSpaceGb != ""
        MessageBox MB_OK|MB_ICONSTOP "설치와 복구에 필요한 저장 공간이 부족합니다. $PreflightFreeSpaceDrive 드라이브에서 약 $PreflightFreeSpaceGb GB를 비운 뒤 설치 파일을 다시 실행해 주세요."
      ${Else}
        MessageBox MB_OK|MB_ICONSTOP "설치와 복구에 필요한 저장 공간이 부족합니다. 공간을 확보한 뒤 설치 파일을 다시 실행해 주세요."
      ${EndIf}
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "설치 폴더에 안전하게 쓰고 정리할 수 없습니다. 폴더 권한을 확인한 뒤 다시 실행해 주세요."
    ${EndIf}
    Abort
  ${ElseIf} $PreflightExit == 30
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "설치 환경을 확인하지 못했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 문의해 주세요."
    Abort
  ${ElseIf} $PreflightExit == "launch_failed"
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "설치 점검 도구를 실행하지 못했습니다. 백신 프로그램이 설치 파일을 차단했는지 확인한 뒤 다시 실행해 주세요."
    Abort
  ${Else}
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "설치 전 점검 결과를 확인하지 못했습니다. 설치 파일을 다시 받아 실행해 주세요."
    Abort
  ${EndIf}

running_engine_missing:
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "실행 중인 음성 분석 프로그램의 설치 파일을 찾지 못했습니다. 프로그램을 정상 종료한 뒤 다시 실행해 주세요."
  Abort

preflight_ready:
FunctionEnd

Section "Install"
  SetShellVarContext current
  Call StopInstalledEngine

detect_previous:
  IfFileExists "$INSTDIR\*.*" 0 create_stage
  IfFileExists "$INSTDIR\${INSTALL_MARKER}" 0 unsafe_existing_install
  StrCpy $CleanupTarget "$INSTDIR"
  StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
  Call ValidateOwnedTree
  ${If} $CleanupExit != 0
    Goto unsafe_existing_install
  ${EndIf}
  StrCpy $HadPreviousInstall 1

create_stage:
  CreateDirectory "$LOCALAPPDATA\Programs\Barorok"
  CreateDirectory "$StageDir"
  SetOutPath "$StageDir"
  ClearErrors
  FileOpen $0 "$StageDir\${INSTALL_MARKER}" w
  IfErrors stage_failed
  FileWrite $0 "barorok-local-engine-v1"
  IfErrors stage_failed
  FileClose $0
  IfErrors stage_failed
  ClearErrors
  FileOpen $0 "$StageDir\${TRANSACTION_MARKER}" w
  IfErrors stage_failed
  FileWrite $0 "pending"
  IfErrors stage_failed
  FileClose $0
  IfErrors stage_failed
  File /r /x "poc-manifest.json" "${ARTIFACT_DIR}\*.*"
  IfErrors stage_failed
  File /oname=poc-manifest.json "${ARTIFACT_DIR}\poc-manifest.json"
  IfErrors stage_failed
  SetOutPath "$StageDir\installer"
  File /oname=barorok-installer-preflight.exe "${HELPER_PATH}"
  IfErrors stage_failed
  SetOutPath "$StageDir"
  WriteUninstaller "$StageDir\Uninstall.exe"
  IfErrors stage_failed
  IfFileExists "$StageDir\engine\${ENGINE_EXE_NAME}" 0 stage_failed
  SetOutPath "$PLUGINSDIR"
  StrCpy $CleanupTarget "$StageDir"
  StrCpy $CleanupManifest "$StageDir\poc-manifest.json"
  Call ValidateCompleteStage
  ${If} $CleanupExit != 0
    Goto stage_failed
  ${EndIf}

  ${If} $HadPreviousInstall == 1
    StrCpy $CleanupTarget "$INSTDIR"
    StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
    Call ValidateOwnedTree
    ${If} $CleanupExit != 0
      Goto unsafe_existing_install
    ${EndIf}
    Rename "$INSTDIR" "$RollbackDir"
    IfErrors swap_failed
    StrCpy $PreviousMoved 1
  ${EndIf}
  StrCpy $CleanupTarget "$StageDir"
  StrCpy $CleanupManifest "$StageDir\poc-manifest.json"
  Call ValidateCompleteStage
  ${If} $CleanupExit != 0
    Goto swap_failed
  ${EndIf}
  Rename "$StageDir" "$INSTDIR"
  IfErrors swap_failed
  StrCpy $StageActivated 1

  Exec '"$EngineExe"'
  StrCpy $ReadinessAttempts 0
readiness_retry:
  IntOp $ReadinessAttempts $ReadinessAttempts + 1
  ClearErrors
  ExecWait '"$PLUGINSDIR\barorok-installer-preflight.exe" --probe-running-engine --manifest "$PLUGINSDIR\poc-manifest.json"' $0
  IfErrors 0 +2
  StrCpy $0 "launch_failed"
  ${If} $0 == 0
    Goto readiness_ready
  ${EndIf}
  ${If} $ReadinessAttempts >= 60
    Goto readiness_failed
  ${EndIf}
  Sleep 500
  Goto readiness_retry

readiness_ready:
  ClearErrors
  Delete "$INSTDIR\${TRANSACTION_MARKER}"
  IfErrors readiness_failed
  IfFileExists "$RollbackDir\${INSTALL_MARKER}" 0 shortcuts
  StrCpy $CleanupTarget "$RollbackDir"
  StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
  Call CleanupOwnedTree
  ${If} $CleanupExit != 0
    Goto rollback_cleanup_warning
  ${EndIf}
  Goto shortcuts

rollback_cleanup_warning:
  MessageBox MB_OK|MB_ICONEXCLAMATION "새 버전을 설치했지만 이전 버전 백업 파일을 정리하지 못했습니다. 다음 설치 때 다시 정리합니다."
  Goto shortcuts

shortcuts:
  CreateDirectory "$SMPROGRAMS\${START_MENU_DIR}"
  ; The web app tells users to run "<brand> 연결" from the Start menu.
  !insertmacro RemoveRecordedConnectShortcut
  ; Every fixed name carries the product name, because "음성 분석" is a common
  ; folder name another program might also use.
  CreateShortcut "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 시작.lnk" "$EngineExe"
  CreateShortcut "$SMPROGRAMS\${START_MENU_DIR}\${BRAND_NAME} 연결.lnk" "$EngineExe" "--pair"
  CreateShortcut "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 종료.lnk" "$EngineExe" "--stop"
  CreateShortcut "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 제거.lnk" "$INSTDIR\Uninstall.exe"
  ; Remove the old folder only after the new shortcuts exist.
  !insertmacro RemoveLegacyStartMenuEntries
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayVersion" "${ENGINE_VERSION}"
  WriteRegStr HKCU "${PRODUCT_KEY}" "Publisher" "${BRAND_NAME}"
  WriteRegStr HKCU "${PRODUCT_KEY}" "ConnectShortcut" "${BRAND_NAME} 연결.lnk"
  WriteRegStr HKCU "${PRODUCT_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoRepair" 1
  Goto install_done

readiness_failed:
  ExecWait '"$EngineExe" --stop' $0
  Call WaitForEngineStopped
  ${If} $StageActivated == 1
    StrCpy $CleanupTarget "$INSTDIR"
    StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
    Call CleanupOwnedTree
    ${If} $CleanupExit != 0
      Goto recovery_failed
    ${EndIf}
  ${EndIf}
  ${If} $PreviousMoved == 1
    StrCpy $CleanupTarget "$RollbackDir"
    StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
    Call ValidateOwnedTree
    ${If} $CleanupExit != 0
      Goto recovery_failed
    ${EndIf}
    Rename "$RollbackDir" "$INSTDIR"
    IfErrors recovery_failed
    IfFileExists "$EngineExe" 0 +2
    Exec '"$EngineExe"'
  ${EndIf}
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "새로 설치한 음성 분석 프로그램이 정상적으로 시작되지 않아 설치를 되돌렸습니다. 기존 데이터는 보존했습니다."
  Abort

swap_failed:
  ${If} $StageActivated == 1
    StrCpy $CleanupTarget "$INSTDIR"
    StrCpy $CleanupManifest "$INSTDIR\poc-manifest.json"
    Call CleanupOwnedTree
  ${EndIf}
  ${If} $PreviousMoved == 1
    StrCpy $CleanupTarget "$RollbackDir"
    StrCpy $CleanupManifest "$RollbackDir\poc-manifest.json"
    Call ValidateOwnedTree
    ${If} $CleanupExit != 0
      Goto recovery_failed
    ${EndIf}
    Rename "$RollbackDir" "$INSTDIR"
    IfErrors recovery_failed
  ${EndIf}
stage_failed:
  IfFileExists "$StageDir\${INSTALL_MARKER}" 0 install_failed_message
  StrCpy $CleanupTarget "$StageDir"
  StrCpy $CleanupManifest "$PLUGINSDIR\poc-manifest.json"
  IfFileExists "$StageDir\poc-manifest.json" 0 +2
  StrCpy $CleanupManifest "$StageDir\poc-manifest.json"
  Call CleanupOwnedTree
install_failed_message:
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "설치 파일을 안전하게 배치하지 못했습니다. 이전 설치는 보존되었습니다."
  Abort

recovery_failed:
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "이전 설치의 복구 상태를 안전하게 확인하지 못했습니다. 설치 파일을 변경하지 않고 중단했습니다."
  Abort

unsafe_existing_install:
  SetErrorLevel 20
  MessageBox MB_OK|MB_ICONSTOP "설치 위치에 이 설치 프로그램이 만들지 않은 파일이 있어 덮어쓰지 않았습니다."
  Abort
unsafe_rollback:
  SetErrorLevel 20
  MessageBox MB_OK|MB_ICONSTOP "이전 복구 폴더의 소유권을 확인할 수 없어 설치를 중단했습니다."
  Abort
unsafe_stage:
  SetErrorLevel 20
  MessageBox MB_OK|MB_ICONSTOP "이전 임시 설치 폴더의 소유권을 확인할 수 없어 설치를 중단했습니다."
  Abort

install_done:
SectionEnd

Function un.onInit
  SetShellVarContext current
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALLER_MUTEX}") p.r0'
  StrCpy $InstallerMutex $0
  System::Call 'kernel32::GetLastError() i.r1'
  ${If} $InstallerMutex == 0
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "제거 잠금을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
    Abort
  ${EndIf}
  ${If} $1 == 183
    SetErrorLevel 20
    MessageBox MB_OK|MB_ICONSTOP "다른 설치 또는 제거가 진행 중입니다. 완료된 뒤 다시 실행해 주세요."
    Abort
  ${EndIf}
FunctionEnd

Function un.onGUIEnd
  ${If} $InstallerMutex != 0
    System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
  ${EndIf}
FunctionEnd

Function un.WaitForEngineStopped
  StrCpy $0 0
un_wait_retry:
  IntOp $0 $0 + 1
  ClearErrors
  ExecWait '"$InstalledHelper" --probe-stopped-engine' $1
  IfErrors 0 +2
  StrCpy $1 "launch_failed"
  ${If} $1 == 0
    Return
  ${EndIf}
  ${If} $0 >= 20
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "음성 분석 프로그램 종료가 완료되지 않아 제거를 중단했습니다."
    Abort
  ${EndIf}
  Sleep 250
  Goto un_wait_retry
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCpy $EngineExe "$INSTDIR\engine\${ENGINE_EXE_NAME}"
  StrCpy $InstalledHelper "$INSTDIR\installer\barorok-installer-preflight.exe"
  IfFileExists "$INSTDIR\${INSTALL_MARKER}" 0 unsafe_uninstall
  IfFileExists "$InstalledHelper" 0 unsafe_uninstall
  IfFileExists "$EngineExe" 0 remove_program
  ExecWait '"$EngineExe" --stop' $0
  ${If} $0 != 0
  ${AndIf} $0 != 3
    SetErrorLevel 30
    MessageBox MB_OK|MB_ICONSTOP "음성 분석 프로그램을 안전하게 종료하지 못해 제거를 중단했습니다."
    Abort
  ${EndIf}
  Call un.WaitForEngineStopped

remove_program:
  ClearErrors
  ExecWait '"$InstalledHelper" --cleanup-owned-tree "$INSTDIR" --manifest "$INSTDIR\poc-manifest.json" --preserve-self-removal-files' $0
  IfErrors 0 +2
  StrCpy $0 "launch_failed"
  ${If} $0 != 0
    SetErrorLevel 20
    MessageBox MB_OK|MB_ICONSTOP "설치 폴더에 이 설치 프로그램이 만들지 않은 파일이 있어 제거를 멈췄습니다. 그 파일을 옮긴 뒤 다시 시도해 주세요."
    Abort
  ${EndIf}
  ClearErrors
  FileOpen $0 "$INSTDIR\${UNINSTALL_MARKER}" w
  IfErrors uninstall_cleanup_failed
  FileWrite $0 "barorok-local-engine-uninstall-v1"
  IfErrors uninstall_cleanup_failed
  FileClose $0
  IfErrors uninstall_cleanup_failed
  ClearErrors
  Delete "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 시작.lnk"
  !insertmacro RemoveRecordedConnectShortcut
  Delete "$SMPROGRAMS\${START_MENU_DIR}\${BRAND_NAME} 연결.lnk"
  Delete "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 종료.lnk"
  Delete "$SMPROGRAMS\${START_MENU_DIR}\음성 분석 제거.lnk"
  RMDir "$SMPROGRAMS\${START_MENU_DIR}"
  !insertmacro RemoveLegacyStartMenuEntries
  ClearErrors
  IfFileExists "$INSTDIR\${TRANSACTION_MARKER}" 0 +2
  Delete "$INSTDIR\${TRANSACTION_MARKER}"
  IfErrors uninstall_cleanup_failed
  Delete "$INSTDIR\poc-manifest.json"
  IfErrors uninstall_cleanup_failed
  Delete "$INSTDIR\${INSTALL_MARKER}"
  IfErrors uninstall_cleanup_failed
  Delete "$INSTDIR\installer\barorok-installer-preflight.exe"
  IfErrors uninstall_cleanup_failed
  RMDir "$INSTDIR\installer"
  IfErrors uninstall_cleanup_failed
  Delete "$INSTDIR\Uninstall.exe"
  IfErrors uninstall_cleanup_failed
  Delete "$INSTDIR\${UNINSTALL_MARKER}"
  IfErrors uninstall_cleanup_failed
  RMDir "$INSTDIR"
  IfErrors restore_uninstall_tombstone
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  RMDir "$LOCALAPPDATA\Programs\Barorok"
  MessageBox MB_OK|MB_ICONINFORMATION "프로그램을 제거했습니다. 모델과 회의 기록 등 사용자 데이터는 보존했습니다."
  Goto uninstall_done

uninstall_cleanup_failed:
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "프로그램 파일 정리를 완료하지 못했습니다. 사용자 데이터는 삭제하지 않았습니다."
  Abort

restore_uninstall_tombstone:
  ClearErrors
  FileOpen $0 "$INSTDIR\${UNINSTALL_MARKER}" w
  IfErrors uninstall_tombstone_restore_failed
  FileWrite $0 "barorok-local-engine-uninstall-v1"
  IfErrors uninstall_tombstone_restore_failed
  FileClose $0
  IfErrors uninstall_tombstone_restore_failed
  Goto uninstall_cleanup_failed

uninstall_tombstone_restore_failed:
  SetErrorLevel 30
  MessageBox MB_OK|MB_ICONSTOP "제거 재시도 표시를 복구하지 못했습니다. 사용자 데이터는 삭제하지 않았습니다. 설치 프로그램을 다시 실행해 복구해 주세요."
  Abort

unsafe_uninstall:
  SetErrorLevel 20
  MessageBox MB_OK|MB_ICONSTOP "설치 폴더의 소유권을 확인할 수 없어 사용자 파일 보호를 위해 제거를 중단했습니다."
  Abort
uninstall_done:
SectionEnd
