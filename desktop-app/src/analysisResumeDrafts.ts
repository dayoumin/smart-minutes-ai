import type { ReportTemplate, TermGlossary } from './meetingKnowledge';

export type AnalysisResumeDraftStatus = 'active' | 'cancelled' | 'stopped' | 'failed' | 'completed' | 'unavailable';
export type AnalysisResumeDraftUnavailableReason = 'no-checkpoint' | 'file-mismatch' | 'completed' | 'not-candidate';

export interface AnalysisResumeDraft {
    jobId: string;
    title: string;
    date: string;
    participants: string;
    meetingPurpose?: string;
    selectedReportTemplateId?: string;
    reportTemplate?: ReportTemplate;
    selectedTermGlossaryIds?: string[];
    termGlossaries?: TermGlossary[];
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
const PENDING_CANCEL_CLEANUP_STORAGE_KEY = 'pendingCancelledAnalysisCleanups';
const UPDATED_EVENT = 'analysis-resume-drafts:updated';
const VOLATILE_UPDATED_EVENT = 'analysis-resume-drafts:volatile-updated';

const canUseStorage = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return typeof window.localStorage !== 'undefined';
    } catch {
        return false;
    }
};

let volatileDrafts: AnalysisResumeDraft[] | null = null;

const readDrafts = (): AnalysisResumeDraft[] => {
    if (volatileDrafts) return volatileDrafts;
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

const writeDrafts = (drafts: AnalysisResumeDraft[]): boolean => {
    if (!canUseStorage()) {
        volatileDrafts = drafts;
        return false;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
        volatileDrafts = null;
        window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
        return true;
    } catch (error) {
        volatileDrafts = drafts;
        window.dispatchEvent(new CustomEvent(VOLATILE_UPDATED_EVENT));
        console.warn('Unable to persist analysis resume drafts:', error);
        return false;
    }
};

export const hasPendingAnalysisResumeDraftPersistence = (): boolean => volatileDrafts !== null;

export const flushPendingAnalysisResumeDraftPersistence = (): boolean => (
    volatileDrafts ? writeDrafts(volatileDrafts) : true
);

export const ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT = UPDATED_EVENT;
export const ANALYSIS_RESUME_DRAFTS_VOLATILE_UPDATED_EVENT = VOLATILE_UPDATED_EVENT;

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
    try {
        window.localStorage.setItem(SUPPRESSED_STORAGE_KEY, JSON.stringify(keys));
        window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
    } catch (error) {
        console.warn('Unable to persist suppressed resume candidates:', error);
    }
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

const writePendingAnalysisDraftCleanups = (jobIds: string[]): boolean => {
    if (!canUseStorage()) return false;
    const uniqueJobIds = [...new Set(jobIds)].filter(Boolean);
    try {
        window.localStorage.setItem(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify(uniqueJobIds));
        window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
        return true;
    } catch (error) {
        console.warn('Unable to persist pending analysis draft cleanups:', error);
        return false;
    }
};

export const queuePendingAnalysisDraftCleanup = (jobId: string): boolean => {
    const current = listPendingAnalysisDraftCleanups();
    if (current.includes(jobId)) return true;
    return writePendingAnalysisDraftCleanups([...current, jobId]);
};

export const removePendingAnalysisDraftCleanup = (jobId: string): boolean => {
    const current = listPendingAnalysisDraftCleanups();
    if (!current.includes(jobId)) return true;
    return writePendingAnalysisDraftCleanups(current.filter(item => item !== jobId));
};

export const listPendingCancelledAnalysisCleanups = (): string[] => {
    if (!canUseStorage()) return [];
    try {
        const raw = window.localStorage.getItem(PENDING_CANCEL_CLEANUP_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
};

const writePendingCancelledAnalysisCleanups = (jobIds: string[]): boolean => {
    if (!canUseStorage()) return false;
    const uniqueJobIds = [...new Set(jobIds)].filter(Boolean);
    try {
        window.localStorage.setItem(PENDING_CANCEL_CLEANUP_STORAGE_KEY, JSON.stringify(uniqueJobIds));
        window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
        return true;
    } catch (error) {
        console.warn('Unable to persist pending cancelled analysis cleanups:', error);
        return false;
    }
};

export const queuePendingCancelledAnalysisCleanup = (jobId: string): boolean => {
    const current = listPendingCancelledAnalysisCleanups();
    if (current.includes(jobId)) return true;
    return writePendingCancelledAnalysisCleanups([...current, jobId]);
};

export const removePendingCancelledAnalysisCleanup = (jobId: string): boolean => {
    const current = listPendingCancelledAnalysisCleanups();
    if (!current.includes(jobId)) return true;
    return writePendingCancelledAnalysisCleanups(current.filter(item => item !== jobId));
};

export const upsertAnalysisResumeDraft = (draft: AnalysisResumeDraft): boolean => {
    const drafts = readDrafts();
    const existing = drafts.find(item => item.jobId === draft.jobId);
    if (existing && JSON.stringify(existing) === JSON.stringify(draft)) {
        return volatileDrafts ? writeDrafts(drafts) : true;
    }
    const next = drafts.filter(item => item.jobId !== draft.jobId);
    next.push(draft);
    return writeDrafts(next);
};

export const removeAnalysisResumeDraft = (jobId: string): boolean => {
    const drafts = readDrafts();
    const next = drafts.filter(item => item.jobId !== jobId);
    if (next.length === drafts.length) return true;
    return writeDrafts(next);
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
): boolean => {
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
    if (!changed) return true;
    return writeDrafts(next);
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
