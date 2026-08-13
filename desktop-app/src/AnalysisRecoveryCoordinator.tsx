import React, { useCallback, useEffect, useRef } from 'react';
import {
    AnalysisResumeDraft,
    AnalysisResumeDraftStatus,
    ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT,
    getAnalysisResumeDraft,
    getResumeDraftKey,
    listAnalysisResumeDrafts,
    listPendingAnalysisDraftCleanups,
    listPendingCancelledAnalysisCleanups,
    markAnalysisResumeDraftUnavailable,
    removeAnalysisResumeDraft,
    removePendingAnalysisDraftCleanup,
    removePendingCancelledAnalysisCleanup,
    upsertAnalysisResumeDraft,
} from './analysisResumeDrafts';
import { ANALYSIS_RECOVERY_SYNC_REQUESTED_EVENT, setAnalysisResumeSyncState } from './analysisResumeState';
import { ANALYSIS_JOB_CLAIMS_UPDATED_EVENT, isAnalysisJobClaimed, queueAnalysisJobMutation } from './analysisJobRuntime';
import { getApiBase, writeFrontendLog } from './apiBase';
import {
    AnalyzeResult,
    deleteMeetingRecordForJob,
    DraftStatusPayload,
    meetingRecordFromSavedAnalysis,
    updateMeetingAnalysisStatus,
    upsertMeetingRecord,
} from './MeetingWriter';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const ACTIVE_SYNC_INTERVAL_MS = 10_000;

const dispatchMeetingsUpdated = (id: string): void => {
    window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id, openHistory: false },
    }));
};

export const AnalysisRecoveryCoordinator: React.FC = () => {
    const syncInFlightRef = useRef(false);
    const syncQueuedRef = useRef(false);
    const mountedRef = useRef(true);

    const syncRecovery = useCallback(async (): Promise<void> => {
        if (syncInFlightRef.current) {
            syncQueuedRef.current = true;
            return;
        }

        syncInFlightRef.current = true;
        setAnalysisResumeSyncState('syncing', { error: null });

        try {
            let localDrafts = listAnalysisResumeDrafts();
            if (ANALYSIS_MODE !== 'real') {
                setAnalysisResumeSyncState('ready', {
                    error: null,
                    successfulAt: new Date().toISOString(),
                });
                return;
            }

            const pendingCancelledJobIds = new Set(listPendingCancelledAnalysisCleanups());
            const pendingJobIds = [...new Set([
                ...listPendingAnalysisDraftCleanups(),
                ...pendingCancelledJobIds,
            ])];
            const unclaimedPendingJobIds = pendingJobIds.filter(jobId => !isAnalysisJobClaimed(jobId));
            const unclaimedDrafts = localDrafts.filter(draft => !isAnalysisJobClaimed(draft.jobId));

            if (unclaimedPendingJobIds.length === 0 && unclaimedDrafts.length === 0) {
                setAnalysisResumeSyncState('ready', {
                    error: null,
                    successfulAt: new Date().toISOString(),
                });
                return;
            }

            const apiBase = await getApiBase();

            for (const jobId of unclaimedPendingJobIds) {
                let localCleanupSucceeded = true;
                if (pendingCancelledJobIds.has(jobId)) {
                    try {
                        await queueAnalysisJobMutation(jobId, async () => {
                            if (isAnalysisJobClaimed(jobId)) return;
                            await deleteMeetingRecordForJob(jobId);
                            removeAnalysisResumeDraft(jobId);
                            dispatchMeetingsUpdated(jobId);
                        });
                    } catch (error) {
                        localCleanupSucceeded = false;
                        await writeFrontendLog(`pending cancelled meeting cleanup error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                    }
                }

                try {
                    const response = await fetch(`${apiBase}/api/analyze/drafts/${encodeURIComponent(jobId)}`, {
                        method: 'DELETE',
                    });
                    if (localCleanupSucceeded && (response.ok || response.status === 404)) {
                        removePendingAnalysisDraftCleanup(jobId);
                        removePendingCancelledAnalysisCleanup(jobId);
                    }
                } catch {
                    // Keep cleanup queued until the backend is available again.
                }
            }

            localDrafts = listAnalysisResumeDrafts().filter(draft => !isAnalysisJobClaimed(draft.jobId));
            if (localDrafts.length > 0) {
                const response = await fetch(`${apiBase}/api/analyze/draft-statuses`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_ids: localDrafts.map(draft => draft.jobId) }),
                });
                if (!response.ok) {
                    throw new Error(`미완료 분석 상태 확인 실패 (${response.status})`);
                }

                const payload = await response.json() as DraftStatusPayload;
                const remoteDrafts = payload.drafts || [];
                const now = new Date().toISOString();

                for (const draft of localDrafts) {
                    if (isAnalysisJobClaimed(draft.jobId)) continue;
                    const currentDraft = getAnalysisResumeDraft(draft.jobId);
                    if (!currentDraft || currentDraft.status === 'completed' || currentDraft.status === 'unavailable') {
                        continue;
                    }

                    const remote = remoteDrafts.find(item => item.job_id === draft.jobId);
                    if (!remote || remote.status === 'missing') {
                        markAnalysisResumeDraftUnavailable(draft.jobId, 'no-checkpoint', {
                            errorMessage: '재사용 가능한 체크포인트를 찾지 못했습니다.',
                            updatedAt: now,
                        });
                        continue;
                    }

                    const remoteTranscriptReady = Boolean(
                        remote.last_progress?.transcript_ready
                        || remote.last_progress?.transcriptReady
                        || currentDraft.transcriptReady,
                    );
                    const remoteExplicitCancellation = remote.status === 'cancelled'
                        && currentDraft.status !== 'cancelled'
                        && currentDraft.status !== 'stopped';

                    if (remoteExplicitCancellation) {
                        try {
                            await queueAnalysisJobMutation(draft.jobId, async () => {
                                if (isAnalysisJobClaimed(draft.jobId)) return;
                                await deleteMeetingRecordForJob(draft.jobId);
                                dispatchMeetingsUpdated(draft.jobId);
                            });
                        } catch (error) {
                            await writeFrontendLog(`cancelled meeting recovery cleanup error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                        }
                    }

                    let completedResultImported = remote.status !== 'completed';
                    if (!remoteExplicitCancellation && (remote.status === 'completed' || remoteTranscriptReady)) {
                        try {
                            const savedResultResponse = await fetch(
                                `${apiBase}/api/analyze/${encodeURIComponent(draft.jobId)}/recoverable-result`,
                            );
                            if (!savedResultResponse.ok) {
                                throw new Error(`saved result unavailable: ${savedResultResponse.status}`);
                            }
                            const savedResult = await savedResultResponse.json() as AnalyzeResult;
                            const recoveryDraft: AnalysisResumeDraft = {
                                ...currentDraft,
                                status: remote.status === 'failed'
                                    ? 'failed'
                                    : remote.status === 'stopped'
                                        ? 'stopped'
                                        : remote.status === 'cancelled'
                                            ? 'cancelled'
                                            : currentDraft.status,
                            };
                            const savedMeetingId = await queueAnalysisJobMutation(draft.jobId, async () => {
                                if (isAnalysisJobClaimed(draft.jobId)) return null;
                                const latestDraft = getAnalysisResumeDraft(draft.jobId);
                                if (!latestDraft || latestDraft.status === 'completed' || latestDraft.status === 'unavailable') {
                                    return null;
                                }
                                return upsertMeetingRecord(meetingRecordFromSavedAnalysis(savedResult, recoveryDraft));
                            });
                            if (savedMeetingId) {
                                dispatchMeetingsUpdated(savedMeetingId);
                                if (remote.status === 'completed') completedResultImported = true;
                            }
                        } catch (error) {
                            await writeFrontendLog(`analysis recovery import error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                            if (remote.status === 'completed') {
                                upsertAnalysisResumeDraft({
                                    ...currentDraft,
                                    lastMessage: '완료된 분석 결과를 다시 가져오고 있습니다.',
                                    errorMessage: '완료된 결과를 아직 가져오지 못했습니다. 잠시 후 다시 확인합니다.',
                                });
                                continue;
                            }
                            if (remote.status === 'failed' || remote.status === 'stopped') {
                                await queueAnalysisJobMutation(
                                    draft.jobId,
                                    async () => {
                                        if (isAnalysisJobClaimed(draft.jobId)) return;
                                        await updateMeetingAnalysisStatus(
                                            draft.jobId,
                                            remote.status === 'failed' ? 'diarization_failed' : 'diarization_stopped',
                                        );
                                    },
                                );
                            }
                        }
                    }

                    if (remote.status === 'completed') {
                        if (!completedResultImported) continue;
                        const completedDraftKey = getResumeDraftKey(currentDraft);
                        listAnalysisResumeDrafts()
                            .filter(candidate => (
                                getResumeDraftKey(candidate) === completedDraftKey
                                && !isAnalysisJobClaimed(candidate.jobId)
                            ))
                            .forEach(candidate => markAnalysisResumeDraftUnavailable(candidate.jobId, 'completed', {
                                status: 'completed',
                                errorMessage: '분석이 완료되어 이어할 필요가 없습니다. 결과는 회의 기록에서 확인하세요.',
                                updatedAt: now,
                            }));
                        continue;
                    }

                    const keepLocalCancellation = (remote.status === 'active' || remote.status === 'cancelled')
                        && (currentDraft.status === 'cancelled' || currentDraft.status === 'stopped');
                    const nextStatus: AnalysisResumeDraftStatus = keepLocalCancellation
                        ? currentDraft.status
                        : remote.status === 'cancelled'
                            ? 'cancelled'
                            : remote.status === 'active'
                                ? 'active'
                                : remote.status === 'stopped'
                                    ? 'stopped'
                                    : 'failed';
                    const resumeEligible = Boolean(remote.resume_supported) && Number(remote.completed_chunk_count || 0) > 0;
                    const nextDraft: AnalysisResumeDraft = {
                        ...currentDraft,
                        status: nextStatus,
                        updatedAt: remote.updated_at || currentDraft.updatedAt,
                        stage: remote.stage || currentDraft.stage,
                        lastMessage: remote.last_progress?.message || currentDraft.lastMessage,
                        lastProgress: typeof remote.last_progress?.progress === 'number'
                            ? remote.last_progress.progress
                            : currentDraft.lastProgress,
                        lastEtaSeconds: remote.last_progress
                            ? Object.prototype.hasOwnProperty.call(remote.last_progress, 'eta_seconds')
                                ? (typeof remote.last_progress.eta_seconds === 'number' ? remote.last_progress.eta_seconds : null)
                                : Object.prototype.hasOwnProperty.call(remote.last_progress, 'etaSeconds')
                                    ? (typeof remote.last_progress.etaSeconds === 'number' ? remote.last_progress.etaSeconds : null)
                                    : null
                            : currentDraft.lastEtaSeconds,
                        transcriptReady: Boolean(remoteTranscriptReady),
                        errorMessage: remote.last_error || (resumeEligible ? undefined : currentDraft.errorMessage),
                        resumeEligible,
                        resumeUnavailableReason: resumeEligible ? undefined : currentDraft.resumeUnavailableReason,
                        completedChunkCount: Number(remote.completed_chunk_count || 0),
                    };
                    if (
                        nextDraft.status !== currentDraft.status
                        || nextDraft.updatedAt !== currentDraft.updatedAt
                        || nextDraft.stage !== currentDraft.stage
                        || nextDraft.lastMessage !== currentDraft.lastMessage
                        || nextDraft.lastProgress !== currentDraft.lastProgress
                        || nextDraft.lastEtaSeconds !== currentDraft.lastEtaSeconds
                        || nextDraft.transcriptReady !== currentDraft.transcriptReady
                        || nextDraft.errorMessage !== currentDraft.errorMessage
                        || nextDraft.resumeEligible !== currentDraft.resumeEligible
                        || nextDraft.completedChunkCount !== currentDraft.completedChunkCount
                    ) {
                        upsertAnalysisResumeDraft(nextDraft);
                    }
                }
            }

            if (mountedRef.current) {
                setAnalysisResumeSyncState('ready', {
                    error: null,
                    successfulAt: new Date().toISOString(),
                });
            }
        } catch (error) {
            if (mountedRef.current) {
                setAnalysisResumeSyncState('error', {
                    error: error instanceof Error ? error.message : '미완료 분석 상태를 확인하지 못했습니다.',
                });
            }
        } finally {
            syncInFlightRef.current = false;
            if (syncQueuedRef.current && mountedRef.current) {
                syncQueuedRef.current = false;
                window.setTimeout(() => void syncRecovery(), 0);
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void syncRecovery();
        const handleSync = () => void syncRecovery();
        const intervalId = window.setInterval(() => {
            if (
                listAnalysisResumeDrafts().some(draft => draft.status === 'active')
                || listPendingAnalysisDraftCleanups().length > 0
                || listPendingCancelledAnalysisCleanups().length > 0
            ) {
                void syncRecovery();
            }
        }, ACTIVE_SYNC_INTERVAL_MS);
        window.addEventListener('focus', handleSync);
        window.addEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, handleSync);
        window.addEventListener(ANALYSIS_RECOVERY_SYNC_REQUESTED_EVENT, handleSync);
        window.addEventListener(ANALYSIS_JOB_CLAIMS_UPDATED_EVENT, handleSync);
        return () => {
            mountedRef.current = false;
            window.clearInterval(intervalId);
            window.removeEventListener('focus', handleSync);
            window.removeEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, handleSync);
            window.removeEventListener(ANALYSIS_RECOVERY_SYNC_REQUESTED_EVENT, handleSync);
            window.removeEventListener(ANALYSIS_JOB_CLAIMS_UPDATED_EVENT, handleSync);
        };
    }, [syncRecovery]);

    return null;
};
