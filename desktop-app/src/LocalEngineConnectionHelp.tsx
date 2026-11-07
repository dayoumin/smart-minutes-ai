import React from 'react';
import { Button } from './components/common';
import { LOCAL_ENGINE_NAME, withJosa } from './brand';
import { LocalEngineCodeDialog } from './LocalEngineCodeDialog';
import { useLocalEngineConnectionControls } from './useLocalEngineConnectionControls';
import { useUpdateControls } from './UpdateContext';

/** Recovery lives in Settings; first-use browser permission still follows an explicit click. */
interface LocalEngineConnectionHelpProps {
    onReturnToWriter: () => void;
    onRequestSupport: () => void;
    preparationReady: boolean;
    remainingIssue?: { title: string; description: string; actionLabel: string; onAction: () => void };
    requiresReinstall?: boolean;
    loadError?: string;
    onRetrySettings: () => void;
    checkingSettings: boolean;
}

export const LocalEngineConnectionHelp: React.FC<LocalEngineConnectionHelpProps> = ({ onReturnToWriter, onRequestSupport, preparationReady, remainingIssue, requiresReinstall = false, loadError, onRetrySettings, checkingSettings }) => {
    const controls = useLocalEngineConnectionControls({ connectionRequested: true });
    const { openGuide } = useUpdateControls();
    const { view, installerUrl, updateUrl } = controls;
    const updateNeeded = view.scene === 'update-required' || view.primaryAction === 'update';
    const repairRequired = view.analysisReady && requiresReinstall;
    const loadFailed = view.analysisReady && Boolean(loadError) && !repairRequired;
    const downloadUrl = repairRequired ? installerUrl ?? updateUrl : updateNeeded ? updateUrl : installerUrl;
    const distributionNeeded = (!view.analysisReady || repairRequired)
        && (view.scene !== 'browser-blocked' || view.secondaryAction === 'download');
    const installationUnavailable = distributionNeeded && !downloadUrl
        && (repairRequired || updateNeeded || ['intro', 'unreachable', 'invalid-response', 'browser-blocked'].includes(view.scene));
    return <>
        <div className="settings-list">
            <div className="settings-row">
                <span className="settings-row-copy">
                    <span className="settings-row-title">{repairRequired ? '필수 모델 파일 복구' : loadFailed ? '설정을 확인하지 못했습니다' : view.analysisReady ? remainingIssue?.title || (preparationReady ? '연결이 확인되었습니다' : '분석 준비 확인 중') : view.title}</span>
                    <span className="settings-row-description">
                        {repairRequired ? `필수 모델 파일이 없습니다. ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.` : loadFailed ? loadError : view.analysisReady ? remainingIssue?.description || (preparationReady ? '작성 화면에서 계속할 수 있습니다.' : '연결은 확인됐습니다. 분석에 필요한 상태를 확인하고 있습니다.') : view.help || view.message}
                    </span>
                </span>
                {repairRequired ? null : loadFailed
                    ? <Button variant="outline" onClick={onRetrySettings} disabled={checkingSettings}>
                        {checkingSettings ? '확인 중' : '다시 확인'}
                    </Button>
                    : view.analysisReady
                    ? remainingIssue
                        ? <Button variant="outline" onClick={remainingIssue.onAction}>{remainingIssue.actionLabel}</Button>
                        : preparationReady ? <Button variant="outline" onClick={onReturnToWriter}>작성 화면으로 돌아가기</Button> : null
                    : view.primaryAction && !['download', 'update'].includes(view.primaryAction)
                        ? <Button variant="outline" disabled={view.primaryDisabled || view.busy}
                            onClick={() => { if (view.primaryAction) void controls.runAction(view.primaryAction); }}>
                            {view.primaryLabel}
                        </Button>
                        : null}
            </div>
            {distributionNeeded && <>
                {downloadUrl && <div className="settings-row">
                    <span className="settings-row-copy">
                        <span className="settings-row-title">{repairRequired ? '연결 프로그램 다시 설치' : updateNeeded ? '업데이트' : '연결 프로그램 설치'}</span>
                    </span>
                    <Button variant="outline" onClick={() => openGuide(updateNeeded && !repairRequired ? 'update' : 'install')}>
                        {updateNeeded && !repairRequired ? '업데이트 안내' : '설치 안내'}
                    </Button>
                </div>}
                {installationUnavailable && <div className="settings-row">
                    <span className="settings-row-copy">
                        <span className="settings-row-title">{updateNeeded ? '업데이트 파일 안내' : '설치 파일 안내'}</span>
                        <span className="settings-row-description">설치 파일 받는 방법을 문의해 주세요.</span>
                    </span>
                    <Button variant="outline" onClick={onRequestSupport}>설치 파일 문의</Button>
                </div>}
            </>}
        </div>
        {controls.codeDialogOpen && <LocalEngineCodeDialog onClose={controls.closeCodeDialog} />}
    </>;
};
