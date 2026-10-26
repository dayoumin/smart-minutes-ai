import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, AudioLines, BarChart3, ChevronDown, ChevronRight, ChevronUp, Clock3, Folder, FolderPlus, Loader2, MoreVertical, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { AnalysisResumeDraft } from './analysisResumeDrafts';
import type { AppView } from './appView';
import { selectVisibleRecoveryDrafts, useAnalysisResumeSnapshot } from './analysisResumeState';
import {
    addMeetingFolder,
    deleteMeetingFolder,
    getAllMeetingFolders,
    getAllMeetings,
    MeetingFolder,
    MeetingRecord,
    moveMeetingToFolder,
    reorderMeetingFolders,
    renameMeetingFolder,
    updateMeetingFolderPinned,
    updateMeeting,
    updateMeetingPinned,
} from './meetingRepository';
import { deleteMeetingWithAnalysis } from './meetingDeletion';
import { isTauriRuntime } from './apiBase';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from './brand';
import { AppToast, ProgressBar, type AppToastMessage } from './components/common';
import { SidebarRecordMoveMenu } from './SidebarRecordMoveMenu';
import { formatAnalysisDuration, formatTranscriptReadyEstimate, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';
import type { SidebarMode } from './useSidebarCollapse';
import { UpdateEntry } from './UpdateEntry';

export interface SidebarProps {
    mode?: SidebarMode;
    onCollapse?: () => void;
    onExpand?: () => void;
    onRequestClose?: () => void;
    activeTab?: AppView;
    selectedMeetingId?: string | null;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string, fallbackId: string | null) => void;
    onSelectResumeDraft?: (jobId: string) => void;
    onOpenStart?: () => void;
    /** The 분석 중 card: back to the analysis progress view. */
    onOpenAnalysis?: () => void;
    onOpenArchive?: () => void;
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
    resumeSelectionBlocked?: boolean;
    onOpenSettings?: () => void;
    onOpenAsrBenchmark?: () => void;
    analysisStatus?: {
        active: boolean;
        completionVisible?: boolean;
        progress: number;
        message: string;
        rawMessage?: string;
        startedAt?: number | null;
        stalled?: boolean;
        transcriptReady?: boolean;
        etaSeconds?: number | null;
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
    if (chunk) return `음성 인식 ${chunk.current}/${chunk.total} 구간`;
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

const getSidebarResumeDraftStatus = (draft: AnalysisResumeDraft): string => {
    if (draft.stage === 'recovering-result') return '결과 복구 중';
    if (draft.status === 'active') return '진행 중';
    if (draft.resumeEligible === false) return '이어하기 불가';
    if (draft.status === 'stopped') return '중단됨';
    if (draft.status === 'cancelled') return '사용자 취소';
    if (draft.status === 'failed') return '실패';
    return '이어하기 가능';
};

const getSidebarResumeDraftTone = (draft: AnalysisResumeDraft): 'info' | 'warning' | 'error' | 'neutral' => {
    if (draft.stage === 'recovering-result') return 'info';
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

const parseMeetingTimestamp = (value?: string): number | null => {
    if (!value) return null;
    const timestamp = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isNaN(timestamp) ? null : timestamp;
};

const formatRecordElapsedTime = (record: MeetingRecord): string => {
    const timestamp = parseMeetingTimestamp(record.createdAt) ?? parseMeetingTimestamp(record.date);
    if (timestamp === null) return '';
    const elapsedDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
    if (elapsedDays === 0) return '오늘';
    if (elapsedDays < 7) return `${elapsedDays}일`;
    if (elapsedDays < 28) return `${Math.floor(elapsedDays / 7)}주`;
    if (elapsedDays < 365) return `${Math.max(1, Math.floor(elapsedDays / 30))}개월`;
    return `${Math.floor(elapsedDays / 365)}년`;
};

const sortMeetingFolders = (folders: MeetingFolder[]): MeetingFolder[] => (
    folders.slice().sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        const aOrder = a.sortOrder;
        const bOrder = b.sortOrder;
        if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
        if (aOrder !== undefined && bOrder === undefined) return -1;
        if (aOrder === undefined && bOrder !== undefined) return 1;
        return a.name.localeCompare(b.name, 'ko');
    })
);

// Focus fallback when a menu target disappears: the create button may be disabled during an analysis,
// so fall back to the 분석 중 card and then the brand button.
const focusSidebarFallback = (createButton: HTMLButtonElement | null, sidebar: HTMLElement | null) => {
    if (createButton && !createButton.disabled) {
        createButton.focus();
        return;
    }
    const analysisCard = sidebar?.querySelector<HTMLElement>('.sidebar-analysis-card, .sidebar-rail-analysis');
    if (analysisCard) {
        analysisCard.focus();
        return;
    }
    sidebar?.querySelector<HTMLElement>('.sidebar-brand')?.focus();
};

export const Sidebar: React.FC<SidebarProps> = ({ mode = 'expanded', onCollapse, onExpand, onRequestClose, activeTab, selectedMeetingId, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenStart, onOpenAnalysis, onOpenArchive, newMeetingBlocked, newMeetingBlockedReason = '진행 중인 분석이 끝나면 새 회의록을 만들 수 있습니다.', resumeSelectionBlocked, onOpenSettings, onOpenAsrBenchmark, analysisStatus }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const recordLoadSequence = useRef(0);
    const [loadedRecordsSequence, setLoadedRecordsSequence] = useState(0);
    const [folders, setFolders] = useState<MeetingFolder[]>([]);
    const [folderLoadFailed, setFolderLoadFailed] = useState(false);
    const [isLoadingFolders, setIsLoadingFolders] = useState(false);
    const folderLoadSequence = useRef(0);
    const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
    const [folderVisibleCounts, setFolderVisibleCounts] = useState<Record<string, number>>({});
    const [showFolderForm, setShowFolderForm] = useState(false);
    const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [folderName, setFolderName] = useState('');
    const [folderError, setFolderError] = useState('');
    const resumeSnapshot = useAnalysisResumeSnapshot();
    const resumeDrafts = useMemo(() => selectVisibleRecoveryDrafts(resumeSnapshot), [resumeSnapshot]);
    const [showResumeDrafts, setShowResumeDrafts] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [deletionToast, setDeletionToast] = useState<AppToastMessage | null>(null);
    useEffect(() => {
        if (!deletionToast) return undefined;
        const timerId = window.setTimeout(() => {
            setDeletionToast(current => (current?.id === deletionToast.id ? null : current));
        }, 5000);
        return () => window.clearTimeout(timerId);
    }, [deletionToast]);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [folderDropTarget, setFolderDropTarget] = useState<{ folderId: string; position: 'before' | 'after' } | null>(null);
    const [isReorderingFolders, setIsReorderingFolders] = useState(false);
    const [folderMenuPosition, setFolderMenuPosition] = useState({ top: 0, left: 0 });
    const [recordMenuPosition, setRecordMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const sidebarRef = useRef<HTMLElement | null>(null);
    const sidebarHadFocus = useRef(false);
    const previousMode = useRef(mode);
    useEffect(() => {
        const track = (event: FocusEvent) => { sidebarHadFocus.current = Boolean(sidebarRef.current?.contains(event.target as Node)); };
        document.addEventListener('focusin', track);
        return () => document.removeEventListener('focusin', track);
    }, []);
    useEffect(() => {
        if (previousMode.current === mode) return;
        previousMode.current = mode;
        const restore = sidebarHadFocus.current;
        const frame = requestAnimationFrame(() => {
            setOpenMenuId(null);
            setOpenFolderMenuId(null);
            if (restore && document.activeElement === document.body) {
                const target = mode === 'rail' ? '.sidebar-rail-expand' : mode === 'overlay' ? '.sidebar-collapse-button' : '.sidebar-brand';
                sidebarRef.current?.querySelector<HTMLElement>(target)?.focus();
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [mode]);
    const createMeetingButtonRef = useRef<HTMLButtonElement | null>(null);
    const folderMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const folderMenuPanelRefs = useRef(new Map<string, HTMLDivElement>());
    const pendingFolderMenuFocusRef = useRef<string | null>(null);
    const recordMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const recordMenuPanelRefs = useRef(new Map<string, HTMLDivElement>());
    const pendingRecordMenuFocusRef = useRef<{
        recordId: string;
        fallbackRecordId: string | null;
        afterRecordsSequence: number;
    } | null>(null);
    const draggedFolderIdRef = useRef<string | null>(null);
    const folderOrderSavingRef = useRef(false);

    const loadRecords = async () => {
        const sequence = ++recordLoadSequence.current;
        try {
            const data = await getAllMeetings();
            if (sequence !== recordLoadSequence.current) return;
            setRecords(data);
            setLoadedRecordsSequence(sequence);
        } catch {
            if (sequence !== recordLoadSequence.current) return;
            const pendingFocus = pendingRecordMenuFocusRef.current;
            if (!pendingFocus || sequence < pendingFocus.afterRecordsSequence) return;
            pendingRecordMenuFocusRef.current = null;
            window.requestAnimationFrame(() => {
                const recordTrigger = recordMenuTriggerRefs.current.get(pendingFocus.recordId);
                const fallbackTrigger = pendingFocus.fallbackRecordId
                    ? recordMenuTriggerRefs.current.get(pendingFocus.fallbackRecordId)
                    : null;
                if (recordTrigger?.isConnected) {
                    recordTrigger.focus();
                    return;
                }
                if (fallbackTrigger?.isConnected) {
                    fallbackTrigger.focus();
                    return;
                }
                focusSidebarFallback(createMeetingButtonRef.current, sidebarRef.current);
            });
        }
    };

    const loadFolders = async () => {
        const sequence = ++folderLoadSequence.current;
        setIsLoadingFolders(true);
        try {
            const data = await getAllMeetingFolders();
            if (sequence !== folderLoadSequence.current) return;
            setFolders(sortMeetingFolders(data));
            setFolderLoadFailed(false);
            const pendingFocusId = pendingFolderMenuFocusRef.current;
            pendingFolderMenuFocusRef.current = null;
            if (pendingFocusId) {
                window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(pendingFocusId)?.focus());
            }
        } catch {
            if (sequence === folderLoadSequence.current) setFolderLoadFailed(true);
        } finally {
            if (sequence === folderLoadSequence.current) setIsLoadingFolders(false);
        }
    };

    useEffect(() => {
        void loadRecords();
        void loadFolders();
        window.addEventListener('focus', loadRecords);
        window.addEventListener('focus', loadFolders);
        window.addEventListener('meetings:updated', loadRecords);
        window.addEventListener('meetings:updated', loadFolders);
        return () => {
            window.removeEventListener('focus', loadRecords);
            window.removeEventListener('focus', loadFolders);
            window.removeEventListener('meetings:updated', loadRecords);
            window.removeEventListener('meetings:updated', loadFolders);
        };
    }, []);

    useEffect(() => {
        if (resumeDrafts.length === 0) setShowResumeDrafts(false);
    }, [resumeDrafts.length]);

    useEffect(() => {
        if (!analysisStatus?.active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [analysisStatus?.active]);

    const sortedRecords = useMemo(
        () => records.slice().sort((a, b) => {
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
            return new Date(b.createdAt ?? b.date).getTime() - new Date(a.createdAt ?? a.date).getTime();
        }),
        [records],
    );
    const folderRecords = useMemo(() => {
        const grouped = new Map<string, MeetingRecord[]>();
        for (const record of sortedRecords) {
            if (!record.folderId) continue;
            const group = grouped.get(record.folderId) ?? [];
            group.push(record);
            grouped.set(record.folderId, group);
        }
        return grouped;
    }, [sortedRecords]);
    const unfiledRecords = useMemo(
        () => sortedRecords.filter(record => !record.folderId),
        [sortedRecords],
    );
    const visibleRecords = useMemo(
        () => [
            ...folders.flatMap(folder => expandedFolderIds.has(folder.id)
                ? (folderRecords.get(folder.id) ?? []).slice(0, folderVisibleCounts[folder.id] ?? 5)
                : []),
            ...unfiledRecords,
        ],
        [folders, expandedFolderIds, folderRecords, folderVisibleCounts, unfiledRecords],
    );
    const analysisElapsedMs = now - (analysisStatus?.startedAt || now);
    const analysisRawMessage = analysisStatus?.rawMessage || analysisStatus?.message || '';
    const transcriptEstimateLabel = analysisStatus
        ? formatTranscriptReadyEstimate(
            analysisElapsedMs,
            analysisStatus.progress,
            analysisRawMessage || analysisStatus.message,
            analysisStatus.transcriptReady,
            analysisStatus.etaSeconds,
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
            if (
                target instanceof Element
                && target.closest(
                    '[data-sidebar-record-menu], [data-sidebar-record-menu-trigger], [data-sidebar-folder-menu], [data-sidebar-folder-menu-trigger]',
                )
            ) return;
            setOpenMenuId(null);
            setOpenFolderMenuId(null);
        };

        document.addEventListener('pointerdown', closeMenu, true);
        return () => {
            document.removeEventListener('pointerdown', closeMenu, true);
        };
    }, []);

    useEffect(() => {
        if (!openFolderMenuId) return;
        const frame = window.requestAnimationFrame(() => {
            folderMenuPanelRefs.current
                .get(openFolderMenuId)
                ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
                ?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [openFolderMenuId]);

    const focusRecordMenuTrigger = (recordId: string | null) => {
        window.requestAnimationFrame(() => {
            const trigger = recordId ? recordMenuTriggerRefs.current.get(recordId) : null;
            if (trigger?.isConnected) {
                trigger.focus();
                return;
            }
            focusSidebarFallback(createMeetingButtonRef.current, sidebarRef.current);
        });
    };

    const closeRecordMenu = (recordId: string, restoreFocus = false) => {
        setOpenMenuId(null);
        if (restoreFocus) focusRecordMenuTrigger(recordId);
    };

    useEffect(() => {
        if (!openMenuId) return;
        const frame = window.requestAnimationFrame(() => {
            const trigger = recordMenuTriggerRefs.current.get(openMenuId);
            const panel = recordMenuPanelRefs.current.get(openMenuId);
            if (!trigger || !panel) return;
            const triggerBounds = trigger.getBoundingClientRect();
            const panelBounds = panel.getBoundingClientRect();
            setRecordMenuPosition({
                top: Math.max(8, Math.min(triggerBounds.bottom + 4, window.innerHeight - panelBounds.height - 8)),
                left: Math.max(8, Math.min(triggerBounds.right - panelBounds.width, window.innerWidth - panelBounds.width - 8)),
            });
        });
        return () => {
            window.cancelAnimationFrame(frame);
            setRecordMenuPosition(null);
        };
    }, [openMenuId]);

    useEffect(() => {
        if (!openMenuId || !recordMenuPosition) return;
        const frame = window.requestAnimationFrame(() => {
            const panel = recordMenuPanelRefs.current.get(openMenuId);
            if (panel?.contains(document.activeElement)) return;
            panel?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [openMenuId, recordMenuPosition]);

    useEffect(() => {
        const pendingFocus = pendingRecordMenuFocusRef.current;
        if (!pendingFocus || loadedRecordsSequence < pendingFocus.afterRecordsSequence) return;
        pendingRecordMenuFocusRef.current = null;
        const focusRecordId = visibleRecords.some(record => record.id === pendingFocus.recordId)
            ? pendingFocus.recordId
            : visibleRecords.some(record => record.id === pendingFocus.fallbackRecordId)
                ? pendingFocus.fallbackRecordId
                : null;
        window.requestAnimationFrame(() => {
            const trigger = focusRecordId ? recordMenuTriggerRefs.current.get(focusRecordId) : null;
            if (trigger?.isConnected) {
                trigger.focus();
                return;
            }
            focusSidebarFallback(createMeetingButtonRef.current, sidebarRef.current);
        });
    }, [visibleRecords, loadedRecordsSequence]);


    const handleRecordMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, recordId: string) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeRecordMenu(recordId, true);
            return;
        }
        if (event.key === 'Tab') {
            const focusableItems = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not([disabled]):not([tabindex="-1"]), select:not([disabled])',
                ),
            );
            const currentIndex = focusableItems.indexOf(document.activeElement as HTMLElement);
            const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
            if (nextIndex >= 0 && nextIndex < focusableItems.length) {
                event.preventDefault();
                event.stopPropagation();
                focusableItems[nextIndex]?.focus();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            closeRecordMenu(recordId, true);
            return;
        }
    };

    const closeFolderMenu = (folderId: string, restoreFocus = false) => {
        setOpenFolderMenuId(null);
        if (restoreFocus) {
            window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(folderId)?.focus());
        }
    };

    const handleFolderMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, folderId: string) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeFolderMenu(folderId, true);
            return;
        }
        if (event.key === 'Tab') {
            setOpenFolderMenuId(null);
            return;
        }

        const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
        );
        if (items.length === 0) return;
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        let nextIndex: number | null = null;
        if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
        if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = items.length - 1;
        if (nextIndex === null) return;

        event.preventDefault();
        event.stopPropagation();
        items[nextIndex]?.focus();
    };

    const handleSelectRecord = (id: string) => {
        setOpenMenuId(null);
        onSelectMeeting?.(id);
    };

    const handleRenameRecord = async (record: MeetingRecord) => {
        closeRecordMenu(record.id, true);
        const nextTitle = window.prompt('회의록 이름 변경', record.title)?.trim();
        if (!nextTitle || nextTitle === record.title) return;
        await updateMeeting({ ...record, title: nextTitle });
        window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
    };

    const handleTogglePinned = async (record: MeetingRecord) => {
        const recordIndex = visibleRecords.findIndex(item => item.id === record.id);
        const fallbackRecordId = visibleRecords[recordIndex + 1]?.id ?? visibleRecords[recordIndex - 1]?.id ?? null;
        try {
            await updateMeetingPinned(record.id, !record.pinned);
            pendingRecordMenuFocusRef.current = {
                recordId: record.id, fallbackRecordId,
                afterRecordsSequence: recordLoadSequence.current + 1,
            };
            setOpenMenuId(null);
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
        } catch (error) {
            setOpenMenuId(null);
            window.alert(error instanceof Error ? error.message : '회의록 고정 상태를 바꾸지 못했습니다.');
            await loadRecords();
            focusRecordMenuTrigger(record.id);
        }
    };

    const handleCreateFolder = async (event: React.FormEvent) => {
        event.preventDefault();
        const nextName = folderName.trim();
        if (isCreatingFolder || !nextName) return;
        if (folders.some(folder => folder.name === nextName)) {
            setFolderError('같은 이름의 폴더가 이미 있습니다.');
            return;
        }
        setFolderError('');
        setIsCreatingFolder(true);
        try {
            await addMeetingFolder(nextName);
            await loadFolders();
            setFolderName('');
            setShowFolderForm(false);
        } catch (error) {
            setFolderError(error instanceof Error ? error.message : '폴더를 만들지 못했습니다.');
            await loadFolders();
        } finally {
            setIsCreatingFolder(false);
        }
    };

    const handleMoveRecord = async (record: MeetingRecord, folderId: string) => {
        const recordIndex = visibleRecords.findIndex(item => item.id === record.id);
        const fallbackRecordId = visibleRecords[recordIndex + 1]?.id ?? visibleRecords[recordIndex - 1]?.id ?? null;
        try {
            await moveMeetingToFolder(record.id, folderId || undefined);
            pendingRecordMenuFocusRef.current = {
                recordId: record.id, fallbackRecordId,
                afterRecordsSequence: recordLoadSequence.current + 1,
            };
            setOpenMenuId(null);
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
        } catch (error) {
            setOpenMenuId(null);
            window.alert(error instanceof Error ? error.message : '회의록 폴더를 변경하지 못했습니다.');
            await loadRecords();
            focusRecordMenuTrigger(record.id);
        }
    };

    const handleToggleFolderPinned = async (folder: MeetingFolder) => {
        pendingFolderMenuFocusRef.current = folder.id;
        setOpenFolderMenuId(null);
        try {
            await updateMeetingFolderPinned(folder.id, !folder.pinned);
            await loadFolders();
        } catch (error) {
            pendingFolderMenuFocusRef.current = null;
            window.alert(error instanceof Error ? error.message : '폴더 고정 상태를 바꾸지 못했습니다.');
        }
    };

    const handleMoveFolder = async (folder: MeetingFolder, direction: -1 | 1) => {
        const folderIndex = folders.findIndex(item => item.id === folder.id);
        const targetIndex = folderIndex + direction;
        const targetFolder = folders[targetIndex];
        if (
            folderIndex < 0
            || !targetFolder
            || Boolean(targetFolder.pinned) !== Boolean(folder.pinned)
        ) return;

        const reorderedFolders = folders.slice();
        [reorderedFolders[folderIndex], reorderedFolders[targetIndex]] = [
            reorderedFolders[targetIndex],
            reorderedFolders[folderIndex],
        ];
        setOpenFolderMenuId(null);
        await persistFolderOrder(reorderedFolders, folder.id);
    };

    const persistFolderOrder = async (reorderedFolders: MeetingFolder[], focusFolderId?: string) => {
        if (folderOrderSavingRef.current) return;
        const normalizedFolders = reorderedFolders.map((item, index) => ({ ...item, sortOrder: index }));
        folderOrderSavingRef.current = true;
        setIsReorderingFolders(true);
        setFolders(normalizedFolders);
        try {
            await reorderMeetingFolders(normalizedFolders.map(item => item.id));
            if (focusFolderId) {
                window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(focusFolderId)?.focus());
            }
        } catch (error) {
            window.alert(error instanceof Error ? error.message : '폴더 순서를 바꾸지 못했습니다.');
            await loadFolders();
        } finally {
            folderOrderSavingRef.current = false;
            setIsReorderingFolders(false);
        }
    };

    const handleFolderDragStart = (event: React.DragEvent<HTMLButtonElement>, folder: MeetingFolder) => {
        if (folderOrderSavingRef.current) {
            event.preventDefault();
            return;
        }
        draggedFolderIdRef.current = folder.id;
        setDraggedFolderId(folder.id);
        setFolderDropTarget(null);
        setOpenFolderMenuId(null);
        setOpenMenuId(null);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', folder.id);
    };

    const handleFolderDragOver = (event: React.DragEvent<HTMLDivElement>, targetFolder: MeetingFolder) => {
        const sourceFolder = folders.find(item => item.id === draggedFolderIdRef.current);
        if (
            !sourceFolder
            || sourceFolder.id === targetFolder.id
            || Boolean(sourceFolder.pinned) !== Boolean(targetFolder.pinned)
        ) {
            event.dataTransfer.dropEffect = 'none';
            setFolderDropTarget(null);
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
        setFolderDropTarget({ folderId: targetFolder.id, position });
    };

    const handleFolderDrop = async (event: React.DragEvent<HTMLDivElement>, targetFolder: MeetingFolder) => {
        event.preventDefault();
        const sourceFolderId = draggedFolderIdRef.current ?? event.dataTransfer.getData('text/plain');
        const sourceFolder = folders.find(item => item.id === sourceFolderId);
        const bounds = event.currentTarget.getBoundingClientRect();
        const dropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
        draggedFolderIdRef.current = null;
        setDraggedFolderId(null);
        setFolderDropTarget(null);
        if (
            !sourceFolder
            || sourceFolder.id === targetFolder.id
            || Boolean(sourceFolder.pinned) !== Boolean(targetFolder.pinned)
        ) return;

        const reorderedFolders = folders.filter(item => item.id !== sourceFolder.id);
        const targetIndex = reorderedFolders.findIndex(item => item.id === targetFolder.id);
        if (targetIndex < 0) return;
        reorderedFolders.splice(targetIndex + (dropPosition === 'after' ? 1 : 0), 0, sourceFolder);
        await persistFolderOrder(reorderedFolders);
    };

    const handleFolderDragEnd = () => {
        draggedFolderIdRef.current = null;
        setDraggedFolderId(null);
        setFolderDropTarget(null);
    };

    const handleRenameFolder = async (folder: MeetingFolder) => {
        closeFolderMenu(folder.id);
        const nextName = window.prompt('폴더 이름 변경', folder.name)?.trim();
        if (!nextName || nextName === folder.name || folders.some(item => item.id !== folder.id && item.name === nextName)) {
            window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(folder.id)?.focus());
            return;
        }
        try {
            pendingFolderMenuFocusRef.current = folder.id;
            await renameMeetingFolder(folder.id, nextName);
            await loadFolders();
        } catch (error) {
            pendingFolderMenuFocusRef.current = null;
            window.alert(error instanceof Error ? error.message : '폴더 이름을 바꾸지 못했습니다.');
        }
    };

    const handleDeleteFolder = async (folder: MeetingFolder) => {
        closeFolderMenu(folder.id);
        if (!window.confirm(`"${folder.name}" 폴더를 삭제할까요?\n\n폴더 안의 회의록은 삭제되지 않고 폴더 없음으로 이동합니다.`)) {
            window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(folder.id)?.focus());
            return;
        }
        const folderIndex = folders.findIndex(item => item.id === folder.id);
        const fallbackFolderId = folders[folderIndex + 1]?.id ?? folders[folderIndex - 1]?.id ?? null;
        await deleteMeetingFolder(folder.id);
        setOpenFolderMenuId(null);
        window.dispatchEvent(new Event('meetings:updated'));
        window.requestAnimationFrame(() => {
            const fallbackTrigger = fallbackFolderId ? folderMenuTriggerRefs.current.get(fallbackFolderId) : null;
            if (fallbackTrigger?.isConnected) fallbackTrigger.focus();
            else focusSidebarFallback(createMeetingButtonRef.current, sidebarRef.current);
        });
    };

    const handleDeleteRecord = async (record: MeetingRecord) => {
        const recordIndex = visibleRecords.findIndex(item => item.id === record.id);
        const fallbackRecordId = visibleRecords[recordIndex + 1]?.id ?? visibleRecords[recordIndex - 1]?.id ?? null;
        closeRecordMenu(record.id, true);
        if (!window.confirm(`"${record.title}" 회의록을 삭제할까요?\n\n앱 안의 회의 기록과 분석 산출물은 삭제되지만, 다운로드 폴더에 저장한 HWPX/음성 파일은 직접 삭제해야 합니다.`)) return;
        const result = await deleteMeetingWithAnalysis(record);
        if (result === 'analysis-active' || result === 'engine-failed' || result === 'cleanup-not-remembered') {
            window.alert({
                'analysis-active': '아직 분석이 진행 중인 회의록입니다. 분석을 중단한 뒤 삭제해 주세요.',
                'engine-failed': '분석 산출물을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.',
                'cleanup-not-remembered': `이 PC의 분석 파일을 나중에 지울 수 있도록 기억하지 못해 회의록을 삭제하지 않았습니다. ${isTauriRuntime() ? '앱' : '브라우저'} 저장 공간을 확인한 뒤 다시 삭제해 주세요.`,
            }[result]);
            return;
        }
        window.dispatchEvent(new Event('meetings:updated'));
        onDeleteMeeting?.(record.id, fallbackRecordId);
        focusRecordMenuTrigger(fallbackRecordId);
        if (result === 'deleted-engine-later') {
            // A transient note: the record is gone, and nothing is left for the user to do.
            setDeletionToast({
                id: Date.now(),
                tone: 'neutral',
                message: isTauriRuntime()
                    ? '회의록을 삭제했습니다. 이 PC의 분석 파일은 분석 기능이 다시 연결되면 지웁니다.'
                    : `회의록을 삭제했습니다. 이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`,
            });
        }
    };

    const renderRecord = (record: MeetingRecord) => {
        const isSelected = (activeTab === 'history' || activeTab === 'minutes' && analysisStatus?.completionVisible)
            && selectedMeetingId === record.id;
        const analysisStateLabel = record.analysisStatus === 'diarization_in_progress'
            ? '참석자 구분 중'
            : record.analysisStatus === 'diarization_failed'
                ? '참석자 구분 실패'
                : record.analysisStatus === 'diarization_stopped'
                    ? '구분 중지'
                    : '';

        return (
            <div
                key={record.id}
                className={`group sidebar-record-row ${isSelected ? 'sidebar-record-row-active' : ''}`}
            >
                <div className="flex items-center gap-1 px-2 py-1.5">
                    <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => handleSelectRecord(record.id)}
                        title={record.title}
                        aria-current={isSelected ? 'page' : undefined}
                    >
                        <Pin
                            size={12}
                            className={`shrink-0 ${record.pinned ? 'text-primary' : 'hidden'}`}
                        />
                        <div className={`ui-item-text min-w-0 flex-1 truncate text-foreground ${isSelected ? 'font-medium' : 'font-normal'}`}>
                            {record.title}
                        </div>
                    </button>
                    <div
                        className={`sidebar-record-meta-slot ${analysisStateLabel ? 'sidebar-record-meta-slot-status' : ''}`}
                        title={analysisStateLabel ? `${analysisStateLabel} · ${record.date}` : record.date}
                    >
                        <span
                            className="sidebar-record-age ui-meta-text truncate text-muted-foreground"
                            data-sidebar-record-age
                        >
                            {analysisStateLabel || formatRecordElapsedTime(record)}
                        </span>
                        <button
                            ref={element => {
                                if (element) recordMenuTriggerRefs.current.set(record.id, element);
                                else recordMenuTriggerRefs.current.delete(record.id);
                            }}
                            type="button"
                            className="icon-button btn-ghost sidebar-record-menu-trigger h-6 w-6"
                            onClick={() => {
                                setOpenFolderMenuId(null);
                                setOpenMenuId(openMenuId === record.id ? null : record.id);
                            }}
                            onKeyDown={event => {
                                if (event.key !== 'Escape' || openMenuId !== record.id) return;
                                event.preventDefault();
                                event.stopPropagation();
                                closeRecordMenu(record.id, true);
                            }}
                            data-sidebar-record-menu-trigger
                            aria-haspopup="dialog"
                            aria-expanded={openMenuId === record.id}
                            aria-controls={`sidebar-record-menu-${record.id}`}
                            title={`${record.title}, ${record.date} 회의록 메뉴`}
                            aria-label={`${record.title}, ${record.date} 회의록 메뉴`}
                        >
                            <MoreVertical size={14} />
                        </button>
                    </div>
                </div>
                {openMenuId === record.id && (
                    <div
                        ref={element => {
                            if (element) recordMenuPanelRefs.current.set(record.id, element);
                            else recordMenuPanelRefs.current.delete(record.id);
                        }}
                        id={`sidebar-record-menu-${record.id}`}
                        role="dialog"
                        aria-label={`${record.title}, ${record.date} 회의록 메뉴`}
                        className="menu-panel fixed z-20 w-44"
                        style={recordMenuPosition
                            ? { top: recordMenuPosition.top, left: recordMenuPosition.left }
                            : { top: 0, left: 0, visibility: 'hidden' }}
                        data-sidebar-record-menu
                        onKeyDown={event => handleRecordMenuKeyDown(event, record.id)}
                    >
                        <button
                            type="button"
                            className="menu-item px-2 py-1.5"
                            onClick={() => handleTogglePinned(record)}
                        >
                            {record.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            {record.pinned ? '고정 해제' : '상단 고정'}
                        </button>
                        <button
                            type="button"
                            className="menu-item px-2 py-1.5"
                            onClick={() => handleRenameRecord(record)}
                        >
                            <Pencil size={13} />
                            이름 변경
                        </button>
                        <SidebarRecordMoveMenu
                            recordId={record.id}
                            folderId={record.folderId}
                            folders={folders}
                            onMove={folderId => void handleMoveRecord(record, folderId)}
                            onClose={() => closeRecordMenu(record.id, true)}
                        />
                        <button
                            type="button"
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
    };

    return (
        <aside ref={sidebarRef} data-settings-focus-scope data-mode={mode} aria-label="앱 메뉴" role={mode === 'overlay' ? 'dialog' : undefined} aria-modal={mode === 'overlay' ? true : undefined}
            onKeyDown={event => {
                if (mode !== 'overlay' || event.defaultPrevented) return;
                if (event.key === 'Escape') { event.preventDefault(); onRequestClose?.(); }
                if (event.key === 'Tab') {
                    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length);
                    const first = buttons[0]; const last = buttons.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            }}
            className="barorok-navigation flex max-h-none shrink-0 flex-col border-r">
            {mode === 'rail' ? <div className="sidebar-rail">
                <button type="button" className="sidebar-brand sidebar-rail-button" aria-label={`${BRAND_NAME} 첫 화면`} title={`${BRAND_NAME} 첫 화면`} onClick={onOpenStart}>
                    <span className="app-brand-mark" aria-hidden="true"><AudioLines size={15} /></span>
                    <strong>{BRAND_NAME}</strong>
                </button>
                <button type="button" className="sidebar-rail-button sidebar-rail-expand" aria-label="메뉴" aria-expanded={false} aria-describedby={resumeDrafts.length > 0 ? 'sidebar-rail-resume-note' : undefined} onClick={onExpand}>메뉴{resumeDrafts.length > 0 && <><span className="sidebar-rail-dot" aria-hidden="true" /><span id="sidebar-rail-resume-note" className="sr-only">이어서 할 분석 있음</span></>}</button>
                <UpdateEntry compact />
                {onOpenSettings && <button type="button" data-settings-focus-fallback className="sidebar-rail-button sidebar-rail-settings" aria-label="설정" title="설정" onClick={onOpenSettings}><Settings size={18} aria-hidden="true" /></button>}
            </div> : <>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="sidebar-brand-row">
                <button type="button" className="sidebar-brand" aria-label={`${BRAND_NAME} 첫 화면`} aria-current={activeTab === 'minutes' ? 'page' : undefined} onClick={onOpenStart}>
                    <span className="app-brand-mark" aria-hidden="true"><AudioLines size={15} /></span>
                    <span className="app-brand-copy">
                        <strong>{BRAND_NAME}</strong>
                    </span>
                </button>
                {mode === 'overlay' && <button type="button" className="sidebar-collapse-button sidebar-menu-close" onClick={onCollapse}>메뉴 닫기</button>}
                </div>
                <button
                    ref={createMeetingButtonRef}
                    type="button"
                    className={`sidebar-create-button mb-3 ${activeTab === 'minutes' && !selectedMeetingId && !analysisStatus?.active ? 'sidebar-create-button-active' : ''}`}
                    disabled={newMeetingBlocked || Boolean(analysisStatus?.active)}
                    aria-describedby={newMeetingBlocked ? 'sidebar-create-blocked' : analysisStatus?.active ? 'sidebar-create-analysis-note' : undefined}
                    title={newMeetingBlocked
                        ? newMeetingBlockedReason
                        : analysisStatus?.active ? '분석이 끝나면 새 회의록을 만들 수 있습니다. 로고를 누르면 진행 상황을 볼 수 있습니다.' : undefined}
                    onClick={() => {
                        setOpenMenuId(null);
                        onCreateMeeting?.();
                    }}
                >
                    <Plus size={15} />
                    새 회의록
                </button>
                {analysisStatus?.active && !newMeetingBlocked && (
                    <span id="sidebar-create-analysis-note" className="sr-only">분석이 끝나면 새 회의록을 만들 수 있습니다. 로고를 누르면 진행 상황을 볼 수 있습니다.</span>
                )}
                {onOpenArchive && (
                    <button
                        type="button"
                        className={`sidebar-create-button sidebar-archive-button mb-3 ${activeTab === 'archive' ? 'sidebar-archive-button-active' : ''}`}
                        aria-current={activeTab === 'archive' ? 'page' : undefined}
                        onClick={() => {
                            setOpenMenuId(null);
                            onOpenArchive();
                        }}
                    >
                        <Search size={17} aria-hidden="true" />
                        기록 찾기
                    </button>
                )}
                <div className="sidebar-content-scroll custom-scrollbar">
                <div className="sidebar-folder-toolbar sidebar-section-header">
                    <span>폴더</span>
                    <button
                        type="button"
                        className="sidebar-section-action"
                        aria-label="폴더 만들기"
                        title="폴더 만들기"
                        aria-expanded={showFolderForm}
                        onClick={() => {
                            setOpenFolderMenuId(null);
                            setShowFolderForm(current => !current);
                        }}
                    >
                        <FolderPlus size={15} aria-hidden="true" />
                    </button>
                </div>
                {folderLoadFailed && (
                    <div className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
                        <p>폴더를 불러오지 못했습니다.</p>
                        <button
                            type="button"
                            className="mt-1 text-primary underline underline-offset-2 disabled:opacity-50"
                            aria-label="폴더 다시 불러오기"
                            disabled={isLoadingFolders}
                            onClick={() => void loadFolders()}
                        >
                            {isLoadingFolders ? '불러오는 중…' : '다시 불러오기'}
                        </button>
                    </div>
                )}
                {folders.length > 0 && (
                    <div className="sidebar-folder-list" aria-label="폴더" aria-busy={isReorderingFolders}>
                        {folders.map(folder => {
                            const isExpanded = expandedFolderIds.has(folder.id);
                            const recordsInFolder = folderRecords.get(folder.id) ?? [];
                            const visibleCount = folderVisibleCounts[folder.id] ?? 5;
                            const folderIndex = folders.findIndex(item => item.id === folder.id);
                            const canMoveUp = folderIndex > 0
                                && Boolean(folders[folderIndex - 1]?.pinned) === Boolean(folder.pinned);
                            const canMoveDown = folderIndex < folders.length - 1
                                && Boolean(folders[folderIndex + 1]?.pinned) === Boolean(folder.pinned);
                            const dropPosition = folderDropTarget?.folderId === folder.id
                                ? folderDropTarget.position
                                : null;
                            return (
                                <div key={folder.id} className="sidebar-folder-group">
                                    <div
                                        className={[
                                            'group sidebar-folder-row',
                                            draggedFolderId === folder.id ? 'sidebar-folder-row-dragging' : '',
                                            dropPosition ? `sidebar-folder-row-drop-${dropPosition}` : '',
                                        ].filter(Boolean).join(' ')}
                                        data-sidebar-folder-row={folder.id}
                                        data-folder-drop-position={dropPosition ?? undefined}
                                        onDragOver={event => handleFolderDragOver(event, folder)}
                                        onDragLeave={event => {
                                            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                                            if (folderDropTarget?.folderId === folder.id) setFolderDropTarget(null);
                                        }}
                                        onDrop={event => void handleFolderDrop(event, folder)}
                                    >
                                        <button
                                            type="button"
                                            className={`sidebar-folder-button ${isExpanded ? 'sidebar-folder-button-active' : ''}`}
                                            aria-expanded={isExpanded}
                                            aria-controls={`sidebar-folder-records-${folder.id}`}
                                            draggable={!isReorderingFolders}
                                            title={`${folder.name} · 같은 고정 그룹 안에서 끌어서 순서 이동`}
                                            onDragStart={event => handleFolderDragStart(event, folder)}
                                            onDragEnd={handleFolderDragEnd}
                                            onClick={() => {
                                                setExpandedFolderIds(current => {
                                                    const next = new Set(current);
                                                    if (next.has(folder.id)) next.delete(folder.id);
                                                    else next.add(folder.id);
                                                    return next;
                                                });
                                                setOpenMenuId(null);
                                                setOpenFolderMenuId(null);
                                            }}
                                        >
                                            <Folder size={15} aria-hidden="true" />
                                            <span>{folder.name}</span>
                                            {folder.pinned && <Pin size={11} className="sidebar-folder-pin" aria-hidden="true" />}
                                            {isExpanded ? <ChevronDown size={12} className="ml-auto" aria-hidden="true" /> : <ChevronRight size={12} className="ml-auto" aria-hidden="true" />}
                                        </button>
                                        <button
                                            ref={element => {
                                                if (element) folderMenuTriggerRefs.current.set(folder.id, element);
                                                else folderMenuTriggerRefs.current.delete(folder.id);
                                            }}
                                            type="button"
                                            className="icon-button btn-ghost sidebar-folder-menu-trigger h-6 w-6"
                                            aria-label={`${folder.name} 폴더 메뉴`}
                                            title={`${folder.name} 폴더 메뉴`}
                                            aria-haspopup="menu"
                                            aria-expanded={openFolderMenuId === folder.id}
                                            aria-controls={`sidebar-folder-menu-${folder.id}`}
                                            data-sidebar-folder-menu-trigger
                                            onClick={event => {
                                                setOpenMenuId(null);
                                                if (openFolderMenuId === folder.id) {
                                                    setOpenFolderMenuId(null);
                                                    return;
                                                }
                                                const rowBounds = event.currentTarget
                                                    .closest('[data-sidebar-folder-row]')
                                                    ?.getBoundingClientRect();
                                                if (rowBounds) {
                                                    const menuWidth = 144;
                                                    const menuHeight = 190;
                                                    const viewportPadding = 8;
                                                    const spaceBelow = window.innerHeight - rowBounds.bottom;
                                                    const preferredTop = spaceBelow >= menuHeight + viewportPadding
                                                        ? rowBounds.bottom + 4
                                                        : rowBounds.top - menuHeight - 4;
                                                    setFolderMenuPosition({
                                                        top: Math.min(
                                                            Math.max(viewportPadding, preferredTop),
                                                            window.innerHeight - menuHeight - viewportPadding,
                                                        ),
                                                        left: Math.min(
                                                            Math.max(viewportPadding, rowBounds.right - menuWidth),
                                                            window.innerWidth - menuWidth - viewportPadding,
                                                        ),
                                                    });
                                                }
                                                setOpenFolderMenuId(folder.id);
                                            }}
                                            onKeyDown={event => {
                                                if (event.key !== 'Escape' || openFolderMenuId !== folder.id) return;
                                                event.preventDefault();
                                                event.stopPropagation();
                                                closeFolderMenu(folder.id, true);
                                            }}
                                        >
                                            <MoreVertical size={14} />
                                        </button>
                                        {openFolderMenuId === folder.id && (
                                            <div
                                                ref={element => {
                                                    if (element) folderMenuPanelRefs.current.set(folder.id, element);
                                                    else folderMenuPanelRefs.current.delete(folder.id);
                                                }}
                                                id={`sidebar-folder-menu-${folder.id}`}
                                                className="menu-panel sidebar-folder-menu"
                                                style={{ top: folderMenuPosition.top, left: folderMenuPosition.left }}
                                                role="menu"
                                                aria-label={`${folder.name} 폴더 메뉴`}
                                                data-sidebar-folder-menu
                                                onKeyDown={event => handleFolderMenuKeyDown(event, folder.id)}
                                            >
                                                <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => void handleToggleFolderPinned(folder)}>
                                                    {folder.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                                    {folder.pinned ? '고정 해제' : '상단 고정'}
                                                </button>
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    tabIndex={-1}
                                                    className="menu-item"
                                                    disabled={isReorderingFolders || !canMoveUp}
                                                    title={!canMoveUp ? '고정 상태가 같은 폴더끼리 이동할 수 있습니다.' : undefined}
                                                    onClick={() => void handleMoveFolder(folder, -1)}
                                                >
                                                    <ArrowUp size={13} />
                                                    위로 이동
                                                </button>
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    tabIndex={-1}
                                                    className="menu-item"
                                                    disabled={isReorderingFolders || !canMoveDown}
                                                    title={!canMoveDown ? '고정 상태가 같은 폴더끼리 이동할 수 있습니다.' : undefined}
                                                    onClick={() => void handleMoveFolder(folder, 1)}
                                                >
                                                    <ArrowDown size={13} />
                                                    아래로 이동
                                                </button>
                                                <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => void handleRenameFolder(folder)}>
                                                    <Pencil size={13} />
                                                    이름 변경
                                                </button>
                                                <button type="button" role="menuitem" tabIndex={-1} className="menu-item menu-item-danger" onClick={() => void handleDeleteFolder(folder)}>
                                                    <Trash2 size={13} />
                                                    삭제
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div
                                        id={`sidebar-folder-records-${folder.id}`}
                                        className="sidebar-folder-records"
                                        role="group"
                                        aria-label={`${folder.name} 회의록`}
                                        hidden={!isExpanded}
                                    >
                                        {isExpanded && <>
                                            {recordsInFolder.slice(0, visibleCount).map(renderRecord)}
                                            {recordsInFolder.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">회의록이 없습니다.</p>}
                                            {recordsInFolder.length > visibleCount && (
                                                <button
                                                    type="button"
                                                    className="sidebar-folder-more"
                                                    onClick={event => {
                                                        const focusNext = event.detail === 0 && recordsInFolder.length <= visibleCount + 5;
                                                        const group = event.currentTarget.parentElement;
                                                        setFolderVisibleCounts(current => ({ ...current, [folder.id]: visibleCount + 5 }));
                                                        if (focusNext) window.requestAnimationFrame(() => {
                                                            group?.querySelectorAll<HTMLElement>('.sidebar-record-row')[visibleCount]?.querySelector('button')?.focus();
                                                        });
                                                    }}
                                                >더 보기</button>
                                            )}
                                        </>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                {showFolderForm && (
                    <form className="sidebar-folder-form" onSubmit={handleCreateFolder}>
                        <label htmlFor="sidebar-folder-name">새 폴더 이름</label>
                        <input
                            id="sidebar-folder-name"
                            className="input-field"
                            value={folderName}
                            maxLength={40}
                            onChange={event => {
                                setFolderName(event.target.value);
                                setFolderError('');
                            }}
                        />
                        {folderError && <p className="text-xs text-destructive" role="alert">{folderError}</p>}
                        <div>
                            <button type="button" className="btn btn-ghost" onClick={() => {
                                setFolderName('');
                                setFolderError('');
                                setShowFolderForm(false);
                            }}>취소</button>
                            <button type="submit" className="btn btn-primary" disabled={isCreatingFolder || !folderName.trim()}>
                                {isCreatingFolder ? '만드는 중' : '만들기'}
                            </button>
                        </div>
                    </form>
                )}
                <div className="sidebar-section-header">
                    <span className="inline-flex h-6 items-center">회의록</span>
                </div>
                <div className="flex flex-col" data-sidebar-records>
                    {unfiledRecords.length ? (
                        unfiledRecords.map(renderRecord)
                    ) : (
                        <div className="sidebar-empty-note px-3 py-2 leading-relaxed text-muted-foreground">
                            {records.length ? '폴더 없는 회의록이 없습니다.' : '아직 저장된 회의록이 없습니다.'}
                        </div>
                    )}
                </div>
                </div>
                {/* Status dock: analysis progress and unfinished drafts sit above settings so the
                    folder and record lists never shift when they appear. */}
                <div className="sidebar-status-dock">
                    {newMeetingBlocked && (
                        <p id="sidebar-create-blocked" className="sidebar-action-note" role="status">
                            {newMeetingBlockedReason}
                        </p>
                    )}
                    {resumeDrafts.length > 0 && !analysisStatus?.active && (
                        <div>
                            <button
                                type="button"
                                className="resume-summary-button w-full status-neutral"
                                aria-expanded={showResumeDrafts}
                                onClick={() => {
                                    setOpenMenuId(null);
                                    setShowResumeDrafts(current => !current);
                                }}
                            >
                                <span>이어서 할 분석 {resumeDrafts.length}건</span>
                                {showResumeDrafts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                            {showResumeDrafts && (
                                <div className="sidebar-status-dock-list custom-scrollbar">
                                    {resumeSelectionBlocked && resumeDrafts.some(draft => draft.status !== 'active') && (
                                        <p id="sidebar-resume-blocked" className="sidebar-action-note" role="status">
                                            다른 분석이 끝난 뒤 이 기록을 이어갈 수 있습니다.
                                        </p>
                                    )}
                                    {resumeDrafts.some(draft => draft.stage === 'recovering-result') && (
                                        <p id="sidebar-result-recovery-pending" className="sidebar-action-note" role="status">
                                            완료된 결과를 다시 가져오고 있습니다.
                                        </p>
                                    )}
                                    {resumeDrafts.map(draft => {
                                        const tone = getSidebarResumeDraftTone(draft);
                                        const resultRecoveryPending = draft.stage === 'recovering-result';
                                        const selectionBlocked = Boolean(
                                            resultRecoveryPending
                                            || (resumeSelectionBlocked && draft.status !== 'active'),
                                        );
                                        const selectionBlockedDescriptionId = resultRecoveryPending
                                            ? 'sidebar-result-recovery-pending'
                                            : selectionBlocked
                                                ? 'sidebar-resume-blocked'
                                                : undefined;
                                        return (
                                            <button
                                                key={draft.jobId}
                                                type="button"
                                                className={`sidebar-resume-draft-button status-${tone} text-left`}
                                                disabled={selectionBlocked}
                                                aria-describedby={selectionBlockedDescriptionId}
                                                title={resultRecoveryPending
                                                    ? '완료된 분석 결과를 다시 가져오고 있습니다.'
                                                    : selectionBlocked
                                                        ? '진행 중인 분석이 끝난 뒤 이어서 분석할 수 있습니다.'
                                                        : undefined}
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
                    {analysisStatus?.active && activeTab !== 'minutes' && (
                        <button
                            type="button"
                            className="sidebar-analysis-card"
                            onClick={() => onOpenAnalysis?.()}
                        >
                            <span className="sr-only">분석 진행 화면 열기. </span>
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
                </div>
                {(onOpenSettings || onOpenAsrBenchmark) && (
                    <div className="mt-2 grid gap-0.5">
                        {onOpenSettings && (
                            <button
                                type="button"
                                className="sidebar-utility-button"
                                data-settings-focus-fallback
                                onClick={() => {
                                    setOpenMenuId(null);
                                    onOpenSettings();
                                }}
                            >
                                <Settings size={15} />
                                설정
                            </button>
                        )}
                        <UpdateEntry />
                        {onOpenAsrBenchmark && (
                        <button
                            type="button"
                            className={`sidebar-utility-button ${activeTab === 'asr-benchmark' ? 'sidebar-utility-button-active' : ''}`}
                            onClick={onOpenAsrBenchmark}
                        >
                            <BarChart3 size={15} />
                            ASR 테스트 결과
                        </button>
                        )}
                    </div>
                )}
            </div>
            </>}
            {deletionToast && createPortal(
                <AppToast
                    message={deletionToast.message}
                    tone={deletionToast.tone}
                    closeLabel="삭제 알림 닫기"
                    onClose={() => setDeletionToast(null)}
                />,
                document.body,
            )}
        </aside>
    );
};
