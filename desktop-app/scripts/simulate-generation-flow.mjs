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
  getMeetingReportGenerationStatus,
  getSpeakerGenerationStatus,
  getTopicGenerationStatus,
  normalizeGenerationStatus,
} = await importTsModule('src/meetingGeneration.ts');

const {
  formatAnalysisDuration,
  formatTranscriptReadyEstimate,
  getTranscriptReadyProgressPercent,
} = await importTsModule('src/analysisTimeEstimate.ts');

const {
  listMinutesOutputTemplates,
  listReportTemplates,
} = await importTsModule('src/meetingKnowledge.ts');

const {
  parseApiErrorBody,
} = await importTsModule('src/apiError.ts');

const reportTemplates = listReportTemplates();
const minutesOutputTemplates = listMinutesOutputTemplates();
assert.equal(reportTemplates.some((template) => template.id === 'archive-minutes'), false);
assert.equal(reportTemplates.some((template) => template.id === 'report-ready-minutes'), false);
assert.equal(reportTemplates.some((template) => template.name === '기본 보고서'), true);
assert.equal(minutesOutputTemplates.some((template) => template.id === 'archive-minutes'), true);

const normalizedStatus = normalizeGenerationStatus(
    { topicSections: 'generating', speakerContextSummaries: 'completed', meeting_report: 'failed' },
    { topic_sections: 'completed', meetingReport: 'completed' },
);
assert.equal(normalizedStatus.summary, undefined);
assert.equal(normalizedStatus.topicSections, 'completed');
assert.equal(normalizedStatus.speakerContextSummaries, 'completed');
assert.equal(normalizedStatus.meetingReport, 'completed');

assert.equal(getTopicGenerationStatus(undefined, []), 'not_started');
assert.equal(getTopicGenerationStatus(undefined, [{ topic: '예산' }]), 'completed');
assert.equal(getTopicGenerationStatus({ topic_sections: 'failed' }, [{ topic: '예산' }]), 'failed');

assert.equal(getSpeakerGenerationStatus(undefined, []), 'not_started');
assert.equal(getSpeakerGenerationStatus({ speaker_context_summaries: 'completed' }, []), 'failed');

assert.equal(getMeetingReportGenerationStatus(undefined, null), 'not_started');
assert.equal(getMeetingReportGenerationStatus(undefined, { content: '보고서 본문' }), 'completed');
assert.equal(getMeetingReportGenerationStatus({ meeting_report: 'completed' }, { content: '' }), 'failed');

assert.equal(canGenerateSpeakerContext({ topic_sections: 'not_started' }, []), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'generating' }, [{ topic: '예산' }]), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'failed' }, [{ topic: '예산' }]), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'completed' }, []), false);
assert.equal(canGenerateSpeakerContext({ topic_sections: 'completed' }, [{ topic: '예산' }]), true);

assert.equal(formatAnalysisDuration(65_000), '1:05');
assert.equal(getTranscriptReadyProgressPercent(42.5, 'Transcribing chunk 2/4...'), 64.39393939393939);
assert.equal(getTranscriptReadyProgressPercent(85, 'Summarizing with Local LLM...'), 100);
assert.equal(getTranscriptReadyProgressPercent(95, 'Saving results...'), 100);
assert.equal(formatTranscriptReadyEstimate(10 * 60_000, 50, 'Transcribing chunk 2/4...'), '약 13:12');
assert.equal(formatTranscriptReadyEstimate(10 * 60_000, 85, 'Summarizing with Local LLM...'), '대화록 준비됨');

assert.equal(
  parseApiErrorBody(JSON.stringify({ detail: 'Output result not found' }), 'fallback').message,
  '분석 원본을 찾지 못했습니다. 음성 파일을 다시 분석해 주세요.',
);
assert.equal(
  parseApiErrorBody(JSON.stringify({ detail: 'Traceback: internal path' }), '다시 시도해 주세요.').message,
  '다시 시도해 주세요.',
);
assert.equal(parseApiErrorBody('', '연결 상태를 확인해 주세요.').message, '연결 상태를 확인해 주세요.');

const structuredTimeout = parseApiErrorBody(JSON.stringify({
  detail: {
    code: 'request_timeout',
    message: 'raw backend message',
    retryable: true,
    user_action: 'retry',
    generation_kind: 'meeting_report',
  },
}), 'fallback');
assert.equal(structuredTimeout.message, '정리 시간이 초과되었습니다. 기존 대화록과 정리 결과는 보존되었습니다. 잠시 후 다시 시도해 주세요.');
assert.equal(structuredTimeout.detail, 'request_timeout');
assert.equal(structuredTimeout.code, 'request_timeout');
assert.equal(structuredTimeout.retryable, true);
assert.equal(structuredTimeout.userAction, 'retry');
assert.equal(structuredTimeout.generationKind, 'meeting_report');

console.log('ok - generation flow simulation');
