import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronDown, ChevronUp, Clock3, Loader2, MoreVertical, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, AnalysisResumeDraft, listAnalysisResumeDrafts } from './analysisResumeDrafts';
import { deleteMeeting, getAllMeetings, MeetingRecord, updateMeeting } from './meetingRepository';
import { toApiUrl } from './apiBase';
import { ProgressBar } from './ProgressBar';
import { formatAnalysisDuration, formatTranscriptReadyEstimate, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';

export interface SidebarProps {
    activeTab?: string;
    selectedMeetingId?: string | null;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string) => void;
    onSelectResumeDraft?: (jobId: string) => void;
    onOpenAsrBenchmark?: () => void;
    analysisStatus?: {
        active: boolean;
        progress: number;
        message: string;
        rawMessage?: string;
        startedAt?: number | null;
        stalled?: boolean;
        transcriptReady?: boolean;
    };
}

const getChunkProgress = (message: string): { current: number; total: number } | null => {
    const match = message.trim().match(/^Transcribing chunk (\d+)\/(\d+)/);
    if (!match) return null;
    return {
        current: Number(match[1]),
        total: Number(match[2]),
    };
};

const formatSidebarStatus = (message: string): string => {
    const baseMessage = (message || '분석 시작 중')
        .replace(' 같은 단계가 오래 걸리고 있습니다. 진행이 바뀌지 않으면 취소 후 다시 시도해 주세요.', '');
    const chunk = getChunkProgress(baseMessage);
    if (chunk) return `음성 인식 ${chunk.current}/${chunk.total} 처리 중`;
    const statusMap: Record<string, string> = {
        '업로드 파일 저장 완료': '파일 저장 완료',
        '음성 인식 모델 확인 중': '모델 확인 중',
        '음성 인식 모델 준비 완료': '모델 준비 완료',
        'Converting to WAV...': '음성 추출 중',
        'Preparing audio chunks...': '구간 나누는 중',
        '음성 인식이 완료되었습니다. 후처리를 준비하고 있습니다.': '후처리 준비 중',
        'Speaker Diarization & Alignment...': '참석자 구분 중',
        '화자 구간 분석 완료. 문장 시간과 맞추는 중': '참석자 구간 확인 완료. 문장 시간과 맞추는 중',
        'Summarizing with Local LLM...': '요약 정리 중',
        'Saving results...': '저장 중',
    };
    return statusMap[baseMessage] || baseMessage;
};

const isVisibleResumeDraft = (draft: AnalysisResumeDraft): boolean => (
    draft.status === 'active'
    || (draft.status !== 'completed' && draft.status !== 'unavailable' && draft.resumeEligible !== false)
);

const getSidebarResumeDraftStatus = (draft: AnalysisResumeDraft): string => {
    if (draft.status === 'active') return '진행 중';
    if (draft.resumeEligible === false) return '이어하기 불가';
    if (draft.status === 'stopped') return '중단됨';
    if (draft.status === 'cancelled') return '사용자 취소';
    if (draft.status === 'failed') return '실패';
    return '이어하기 가능';
};

const getSidebarResumeDraftTone = (draft: AnalysisResumeDraft): 'info' | 'warning' | 'error' | 'neutral' => {
    if (draft.status === 'active') return 'info';
    if (draft.status === 'failed') return 'error';
    if (draft.resumeEligible === false) return 'warning';
    if (draft.status === 'cancelled' || draft.status === 'stopped') return 'warning';
    return 'info';
};

const formatResumeDraftUpdatedAt = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
};

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, selectedMeetingId, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenAsrBenchmark, analysisStatus }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [resumeDrafts, setResumeDrafts] = useState<AnalysisResumeDraft[]>([]);
    const [showResumeDrafts, setShowResumeDrafts] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showAllRecords, setShowAllRecords] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const sidebarRef = useRef<HTMLElement | null>(null);

    const loadRecords = async () => {
        try {
            const data = await getAllMeetings();
            setRecords(data);
        } catch {
            setRecords([]);
        }
    };

    const loadResumeDrafts = () => {
        const drafts = listAnalysisResumeDrafts().filter(isVisibleResumeDraft);
        setResumeDrafts(drafts);
        if (drafts.length === 0) setShowResumeDrafts(false);
    };

    useEffect(() => {
        void loadRecords();
        loadResumeDrafts();
        window.addEventListener('focus', loadRecords);
        window.addEventListener('meetings:updated', loadRecords);
        window.addEventListener('focus', loadResumeDrafts);
        window.addEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, loadResumeDrafts);
        return () => {
            window.removeEventListener('focus', loadRecords);
            window.removeEventListener('meetings:updated', loadRecords);
            window.removeEventListener('focus', loadResumeDrafts);
            window.removeEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, loadResumeDrafts);
        };
    }, []);

    useEffect(() => {
        if (!analysisStatus?.active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [analysisStatus?.active]);

    const sortedRecords = useMemo(
        () => records.slice().sort((a, b) => {
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        }),
        [records],
    );
    const visibleRecords = useMemo(
        () => showAllRecords ? sortedRecords : sortedRecords.slice(0, 10),
        [showAllRecords, sortedRecords],
    );
    const analysisElapsedMs = now - (analysisStatus?.startedAt || now);
    const analysisRawMessage = analysisStatus?.rawMessage || analysisStatus?.message || '';
    const transcriptEstimateLabel = analysisStatus
        ? formatTranscriptReadyEstimate(
            analysisElapsedMs,
            analysisStatus.progress,
            analysisRawMessage || analysisStatus.message,
            analysisStatus.transcriptReady,
        )
        : '';
    const transcriptProgressPercent = analysisStatus
        ? getTranscriptReadyProgressPercent(
            analysisStatus.progress,
            analysisRawMessage || analysisStatus.message,
            analysisStatus.transcriptReady,
        )
        : 0;
    const sidebarEstimateLabel = transcriptEstimateLabel === '대화록 준비됨' || transcriptEstimateLabel === '측정 중'
        ? transcriptEstimateLabel
        : `예상 ${transcriptEstimateLabel}`;

    useEffect(() => {
        const closeMenu = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest('[data-sidebar-record-menu], [data-sidebar-record-menu-trigger]')) return;
            setOpenMenuId(null);
        };
        const closeMenuWithKeyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpenMenuId(null);
        };

        document.addEventListener('pointerdown', closeMenu, true);
        window.addEventListener('keydown', closeMenuWithKeyboard);
        return () => {
            document.removeEventListener('pointerdown', closeMenu, true);
            window.removeEventListener('keydown', closeMenuWithKeyboard);
        };
    }, []);

    const handleSelectRecord = (id: string) => {
        setOpenMenuId(null);
        onSelectMeeting?.(id);
    };

    const handleRenameRecord = async (record: MeetingRecord) => {
        setOpenMenuId(null);
        const nextTitle = window.prompt('회의록 이름 변경', record.title)?.trim();
        if (!nextTitle || nextTitle === record.title) return;
        await updateMeeting({ ...record, title: nextTitle });
        window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
    };

    const handleTogglePinned = async (record: MeetingRecord) => {
        await updateMeeting({ ...record, pinned: !record.pinned });
        setOpenMenuId(null);
        window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
    };

    const handleDeleteRecord = async (record: MeetingRecord) => {
        setOpenMenuId(null);
        if (!window.confirm(`"${record.title}" 회의록을 삭제할까요?\n\n앱 안의 회의 기록과 분석 산출물은 삭제되지만, 다운로드 폴더에 저장한 HWPX/음성 파일은 직접 삭제해야 합니다.`)) return;
        if (record.jobId) {
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(record.jobId)}`), {
                method: 'DELETE',
            }).catch(() => null);
            if (response && !response.ok && response.status !== 404) {
                const detail = await response.json().catch(() => null) as { detail?: string } | null;
                const message = response.status === 409 && detail?.detail === 'analysis_job_active'
                    ? '아직 분석이 진행 중인 회의록입니다. 분석을 중단한 뒤 삭제해 주세요.'
                    : '분석 산출물을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.';
                window.alert(message);
                return;
            }
        }
        await deleteMeeting(record.id);
        window.dispatchEvent(new Event('meetings:updated'));
        onDeleteMeeting?.(record.id);
    };

    return (
        <aside ref={sidebarRef} className="relative z-10 flex max-h-[42vh] shrink-0 flex-col border-b border-border bg-background p-4 lg:h-full lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="mb-3 px-3 pt-1">
                    <span className="text-lg font-semibold text-foreground">회의 기록</span>
                </div>
                <button
                    type="button"
                    className={`sidebar-create-button mb-3 ${activeTab === 'minutes' ? 'sidebar-create-button-active' : ''}`}
                    onClick={() => {
                        setOpenMenuId(null);
                        onCreateMeeting?.();
                    }}
                >
                    새 회의록 작성
                </button>
                {resumeDrafts.length > 0 && !analysisStatus?.active && (
                    <div className="mb-3">
                        <button
                            type="button"
                            className="resume-summary-button w-full status-neutral"
                            aria-expanded={showResumeDrafts}
                            onClick={() => {
                                setOpenMenuId(null);
                                setShowResumeDrafts(current => !current);
                            }}
                        >
                            <span>미완료 분석 기록 {resumeDrafts.length}건</span>
                            {showResumeDrafts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        {showResumeDrafts && (
                            <div className="mt-2 grid gap-1.5">
                                {resumeDrafts.map(draft => {
                                    const tone = getSidebarResumeDraftTone(draft);
                                    return (
                                        <button
                                            key={draft.jobId}
                                            type="button"
                                            className={`sidebar-resume-draft-button status-${tone} text-left`}
                                            onClick={() => {
                                                setOpenMenuId(null);
                                                onSelectResumeDraft?.(draft.jobId);
                                            }}
                                        >
                                            <span className="flex min-w-0 items-center justify-between gap-2">
                                                <span className="truncate font-medium text-foreground">{draft.title || draft.sourceFilename}</span>
                                                <span className={`status-pill status-${tone}`}>{getSidebarResumeDraftStatus(draft)}</span>
                                            </span>
                                            <span className="mt-1 block truncate text-[11px] text-muted-foreground">{draft.sourceFilename}</span>
                                            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                                {formatResumeDraftUpdatedAt(draft.updatedAt)}{draft.lastMessage ? ` · ${formatSidebarStatus(draft.lastMessage)}` : ''}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
                {analysisStatus?.active && (
                    <button
                        type="button"
                        className="sidebar-analysis-card mb-3"
                        onClick={() => onCreateMeeting?.()}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span className="sidebar-analysis-title inline-flex items-center gap-1.5">
                                <Loader2 size={13} className="animate-spin text-primary" />
                                분석 중
                            </span>
                            <span className="sidebar-analysis-elapsed">
                                <Clock3 size={12} />
                                {formatAnalysisDuration(analysisElapsedMs)}
                            </span>
                        </div>
                        <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{formatSidebarStatus(analysisRawMessage)}</span>
                            <span className="shrink-0">{sidebarEstimateLabel}</span>
                        </div>
                        <ProgressBar
                            value={transcriptProgressPercent}
                            size="sm"
                            className="mt-2"
                            decorative
                        />
                    </button>
                )}
                <div className="flex min-h-0 max-h-56 flex-col overflow-y-auto pr-1 custom-scrollbar lg:max-h-none lg:flex-1">
                    {visibleRecords.length ? (
                        visibleRecords.map(record => {
                            const isSelected = selectedMeetingId === record.id;

                            return (
                                <div
                                    key={record.id}
                                    className={`group relative rounded-md transition-colors ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/40'}`}
                                >
                                <div className="flex items-start gap-1 px-2 py-1.5">
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                                        onClick={() => handleSelectRecord(record.id)}
                                        title={record.title}
                                        aria-current={isSelected ? 'page' : undefined}
                                    >
                                        <Pin
                                            size={12}
                                            className={`mt-0.5 shrink-0 ${record.pinned ? 'text-primary' : 'text-transparent'}`}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className={`truncate text-[13px] font-semibold ${isSelected ? 'text-primary' : 'text-foreground'}`}>{record.title}</div>
                                            <div className="truncate text-[11px] text-muted-foreground">{record.date}</div>
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-primary"
                                        onClick={() => setOpenMenuId(openMenuId === record.id ? null : record.id)}
                                        data-sidebar-record-menu-trigger
                                        aria-haspopup="menu"
                                        aria-expanded={openMenuId === record.id}
                                        aria-controls={`sidebar-record-menu-${record.id}`}
                                        title="회의록 메뉴"
                                        aria-label="회의록 메뉴"
                                    >
                                        <MoreVertical size={14} />
                                    </button>
                                </div>
                                {openMenuId === record.id && (
                                    <div id={`sidebar-record-menu-${record.id}`} role="menu" className="menu-panel absolute right-2 top-8 z-20 w-32 text-xs" data-sidebar-record-menu>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="menu-item px-2 py-1.5"
                                            onClick={() => handleTogglePinned(record)}
                                        >
                                            {record.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                            {record.pinned ? '고정 해제' : '상단 고정'}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="menu-item px-2 py-1.5"
                                            onClick={() => handleRenameRecord(record)}
                                        >
                                            <Pencil size={13} />
                                            이름 변경
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="menu-item menu-item-danger px-2 py-1.5"
                                            onClick={() => handleDeleteRecord(record)}
                                        >
                                            <Trash2 size={13} />
                                            삭제
                                        </button>
                                    </div>
                                )}
                                </div>
                            );
                        })
                    ) : (
                        <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            아직 저장된 회의록이 없습니다.
                        </div>
                    )}
                    {sortedRecords.length > 10 && (
                        <button
                            type="button"
                            className="mt-2 rounded-md px-3 py-2 text-left text-xs font-medium text-primary hover:bg-primary/5"
                            onClick={() => setShowAllRecords(current => !current)}
                        >
                            {showAllRecords ? '최근 10개만 보기' : '전체 회의 기록 보기'}
                        </button>
                    )}
                </div>
                {onOpenAsrBenchmark && (
                    <div className="mt-3 border-t border-border pt-3">
                        <button
                            type="button"
                            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors ${activeTab === 'asr-benchmark' ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                            onClick={onOpenAsrBenchmark}
                        >
                            <BarChart3 size={15} />
                            ASR 테스트 결과
                        </button>
                    </div>
                )}
            </div>
        </aside>
    );
};
