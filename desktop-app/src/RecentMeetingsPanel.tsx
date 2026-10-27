import React, { useMemo } from 'react';
import { FileAudio, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from './components/common';
import { isTauriRuntime } from './apiBase';
import { toUserFacingAnalysisError } from './apiError';
import {
    requestAnalysisRecoverySync,
    useAnalysisResumeSnapshot,
} from './analysisResumeState';
import { createStartWorkspaceModel } from './startWorkspaceModel';

interface RecentMeetingsPanelProps {
    onResumeDraft: (jobId: string) => void;
    newMeetingBlocked?: boolean;
}

/** The new-record companion contains only resumable-analysis recovery; saved meetings live in the sidebar. */
export const RecentMeetingsPanel: React.FC<RecentMeetingsPanelProps> = ({ onResumeDraft, newMeetingBlocked = false }) => {
    const recoverySnapshot = useAnalysisResumeSnapshot();
    const model = useMemo(
        () => createStartWorkspaceModel([], recoverySnapshot),
        [recoverySnapshot],
    );
    const recoverySyncing = recoverySnapshot.syncStatus === 'syncing';

    const recoveryDraft = model.scene === 'recovery' ? model.recoveryDraft : null;
    const recoveryCard = recoveryDraft && (
        <section className="writer-recovery" aria-labelledby="writer-recovery-label writer-recovery-title">
            <span className="icon-badge" aria-hidden="true"><RotateCcw size={18} /></span>
            <div className="writer-recovery-copy">
                <span id="writer-recovery-label" className="writer-recovery-label">{recoveryDraft.status === 'active' ? '분석 상태 확인 중' : '이어서 할 분석'}</span>
                <h3 id="writer-recovery-title">{recoveryDraft.title || recoveryDraft.sourceFilename}</h3>
                <p>
                    {recoveryDraft.status === 'active'
                        ? '이전 분석이 아직 실행 중입니다. 완료되거나 다시 시작할 수 있는 상태가 되면 알려드릴게요.'
                        : recoveryDraft.errorMessage
                            ? toUserFacingAnalysisError(recoveryDraft.errorMessage, { desktopApp: isTauriRuntime() })
                            : '같은 음성 파일을 선택하면 저장된 진행분부터 이어서 분석합니다.'}
                </p>
                <span className="writer-recovery-meta"><FileAudio size={14} aria-hidden="true" />{recoveryDraft.sourceFilename}</span>
            </div>
            <div className="writer-recovery-actions">
                {model.recoveryAction === 'resume' && (
                    <Button
                        variant="outline"
                        onClick={() => onResumeDraft(recoveryDraft.jobId)}
                        disabled={newMeetingBlocked}
                        aria-describedby={newMeetingBlocked ? 'writer-analysis-start-blocked' : undefined}
                    >
                        이어서 분석
                    </Button>
                )}
                {(model.recoveryAction === 'refresh' || model.recoveryAction === 'wait') && (
                    <Button variant="outline" onClick={requestAnalysisRecoverySync} disabled={recoverySyncing}>
                        {recoverySyncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                        {recoverySyncing ? '확인 중' : model.recoveryAction === 'refresh' ? '다시 확인' : '상태 확인'}
                    </Button>
                )}
            </div>
        </section>
    );

    return recoveryCard;
};
