import { isAnalysisJobClaimed, queueAnalysisJobMutation } from './analysisJobRuntime';
import { listAnalysisResumeDrafts } from './analysisResumeDrafts';
import { localEngineClient } from './localEngineClient';
import { deleteMeeting, getAllMeetings, type MeetingRecord } from './meetingRepository';

// Engine copies of deleted meetings that still have to be deleted. A record deleted while the engine did not
// answer leaves its analysis on this PC; the recovery sync retries these until the engine confirms each one.
const PENDING_CLEANUP_STORAGE_KEY = 'pendingMeetingOutputCleanups';

export const listPendingMeetingOutputCleanups = (): string[] => {
    try {
        const raw = window.localStorage.getItem(PENDING_CLEANUP_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
    } catch {
        return [];
    }
};

const writePendingMeetingOutputCleanups = (jobIds: string[]): boolean => {
    try {
        const unique = [...new Set(jobIds)];
        if (unique.length === 0) window.localStorage.removeItem(PENDING_CLEANUP_STORAGE_KEY);
        else window.localStorage.setItem(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify(unique));
        return true;
    } catch {
        return false;
    }
};

/** False when the job could not be remembered; the caller must then keep the record instead of deleting it. */
export const queuePendingMeetingOutputCleanup = (jobId: string): boolean => {
    const current = listPendingMeetingOutputCleanups();
    if (current.includes(jobId)) return true;
    return writePendingMeetingOutputCleanups([...current, jobId]);
};

export const removePendingMeetingOutputCleanup = (jobId: string): boolean => {
    const current = listPendingMeetingOutputCleanups();
    if (!current.includes(jobId)) return true;
    return writePendingMeetingOutputCleanups(current.filter(item => item !== jobId));
};

export type MeetingDeletionResult =
    /** The record and its copy on this PC are gone. */
    | 'deleted'
    /** The record is gone; its copy on this PC is deleted the next time the engine answers. */
    | 'deleted-engine-later'
    /** Kept: the analysis is still running. */
    | 'analysis-active'
    /** Kept: the engine answered but could not delete its copy. */
    | 'engine-failed'
    /** Kept: the engine did not answer and this browser could not remember the cleanup. */
    | 'cleanup-not-remembered';

/** Deletes a meeting record and its analysis on this PC, so the record never outlives a copy nobody can find. */
export const deleteMeetingWithAnalysis = async (
    record: Pick<MeetingRecord, 'id' | 'jobId'>,
    /** The engine already failed to answer in this batch; queue the copy instead of asking again. */
    options: { engineUnreachable?: boolean } = {},
): Promise<MeetingDeletionResult> => {
    const jobId = record.jobId;
    if (jobId) {
        const response = options.engineUnreachable ? null : await localEngineClient.request(`/api/outputs/${encodeURIComponent(jobId)}`, {
            method: 'DELETE',
        }).catch(() => null);
        if (!response) {
            if (!queuePendingMeetingOutputCleanup(jobId)) return 'cleanup-not-remembered';
            try {
                await deleteMeeting(record.id);
            } catch (error) {
                // The record is still here, so its analysis must stay too.
                removePendingMeetingOutputCleanup(jobId);
                throw error;
            }
            return 'deleted-engine-later';
        }
        if (!response.ok && response.status !== 404) {
            const detail = await response.json().catch(() => null) as { detail?: string } | null;
            return response.status === 409 && detail?.detail === 'analysis_job_active' ? 'analysis-active' : 'engine-failed';
        }
    }
    await deleteMeeting(record.id);
    return 'deleted';
};

export interface MeetingDeletionSummary {
    deletedIds: string[];
    /** Deleted records whose copy on this PC waits for the engine. */
    deferredCount: number;
    kept: Array<{ id: string; reason: Exclude<MeetingDeletionResult, 'deleted' | 'deleted-engine-later'> | 'record-failed' }>;
}

/** Deletes records one at a time, so one refusal (a running analysis) never stops the rest. */
export const deleteMeetingsWithAnalysis = async (
    records: Array<Pick<MeetingRecord, 'id' | 'jobId'>>,
    onProgress?: (done: number) => void,
): Promise<MeetingDeletionSummary> => {
    const summary: MeetingDeletionSummary = { deletedIds: [], deferredCount: 0, kept: [] };
    let engineUnreachable = false;
    for (const [index, record] of records.entries()) {
        try {
            const result = await deleteMeetingWithAnalysis(record, { engineUnreachable });
            // One unanswered request is enough: waiting for every record's refusal would stall the whole batch.
            if (result === 'deleted-engine-later') engineUnreachable = true;
            if (result === 'deleted' || result === 'deleted-engine-later') {
                summary.deletedIds.push(record.id);
                if (result === 'deleted-engine-later') summary.deferredCount += 1;
            } else {
                summary.kept.push({ id: record.id, reason: result });
            }
        } catch {
            summary.kept.push({ id: record.id, reason: 'record-failed' });
        }
        onProgress?.(index + 1);
    }
    return summary;
};

export interface StoredAnalysis {
    jobId: string;
    completedAt: string;
    sizeBytes: number;
}

export type StoredAnalysesLookup =
    | { status: 'ok'; analyses: StoredAnalysis[] }
    | { status: 'engine-unreachable' }
    /** An engine from before the listing existed refuses (web session) or does not know (desktop) the route. */
    | { status: 'engine-outdated' }
    | { status: 'failed' };

/** Completed analyses kept on this PC, whichever browser's records they belong to. */
export const listStoredAnalyses = async (): Promise<StoredAnalysesLookup> => {
    const response = await localEngineClient.request('/api/stored-analyses').catch(() => null);
    if (!response) return { status: 'engine-unreachable' };
    if (response.status === 403 || response.status === 404) return { status: 'engine-outdated' };
    if (!response.ok) return { status: 'failed' };
    const payload = await response.json().catch(() => null) as { analyses?: unknown } | null;
    if (!Array.isArray(payload?.analyses)) return { status: 'failed' };
    const analyses = payload.analyses.flatMap((row): StoredAnalysis[] => {
        if (!row || typeof row !== 'object') return [];
        const { job_id: jobId, completed_at: completedAt, size_bytes: sizeBytes } = row as Record<string, unknown>;
        if (typeof jobId !== 'string' || !jobId) return [];
        return [{
            jobId,
            completedAt: typeof completedAt === 'string' ? completedAt : '',
            sizeBytes: typeof sizeBytes === 'number' && sizeBytes > 0 ? sizeBytes : 0,
        }];
    });
    return { status: 'ok', analyses };
};

export interface StoredAnalysesDeletion {
    deletedCount: number;
    /** Still running, so the engine kept them. */
    activeCount: number;
    /** The engine answered but could not delete them (a locked file, for example). */
    failedCount: number;
    /** The engine stopped answering or stopped accepting this browser part way; the rest were not tried. */
    interrupted: boolean;
}

/** Deletes analyses on this PC that no record of this browser uses. */
export const deleteStoredAnalyses = async (jobIds: string[]): Promise<StoredAnalysesDeletion> => {
    const outcome: StoredAnalysesDeletion = { deletedCount: 0, activeCount: 0, failedCount: 0, interrupted: false };
    for (const jobId of jobIds) {
        const response = await localEngineClient.request(`/api/outputs/${encodeURIComponent(jobId)}`, {
            method: 'DELETE',
        }).catch(() => null);
        if (!response || response.status === 401 || response.status === 403) {
            outcome.interrupted = true;
            break;
        }
        if (response.ok || response.status === 404) {
            outcome.deletedCount += 1;
            removePendingMeetingOutputCleanup(jobId);
        } else if (response.status === 409) {
            outcome.activeCount += 1;
        } else {
            outcome.failedCount += 1;
        }
    }
    return outcome;
};

/**
 * Retries the queued deletions of this PC's copies. A job an analysis claims is skipped, and a job a record or
 * draft uses again (the same file resumed under the same job) leaves the queue: its files are no longer leftovers.
 */
export const flushPendingMeetingOutputCleanups = async (): Promise<void> => {
    const queued = listPendingMeetingOutputCleanups();
    if (queued.length === 0) return;
    // Without the records this browser cannot tell which jobs are in use again, so it waits for the next try.
    const records = await getAllMeetings().catch(() => null);
    if (!records) return;
    const usedJobIds = new Set(records.flatMap(record => (record.jobId ? [record.id, record.jobId] : [record.id])));
    for (const draft of listAnalysisResumeDrafts()) usedJobIds.add(draft.jobId);
    for (const jobId of queued) {
        if (usedJobIds.has(jobId)) {
            removePendingMeetingOutputCleanup(jobId);
            continue;
        }
        if (isAnalysisJobClaimed(jobId)) continue;
        const outcome = await queueAnalysisJobMutation(jobId, async () => {
            if (isAnalysisJobClaimed(jobId)) return 'skipped';
            const response = await localEngineClient.request(`/api/outputs/${encodeURIComponent(jobId)}`, {
                method: 'DELETE',
            }).catch(() => null);
            if (!response || response.status === 401 || response.status === 403) return 'unreachable';
            if (response.ok || response.status === 404) removePendingMeetingOutputCleanup(jobId);
            return 'answered';
        });
        // Every remaining item would get the same no-answer or refusal; try again on the next sync.
        if (outcome === 'unreachable') break;
    }
};
