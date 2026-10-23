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

interface OrganizedMeetingContentShape {
    summary?: string;
    topics?: readonly unknown[];
    topicSections?: readonly unknown[];
    speakerContextSummaries?: readonly unknown[];
    participantSummaries?: readonly unknown[];
    decisions?: readonly unknown[];
    actions?: readonly unknown[];
    needsCheck?: readonly string[];
}

export const hasOrganizedMeetingContent = (
    meeting: OrganizedMeetingContentShape | null | undefined,
    summaryIsDeferred: boolean,
): boolean => Boolean(meeting && (
    (!summaryIsDeferred && meeting.summary?.trim())
    || meeting.topics?.length || meeting.topicSections?.length
    || meeting.speakerContextSummaries?.length || meeting.participantSummaries?.length
    || meeting.decisions?.length || meeting.actions?.length
    || meeting.needsCheck?.some(note => note.trim()
        && (!summaryIsDeferred || note.trim() !== meeting.summary?.trim()))
));

/**
 * Topics shown as "주요 주제" on screen and in exports. Topic section titles supersede summary
 * keywords (the backend appends them to `topics`, so merging both repeats near-identical items).
 * Trim ends, then compare Unicode lowercase without locale-specific or case-fold expansion.
 * Keep the first spelling and all source data. Mirrors backend `pipeline.summary_display.get_display_topics`.
 */
export const getDisplayTopics = (
    topics: readonly unknown[] | undefined,
    topicSections: readonly (TopicSectionShape | null | undefined)[] | undefined,
): string[] => {
    // Generated JSON is not schema-checked per item, so skip non-string values instead of throwing.
    const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const sectionTopics = (topicSections ?? []).map(section => clean(section?.topic)).filter(Boolean);
    const source = sectionTopics.length ? sectionTopics : (topics ?? []).map(clean).filter(Boolean);
    const seen = new Set<string>();
    return source.filter(topic => {
        const key = topic.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

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
