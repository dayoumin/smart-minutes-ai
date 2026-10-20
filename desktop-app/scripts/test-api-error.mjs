import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EngineError,
  describeAnalysisError,
  toUserFacingAnalysisError,
  toUserFacingError,
} from '../src/apiError.ts';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';
import brandConfig from '../../configs/brand.json' with { type: 'json' };

const FETCH_FAILURE = new TypeError('Failed to fetch');

await test('the brand comes from configs/brand.json and particles follow the last syllable', () => {
  assert.equal(BRAND_NAME, brandConfig.brandName);
  assert.equal(LOCAL_ENGINE_NAME, `${brandConfig.brandName} 연결`);
  assert.equal(withJosa('바로록', '을/를'), '바로록을');
  assert.equal(withJosa('바로', '을/를'), '바로를');
  assert.equal(withJosa('바로록 연결', '이/가'), '바로록 연결이');
  assert.equal(withJosa('바로', '이/가'), '바로가');
  assert.equal(withJosa('바로록 연결', '으로/로'), '바로록 연결로');
  assert.equal(withJosa('음성 분석', '으로/로'), '음성 분석으로');
  assert.equal(withJosa('바로', '으로/로'), '바로로');
  assert.equal(withJosa('LMO', '을/를'), 'LMO을(를)');
  assert.notEqual(withJosa('바로', '을/를'), '바로을');
});

await test('analysis failures are classified by engine code before wording', () => {
  assert.deepEqual(
    describeAnalysisError(new EngineError('CUDA failed with error out of memory', 'insufficient_memory')).cause,
    'memory',
  );
  assert.equal(describeAnalysisError(new EngineError('No space left on device', 'insufficient_storage')).cause, 'disk-space');
  assert.equal(describeAnalysisError(new EngineError('ffmpeg conversion failed', 'unsupported_media')).cause, 'unsupported-file');
  const stageTimeout = describeAnalysisError(new EngineError('같은 분석 단계가 너무 오래 진행되지 않았습니다.', 'analysis_stage_timeout'));
  assert.equal(stageTimeout.cause, 'timeout');
  assert.equal(stageTimeout.message, '응답이 너무 오래 걸려 멈췄습니다. 잠시 뒤 다시 시도해 주세요.');
  // Mapped codes keep their own sentence and still report the cause.
  const tooLong = describeAnalysisError(new EngineError('duration_limit_exceeded', 'duration_limit_exceeded'));
  assert.equal(tooLong.cause, 'unsupported-file');
  assert.equal(tooLong.message, '2시간 이하의 음성·영상 파일을 선택해 주세요.');
});

await test('older engines without a code are classified from raw wording', () => {
  assert.equal(describeAnalysisError(new Error('RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB')).cause, 'memory');
  // GPU run-time failures: by code, by raw library text; memory still wins for a CUDA out-of-memory.
  assert.equal(describeAnalysisError(new EngineError('Library cublas64_12.dll is not found', 'gpu_unavailable')).cause, 'gpu');
  assert.equal(describeAnalysisError(new Error('Could not load library cudnn_ops64_9.dll')).cause, 'gpu');
  assert.equal(describeAnalysisError(new Error('CUDA error: out of memory')).cause, 'memory');
  assert.equal(describeAnalysisError(new Error('std::bad_alloc')).cause, 'memory');
  assert.equal(describeAnalysisError(new Error('[Errno 28] No space left on device')).cause, 'disk-space');
  assert.equal(describeAnalysisError(new Error('ffmpeg conversion failed: a.m4a: Invalid data found when processing input')).cause, 'unsupported-file');
  assert.equal(describeAnalysisError(new DOMException('The request timed out.', 'TimeoutError')).cause, 'timeout');
  assert.equal(describeAnalysisError('서버 응답 오류: 507').cause, 'disk-space');
  // Our own Korean preflight sentence is kept and still classified.
  const preflight = describeAnalysisError(new Error('저장 공간이 부족합니다. 임시 파일을 정리한 뒤 다시 시도해 주세요.'));
  assert.deepEqual(preflight, { cause: 'disk-space', message: '저장 공간이 부족합니다. 임시 파일을 정리한 뒤 다시 시도해 주세요.' });
});

await test('localized OS and engine text is classified but never shown as is', () => {
  // Korean Windows localizes OS errors; Hangul alone does not make a sentence ours.
  assert.deepEqual(
    describeAnalysisError(new Error('ffmpeg conversion failed: [WinError 2] 지정된 파일을 찾을 수 없습니다')),
    { cause: 'other', message: '분석 중 문제가 생겼습니다. 다시 시도해 주세요.' },
  );
  assert.equal(
    describeAnalysisError(new Error("[WinError 32] 다른 프로세스가 파일을 사용 중이기 때문에 액세스할 수 없습니다: 'C:\\temp\\chunk_001.wav'")).message,
    '분석 중 문제가 생겼습니다. 다시 시도해 주세요.',
  );
  assert.equal(toUserFacingError(new Error('RuntimeError: 참석자 구분 실패'), '참석자 구분을 마치지 못했습니다.'), '참석자 구분을 마치지 못했습니다.');
  // The storage check's own sentence (with the sizes) is ours and kept.
  const storage = describeAnalysisError(new Error('저장 공간이 부족합니다. 필요한 여유 공간: 3.2GB, 현재 여유 공간: 1.1GB'));
  assert.deepEqual(storage, { cause: 'disk-space', message: '저장 공간이 부족합니다. 필요한 여유 공간: 3.2GB, 현재 여유 공간: 1.1GB' });
  // A code bug or an ffmpeg warning is not an unreadable file.
  assert.equal(describeAnalysisError(new Error("ValueError: Unknown format code 'd' for object of type 'float'")).cause, 'other');
  assert.equal(describeAnalysisError(new Error('Could not find codec parameters for stream 1')).cause, 'other');
});

await test('engine disconnection names the runtime-specific next step', () => {
  const web = describeAnalysisError(FETCH_FAILURE);
  assert.equal(web.cause, 'engine-disconnected');
  assert.equal(web.message, `이 PC의 분석 기능에 연결하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인한 뒤 다시 시도해 주세요.`);
  assert.match(describeAnalysisError(FETCH_FAILURE, { desktopApp: true }).message, /앱을 다시 실행/);
  assert.equal(toUserFacingAnalysisError('Failed to fetch'), web.message);
});

await test('unknown English text never reaches the user', () => {
  assert.deepEqual(describeAnalysisError(new Error('KeyError: segments')), {
    cause: 'other',
    message: '분석 중 문제가 생겼습니다. 다시 시도해 주세요.',
  });
  assert.equal(toUserFacingAnalysisError(''), '분석 중 문제가 생겼습니다. 다시 시도해 주세요.');
});

await test('other actions lead with what failed and add the cause next step', () => {
  const failed = '대화록 수정본을 저장하지 못했습니다.';
  assert.equal(toUserFacingError(FETCH_FAILURE, failed), `${failed} ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`);
  assert.equal(toUserFacingError(FETCH_FAILURE, failed, { desktopApp: true }), `${failed} 앱을 다시 실행한 뒤 다시 시도해 주세요.`);
  assert.equal(
    toUserFacingError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'), failed),
    `${failed} 저장 공간을 확보한 뒤 다시 시도해 주세요.`,
  );
  assert.equal(toUserFacingError(new Error('Traceback (most recent call last): ...'), failed), failed);
  // Raw JSON response bodies are read for their detail, never shown.
  assert.equal(toUserFacingError(new Error('{"detail":"Output result not found"}'), failed), '분석 원본을 찾지 못했습니다. 음성 파일을 다시 분석해 주세요.');
  assert.equal(toUserFacingError(new Error('{"detail":"internal stack"}'), failed), failed);
  // Our own Korean messages are already user sentences.
  assert.equal(toUserFacingError(new Error('저장된 음성 파일을 찾지 못했습니다.'), failed), '저장된 음성 파일을 찾지 못했습니다.');
  assert.equal(toUserFacingError(undefined, failed), failed);
});
