export const MAX_ANALYSIS_DURATION_SECONDS = 2 * 60 * 60;
export const ANALYSIS_DURATION_LIMIT_MESSAGE = '2시간 이하의 음성·영상 파일을 선택해 주세요.';

/** Browser metadata is advisory; the server checks the actual media before analysis. */
export const getAnalysisDurationLimitError = (durationSeconds: number | null | undefined): string | null => (
    typeof durationSeconds === 'number'
    && Number.isFinite(durationSeconds)
    && durationSeconds > MAX_ANALYSIS_DURATION_SECONDS
        ? ANALYSIS_DURATION_LIMIT_MESSAGE
        : null
);
