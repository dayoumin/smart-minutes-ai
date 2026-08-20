import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, FileAudio, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import {
    requestAnalysisRecoverySync,
    useAnalysisResumeSnapshot,
} from './analysisResumeState';
import { getAllMeetings, type MeetingRecord } from './meetingRepository';
import { createStartWorkspaceModel } from './startWorkspaceModel';

interface StartWorkspaceProps {
    onCreateMeeting: () => void;
    onOpenMeeting: (id: string) => void;
    onResumeDraft: (jobId: string) => void;
    analysisActive?: boolean;
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
}

const START_ASSURANCES = [
    {
        label: '내 PC에서 보관',
        detail: '회의록과 분석 결과는 이 PC에 보관됩니다.',
    },
    {
        label: '영상·음성 파일 지원',
        detail: '회의가 끝난 뒤 영상이나 음성 파일을 가져와도 됩니다.',
    },
    {
        label: '대화록과 회의 요약',
        detail: '분석이 끝나면 대화록과 회의 요약을 함께 정리합니다.',
    },
] as const;

const formatMeetingDate = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '날짜 미정';
    return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
};

const meetingPreview = (meeting: MeetingRecord): string => {
    const summary = meeting.summary?.replace(/\s+/g, ' ').trim();
    if (summary) return summary;
    if (meeting.meetingPurpose?.trim()) return meeting.meetingPurpose.trim();
    return '정리된 회의 기록을 열어 대화록과 회의 요약을 확인하세요.';
};

const primaryButtonContent = (label: string, icon: React.ReactNode) => (
    <>
        <span
            className="start-primary-tail"
            aria-hidden="true"
        />
        <span className="start-primary-label">{icon}<span className="start-primary-label-text">{label}</span></span>
    </>
);

export const StartWorkspace: React.FC<StartWorkspaceProps> = ({ onCreateMeeting, onOpenMeeting, onResumeDraft, analysisActive = false, newMeetingBlocked = false, newMeetingBlockedReason = '진행 중인 분석이 끝나면 새 기록을 만들 수 있습니다.' }) => {
    const recoverySnapshot = useAnalysisResumeSnapshot();
    const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
    const [meetingsLoaded, setMeetingsLoaded] = useState(false);
    const [meetingsError, setMeetingsError] = useState<string | null>(null);
    const meetingsRequestRef = React.useRef(0);

    const refreshMeetings = useCallback(async () => {
        const requestId = ++meetingsRequestRef.current;
        try {
            const nextMeetings = await getAllMeetings();
            if (requestId !== meetingsRequestRef.current) return;
            setMeetings(nextMeetings);
            setMeetingsError(null);
        } catch {
            if (requestId !== meetingsRequestRef.current) return;
            setMeetingsError('저장된 회의록을 불러오지 못했습니다.');
        } finally {
            if (requestId === meetingsRequestRef.current) setMeetingsLoaded(true);
        }
    }, []);

    useEffect(() => {
        void refreshMeetings();
        const handleMeetingsUpdated = () => void refreshMeetings();
        window.addEventListener('meetings:updated', handleMeetingsUpdated);
        return () => window.removeEventListener('meetings:updated', handleMeetingsUpdated);
    }, [refreshMeetings]);

    const model = useMemo(
        () => createStartWorkspaceModel(meetings, recoverySnapshot),
        [meetings, recoverySnapshot],
    );
    const initialLoading = !meetingsLoaded
        || (
            recoverySnapshot.lastSuccessfulSyncAt === null
            && (recoverySnapshot.syncStatus === 'idle' || recoverySnapshot.syncStatus === 'syncing')
        );

    const recoverySyncing = recoverySnapshot.syncStatus === 'syncing';

    return (
        <section className="start-workspace" aria-labelledby="start-workspace-title" aria-busy={initialLoading || recoverySyncing}>
            <div className={`start-workspace-panel start-scene-${model.scene}`}>
                <div className="start-workspace-heading">
                    <h1 id="start-workspace-title">말하는 순간부터, 회의록이 됩니다</h1>
                    <p>영상이나 음성 파일을 넣으면 대화록과 회의 요약을 한곳에서 정리합니다.</p>
                </div>

                <div className="start-scene-card" aria-live="polite">
                    {meetingsError && !model.recoveryDraft ? (
                        <div className="start-scene-loading start-scene-load-error">
                            <span>{meetingsError}</span>
                            <button type="button" className="start-secondary-button" onClick={() => void refreshMeetings()}>
                                <RefreshCw size={17} /> 다시 불러오기
                            </button>
                        </div>
                    ) : initialLoading && model.scene !== 'recovery' ? (
                        <div className="start-scene-loading">
                            <Loader2 size={24} className="animate-spin" aria-hidden="true" />
                            <span>저장된 회의 기록을 확인하고 있습니다.</span>
                        </div>
                    ) : model.scene === 'recovery' && model.recoveryDraft ? (
                        <>
                            <div className="start-scene-icon start-scene-icon-recovery"><RotateCcw size={22} /></div>
                            <div className="start-scene-copy">
                                <span className="start-scene-eyebrow">
                                    {model.recoveryDraft.status === 'active' ? '분석 상태 확인 중' : '이어서 할 기록'}
                                </span>
                                <h2>{model.recoveryDraft.title || model.recoveryDraft.sourceFilename}</h2>
                                <p>
                                    {model.recoveryDraft.status === 'active'
                                        ? '이전 분석이 아직 실행 중입니다. 완료되거나 다시 시작할 수 있는 상태가 되면 알려드릴게요.'
                                        : model.recoveryDraft.errorMessage || '같은 음성 파일을 선택하면 저장된 진행분부터 이어서 분석합니다.'}
                                </p>
                                <span className="start-scene-meta"><FileAudio size={15} />{model.recoveryDraft.sourceFilename}</span>
                            </div>
                            <div className="start-scene-actions">
                                {model.recoveryAction === 'resume' && (
                                    <button type="button" className="start-primary-button" onClick={() => onResumeDraft(model.recoveryDraft!.jobId)} disabled={newMeetingBlocked} aria-describedby={newMeetingBlocked ? 'start-new-meeting-blocked' : undefined}>
                                        {primaryButtonContent('이어서 기록', <ArrowRight size={18} />)}
                                    </button>
                                )}
                                {model.recoveryAction === 'refresh' && (
                                    <button type="button" className="start-secondary-button" onClick={requestAnalysisRecoverySync} disabled={recoverySyncing}>
                                        {recoverySyncing ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />} {recoverySyncing ? '확인 중' : '다시 확인'}
                                    </button>
                                )}
                                {model.recoveryAction === 'wait' && (
                                    <button type="button" className="start-secondary-button" onClick={requestAnalysisRecoverySync} disabled={recoverySyncing}>
                                        {recoverySyncing ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}
                                        {recoverySyncing ? '확인 중' : '상태 확인'}
                                    </button>
                                )}
                                <button type="button" className="start-text-button" onClick={onCreateMeeting} disabled={newMeetingBlocked} aria-describedby={newMeetingBlocked ? 'start-new-meeting-blocked' : undefined}>{analysisActive ? '진행 중인 분석 보기' : '새 기록 만들기'}</button>
                            </div>
                        </>
                    ) : model.scene === 'recent' && model.recentMeeting ? (
                        <>
                            <div className="start-scene-icon"><CalendarDays size={22} /></div>
                            <div className="start-scene-copy">
                                <span className="start-scene-eyebrow">최근 회의록</span>
                                <h2>{model.recentMeeting.title}</h2>
                                <p>{meetingPreview(model.recentMeeting)}</p>
                                <span className="start-scene-meta"><CalendarDays size={15} />{formatMeetingDate(model.recentMeeting.date)}</span>
                            </div>
                            <div className="start-scene-actions">
                                <button type="button" className="start-primary-button" onClick={() => onOpenMeeting(model.recentMeeting!.id)}>
                                    {primaryButtonContent('회의록 열기', <ArrowRight size={17} />)}
                                </button>
                                <button type="button" className="start-text-button" onClick={onCreateMeeting} disabled={newMeetingBlocked} aria-describedby={newMeetingBlocked ? 'start-new-meeting-blocked' : undefined}>{analysisActive ? '진행 중인 분석 보기' : '새 기록 만들기'}</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="start-scene-icon"><FileAudio size={22} /></div>
                            <div className="start-scene-copy">
                                <h2>저장된 회의록이 없습니다</h2>
                            </div>
                            <div className="start-scene-actions">
                                <button type="button" className="start-primary-button" onClick={onCreateMeeting} disabled={newMeetingBlocked} aria-describedby={newMeetingBlocked ? 'start-new-meeting-blocked' : undefined}>
                                    {primaryButtonContent(analysisActive ? '진행 중인 분석 보기' : '새 기록', analysisActive ? <ArrowRight size={18} /> : null)}
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {newMeetingBlocked && (
                    <p id="start-new-meeting-blocked" className="start-workspace-blocked-note" role="status">
                        {newMeetingBlockedReason}
                    </p>
                )}

                <div className="start-workspace-assurance" aria-label="제품 특징">
                    {START_ASSURANCES.map((assurance, index) => {
                        const tooltipId = `start-assurance-tooltip-${index}`;
                        return (
                            <span
                                key={assurance.label}
                                className="start-assurance-item"
                                tabIndex={0}
                                aria-describedby={tooltipId}
                            >
                                {assurance.label}
                                <span id={tooltipId} role="tooltip" className="start-assurance-tooltip">
                                    {assurance.detail}
                                </span>
                            </span>
                        );
                    })}
                </div>
            </div>
        </section>
    );
};
