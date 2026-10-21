import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the actual pure builders without rendering or duplicating their implementation.
const source = readFileSync(new URL('../src/MeetingDownloadControl.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('MeetingDownloadControl.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const builders = tree.statements.filter(node => ts.isVariableStatement(node)
  && !node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'MeetingDownloadControl'));
// Imported helpers are loaded from their real source so the builders keep using them.
const generationSource = readFileSync(new URL('../src/meetingGeneration.ts', import.meta.url), 'utf8');
const generationTree = ts.createSourceFile('meetingGeneration.ts', generationSource, ts.ScriptTarget.Latest, true);
const displayTopicsHelper = generationTree.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'getDisplayTopics'));
assert.ok(displayTopicsHelper, 'Load the shared display-topic helper used by the export builders');
const generationExports = {};
runInNewContext(ts.transpileModule(displayTopicsHelper.getText(generationTree) + '\nexport { getDisplayTopics };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: generationExports });
const exports = {};
const reviewExports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/transcriptReview.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: reviewExports });
runInNewContext(ts.transpileModule(builders.map(node => node.getText(tree)).join('\n')
  + '\nexport { buildFallbackText, buildExportPayload };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, getDisplayTopics: generationExports.getDisplayTopics, formatReviewTime: reviewExports.formatReviewTime,
  getTranscriptReviewIssues: reviewExports.getTranscriptReviewIssues, reviewReasonLabels: reviewExports.reviewReasonLabels });
const { buildFallbackText, buildExportPayload } = exports;
await test('review ranges and reasons survive local TXT and export payload grouping', () => {
  const meeting={id:'reviews',title:'확인 구간',date:'2026-10-21',segments:[{start:'00:01:17',end:'00:01:21',speaker:'A',text:'확인',shortSpeakerOverlap:true}],displaySegments:[{start:'00:01:00',end:'00:03:34',speaker:'A',text:'전체 문단',shortSpeakerOverlap:true}]};
  const text=buildFallbackText(meeting,'transcript');
  assert.ok(text.includes('00:01:17.00–00:01:21.00'));
  assert.ok(text.includes('짧은 다른 참석자 구간'));
  const payload=JSON.parse(JSON.stringify(buildExportPayload(meeting,'transcript','확인')));
  assert.deepEqual(payload.displaySegments[0].reviewIssues,[{reason:'short_speaker_overlap',start:77,end:81}]);
});
const displayTopicCases = JSON.parse(readFileSync(new URL('../../tests/fixtures/display-topics.json', import.meta.url), 'utf8'));
for (const fixture of displayTopicCases) {
  await test(`shared display topics and local TXT: ${fixture.name}`, () => {
    const meeting = {
      id: 'topic-fixture', title: '주제 검증', date: '2026-10-20', summary: '요약',
      topics: fixture.summary.topics, topicSections: fixture.summary.topic_sections,
    };
    const before = JSON.stringify(meeting);
    assert.deepEqual(Array.from(generationExports.getDisplayTopics(meeting.topics, meeting.topicSections)), fixture.expected);
    for (const scope of ['organized', 'full']) {
      const text = buildFallbackText(meeting, scope);
      const lines = text.split('\n');
      const start = lines.indexOf('[주요 주제]');
      if (fixture.expected.length) {
        assert.notEqual(start, -1);
        const topicLines = lines.slice(start + 1);
        const end = topicLines.findIndex(line => !line.startsWith('- '));
        assert.deepEqual(topicLines.slice(0, end < 0 ? undefined : end), fixture.expected.map(topic => `- ${topic}`));
      } else {
        assert.equal(start, -1);
      }
      for (const section of meeting.topicSections) {
        if (section.summary) assert.ok(text.includes(section.summary));
      }
    }
    assert.equal(JSON.stringify(meeting), before, 'Display deduplication must not rewrite stored topics or section bodies');
  });
}
await test('display topics ignore malformed section titles and fall back to valid keywords', () => {
  const summary = { topics: [3, null, ' 예산 '], topicSections: [null, 'invalid', { topic: 123 }, { topic: {} }, { topic: null }] };
  assert.deepEqual(Array.from(generationExports.getDisplayTopics(summary.topics, summary.topicSections)), ['예산']);
});
const repositorySource = readFileSync(new URL('../src/meetingRepository.ts', import.meta.url), 'utf8');
const repositoryTree = ts.createSourceFile('meetingRepository.ts', repositorySource, ts.ScriptTarget.Latest, true);
const normalizer = repositoryTree.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'normalizeMeetingRecord'));
assert.ok(normalizer, 'Exercise the actual repository normalizer used on record reads');
const repositoryExports = {};
runInNewContext(ts.transpileModule(normalizer.getText(repositoryTree) + '\nexport { normalizeMeetingRecord };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: repositoryExports });
const { normalizeMeetingRecord } = repositoryExports;
const record = () => ({
  id: 'frontend-only', title: '현재 제목', date: '2026-10-15 09:30', participants: '참석자01',
  summary: '현재 정리', meetingPurpose: '현재 목적',
  segments: [{ start: '00:00:00', end: '00:00:01', speaker: 'SPEAKER_00', displaySpeaker: '삭제한 이름', text: '원래 발언' }],
  displaySegments: [{ start: '00:00:00', end: '00:00:01', speaker: 'SPEAKER_00', displaySpeaker: '삭제한 이름', text: '표시용 발언' }],
  editedDisplaySegments: [{ start: '00:00:00', end: '00:00:01', speaker: 'SPEAKER_00', displaySpeaker: '삭제한 이름', text: '수정한 최신 발언' }],
  speakerLabels: {},
});

await test('cleared labels never revive stale transcript names in local TXT/full fallback', () => {
  const meeting = record();
  const before = JSON.stringify(meeting);
  for (const scope of ['transcript', 'full']) {
    const text = buildFallbackText(meeting, scope);
    assert.ok(text.includes('참석자01: 수정한 최신 발언'));
    assert.equal(text.includes('삭제한 이름'), false);
  }
  assert.equal(JSON.stringify(meeting), before);
});

await test('explicit partial labels override names and leave unmapped speakers at defaults', () => {
  const meeting = record();
  meeting.speakerLabels = { SPEAKER_00: ' 새 이름 ' };
  meeting.editedDisplaySegments.push({ ...meeting.segments[0], speaker: 'SPEAKER_01', displaySpeaker: '또 다른 예전 이름' });
  const text = buildFallbackText(meeting, 'transcript');
  assert.ok(text.includes('새 이름: 수정한 최신 발언'));
  assert.ok(text.includes('참석자02: 원래 발언'));
  assert.equal(text.includes('또 다른 예전 이름'), false);
});

await test('legacy records without an explicit label set retain their historical display names', () => {
  const meeting = record();
  delete meeting.speakerLabels;
  const reopened = normalizeMeetingRecord(JSON.parse(JSON.stringify(meeting)));
  assert.equal(reopened.speakerLabels, undefined);
  assert.ok(buildFallbackText(reopened, 'transcript').includes('삭제한 이름: 수정한 최신 발언'));
  assert.equal('speakerLabels' in JSON.parse(JSON.stringify(buildExportPayload(reopened, 'transcript', '파일'))), false);
});

await test('an explicit cleared label set survives reloading even with stale legacy labels', () => {
  const meeting = record();
  meeting.speaker_labels = { SPEAKER_00: '삭제한 이름' };
  const reopened = normalizeMeetingRecord(JSON.parse(JSON.stringify(meeting)));
  assert.equal(Object.keys(reopened.speakerLabels).length, 0);
  const text = buildFallbackText(reopened, 'transcript');
  assert.ok(text.includes('참석자01: 수정한 최신 발언'));
  assert.equal(text.includes('삭제한 이름'), false);
});

await test('fallback and payload agree on edited, reverted and original transcript precedence', () => {
  const meeting = record();
  const check = expected => {
    assert.ok(buildFallbackText(meeting, 'transcript').includes(expected));
    assert.equal(buildExportPayload(meeting, 'transcript', '새 파일명').displaySegments[0].text, expected);
  };
  check('수정한 최신 발언');
  meeting.editedDisplaySegments = [];
  check('표시용 발언');
  meeting.displaySegments = [];
  check('원래 발언');
});

await test('organized fallback uses current labels for structured participant summaries', () => {
  const meeting = record();
  meeting.speakerContextSummaries = [{ speaker: 'SPEAKER_00', display_name: '삭제한 이름', summary: '참석자별 정리', key_points: [], actions: [] }];
  const text = buildFallbackText(meeting, 'organized');
  assert.ok(text.includes('- 참석자01: 참석자별 정리'));
  assert.equal(text.includes('삭제한 이름'), false);
});

await test('frontend-only records can export every scope without backend output references', () => {
  const meeting = record();
  meeting.meetingReport = { templateId: 'minutes', generatedAt: 'now', content: '현재 보고서' };
  for (const scope of ['transcript', 'organized', 'report', 'full']) {
    const payload = buildExportPayload(meeting, scope, '파일/이름');
    assert.equal(payload.id, meeting.id);
    assert.equal(payload.exportScope, scope);
    assert.equal(payload.downloadFilename, '파일-이름');
    assert.equal(payload.jobId, undefined);
    assert.equal(payload.outputFiles, undefined);
    assert.equal(Object.keys(payload.speakerLabels).length, 0);
    assert.ok(buildFallbackText(meeting, scope).includes('현재 제목'));
  }
});

await test('organized fallback lists topic section titles once under 주요 주제', () => {
  const meeting = record();
  meeting.topics = ['장비 교정', '음향 장비 교정', ' 음향 장비 교정 '];
  meeting.topicSections = [
    { topic: '음향 장비 교정', summary: '교정 본문' },
    { topic: '어획량 감소와 수온', summary: '수온 본문' },
  ];
  const text = buildFallbackText(meeting, 'organized');
  assert.ok(text.includes('[주요 주제]\n- 음향 장비 교정\n- 어획량 감소와 수온\n'));
  assert.equal(text.includes('- 장비 교정\n'), false);
  meeting.topicSections = [];
  const fallbackLines = buildFallbackText(meeting, 'organized').split('\n');
  const topicStart = fallbackLines.indexOf('[주요 주제]');
  assert.deepEqual(fallbackLines.slice(topicStart + 1, topicStart + 3), ['- 장비 교정', '- 음향 장비 교정']);
  assert.equal(fallbackLines[topicStart + 3]?.startsWith('- ') ?? false, false, 'whitespace-only duplicates should not repeat');
});

await test('organized fallback skips malformed generated topic values instead of throwing', () => {
  const meeting = record();
  meeting.topics = [3, null, ' 예산 '];
  meeting.topicSections = [{ topic: null, summary: '본문' }];
  const lines = buildFallbackText(meeting, 'organized').split('\n');
  const start = lines.indexOf('[주요 주제]');
  assert.deepEqual(lines.slice(start + 1, start + 2), ['- 예산']);
});
