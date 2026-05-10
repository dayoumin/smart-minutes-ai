import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Clock3, MoreVertical, Pencil, Pin, PinOff, PlusCircle, Trash2 } from 'lucide-react';
import { deleteMeeting, getAllMeetings, MeetingRecord, updateMeeting } from './meetingRepository';
import { toApiUrl } from './apiBase';

export interface SidebarProps {
    activeTab?: string;
    selectedMeetingId?: string | null;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string) => void;
    onOpenAsrBenchmark?: () => void;
    analysisStatus?: {
        active: boolean;
        progress: number;
        message: string;
        rawMessage?: string;
        startedAt?: number | null;
        stalled?: boolean;
    };
}

const formatElapsed = (milliseconds: number): string => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}시간 ${remainingMinutes}분`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const getChunkProgress = (message: string): { current: number; total: number } | null => {
    const match = message.trim().match(/^Transcribing chunk (\d+)\/(\d+)/);
    if (!match) return null;
    return {
        current: Number(match[1]),
        total: Number(match[2]),
    };
};

const formatRemaining = (elapsedMs: number, message: string, stalled: boolean): string => {
    if (stalled) return '확인 필요';
    const chunk = getChunkProgress(message);
    if (!chunk || chunk.current <= 0 || chunk.total <= chunk.current) return '측정 중';
    return `예상 ${formatElapsed((elapsedMs / chunk.current) * chunk.total - elapsedMs)}`;
};

const formatSidebarStatus = (message: string): string => {
    const chunk = getChunkProgress(message);
    if (chunk) return `음성 인식 ${chunk.current}/${chunk.total}`;
    return (message || '회의록을 작성하고 있습니다.')
        .replace(' 같은 단계가 오래 걸리고 있습니다. 진행이 바뀌지 않으면 취소 후 다시 시도해 주세요.', '');
};

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, selectedMeetingId, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onOpenAsrBenchmark, analysisStatus }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
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

    useEffect(() => {
        void loadRecords();
        window.addEventListener('focus', loadRecords);
        window.addEventListener('meetings:updated', loadRecords);
        return () => {
            window.removeEventListener('focus', loadRecords);
            window.removeEventListener('meetings:updated', loadRecords);
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

    useEffect(() => {
        const closeMenu = (event: PointerEvent) => {
            if (!sidebarRef.current?.contains(event.target as Node)) {
                setOpenMenuId(null);
            }
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
        if (!window.confirm(`"${record.title}" 회의록을 삭제할까요?`)) return;
        await deleteMeeting(record.id);
        if (record.jobId) {
            await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(record.jobId)}`), {
                method: 'DELETE',
            }).catch(() => null);
        }
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
                    <PlusCircle size={15} />
                    새 회의록 작성
                </button>
                {analysisStatus?.active && (
                    <button
                        type="button"
                        className="sidebar-analysis-card mb-3"
                        onClick={() => onCreateMeeting?.()}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span className="sidebar-analysis-title">분석 중</span>
                            <span className="sidebar-analysis-elapsed">
                                <Clock3 size={12} />
                                {formatElapsed(analysisElapsedMs)}
                            </span>
                        </div>
                        <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{analysisStatus.stalled ? '진행 확인 필요' : formatSidebarStatus(analysisRawMessage)}</span>
                            <span className="shrink-0">{formatRemaining(analysisElapsedMs, analysisRawMessage, Boolean(analysisStatus.stalled))}</span>
                        </div>
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
                                    <div id={`sidebar-record-menu-${record.id}`} role="menu" className="menu-panel absolute right-2 top-8 z-20 w-32 text-xs">
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
