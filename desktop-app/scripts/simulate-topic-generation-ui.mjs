import assert from 'node:assert/strict';
import { getTopicGenerationUiState } from '../src/topicGenerationUi.ts';

assert.deepEqual(getTopicGenerationUiState({
  generatingKind: null,
  topicGenerationStatus: 'not_started',
  topicGenerationIntent: null,
}), {
  isTopicGenerationRunning: false,
  isMainTopicGenerationRunning: false,
  isCustomTopicGenerationRunning: false,
});

assert.deepEqual(getTopicGenerationUiState({
  generatingKind: 'topicSections',
  topicGenerationStatus: 'generating',
  topicGenerationIntent: 'all',
}), {
  isTopicGenerationRunning: true,
  isMainTopicGenerationRunning: true,
  isCustomTopicGenerationRunning: false,
});

assert.deepEqual(getTopicGenerationUiState({
  generatingKind: 'topicSections',
  topicGenerationStatus: 'generating',
  topicGenerationIntent: 'custom',
}), {
  isTopicGenerationRunning: true,
  isMainTopicGenerationRunning: false,
  isCustomTopicGenerationRunning: true,
});

assert.deepEqual(getTopicGenerationUiState({
  generatingKind: null,
  topicGenerationStatus: 'generating',
  topicGenerationIntent: null,
}), {
  isTopicGenerationRunning: true,
  isMainTopicGenerationRunning: true,
  isCustomTopicGenerationRunning: false,
});

console.log('ok - topic generation UI state simulation');
