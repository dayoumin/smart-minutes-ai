import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYSIS_DURATION_LIMIT_MESSAGE,
  MAX_ANALYSIS_DURATION_SECONDS,
  getAnalysisDurationLimitError,
} from '../src/analysisMediaLimit.ts';
import { parseApiErrorBody, toUserFacingAnalysisError } from '../src/apiError.ts';

await test('two hours is allowed; even a fractional excess requires a shorter file', () => {
  assert.equal(MAX_ANALYSIS_DURATION_SECONDS, 7200);
  for (const duration of [1, 3600, 7199.999, 7200]) {
    assert.equal(getAnalysisDurationLimitError(duration), null);
  }
  // The selected file's length comes first, rounded up so just over the limit never reads as two hours.
  assert.equal(getAnalysisDurationLimitError(7200.001), `선택한 파일은 약 2시간 1분입니다. ${ANALYSIS_DURATION_LIMIT_MESSAGE}`);
  assert.equal(getAnalysisDurationLimitError(9000), `선택한 파일은 약 2시간 30분입니다. ${ANALYSIS_DURATION_LIMIT_MESSAGE}`);
  assert.equal(getAnalysisDurationLimitError(10800), `선택한 파일은 약 3시간입니다. ${ANALYSIS_DURATION_LIMIT_MESSAGE}`);
});

await test('unreadable browser metadata is deferred to actual server inspection', () => {
  for (const duration of [null, undefined, 0, -1, Number.NaN, Infinity, -Infinity]) {
    assert.equal(getAnalysisDurationLimitError(duration), null);
  }
});

await test('authoritative server duration rejection has the same actionable message', () => {
  const info = parseApiErrorBody(JSON.stringify({ detail: {
    code: 'duration_limit_exceeded',
    message: '2시간 이하의 음성·영상 파일을 선택해 주세요.',
    max_duration_seconds: 7200,
    duration_seconds: 7200.25,
  } }), '서버 응답 오류: 413');
  assert.equal(info.code, 'duration_limit_exceeded');
  assert.equal(info.detail, 'duration_limit_exceeded');
  assert.equal(info.message, ANALYSIS_DURATION_LIMIT_MESSAGE);
  assert.equal(toUserFacingAnalysisError(info.detail), ANALYSIS_DURATION_LIMIT_MESSAGE);
});

await test('a server-unreadable file is distinguished from an overlong one', () => {
  const info = parseApiErrorBody(JSON.stringify({ detail: {
    code: 'media_duration_unavailable',
    message: '파일 길이를 확인하지 못했습니다. 재생 가능한 음성·영상 파일을 선택해 주세요.',
    max_duration_seconds: 7200,
  } }), '서버 응답 오류: 422');
  assert.equal(info.code, 'media_duration_unavailable');
  assert.equal(info.message, '파일 길이를 확인하지 못했습니다. 재생 가능한 음성·영상 파일을 선택해 주세요.');
  assert.equal(toUserFacingAnalysisError('media_duration_unavailable'), info.message);
});
