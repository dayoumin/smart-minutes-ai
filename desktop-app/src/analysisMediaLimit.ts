export const MAX_ANALYSIS_DURATION_SECONDS = 2 * 60 * 60;
export const ANALYSIS_DURATION_LIMIT_MESSAGE = '2시간 이하의 음성·영상 파일을 선택해 주세요.';

// Rounded up so a file just over the limit never reads as "약 2시간".
const formatOverLimitDuration = (durationSeconds: number): string => {
    const totalMinutes = Math.ceil(durationSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
};

/** Browser metadata is advisory; the server checks the actual media before analysis. */
export const getAnalysisDurationLimitError = (durationSeconds: number | null | undefined): string | null => (
    typeof durationSeconds === 'number'
    && Number.isFinite(durationSeconds)
    && durationSeconds > MAX_ANALYSIS_DURATION_SECONDS
        ? `선택한 파일은 약 ${formatOverLimitDuration(durationSeconds)}입니다. ${ANALYSIS_DURATION_LIMIT_MESSAGE}`
        : null
);
