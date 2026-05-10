export type GenerationState = 'not_started' | 'generating' | 'completed' | 'failed';

export interface MeetingGenerationStatusShape {
    topicSections?: GenerationState;
    topic_sections?: GenerationState;
    speakerContextSummaries?: GenerationState;
    speaker_context_summaries?: GenerationState;
}

export interface TopicSectionShape {
    topic?: string;
}

const pickGenerationStatus = (
    baseStatus: MeetingGenerationStatusShape | undefined,
    patchStatus: MeetingGenerationStatusShape | undefined,
    camelKey: 'topicSections' | 'speakerContextSummaries',
    snakeKey: 'topic_sections' | 'speaker_context_summaries',
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
    topicSections: pickGenerationStatus(baseStatus, patchStatus, 'topicSections', 'topic_sections'),
    speakerContextSummaries: pickGenerationStatus(
        baseStatus,
        patchStatus,
        'speakerContextSummaries',
        'speaker_context_summaries',
    ),
});

export const getTopicGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    topicSections?: TopicSectionShape[],
): GenerationState => (
    status?.topicSections
    ?? status?.topic_sections
    ?? (topicSections?.length ? 'completed' : 'not_started')
);

export const getSpeakerGenerationStatus = (
    status?: MeetingGenerationStatusShape,
    speakerContextSummaries?: unknown[],
): GenerationState => (
    status?.speakerContextSummaries
    ?? status?.speaker_context_summaries
    ?? (speakerContextSummaries?.length ? 'completed' : 'not_started')
);

export const canGenerateSpeakerContext = (
    status?: MeetingGenerationStatusShape,
    topicSections?: TopicSectionShape[],
): boolean => getTopicGenerationStatus(status, topicSections) === 'completed' && Boolean(topicSections?.length);
