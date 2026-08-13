const claimedJobIds = new Set<string>();
const mutationQueues = new Map<string, Promise<void>>();
const CLAIMS_UPDATED_EVENT = 'analysis-job-runtime:claims-updated';

export const ANALYSIS_JOB_CLAIMS_UPDATED_EVENT = CLAIMS_UPDATED_EVENT;

export const claimAnalysisJob = (jobId: string): boolean => {
    if (!jobId) return false;
    if (claimedJobIds.has(jobId)) return true;
    if (mutationQueues.has(jobId)) return false;
    claimedJobIds.add(jobId);
    window.dispatchEvent(new CustomEvent(CLAIMS_UPDATED_EVENT));
    return true;
};

export const releaseAnalysisJob = (jobId: string | null | undefined): void => {
    if (!jobId || !claimedJobIds.delete(jobId)) return;
    window.dispatchEvent(new CustomEvent(CLAIMS_UPDATED_EVENT));
};

export const isAnalysisJobClaimed = (jobId: string): boolean => claimedJobIds.has(jobId);

export const queueAnalysisJobMutation = <T,>(
    jobId: string,
    mutation: () => Promise<T>,
): Promise<T> => {
    const previous = mutationQueues.get(jobId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const settled = result.then(() => undefined, () => undefined);
    mutationQueues.set(jobId, settled);
    void settled.finally(() => {
        if (mutationQueues.get(jobId) === settled) {
            mutationQueues.delete(jobId);
        }
    });
    return result;
};
