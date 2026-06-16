export type GenerationState = 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';

export interface MeetingGenerationStatusShape {
    summary?: GenerationState;
    topicSections?: GenerationState;
    topic_sections?: GenerationState;
    speakerContextSummaries?: GenerationState;
    speaker_context_summaries?: GenerationState;
    meetingReport?: GenerationState;
    meeting_report?: GenerationState;
}

export interface TopicSectionShape {
    topic?: string;
}

const pickGenerationStatus = (
    baseStatus: MeetingGenerationStatusShape | undefined,
    patchStatus: MeetingGenerationStatusShape | undefined,
    camelKey: 'summary' | 'topicSections' | 'speakerContextSummaries' | 'meetingReport',
    snakeKey: 'summary' | 'topic_sections' | 'speaker_context_summaries' | 'meeting_report',
): GenerationState | undefined => (
    patchStatus?.[camelKey]
    ?? patchStatus?.[snakeKey]
    ?? baseStatus?.[camelKey]
    ?? baseStatus?.[snakeKey]
);

export const normalizeGenerationStatus = (
    baseStatus?: MeetingGenerationStatusShape,
    patchStatus?: MeetingGenerationStatusShape,
): MeetingGenerationStatusShape => ({
    summary: pickGenerationStatus(baseStatus, patchStatus, 'summary', 'summary'),
    topicSections: pickGenerationStatus(baseStatus, patchStatus, 'topicSections', 'topic_sections'),
    speakerContextSummaries: pickGenerationStatus(
        baseStatus,
        patchStatus,
        'speakerContextSummaries',
        'speaker_context_summaries',
    ),
    meetingReport: pickGenerationStatus(
        baseStatus,
        patchStatus,
        'meetingReport',
        'meeting_report',
    ),
});

export const getSummaryGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    overview?: string,
): GenerationState => (
    status?.summary
    ?? (overview?.trim() ? 'completed' : 'not_started')
);

export const getTopicGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    topicSections?: TopicSectionShape[],
): GenerationState => {
    const hasTopicSections = Boolean(topicSections?.some(section => section.topic?.trim()));
    const explicitStatus = status?.topicSections ?? status?.topic_sections;
    if (explicitStatus === 'completed' && !hasTopicSections) return 'failed';
    return explicitStatus ?? (hasTopicSections ? 'completed' : 'not_started');
};

export const getSpeakerGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    speakerContextSummaries?: unknown[],
): GenerationState => {
    const hasSpeakerContext = Boolean(speakerContextSummaries?.length);
    const explicitStatus = status?.speakerContextSummaries ?? status?.speaker_context_summaries;
    if (explicitStatus === 'completed' && !hasSpeakerContext) return 'failed';
    return explicitStatus ?? (hasSpeakerContext ? 'completed' : 'not_started');
};

export const getMeetingReportGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    meetingReport?: { content?: string; sections?: unknown[] } | null,
): GenerationState => {
    const hasMeetingReport = Boolean(meetingReport?.content?.trim() || meetingReport?.sections?.length);
    const explicitStatus = status?.meetingReport ?? status?.meeting_report;
    if (explicitStatus === 'completed' && !hasMeetingReport) return 'failed';
    return explicitStatus ?? (hasMeetingReport ? 'completed' : 'not_started');
};

export const canGenerateSpeakerContext = (
    status?: MeetingGenerationStatusShape,
    topicSections?: TopicSectionShape[],
): boolean => {
    const sectionCount = topicSections?.filter(section => section.topic?.trim()).length ?? 0;
    return getTopicGenerationStatus(status, topicSections) === 'completed' && sectionCount >= 1;
};
