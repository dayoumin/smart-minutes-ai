import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, AudioLines, BarChart3, ChevronDown, ChevronUp, Clock3, Folder, FolderPlus, Loader2, MoreVertical, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { AnalysisResumeDraft } from './analysisResumeDrafts';
import type { AppView } from './appView';
import { selectVisibleRecoveryDrafts, useAnalysisResumeSnapshot } from './analysisResumeState';
import {
    addMeetingFolder,
    deleteMeetingFolder,
    deleteMeeting,
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
import { toApiUrl } from './apiBase';
import { ProgressBar } from './ProgressBar';
import { formatAnalysisDuration, formatTranscriptReadyEstimate, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';

export interface SidebarProps {
    activeTab?: AppView;
    selectedMeetingId?: string | null;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string, fallbackId: string | null) => void;
    onSelectResumeDraft?: (jobId: string) => void;
    onOpenStart?: () => void;
    onOpenArchive?: () => void;
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
    resumeSelectionBlocked?: boolean;
    onOpenSettings?: () => void;
    onOpenAsrBenchmark?: () => void;
    analysisStatus?: {
        active: boolean;
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

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, selectedMeetingId, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenStart, onOpenArchive, newMeetingBlocked, newMeetingBlockedReason = '진행 중인 분석이 끝나면 새 기록을 만들 수 있습니다.', resumeSelectionBlocked, onOpenSettings, onOpenAsrBenchmark, analysisStatus }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [folders, setFolders] = useState<MeetingFolder[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
    const [showFolderForm, setShowFolderForm] = useState(false);
    const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [folderName, setFolderName] = useState('');
    const [folderError, setFolderError] = useState('');
    const resumeSnapshot = useAnalysisResumeSnapshot();
    const resumeDrafts = useMemo(() => selectVisibleRecoveryDrafts(resumeSnapshot), [resumeSnapshot]);
    const [showResumeDrafts, setShowResumeDrafts] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showAllRecords, setShowAllRecords] = useState(false);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [folderDropTarget, setFolderDropTarget] = useState<{ folderId: string; position: 'before' | 'after' } | null>(null);
    const [isReorderingFolders, setIsReorderingFolders] = useState(false);
    const [folderMenuPosition, setFolderMenuPosition] = useState({ top: 0, left: 0 });
    const [recordMenuPosition, setRecordMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const sidebarRef = useRef<HTMLElement | null>(null);
    const createMeetingButtonRef = useRef<HTMLButtonElement | null>(null);
    const folderMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const folderMenuPanelRefs = useRef(new Map<string, HTMLDivElement>());
    const pendingFolderMenuFocusRef = useRef<string | null>(null);
    const recordMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const recordMenuPanelRefs = useRef(new Map<string, HTMLDivElement>());
    const pendingRecordMenuFocusRef = useRef<{ recordId: string; fallbackRecordId: string | null } | null>(null);
    const draggedFolderIdRef = useRef<string | null>(null);
    const folderOrderSavingRef = useRef(false);
    const recordsListRef = useRef<HTMLDivElement | null>(null);

    const loadRecords = async () => {
        try {
            const data = await getAllMeetings();
            setRecords(data);
        } catch {
            const pendingFocus = pendingRecordMenuFocusRef.current;
            pendingRecordMenuFocusRef.current = null;
            if (!pendingFocus) return;
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
                createMeetingButtonRef.current?.focus();
            });
        }
    };

    const loadFolders = async () => {
        try {
            const data = await getAllMeetingFolders();
            setFolders(sortMeetingFolders(data));
            const pendingFocusId = pendingFolderMenuFocusRef.current;
            pendingFolderMenuFocusRef.current = null;
            if (pendingFocusId) {
                window.requestAnimationFrame(() => folderMenuTriggerRefs.current.get(pendingFocusId)?.focus());
            }
        } catch {
            setFolders([]);
        }
    };

    useEffect(() => {
        void loadRecords();
        void loadFolders();
        window.addEventListener('focus', loadRecords);
        window.addEventListener('meetings:updated', loadRecords);
        window.addEventListener('meetings:updated', loadFolders);
        return () => {
            window.removeEventListener('focus', loadRecords);
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
    const filteredRecords = useMemo(
        () => sortedRecords.filter(record => {
            if (!activeFolderId) return true;
            return record.folderId === activeFolderId;
        }),
        [activeFolderId, sortedRecords],
    );
    const visibleRecords = useMemo(
        () => showAllRecords ? filteredRecords : filteredRecords.slice(0, 10),
        [filteredRecords, showAllRecords],
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
            createMeetingButtonRef.current?.focus();
        });
    };

    const closeRecordMenu = (recordId: string, restoreFocus = false) => {
        setOpenMenuId(null);
        if (restoreFocus) focusRecordMenuTrigger(recordId);
    };

    useEffect(() => {
        if (!openMenuId) return;
        let focusFrame = 0;
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
            focusFrame = window.requestAnimationFrame(() => {
                panel.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
            });
        });
        return () => {
            window.cancelAnimationFrame(frame);
            if (focusFrame) window.cancelAnimationFrame(focusFrame);
            setRecordMenuPosition(null);
        };
    }, [openMenuId]);

    useEffect(() => {
        const pendingFocus = pendingRecordMenuFocusRef.current;
        if (!pendingFocus) return;
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
            createMeetingButtonRef.current?.focus();
        });
    }, [visibleRecords]);


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
                    'button:not([disabled]), select:not([disabled])',
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
            pendingRecordMenuFocusRef.current = { recordId: record.id, fallbackRecordId };
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
            const folder = await addMeetingFolder(nextName);
            await loadFolders();
            setActiveFolderId(folder.id);
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
        pendingRecordMenuFocusRef.current = { recordId: record.id, fallbackRecordId };
        await moveMeetingToFolder(record.id, folderId || undefined);
        setOpenMenuId(null);
        window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: record.id } }));
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
        if (activeFolderId === folder.id) setActiveFolderId(null);
        setOpenFolderMenuId(null);
        window.dispatchEvent(new Event('meetings:updated'));
        window.requestAnimationFrame(() => {
            const fallbackTrigger = fallbackFolderId ? folderMenuTriggerRefs.current.get(fallbackFolderId) : null;
            if (fallbackTrigger?.isConnected) fallbackTrigger.focus();
            else createMeetingButtonRef.current?.focus();
        });
    };

    const handleDeleteRecord = async (record: MeetingRecord) => {
        const recordIndex = visibleRecords.findIndex(item => item.id === record.id);
        const fallbackRecordId = visibleRecords[recordIndex + 1]?.id ?? visibleRecords[recordIndex - 1]?.id ?? null;
        closeRecordMenu(record.id, true);
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
        onDeleteMeeting?.(record.id, fallbackRecordId);
        focusRecordMenuTrigger(fallbackRecordId);
    };

    return (
        <aside ref={sidebarRef} className="barorok-navigation relative z-10 flex h-full max-h-none w-[17rem] shrink-0 flex-col border-r border-border p-4">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {(activeTab === 'minutes' || activeTab === 'start') && (
                    <button type="button" className="sidebar-ocean-brand" aria-label="바로록 시작 화면" onClick={onOpenStart}>
                        <span className="app-brand-mark" aria-hidden="true"><AudioLines size={22} /></span>
                        <span className="app-brand-copy">
                            <strong>바로록</strong>
                            <small>개인용 로컬 회의록</small>
                        </span>
                    </button>
                )}
                <button
                    ref={createMeetingButtonRef}
                    type="button"
                    className="sidebar-create-button mb-3"
                    disabled={newMeetingBlocked}
                    aria-describedby={newMeetingBlocked ? 'sidebar-create-blocked' : undefined}
                    title={newMeetingBlocked ? newMeetingBlockedReason : undefined}
                    onClick={() => {
                        setOpenMenuId(null);
                        onCreateMeeting?.();
                    }}
                >
                    {analysisStatus?.active ? <Clock3 size={17} /> : <Plus size={17} />}
                    {analysisStatus?.active ? '진행 중인 분석 보기' : '새 기록'}
                </button>
                {newMeetingBlocked && (
                    <p id="sidebar-create-blocked" className="sidebar-action-note" role="status">
                        {newMeetingBlockedReason}
                    </p>
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
                <div className="sidebar-folder-toolbar">
                    <button
                        type="button"
                        className="sidebar-folder-create-button"
                        aria-label="폴더 만들기"
                        aria-expanded={showFolderForm}
                        onClick={() => {
                            setOpenFolderMenuId(null);
                            setShowFolderForm(current => !current);
                        }}
                    >
                        <FolderPlus size={16} />
                        <span>폴더 만들기</span>
                    </button>
                </div>
                {folders.length > 0 && (
                    <div className="sidebar-folder-list" aria-label="폴더" aria-busy={isReorderingFolders}>
                        {folders.map(folder => {
                            const isActive = activeFolderId === folder.id;
                            const folderIndex = folders.findIndex(item => item.id === folder.id);
                            const canMoveUp = folderIndex > 0
                                && Boolean(folders[folderIndex - 1]?.pinned) === Boolean(folder.pinned);
                            const canMoveDown = folderIndex < folders.length - 1
                                && Boolean(folders[folderIndex + 1]?.pinned) === Boolean(folder.pinned);
                            const dropPosition = folderDropTarget?.folderId === folder.id
                                ? folderDropTarget.position
                                : null;
                            return (
                                <div
                                    key={folder.id}
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
                                        className={`sidebar-folder-button ${isActive ? 'sidebar-folder-button-active' : ''}`}
                                        aria-pressed={isActive}
                                        draggable={!isReorderingFolders}
                                        title={`${folder.name} · 같은 고정 그룹 안에서 끌어서 순서 이동`}
                                        onDragStart={event => handleFolderDragStart(event, folder)}
                                        onDragEnd={handleFolderDragEnd}
                                        onClick={() => {
                                            setActiveFolderId(current => current === folder.id ? null : folder.id);
                                            setOpenFolderMenuId(null);
                                            setShowAllRecords(false);
                                            window.requestAnimationFrame(() => {
                                                recordsListRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                                            });
                                        }}
                                    >
                                        <Folder size={15} aria-hidden="true" />
                                        <span>{folder.name}</span>
                                        {folder.pinned && <Pin size={11} className="sidebar-folder-pin" aria-hidden="true" />}
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
                                                    ? '진행 중인 분석이 끝난 뒤 이어서 기록할 수 있습니다.'
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
                <div ref={recordsListRef} className="flex flex-col" data-sidebar-records>
                    {visibleRecords.length ? (
                        visibleRecords.map(record => {
                            const isSelected = activeTab === 'history' && selectedMeetingId === record.id;
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
                                        <div className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                                            {record.title}
                                        </div>
                                    </button>
                                    <div className="sidebar-record-meta-slot">
                                        <span
                                            className="sidebar-record-age truncate text-[11px] text-muted-foreground"
                                            data-sidebar-record-age
                                            title={record.date}
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
                                        className="menu-panel fixed z-20 w-44 text-xs"
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
                                        <label className="sidebar-record-folder-field">
                                            <span>폴더</span>
                                            <select
                                                className="select-field"
                                                aria-label={`${record.title} 폴더`}
                                                value={record.folderId ?? ''}
                                                onChange={event => void handleMoveRecord(record, event.target.value)}
                                            >
                                                <option value="">폴더 없음</option>
                                                {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                                            </select>
                                        </label>
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
                        })
                    ) : (
                        <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            {activeFolderId
                                ? '이 폴더에는 회의록이 없습니다.'
                                : '아직 저장된 회의록이 없습니다.'}
                        </div>
                    )}
                    {filteredRecords.length > 10 && (
                        <button
                            type="button"
                            className="mt-2 rounded-md px-3 py-2 text-left text-xs font-medium text-primary hover:bg-primary/5"
                            onClick={() => setShowAllRecords(current => !current)}
                        >
                            {showAllRecords ? '접기' : '더 보기'}
                        </button>
                    )}
                </div>
                </div>
                {(onOpenSettings || onOpenAsrBenchmark) && (
                    <div className="mt-3 grid gap-1 border-t border-border pt-3">
                        {onOpenSettings && (
                            <button
                                type="button"
                                className="sidebar-utility-button"
                                onClick={() => {
                                    setOpenMenuId(null);
                                    onOpenSettings();
                                }}
                            >
                                <Settings size={15} />
                                설정
                            </button>
                        )}
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
        </aside>
    );
};
