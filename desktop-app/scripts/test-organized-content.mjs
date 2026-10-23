import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasOrganizedMeetingContent } from '../src/meetingGeneration.ts';

const guidance = '대화록 생성이 완료되었습니다. 정리는 회의 기록에서 별도로 실행해 주세요.';
const deferred = { summary: guidance, needsCheck: [guidance] };

test('deferred analysis guidance alone is not an organized result', () => {
  assert.equal(hasOrganizedMeetingContent(deferred, true), false);
  assert.equal(hasOrganizedMeetingContent({ summary: guidance }, true), false);
  assert.equal(hasOrganizedMeetingContent({ ...deferred, needsCheck: [` ${guidance} `, ' '] }, true), false);
  assert.equal(hasOrganizedMeetingContent(null, false), false);
  assert.equal(hasOrganizedMeetingContent({}, false), false);
});

test('partial organized results remain downloadable alongside deferred guidance', () => {
  for (const result of [
    { topics: ['조사 일정'] },
    { topicSections: [{ topic: '조사 일정', summary: '금요일 자료 공유' }] },
    { speakerContextSummaries: [{ speaker: 'A', summary: '일정 확인' }] },
    { participantSummaries: [{ participant: 'A', summary: '일정 확인' }] },
    { decisions: ['금요일 공유'] },
    { actions: ['자료 준비'] },
    { needsCheck: [guidance, '자료 제출일 확인 필요'] },
  ]) {
    assert.equal(hasOrganizedMeetingContent({ ...deferred, ...result }, true), true);
  }
});

test('real summary and standalone review notes remain downloadable', () => {
  assert.equal(hasOrganizedMeetingContent({ summary: '조사 일정을 확인했습니다.' }, false), true);
  assert.equal(hasOrganizedMeetingContent({ needsCheck: ['일정 확인 필요'] }, false), true);
  assert.equal(hasOrganizedMeetingContent({ summary: ' ', needsCheck: [' '] }, false), false);
});
