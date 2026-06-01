import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const importTsModule = async (path) => {
  const source = await readFile(resolve(path), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(outputText)}`);
};

const { getTopicGenerationUiState } = await importTsModule('src/topicGenerationUi.ts');

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
