import type { MeetingSegment, TranscriptReviewIssue } from './meetingRepository';

export const reviewReasonLabels: Record<TranscriptReviewIssue['reason'], string> = {
    timing_estimated: '문장별 발화 시각을 추정한 구간',
    timing_legacy: '이전 분석에서 시각을 추정·보정한 구간(세부 사유 없음)',
    timestamp_adjusted: '음성 조각의 경계에 맞춰 시각을 보정한 구간',
    speaker_unassigned: '참석자를 배정하지 못한 구간',
    speaker_split: '한 인식 구간의 내용을 참석자별로 나눈 구간',
    short_speaker_overlap: '짧은 다른 참석자 구간이 걸쳐 있는 부분',
    speaker_coverage_gap: '참석자 음성 구간 사이에 빈틈이 있는 부분',
    speaker_coverage_overlap: '서로 다른 참석자 음성 구간이 겹치는 부분',
    speaker_review: '이전 분석에서 참석자 확인 대상으로 남긴 구간',
};

const toSeconds = (value: string): number => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
export const isUnassignedSpeaker = (speaker: string): boolean => /^(unknown|unassigned)$/i.test(speaker.trim());
export const isTimingReview = (issue: TranscriptReviewIssue): boolean => issue.reason === 'timing_estimated' || issue.reason === 'timing_legacy' || issue.reason === 'timestamp_adjusted';

export const normalizeReviewIssues = (values: unknown): TranscriptReviewIssue[] => {
    if (!Array.isArray(values)) return [];
    const unique = new Map<string, TranscriptReviewIssue>();
    for (const value of values) {
        if (!value || typeof value !== 'object' || typeof value.reason !== 'string'
            || !Object.hasOwn(reviewReasonLabels, value.reason)
            || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.start < 0 || value.end < value.start) continue;
        const entry: TranscriptReviewIssue = { reason: value.reason as TranscriptReviewIssue['reason'], start: value.start, end: value.end };
        unique.set(`${entry.reason}:${entry.start}:${entry.end}`, entry);
    }
    return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.reason.localeCompare(b.reason));
};

const legacyIssues = (segment: MeetingSegment): TranscriptReviewIssue[] => {
    const reasons: TranscriptReviewIssue['reason'][] = [];
    if (segment.timingApproximate) reasons.push('timing_legacy');
    if (segment.shortSpeakerOverlap || segment.short_speaker_overlap) reasons.push('short_speaker_overlap');
    if (segment.speakerSplitCoverageGap || segment.speaker_split_coverage_gap) reasons.push('speaker_coverage_gap');
    if (segment.speakerSplitCoverageOverlap || segment.speaker_split_coverage_overlap) reasons.push('speaker_coverage_overlap');
    if (segment.mixedSpeakerSplit || segment.mixed_speaker_split) reasons.push('speaker_split');
    if (isUnassignedSpeaker(segment.speaker)) reasons.push('speaker_unassigned');
    if ((segment.speakerNeedsReview || segment.speaker_needs_review) && !reasons.some(reason => reason !== 'timing_legacy')) reasons.push('speaker_review');
    return normalizeReviewIssues(reasons.map(reason => ({ reason, start: toSeconds(segment.start), end: toSeconds(segment.end) })));
};

const ownIssues = (segment: MeetingSegment): TranscriptReviewIssue[] => {
    const issues = segment.reviewVersion === 1 && Array.isArray(segment.reviewIssues)
        ? normalizeReviewIssues(segment.reviewIssues) : legacyIssues(segment);
    if (isUnassignedSpeaker(segment.speaker) && !issues.some(issue => issue.reason === 'speaker_unassigned')) {
        issues.push(...legacyIssues({ ...segment, timingApproximate: false }).filter(issue => issue.reason === 'speaker_unassigned'));
    }
    return issues;
};

export const getTranscriptReviewIssues = (segment: MeetingSegment, rawSegments: MeetingSegment[]): TranscriptReviewIssue[] => {
    if (segment.reviewVersion === 1 && Array.isArray(segment.reviewIssues)) return ownIssues(segment);
    const start = toSeconds(segment.start), end = toSeconds(segment.end);
    const sources = rawSegments.filter(source => toSeconds(source.start) < end && toSeconds(source.end) > start);
    if (!sources.length) return ownIssues(segment);
    const precise = sources.flatMap(ownIssues);
    const fallback = ownIssues(segment)
        .filter(issue => !precise.some(other => isTimingReview(issue) === isTimingReview(other)))
        .flatMap(issue => sources.filter(source => source.reviewVersion !== 1 || !Array.isArray(source.reviewIssues))
            .map(source => ({ ...issue, start: Math.max(start, toSeconds(source.start)), end: Math.min(end, toSeconds(source.end)) })));
    const unassigned = ownIssues(segment).filter(issue => issue.reason === 'speaker_unassigned');
    return normalizeReviewIssues([...precise, ...fallback, ...unassigned]);
};

export const formatReviewTime = (seconds: number): string => {
    const centiseconds = Math.round(seconds * 100);
    const whole = Math.floor(centiseconds / 100);
    return `${String(Math.floor(whole / 3600)).padStart(2, '0')}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
};
