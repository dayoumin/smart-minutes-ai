import { useSyncExternalStore } from 'react';
import {
    ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT,
    ANALYSIS_RESUME_DRAFTS_VOLATILE_UPDATED_EVENT,
    AnalysisResumeDraft,
    listAnalysisResumeDrafts,
    listPendingCancelledAnalysisCleanups,
} from './analysisResumeDrafts';

export type AnalysisResumeSyncStatus = 'idle' | 'syncing' | 'ready' | 'error';
export const ANALYSIS_RECOVERY_SYNC_REQUESTED_EVENT = 'analysis-recovery:sync-requested';

export interface AnalysisResumeSnapshot {
    syncStatus: AnalysisResumeSyncStatus;
    lastSuccessfulSyncAt: string | null;
    drafts: AnalysisResumeDraft[];
    pendingCancelledCleanupJobIds: string[];
    error: string | null;
}

type Listener = () => void;

let snapshot: AnalysisResumeSnapshot = {
    syncStatus: 'idle',
    lastSuccessfulSyncAt: null,
    drafts: listAnalysisResumeDrafts(),
    pendingCancelledCleanupJobIds: listPendingCancelledAnalysisCleanups(),
    error: null,
};

const listeners = new Set<Listener>();

const emit = (): void => {
    listeners.forEach(listener => listener());
};

export const getAnalysisResumeSnapshot = (): AnalysisResumeSnapshot => snapshot;

export const refreshAnalysisResumeSnapshot = (): AnalysisResumeSnapshot => {
    const drafts = listAnalysisResumeDrafts();
    const pendingCancelledCleanupJobIds = listPendingCancelledAnalysisCleanups();
    snapshot = { ...snapshot, drafts, pendingCancelledCleanupJobIds };
    emit();
    return snapshot;
};

export const setAnalysisResumeSyncState = (
    syncStatus: AnalysisResumeSyncStatus,
    options: {
        error?: string | null;
        successfulAt?: string | null;
        refreshDrafts?: boolean;
    } = {},
): AnalysisResumeSnapshot => {
    snapshot = {
        ...snapshot,
        syncStatus,
        lastSuccessfulSyncAt: options.successfulAt === undefined
            ? snapshot.lastSuccessfulSyncAt
            : options.successfulAt,
        drafts: options.refreshDrafts === false ? snapshot.drafts : listAnalysisResumeDrafts(),
        pendingCancelledCleanupJobIds: options.refreshDrafts === false
            ? snapshot.pendingCancelledCleanupJobIds
            : listPendingCancelledAnalysisCleanups(),
        error: options.error === undefined ? snapshot.error : options.error,
    };
    emit();
    return snapshot;
};

const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

if (typeof window !== 'undefined') {
    window.addEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, refreshAnalysisResumeSnapshot);
    window.addEventListener(ANALYSIS_RESUME_DRAFTS_VOLATILE_UPDATED_EVENT, refreshAnalysisResumeSnapshot);
}

export const useAnalysisResumeSnapshot = (): AnalysisResumeSnapshot => (
    useSyncExternalStore(subscribe, getAnalysisResumeSnapshot, getAnalysisResumeSnapshot)
);

export const requestAnalysisRecoverySync = (): void => {
    window.dispatchEvent(new CustomEvent(ANALYSIS_RECOVERY_SYNC_REQUESTED_EVENT));
};

export const isVisibleRecoveryDraft = (draft: AnalysisResumeDraft): boolean => (
    draft.status === 'active'
    || draft.stage === 'recovering-result'
    || (
        draft.status !== 'completed'
        && draft.status !== 'unavailable'
        && draft.resumeEligible !== false
    )
);

export const isActionableResumeDraft = (
    draft: AnalysisResumeDraft,
    currentSnapshot: AnalysisResumeSnapshot = snapshot,
): boolean => (
    currentSnapshot.syncStatus === 'ready'
    && draft.status !== 'active'
    && draft.status !== 'completed'
    && draft.status !== 'unavailable'
    && draft.resumeEligible === true
);

export const selectVisibleRecoveryDrafts = (
    currentSnapshot: AnalysisResumeSnapshot = snapshot,
): AnalysisResumeDraft[] => currentSnapshot.drafts.filter(isVisibleRecoveryDraft);

export const selectPrimaryRecoveryDraft = (
    currentSnapshot: AnalysisResumeSnapshot = snapshot,
): AnalysisResumeDraft | null => {
    const visible = selectVisibleRecoveryDrafts(currentSnapshot);
    return visible.find(draft => draft.status === 'active')
        || visible.find(draft => isActionableResumeDraft(draft, currentSnapshot))
        || visible[0]
        || null;
};
