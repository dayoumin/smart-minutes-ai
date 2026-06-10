export type AnalysisResumeDraftStatus = 'active' | 'cancelled' | 'stopped' | 'failed' | 'completed' | 'unavailable';
export type AnalysisResumeDraftUnavailableReason = 'no-checkpoint' | 'file-mismatch' | 'completed' | 'not-candidate';

export interface AnalysisResumeDraft {
    jobId: string;
    title: string;
    date: string;
    participants: string;
    meetingPurpose?: string;
    sourceFilename: string;
    sourceSize: number;
    sourceLastModified: number;
    status: AnalysisResumeDraftStatus;
    createdAt: string;
    updatedAt: string;
    stage?: string;
    lastMessage?: string;
    lastProgress?: number;
    lastEtaSeconds?: number | null;
    transcriptReady?: boolean;
    errorMessage?: string;
    resumeEligible?: boolean;
    resumeUnavailableReason?: AnalysisResumeDraftUnavailableReason;
    completedChunkCount?: number;
}

export interface AnalysisResumeDraftFileKey {
    sourceFilename: string;
    sourceSize: number;
    sourceLastModified: number;
}

const STORAGE_KEY = 'analysisResumeDrafts';
const SUPPRESSED_STORAGE_KEY = 'suppressedResumeCandidateKeys';
const PENDING_CLEANUP_STORAGE_KEY = 'pendingAnalysisDraftCleanups';
const UPDATED_EVENT = 'analysis-resume-drafts:updated';

const canUseStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const readDrafts = (): AnalysisResumeDraft[] => {
    if (!canUseStorage()) return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as AnalysisResumeDraft[] : [];
    } catch {
        return [];
    }
};

const writeDrafts = (drafts: AnalysisResumeDraft[]): void => {
    if (!canUseStorage()) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
};

export const ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT = UPDATED_EVENT;

export const getResumeDraftKey = (value: AnalysisResumeDraftFileKey): string => (
    `${value.sourceFilename}::${value.sourceSize}::${value.sourceLastModified}`
);

export const listAnalysisResumeDrafts = (): AnalysisResumeDraft[] => (
    readDrafts().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
);

export const getAnalysisResumeDraft = (jobId: string): AnalysisResumeDraft | undefined => (
    readDrafts().find(draft => draft.jobId === jobId)
);

export const listSuppressedResumeCandidateKeys = (): string[] => {
    if (!canUseStorage()) return [];
    try {
        const raw = window.localStorage.getItem(SUPPRESSED_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
};

const writeSuppressedResumeCandidateKeys = (keys: string[]): void => {
    if (!canUseStorage()) return;
    window.localStorage.setItem(SUPPRESSED_STORAGE_KEY, JSON.stringify(keys));
    window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
};

export const suppressResumeCandidateKey = (key: string): void => {
    const current = listSuppressedResumeCandidateKeys();
    if (current.includes(key)) return;
    writeSuppressedResumeCandidateKeys([...current, key]);
};

export const unsuppressResumeCandidateKey = (key: string): void => {
    const current = listSuppressedResumeCandidateKeys();
    if (!current.includes(key)) return;
    writeSuppressedResumeCandidateKeys(current.filter(item => item !== key));
};

export const listPendingAnalysisDraftCleanups = (): string[] => {
    if (!canUseStorage()) return [];
    try {
        const raw = window.localStorage.getItem(PENDING_CLEANUP_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
};

const writePendingAnalysisDraftCleanups = (jobIds: string[]): void => {
    if (!canUseStorage()) return;
    const uniqueJobIds = [...new Set(jobIds)].filter(Boolean);
    window.localStorage.setItem(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify(uniqueJobIds));
    window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
};

export const queuePendingAnalysisDraftCleanup = (jobId: string): void => {
    const current = listPendingAnalysisDraftCleanups();
    if (current.includes(jobId)) return;
    writePendingAnalysisDraftCleanups([...current, jobId]);
};

export const removePendingAnalysisDraftCleanup = (jobId: string): void => {
    const current = listPendingAnalysisDraftCleanups();
    if (!current.includes(jobId)) return;
    writePendingAnalysisDraftCleanups(current.filter(item => item !== jobId));
};

export const upsertAnalysisResumeDraft = (draft: AnalysisResumeDraft): void => {
    const drafts = readDrafts();
    const next = drafts.filter(item => item.jobId !== draft.jobId);
    next.push(draft);
    writeDrafts(next);
};

export const removeAnalysisResumeDraft = (jobId: string): void => {
    const drafts = readDrafts();
    const next = drafts.filter(item => item.jobId !== jobId);
    if (next.length === drafts.length) return;
    writeDrafts(next);
};

export const dismissAnalysisResumeDraft = (draft: AnalysisResumeDraft): void => {
    suppressResumeCandidateKey(getResumeDraftKey(draft));
    removeAnalysisResumeDraft(draft.jobId);
};

export const removeAnalysisResumeDraftsForKey = (
    value: AnalysisResumeDraftFileKey,
    options: { clearSuppression?: boolean } = {},
): void => {
    const draftKey = getResumeDraftKey(value);
    const drafts = readDrafts();
    const next = drafts.filter(item => getResumeDraftKey(item) !== draftKey);
    const draftsChanged = next.length !== drafts.length;
    const currentSuppressed = listSuppressedResumeCandidateKeys();
    const suppressionChanged = options.clearSuppression !== false && currentSuppressed.includes(draftKey);

    if (draftsChanged) {
        writeDrafts(next);
    }

    if (suppressionChanged) {
        writeSuppressedResumeCandidateKeys(currentSuppressed.filter(item => item !== draftKey));
    }
};

export const markAnalysisResumeDraftUnavailable = (
    jobId: string,
    reason: AnalysisResumeDraftUnavailableReason,
    options: {
        status?: Extract<AnalysisResumeDraftStatus, 'completed' | 'unavailable'>;
        errorMessage?: string;
        updatedAt?: string;
    } = {},
): void => {
    const drafts = readDrafts();
    let changed = false;
    const next = drafts.map(draft => {
        if (draft.jobId !== jobId) return draft;
        changed = true;
        return {
            ...draft,
            status: options.status || (reason === 'completed' ? 'completed' : 'unavailable'),
            updatedAt: options.updatedAt || new Date().toISOString(),
            resumeEligible: false,
            resumeUnavailableReason: reason,
            errorMessage: options.errorMessage || draft.errorMessage,
        };
    });
    if (changed) writeDrafts(next);
};

export const markAnalysisResumeDraftsForKeyUnavailable = (
    value: AnalysisResumeDraftFileKey,
    reason: AnalysisResumeDraftUnavailableReason,
    options: {
        status?: Extract<AnalysisResumeDraftStatus, 'completed' | 'unavailable'>;
        errorMessage?: string;
        updatedAt?: string;
        exceptJobId?: string | null;
        clearSuppression?: boolean;
    } = {},
): void => {
    const draftKey = getResumeDraftKey(value);
    const now = options.updatedAt || new Date().toISOString();
    const drafts = readDrafts();
    let draftsChanged = false;
    const next = drafts.map(draft => {
        if (getResumeDraftKey(draft) !== draftKey || draft.jobId === options.exceptJobId) return draft;
        draftsChanged = true;
        return {
            ...draft,
            status: options.status || (reason === 'completed' ? 'completed' : 'unavailable'),
            updatedAt: now,
            resumeEligible: false,
            resumeUnavailableReason: reason,
            errorMessage: options.errorMessage || draft.errorMessage,
        };
    });
    const currentSuppressed = listSuppressedResumeCandidateKeys();
    const suppressionChanged = options.clearSuppression !== false && currentSuppressed.includes(draftKey);

    if (draftsChanged) {
        writeDrafts(next);
    }

    if (suppressionChanged) {
        writeSuppressedResumeCandidateKeys(currentSuppressed.filter(item => item !== draftKey));
    }
};
