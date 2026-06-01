export type TopicGenerationIntent = 'all' | 'custom' | null;

interface TopicGenerationUiStateInput {
    generatingKind: string | null;
    topicGenerationStatus: string;
    topicGenerationIntent: TopicGenerationIntent;
}

export interface TopicGenerationUiState {
    isTopicGenerationRunning: boolean;
    isMainTopicGenerationRunning: boolean;
    isCustomTopicGenerationRunning: boolean;
}

export const getTopicGenerationUiState = ({
    generatingKind,
    topicGenerationStatus,
    topicGenerationIntent,
}: TopicGenerationUiStateInput): TopicGenerationUiState => {
    const isTopicGenerationRunning = generatingKind === 'topicSections' || topicGenerationStatus === 'generating';

    return {
        isTopicGenerationRunning,
        isMainTopicGenerationRunning: isTopicGenerationRunning && topicGenerationIntent !== 'custom',
        isCustomTopicGenerationRunning: isTopicGenerationRunning && topicGenerationIntent === 'custom',
    };
};
