import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioLines, FileAudio, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import {
    requestAnalysisRecoverySync,
    useAnalysisResumeSnapshot,
} from './analysisResumeState';
import { getAllMeetings, type MeetingRecord } from './meetingRepository';
import { createStartWorkspaceModel } from './startWorkspaceModel';

interface RecentMeetingsPanelProps {
    onOpenMeeting: (id: string) => void;
    onResumeDraft: (jobId: string) => void;
    newMeetingBlocked?: boolean;
}

const RECENT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same basis as the sidebar list: when the meeting was recorded, not when it was last edited or pinned.
const meetingTimestamp = (meeting: MeetingRecord): number => {
    const value = meeting.createdAt || meeting.date || '';
    const timestamp = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const startOfDay = (time: number): number => {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

const groupLabel = (time: number, now: number): string => {
    const today = startOfDay(now);
    if (time >= today) return '오늘';
    if (time >= today - 6 * DAY_MS) return '최근 7일';
    return '이전';
};

const formatRowDate = (time: number, now: number): string => {
    if (!time) return '';
    const date = new Date(time);
    if (time >= startOfDay(now)) {
        return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(date);
    }
    return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(date);
};

/** New-record companion: resumable analysis first, otherwise the most recent meetings (replaces the old start screen). */
export const RecentMeetingsPanel: React.FC<RecentMeetingsPanelProps> = ({ onOpenMeeting, onResumeDraft, newMeetingBlocked = false }) => {
    const recoverySnapshot = useAnalysisResumeSnapshot();
    const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
    const [meetingsError, setMeetingsError] = useState<string | null>(null);
    const [loadedAt, setLoadedAt] = useState(() => Date.now());
    const meetingsRequestRef = React.useRef(0);

    const refreshMeetings = useCallback(async () => {
        const requestId = ++meetingsRequestRef.current;
        try {
            const nextMeetings = await getAllMeetings();
            if (requestId !== meetingsRequestRef.current) return;
            setMeetings(nextMeetings);
            setLoadedAt(Date.now());
            setMeetingsError(null);
        } catch {
            if (requestId !== meetingsRequestRef.current) return;
            setMeetingsError('저장된 회의록을 불러오지 못했습니다.');
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
    const recentGroups = useMemo(() => {
        const now = loadedAt;
        const recent = [...meetings]
            .map(meeting => ({ meeting, time: meetingTimestamp(meeting) }))
            .sort((left, right) => right.time - left.time)
            .slice(0, RECENT_LIMIT);
        const groups: Array<{ label: string; rows: Array<{ meeting: MeetingRecord; dateLabel: string }> }> = [];
        recent.forEach(({ meeting, time }) => {
            const label = groupLabel(time, now);
            const row = { meeting, dateLabel: formatRowDate(time, now) };
            const last = groups[groups.length - 1];
            if (last?.label === label) last.rows.push(row);
            else groups.push({ label, rows: [row] });
        });
        return groups;
    }, [loadedAt, meetings]);
    const recoverySyncing = recoverySnapshot.syncStatus === 'syncing';
    // Hold the recent list until the first recovery check settles so it does not swap into a recovery card.
    const initialRecoveryCheckPending = recoverySnapshot.lastSuccessfulSyncAt === null
        && (recoverySnapshot.syncStatus === 'idle' || recoverySyncing);

    if (model.scene === 'recovery' && model.recoveryDraft) {
        const draft = model.recoveryDraft;
        return (
            <section className="writer-recovery" aria-labelledby="writer-recovery-label writer-recovery-title">
                <span className="icon-badge" aria-hidden="true"><RotateCcw size={18} /></span>
                <div className="writer-recovery-copy">
                    <span id="writer-recovery-label" className="writer-recovery-label">{draft.status === 'active' ? '분석 상태 확인 중' : '이어서 할 기록'}</span>
                    <h3 id="writer-recovery-title">{draft.title || draft.sourceFilename}</h3>
                    <p>
                        {draft.status === 'active'
                            ? '이전 분석이 아직 실행 중입니다. 완료되거나 다시 시작할 수 있는 상태가 되면 알려드릴게요.'
                            : draft.errorMessage || '같은 음성 파일을 선택하면 저장된 진행분부터 이어서 분석합니다.'}
                    </p>
                    <span className="writer-recovery-meta"><FileAudio size={14} aria-hidden="true" />{draft.sourceFilename}</span>
                </div>
                <div className="writer-recovery-actions">
                    {model.recoveryAction === 'resume' && (
                        <Button
                            onClick={() => onResumeDraft(draft.jobId)}
                            disabled={newMeetingBlocked}
                            aria-describedby={newMeetingBlocked ? 'writer-analysis-start-blocked' : undefined}
                        >
                            이어서 기록
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
    }

    if (meetingsError) {
        return (
            <section className="recent-meetings" aria-label="최근 회의록">
                <div className="recent-meetings-error" role="status">
                    <span>{meetingsError}</span>
                    <Button variant="ghost" onClick={() => void refreshMeetings()}>
                        <RefreshCw size={15} />
                        다시 불러오기
                    </Button>
                </div>
            </section>
        );
    }

    if (initialRecoveryCheckPending || !recentGroups.length) return null;

    return (
        <section className="recent-meetings" aria-labelledby="recent-meetings-title">
            <h3 id="recent-meetings-title" className="recent-meetings-title">최근 회의록</h3>
            {recentGroups.map(group => (
                <div key={group.label} className="recent-meetings-group">
                    <div className="recent-meetings-group-label">{group.label}</div>
                    <ul className="recent-meetings-list">
                        {group.rows.map(({ meeting, dateLabel }) => (
                            <li key={meeting.id}>
                                <button type="button" className="recent-meeting-row" onClick={() => onOpenMeeting(meeting.id)}>
                                    <AudioLines size={16} aria-hidden="true" className="recent-meeting-icon" />
                                    <span className="recent-meeting-title">{meeting.title}</span>
                                    <span className="recent-meeting-purpose">{meeting.meetingPurpose?.trim() || ''}</span>
                                    <span className="recent-meeting-date">{dateLabel}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </section>
    );
};
