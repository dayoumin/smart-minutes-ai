import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { listAnalysisResumeDrafts } from './analysisResumeDrafts';
import { isTauriRuntime } from './apiBase';
import { LOCAL_ENGINE_NAME, withJosa } from './brand';
import { AppToast, type AppToastMessage } from './components/common';
import {
    deleteMeetingsWithAnalysis,
    deleteStoredAnalyses,
    listStoredAnalyses,
    type MeetingDeletionSummary,
    type StoredAnalysesLookup,
} from './meetingDeletion';
import { getAllMeetings, type MeetingRecord } from './meetingRepository';

type Period = 'all' | '3' | '6' | '12';

const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
    { value: 'all', label: '전체' },
    { value: '3', label: '3개월 지난 회의록' },
    { value: '6', label: '6개월 지난 회의록' },
    { value: '12', label: '1년 지난 회의록' },
];

// Same basis as the sidebar and recent list: when the meeting was recorded, not when it was last edited.
const meetingTimestamp = (meeting: MeetingRecord): number => {
    const value = meeting.createdAt || meeting.date || '';
    const timestamp = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const monthsBefore = (now: number, months: number): number => {
    const date = new Date(now);
    date.setMonth(date.getMonth() - months);
    return date.getTime();
};

const formatDate = (time: number): string => (
    time ? new Date(time).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) : '날짜 없음'
);

const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const engineLaterSentence = (): string => (
    isTauriRuntime()
        ? '이 PC의 분석 파일은 분석 기능이 다시 연결되면 지웁니다.'
        : `이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`
);

const keptSentence = (summary: MeetingDeletionSummary, desktop: boolean): string => {
    const counts = new Map<string, number>();
    for (const item of summary.kept) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    const reasons = [
        counts.get('analysis-active') ? `분석이 진행 중인 ${counts.get('analysis-active')}개` : '',
        counts.get('engine-failed') ? `이 PC의 분석 파일을 지우지 못한 ${counts.get('engine-failed')}개` : '',
        counts.get('cleanup-not-remembered') ? `나중에 지울 분석 파일을 기억하지 못한 ${counts.get('cleanup-not-remembered')}개` : '',
        counts.get('record-failed') ? `${desktop ? '앱' : '브라우저'}에서 지우지 못한 ${counts.get('record-failed')}개` : '',
    ].filter(Boolean);
    const lead = summary.deletedIds.length > 0 ? `${summary.deletedIds.length}개를 삭제했습니다. ` : '';
    const next = counts.get('analysis-active') && reasons.length === 1
        ? '분석을 중단한 뒤 다시 삭제해 주세요.'
        : '잠시 후 다시 삭제해 주세요.';
    const later = summary.deferredCount > 0 ? ` ${engineLaterSentence()}` : '';
    return `${lead}${reasons.join(', ')}는 남겼습니다. ${next}${later}`;
};

type PcFilesState =
    | { status: 'checking' }
    | { status: 'ready'; jobIds: string[]; sizeBytes: number }
    | { status: Exclude<StoredAnalysesLookup['status'], 'ok'> };

interface MeetingCleanupPanelProps {
    onBack: () => void;
    /** Records deleted here, so the app can leave a meeting that no longer exists. */
    onMeetingsDeleted?: (ids: string[]) => void;
    /** True while a deletion runs, so the settings dialog does not close or switch away from its result. */
    onBusyChange?: (busy: boolean) => void;
}

export const MeetingCleanupPanel: React.FC<MeetingCleanupPanelProps> = ({ onBack, onMeetingsDeleted, onBusyChange }) => {
    const desktop = isTauriRuntime();
    const [records, setRecords] = useState<MeetingRecord[] | null>(null);
    const [recordsFailed, setRecordsFailed] = useState(false);
    const [period, setPeriod] = useState<Period>('all');
    // Taken when the period is picked, so the list does not shift while it is open.
    const [cutoff, setCutoff] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null);
    const [keptMessage, setKeptMessage] = useState('');
    const [pcFiles, setPcFiles] = useState<PcFilesState>({ status: 'checking' });
    const [pcDeleting, setPcDeleting] = useState(false);
    const [pcMessage, setPcMessage] = useState('');
    const [toast, setToast] = useState<AppToastMessage | null>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const headCheckboxRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        headingRef.current?.focus();
        return () => { mountedRef.current = false; };
    }, []);

    const busy = Boolean(deleting) || pcDeleting;
    useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);
    useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

    // A button that turned disabled or went away drops focus to the page; bring it back into this view.
    const keepFocusInView = () => {
        const active = document.activeElement;
        if (!active || active === document.body || (active instanceof HTMLButtonElement && active.disabled)) {
            headingRef.current?.focus();
        }
    };

    useEffect(() => {
        if (!toast) return undefined;
        const timerId = window.setTimeout(() => setToast(current => (current?.id === toast.id ? null : current)), 5000);
        return () => window.clearTimeout(timerId);
    }, [toast]);

    const checkPcFiles = useCallback(async (knownRecords: MeetingRecord[]) => {
        setPcFiles({ status: 'checking' });
        const lookup = await listStoredAnalyses();
        if (!mountedRef.current) return;
        if (lookup.status !== 'ok') {
            setPcFiles({ status: lookup.status });
            return;
        }
        // Analyses this browser still uses: its records (some older ones are stored under the job id itself) and
        // the analyses it can still resume or import.
        const usedJobIds = new Set([
            ...knownRecords.flatMap(record => (record.jobId ? [record.id, record.jobId] : [record.id])),
            ...listAnalysisResumeDrafts().map(draft => draft.jobId),
        ]);
        const leftovers = lookup.analyses.filter(analysis => !usedJobIds.has(analysis.jobId));
        setPcFiles({
            status: 'ready',
            jobIds: leftovers.map(analysis => analysis.jobId),
            sizeBytes: leftovers.reduce((total, analysis) => total + analysis.sizeBytes, 0),
        });
    }, []);

    // Null when the records could not be read: an empty list would make every analysis on this PC a leftover.
    const loadRecords = useCallback(async (): Promise<MeetingRecord[] | null> => {
        const loaded = await getAllMeetings().catch(() => null);
        if (!loaded) {
            if (mountedRef.current) setRecordsFailed(true);
            return null;
        }
        const sorted = [...loaded].sort((left, right) => meetingTimestamp(right) - meetingTimestamp(left));
        if (mountedRef.current) {
            setRecordsFailed(false);
            setRecords(sorted);
        }
        return sorted;
    }, []);

    const refresh = useCallback(async () => {
        const loaded = await loadRecords();
        if (loaded) await checkPcFiles(loaded);
        else if (mountedRef.current) setPcFiles({ status: 'failed' });
    }, [checkPcFiles, loadRecords]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const visibleRecords = useMemo(() => {
        if (!records) return [];
        if (cutoff === null) return records;
        return records.filter(record => meetingTimestamp(record) < cutoff);
    }, [cutoff, records]);

    // Selection follows what is shown, so deleting never touches a record the filter hid.
    const visibleSelectedIds = visibleRecords.filter(record => selectedIds.has(record.id)).map(record => record.id);
    const allSelected = visibleRecords.length > 0 && visibleSelectedIds.length === visibleRecords.length;
    const someSelected = visibleSelectedIds.length > 0 && !allSelected;

    useEffect(() => {
        if (headCheckboxRef.current) headCheckboxRef.current.indeterminate = someSelected;
    }, [someSelected]);

    const toggleRecord = (id: string) => {
        setKeptMessage('');
        setSelectedIds(current => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        setKeptMessage('');
        setSelectedIds(allSelected ? new Set() : new Set(visibleRecords.map(record => record.id)));
    };

    const changePeriod = (value: Period) => {
        setPeriod(value);
        setCutoff(value === 'all' ? null : monthsBefore(Date.now(), Number(value)));
        setKeptMessage('');
        setSelectedIds(new Set());
    };

    const deleteSelected = async () => {
        const targets = visibleRecords.filter(record => selectedIds.has(record.id));
        if (targets.length === 0 || deleting) return;
        if (!window.confirm(`회의록 ${targets.length}개를 삭제할까요?\n\n회의 기록과 이 PC의 분석 결과가 함께 삭제됩니다. 다운로드 폴더에 저장한 파일은 직접 삭제해야 합니다.`)) return;
        setKeptMessage('');
        setDeleting({ done: 0, total: targets.length });
        const summary = await deleteMeetingsWithAnalysis(targets, done => {
            if (mountedRef.current) setDeleting({ done, total: targets.length });
        });
        if (summary.deletedIds.length > 0) {
            window.dispatchEvent(new Event('meetings:updated'));
            onMeetingsDeleted?.(summary.deletedIds);
        }
        if (!mountedRef.current) return;
        setDeleting(null);
        // Records that stayed remain selected, so trying again is one click.
        setSelectedIds(new Set(summary.kept.map(item => item.id)));
        if (summary.kept.length > 0) {
            setKeptMessage(keptSentence(summary, desktop));
        } else {
            setToast({
                id: Date.now(),
                tone: 'neutral',
                message: `회의록 ${summary.deletedIds.length}개를 삭제했습니다.${summary.deferredCount > 0 ? ` ${engineLaterSentence()}` : ''}`,
            });
        }
        await refresh();
        keepFocusInView();
    };

    const deletePcFiles = async () => {
        if (pcFiles.status !== 'ready' || pcFiles.jobIds.length === 0 || pcDeleting || !records) return;
        const count = pcFiles.jobIds.length;
        const question = desktop
            ? `이 PC에만 남은 분석 결과 ${count}개를 삭제할까요?`
            : `이 PC에만 남은 분석 결과 ${count}개를 삭제할까요?\n\n같은 PC를 다른 브라우저에서도 쓴다면, 그 브라우저 회의록의 분석 결과도 함께 지워집니다.`;
        if (!window.confirm(question)) return;
        setPcMessage('');
        setPcDeleting(true);
        const outcome = await deleteStoredAnalyses(pcFiles.jobIds);
        if (!mountedRef.current) return;
        setPcDeleting(false);
        if (outcome.interrupted || outcome.activeCount > 0 || outcome.failedCount > 0) {
            setPcMessage([
                outcome.deletedCount > 0 ? `${outcome.deletedCount}개를 삭제했습니다.` : '',
                outcome.activeCount > 0 ? `분석이 진행 중인 ${outcome.activeCount}개는 남겼습니다.` : '',
                outcome.failedCount > 0 ? `${outcome.failedCount}개는 지우지 못했습니다. 잠시 후 다시 시도해 주세요.` : '',
                outcome.interrupted
                    ? (isTauriRuntime()
                        ? '분석 기능과 연결이 끊겨 나머지는 지우지 못했습니다.'
                        : `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 응답하지 않아 나머지는 지우지 못했습니다.`)
                    : '',
            ].filter(Boolean).join(' '));
        } else {
            setToast({ id: Date.now(), tone: 'neutral', message: `이 PC의 분석 결과 ${outcome.deletedCount}개를 삭제했습니다.` });
        }
        await checkPcFiles(records);
        keepFocusInView();
    };

    const pcSentence = (() => {
        switch (pcFiles.status) {
            case 'checking': return '이 PC에 남은 분석 파일을 확인하고 있습니다.';
            case 'engine-unreachable': return isTauriRuntime()
                ? '분석 기능이 연결되면 확인할 수 있습니다.'
                : `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중일 때 확인할 수 있습니다.`;
            case 'engine-outdated': return `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 업데이트하면 확인할 수 있습니다.`;
            case 'failed': return '이 PC에 남은 분석 파일을 확인하지 못했습니다. 잠시 후 다시 열어 주세요.';
            case 'ready': return pcFiles.jobIds.length === 0 ? '이 PC에만 남은 분석 파일이 없습니다.' : '';
        }
    })();

    const totalCount = records?.length ?? 0;
    return (
        <section className="settings-page meeting-cleanup" aria-labelledby="meeting-cleanup-title">
            <div className="meeting-cleanup-heading">
                <button type="button" className="meeting-cleanup-back" disabled={busy} onClick={onBack}>
                    <ChevronLeft size={16} aria-hidden="true" />
                    일반 설정
                </button>
                <h3 id="meeting-cleanup-title" ref={headingRef} tabIndex={-1}>회의록 정리</h3>
                <p>회의록을 골라 한 번에 지웁니다. 지운 회의록의 분석 결과는 이 PC에서도 함께 지웁니다.</p>
            </div>

            <div className="settings-group">
                <h4 id="meeting-cleanup-records-title">{desktop ? '이 앱의 회의록' : '이 브라우저의 회의록'}</h4>
                <div className="settings-list meeting-cleanup-card" aria-busy={records === null || Boolean(deleting)}>
                    <div className="meeting-cleanup-toolbar">
                        <label htmlFor="meeting-cleanup-period">기간</label>
                        <select
                            id="meeting-cleanup-period"
                            className="select-field meeting-cleanup-period"
                            value={period}
                            disabled={Boolean(deleting)}
                            onChange={event => changePeriod(event.target.value as Period)}
                        >
                            {PERIOD_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        <span className="meeting-cleanup-count">
                            {records === null ? '' : period === 'all' ? `전체 ${totalCount}개` : `전체 ${totalCount}개 중 ${visibleRecords.length}개`}
                        </span>
                    </div>
                    {records === null ? (
                        recordsFailed
                            ? <p className="meeting-cleanup-empty" role="alert">회의록을 불러오지 못했습니다. 설정을 닫았다가 다시 열어 주세요.</p>
                            : <p className="meeting-cleanup-empty">회의록을 불러오고 있습니다.</p>
                    ) : visibleRecords.length === 0 ? (
                        <p className="meeting-cleanup-empty">
                            {totalCount === 0
                                ? (desktop ? '이 앱에 저장된 회의록이 없습니다.' : '이 브라우저에 저장된 회의록이 없습니다.')
                                : '이 기간에 해당하는 회의록이 없습니다.'}
                        </p>
                    ) : (
                        <>
                            <label className="meeting-cleanup-row meeting-cleanup-row-head">
                                <input
                                    ref={headCheckboxRef}
                                    type="checkbox"
                                    className="meeting-cleanup-checkbox"
                                    checked={allSelected}
                                    disabled={Boolean(deleting) || visibleRecords.length === 0}
                                    onChange={toggleAll}
                                />
                                <span className="meeting-cleanup-title">표시된 {visibleRecords.length}개 모두 선택</span>
                                <span className="meeting-cleanup-selected" aria-live="polite">{visibleSelectedIds.length}개 선택됨</span>
                            </label>
                            <ul className="meeting-cleanup-list custom-scrollbar" aria-labelledby="meeting-cleanup-records-title">
                                {visibleRecords.map(record => {
                                    const time = meetingTimestamp(record);
                                    return (
                                        <li key={record.id}>
                                            <label className="meeting-cleanup-row">
                                                <input
                                                    type="checkbox"
                                                    className="meeting-cleanup-checkbox"
                                                    checked={selectedIds.has(record.id)}
                                                    disabled={Boolean(deleting)}
                                                    onChange={() => toggleRecord(record.id)}
                                                />
                                                <span className="meeting-cleanup-title">{record.title || '제목 없는 회의록'}</span>
                                                <span className="meeting-cleanup-date">{formatDate(time)}</span>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                    <div className="meeting-cleanup-actions">
                        {keptMessage
                            ? <p className="meeting-cleanup-kept" role="alert">{keptMessage}</p>
                            : <p className="meeting-cleanup-hint">다운로드 폴더에 저장한 파일은 직접 지워 주세요.</p>}
                        <button
                            type="button"
                            className="btn btn-outline meeting-cleanup-danger"
                            disabled={visibleSelectedIds.length === 0 || Boolean(deleting)}
                            onClick={() => void deleteSelected()}
                        >
                            {deleting
                                ? `삭제하는 중 ${deleting.done}/${deleting.total}`
                                : visibleSelectedIds.length > 0 ? `선택한 ${visibleSelectedIds.length}개 삭제` : '선택한 회의록 삭제'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <h4>이 PC에만 남은 분석 파일</h4>
                <div className="settings-list">
                    <div className="meeting-cleanup-pc" aria-busy={pcFiles.status === 'checking' || pcDeleting}>
                        <div className="meeting-cleanup-pc-copy">
                            {pcFiles.status === 'ready' && pcFiles.jobIds.length > 0 ? (
                                <>
                                    <span className="meeting-cleanup-pc-title">분석 결과 {pcFiles.jobIds.length}개 · {formatBytes(pcFiles.sizeBytes)}</span>
                                    <span className="meeting-cleanup-pc-description">
                                        {desktop
                                            ? '이 앱의 회의록과 연결되지 않은 분석 결과입니다.'
                                            : '이 브라우저의 회의록과 연결되지 않은 분석 결과입니다. 같은 PC를 다른 브라우저에서도 쓴다면, 그 브라우저 회의록의 분석 결과도 함께 지워집니다.'}
                                    </span>
                                </>
                            ) : (
                                <span className="meeting-cleanup-pc-status" role="status">{pcSentence}</span>
                            )}
                            {pcMessage && <span className="meeting-cleanup-kept" role="alert">{pcMessage}</span>}
                        </div>
                        {pcFiles.status === 'ready' && pcFiles.jobIds.length > 0 && (
                            <button
                                type="button"
                                className="btn btn-outline meeting-cleanup-danger"
                                disabled={pcDeleting}
                                onClick={() => void deletePcFiles()}
                            >
                                {pcDeleting ? '삭제하는 중' : '모두 삭제'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
            {toast && createPortal(
                <AppToast message={toast.message} tone={toast.tone} closeLabel="정리 알림 닫기" onClose={() => setToast(null)} />,
                document.body,
            )}
        </section>
    );
};
