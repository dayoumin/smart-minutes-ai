const TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT = 66;

export const formatAnalysisDuration = (milliseconds: number): string => {
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

const isTranscriptReadyStage = (
    message: string,
    progressPercent: number,
    transcriptReady = false,
): boolean => {
    if (transcriptReady) return true;
    const normalized = message.trim();
    return progressPercent >= 100
        || normalized === '대화록 저장이 완료되었습니다. 후속 정리를 확인하고 있습니다.'
        || normalized === 'Summarizing with Local LLM...'
        || normalized === 'Saving results...'
        || normalized.includes('대화록 생성이 완료')
        || normalized.includes('요약 AI가 준비되지 않아')
        || normalized.includes('회의록을 저장했습니다');
};

export const getTranscriptReadyProgressPercent = (
    progressPercent: number,
    message: string,
    transcriptReady = false,
): number => {
    if (isTranscriptReadyStage(message, progressPercent, transcriptReady)) return 100;

    const boundedProgress = Math.min(Math.max(progressPercent, 0), TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT);
    return Math.min(99, (boundedProgress / TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT) * 100);
};

export const formatTranscriptReadyEstimate = (
    elapsedMs: number,
    progressPercent: number,
    message: string,
    transcriptReady = false,
    backendEtaSeconds?: number | null,
): string => {
    if (isTranscriptReadyStage(message, progressPercent, transcriptReady)) return '대화록 준비됨';
    if (typeof backendEtaSeconds === 'number' && Number.isFinite(backendEtaSeconds) && backendEtaSeconds >= 0) {
        return `약 ${formatAnalysisDuration(backendEtaSeconds * 1000)}`;
    }
    if (elapsedMs < 5_000 || progressPercent < 10) return '측정 중';

    const transcriptProgressPercent = Math.max(
        1,
        getTranscriptReadyProgressPercent(progressPercent, message, transcriptReady),
    );
    const estimatedTotalMs = elapsedMs / (transcriptProgressPercent / 100);
    return `약 ${formatAnalysisDuration(estimatedTotalMs)}`;
};
