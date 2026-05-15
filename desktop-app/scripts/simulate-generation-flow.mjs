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

const {
  canGenerateSpeakerContext,
  getSpeakerGenerationStatus,
  getTopicGenerationStatus,
  normalizeGenerationStatus,
} = await importTsModule('src/meetingGeneration.ts');

const {
  formatAnalysisDuration,
  formatTranscriptReadyEstimate,
} = await importTsModule('src/analysisTimeEstimate.ts');

const normalizedStatus = normalizeGenerationStatus(
    { topicSections: 'generating', speakerContextSummaries: 'completed' },
    { topic_sections: 'completed' },
);
assert.equal(normalizedStatus.summary, undefined);
assert.equal(normalizedStatus.topicSections, 'completed');
assert.equal(normalizedStatus.speakerContextSummaries, 'completed');

assert.equal(getTopicGenerationStatus(undefined, []), 'not_started');
assert.equal(getTopicGenerationStatus(undefined, [{ topic: '예산' }]), 'completed');
assert.equal(getTopicGenerationStatus({ topic_sections: 'failed' }, [{ topic: '예산' }]), 'failed');

assert.equal(getSpeakerGenerationStatus(undefined, []), 'not_started');
assert.equal(getSpeakerGenerationStatus({ speaker_context_summaries: 'completed' }, []), 'completed');

assert.equal(canGenerateSpeakerContext({ topic_sections: 'not_started' }, []), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'generating' }, [{ topic: '예산' }]), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'failed' }, [{ topic: '예산' }]), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'completed' }, []), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'completed' }, [{ topic: '예산' }]), true);

assert.equal(formatAnalysisDuration(65_000), '1:05');
assert.equal(formatTranscriptReadyEstimate(10 * 60_000, 50, 'Transcribing chunk 2/4...'), '약 17:00');
assert.equal(formatTranscriptReadyEstimate(10 * 60_000, 85, 'Summarizing with Local LLM...'), '대화록 준비됨');

console.log('ok - generation flow simulation');
