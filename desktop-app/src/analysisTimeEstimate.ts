const TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT = 85;

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

const isTranscriptReadyStage = (message: string, progressPercent: number): boolean => {
    const normalized = message.trim();
    return progressPercent >= TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT
        || normalized === 'Summarizing with Local LLM...'
        || normalized === 'Saving results...'
        || normalized.includes('요약 AI가 준비되지 않아')
        || normalized.includes('회의록을 저장했습니다');
};

export const getTranscriptReadyProgressPercent = (
    progressPercent: number,
    message: string,
): number => {
    if (isTranscriptReadyStage(message, progressPercent)) return 100;

    const boundedProgress = Math.min(Math.max(progressPercent, 0), TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT);
    return (boundedProgress / TRANSCRIPT_READY_BACKEND_PROGRESS_PERCENT) * 100;
};

export const formatTranscriptReadyEstimate = (
    elapsedMs: number,
    progressPercent: number,
    message: string,
): string => {
    if (isTranscriptReadyStage(message, progressPercent)) return '대화록 준비됨';
    if (elapsedMs < 5_000 || progressPercent < 10) return '측정 중';

    const transcriptProgressPercent = Math.max(1, getTranscriptReadyProgressPercent(progressPercent, message));
    const estimatedTotalMs = elapsedMs / (transcriptProgressPercent / 100);
    return `약 ${formatAnalysisDuration(estimatedTotalMs)}`;
};
