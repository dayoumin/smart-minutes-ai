import {
    upsertMeetingRecord,
    deleteMeetingRecordForJob,
    updateMeetingAnalysisStatus,
} from './analysisMeetingPersistence';
import type { AnalyzeResult } from './analysisMeetingPersistence';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleHelp, Download, FileAudio, FolderOpen, Loader2, Pause, RefreshCw, Settings, ShieldCheck, Square, Trash2, UploadCloud, X } from 'lucide-react';
import {
    ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT,
    AnalysisResumeDraft,
    AnalysisResumeDraftFileKey,
    AnalysisResumeDraftStatus,
    AnalysisResumeDraftUnavailableReason,
    getAnalysisResumeDraft,
    getResumeDraftKey,
    listAnalysisResumeDrafts,
    listSuppressedResumeCandidateKeys,
    markAnalysisResumeDraftUnavailable,
    markAnalysisResumeDraftsForKeyUnavailable,
    queuePendingCancelledAnalysisCleanup,
    queuePendingAnalysisDraftCleanup,
    removeAnalysisResumeDraft,
    removePendingCancelledAnalysisCleanup,
    removePendingAnalysisDraftCleanup,
    suppressResumeCandidateKey,
    unsuppressResumeCandidateKey,
    upsertAnalysisResumeDraft,
} from './analysisResumeDrafts';
import { Button, IconButton, Input, ProgressBar, StatusBanner, AppToast, AppToastMessage, AppToastTone } from './components/common';
import type { MeetingRecord } from './meetingRepository';
import { getApiBase, isTauriRuntime, openSavedFileLocation, writeFrontendLog } from './apiBase';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from './brand';
import {
    describeAnalysisError,
    EngineError,
    readApiErrorInfo,
    readApiErrorMessage as readResponseError,
    toUserFacingError,
    type UserErrorCause,
} from './apiError';
import { getAnalysisDurationLimitError } from './analysisMediaLimit';
import { formatAnalysisDuration, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';
import {
    DEFAULT_CONTEXT_TEMPLATE_ID,
    DEFAULT_REPORT_TEMPLATE_ID,
    getContextTemplateById,
    getReportTemplateById,
} from './meetingKnowledge';
import { claimAnalysisJob, queueAnalysisJobMutation, releaseAnalysisJob } from './analysisJobRuntime';
import { isActionableResumeDraft, useAnalysisResumeSnapshot } from './analysisResumeState';
import { localEngineClient } from './localEngineClient';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';
import { canUseLocalEngineCapability, transportFromHealthEvidence } from './localEngineConnection';
import type { LocalEngineProbePayload } from './localEngineConnection';
import { LocalEngineConnectionSurface } from './LocalEngineConnectionSurface';
import { LocalProcessingNotice, type LocalProcessingNoticeMode } from './LocalProcessingNotice';
import { hasSeenLocalProcessingIntro } from './localProcessingIntro';
import { getRuntimeEnvironment } from './runtimeEnvironment';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const BACKEND_READY_TIMEOUT_MS = 45_000;
const BACKEND_READY_INTERVAL_MS = 1_000;
// After the first 45s the writer keeps checking slowly so the not-connected hint clears once the engine starts.
const READINESS_SLOW_POLL_MS = 10_000;
const DESKTOP_ENGINE_NOT_READY_MESSAGE = '분석 기능이 아직 준비되지 않았습니다. 첫 실행은 몇 분 걸릴 수 있으며, 계속되면 앱을 다시 실행해 주세요.';
// Why the step after a saved transcript did not finish ("메모리가 부족해 참석자 구분을 마치지 못했습니다").
const TRANSCRIPT_KEPT_CAUSE_CLAUSES: Partial<Record<UserErrorCause, string>> = {
    memory: '메모리가 부족해 ',
    'disk-space': '저장 공간이 부족해 ',
    timeout: '응답이 너무 오래 걸려 ',
    'engine-disconnected': '분석 기능 연결이 끊겨 ',
};
// Each request before the analysis stream (settings, readiness, resume check, storage check) gives up after this.
const PREPARATION_REQUEST_TIMEOUT_MS = 15_000;
const ANALYSIS_STALL_WARNING_MS = 120_000;
const LONG_MEDIA_NOTICE_SECONDS = 30 * 60;
const VERY_LONG_MEDIA_NOTICE_SECONDS = 90 * 60;
const PARTICIPANT_SEPARATION_CAUTION_SECONDS = 140 * 60;
const SHOW_AUDIO_EXTRACT_TOOL = false;
const LOCAL_ENGINE_CONNECTION_UI_ENABLED = import.meta.env.VITE_LOCAL_ENGINE_CONNECTION_UI === 'true'
    || (import.meta.env.DEV
        && typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('localEngineConnection') === '1');
const getNowMs = (): number => Date.now();
const REQUIRED_FIELDS_ERROR_PREFIX = '필수 항목을 확인해 주세요';
// datetime-local expects local wall-clock time; toISOString() would be UTC (9 hours early in KST).
const toLocalDateTimeInputValue = (value: Date = new Date()): string => {
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
};

const getAdjustedEtaSeconds = (
    etaSeconds: number | null,
    receivedAt: number | null,
    nowMs: number,
): number | null => {
    if (typeof etaSeconds !== 'number' || !Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
    if (!receivedAt) return etaSeconds;
    const elapsedSeconds = Math.floor(Math.max(0, nowMs - receivedAt) / 1000);
    return Math.max(0, etaSeconds - elapsedSeconds);
};

const getSelectedFileProcessingGuidance = (
    durationSeconds: number | null,
    includeDiarizationDuringAnalysis: boolean,
): string | null => {
    if (getAnalysisDurationLimitError(durationSeconds)) return null;
    if (!durationSeconds || durationSeconds < LONG_MEDIA_NOTICE_SECONDS) return null;
    if (includeDiarizationDuringAnalysis) {
        if (durationSeconds >= PARTICIPANT_SEPARATION_CAUTION_SECONDS) {
            return '매우 긴 파일입니다. 참석자 구분까지 이어서 실행하면 오래 걸릴 수 있습니다. 대화록을 먼저 보려면 설정에서 참석자 구분을 끄세요.';
        }
        return '긴 파일입니다. 참석자 구분까지 이어서 실행하므로 전체 완료까지 시간이 더 걸릴 수 있습니다.';
    }
    if (durationSeconds >= PARTICIPANT_SEPARATION_CAUTION_SECONDS) {
        return '매우 긴 파일입니다. 대화록을 먼저 저장합니다. 참석자 구분은 PC 상태에 따라 결과 화면에서 실행하지 못할 수 있습니다.';
    }
    if (durationSeconds >= VERY_LONG_MEDIA_NOTICE_SECONDS) {
        return '긴 파일입니다. 대화록을 먼저 저장하고, 참석자 구분과 정리는 결과 화면에서 실행할 수 있습니다.';
    }
    return '긴 파일입니다. 대화록을 먼저 저장한 뒤 참석자 구분과 정리를 결과 화면에서 실행할 수 있습니다.';
};

const getAnalysisProgressGuidance = (
    durationSeconds: number | null,
    isTranscriptReady: boolean,
    includeDiarizationDuringAnalysis: boolean,
): string | null => {
    if (isTranscriptReady) {
        return includeDiarizationDuringAnalysis
            ? '대화록은 저장되었습니다. 참석자 구분을 계속 진행합니다. 문제가 생겨도 저장된 대화록은 남습니다.'
            : '대화록은 저장되었습니다. 결과 보기를 누르면 음성 파일이 보관된 경우 참석자 구분과 정리를 실행할 수 있습니다.';
    }
    if (!durationSeconds || durationSeconds < LONG_MEDIA_NOTICE_SECONDS) return null;
    if (durationSeconds >= VERY_LONG_MEDIA_NOTICE_SECONDS) {
        return includeDiarizationDuringAnalysis
            ? '파일이 길어 시간이 오래 걸릴 수 있습니다. 대화록이 준비된 뒤 참석자 구분까지 이어서 실행합니다.'
            : '파일이 길어 시간이 오래 걸릴 수 있습니다. 대화록 예상은 저장 기준이며, 완료된 진행분은 이어서 사용할 수 있게 남깁니다.';
    }
    return includeDiarizationDuringAnalysis
        ? '대화록이 준비된 뒤 참석자 구분까지 이어서 실행합니다.'
        : '대화록 예상은 저장 기준입니다. 참석자 구분과 정리는 결과 화면에서 실행할 수 있습니다.';
};

interface ResumeCandidate {
    job_id: string;
    stage: string;
    updated_at?: string;
    created_at?: string;
    resume_supported: boolean;
    active: boolean;
    chunk_count: number;
    completed_chunk_count: number;
    last_progress?: {
        message?: string;
        progress?: number;
        status?: string;
        eta_seconds?: number | null;
        etaSeconds?: number | null;
    };
}

interface ResumeCandidatesPayload {
    candidates?: ResumeCandidate[];
    recommended_job_id?: string | null;
}

interface ModelStatus {
    key: string;
    label: string;
    installed: boolean;
    required: boolean;
    path?: string;
    token_available?: boolean;
    requires_token?: boolean;
    downloadable?: boolean;
}

interface ModelsPayload {
    ready: boolean;
    models: ModelStatus[];
    errors?: string[];
    selected_stt_device?: string;
    stt_device_status?: { gpu_usable?: boolean; gpu_reason?: string };
    diarization_generate_during_analysis?: boolean;
}

interface AnalysisStoragePreflightPayload {
    ok?: boolean;
    level?: 'ok' | 'warning' | 'error';
    reason?: string;
    message?: string;
    required_bytes?: number;
    available_bytes?: number | null;
    target_dir?: string;
}

type ReadinessState = 'checking' | 'server-waiting' | 'ready' | 'missing-models' | 'error';
type AnalysisPhase = 'idle' | 'checking-server' | 'checking-models' | 'analyzing' | 'error';
type AnalysisStopAction = 'stop' | 'cancel';
type AudioExtractNotice = { tone: 'success' | 'error'; message: string; savedPath?: string | null; elapsedMs?: number };

interface CompletionNotice {
    meetingId: string;
    detailTab: 'summary' | 'script';
    elapsedMs: number;
    title: string;
    sourceFilename: string;
    note?: string;
    autoSaveNote?: string;
}

interface AnalysisSettingsResponse {
    diarization?: {
        generate_during_analysis?: boolean;
    };
    privacy?: {
        preserve_extracted_audio?: boolean;
        auto_save_audio_copy?: boolean;
    };
}

interface ReadinessCheck {
    state: ReadinessState;
    message: string;
    models?: ModelsPayload;
    /** The engine answered /api/health, even if it is not ready yet. */
    reachable?: boolean;
}

interface ReadinessOptions {
    soft?: boolean;
    /** A stopped analysis preparation aborts its check; an aborted check changes no readiness state. */
    signal?: AbortSignal;
}

const getFallbackAnalysisMessage = (phase: AnalysisPhase, progressPercent: number): string => {
    if (phase === 'checking-server') return '분석 기능 확인 중';
    if (phase === 'checking-models') return '모델 확인 중';
    if (progressPercent >= 95) return '저장 중';
    if (progressPercent >= 80) return '대화록 저장 중';
    if (progressPercent >= 25) return '음성 인식 중';
    return '분석 시작 중';
};

const parseSseChunk = (chunk: string): string[] => {
    return chunk
        .split('\n\n')
        .map(block =>
            block
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim())
                .join('\n')
        )
        .filter(Boolean);
};

const formatFileSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
};

const AUDIO_FILE_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma']);
const VIDEO_FILE_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);
const ACCEPTED_MEETING_MEDIA = [
    'audio/*',
    'video/*',
    ...AUDIO_FILE_EXTENSIONS,
    ...VIDEO_FILE_EXTENSIONS,
].join(',');

const getFileExtension = (filename: string): string => {
    const match = filename.toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : '';
};

const getMeetingTitleFromFilename = (filename: string): string => {
    const extension = getFileExtension(filename);
    const filenameWithoutExtension = extension ? filename.slice(0, -extension.length) : filename;
    return filenameWithoutExtension.trim() || filename.trim();
};

const getFileKind = (selectedFile: File): 'audio' | 'video' | 'unknown' => {
    if (selectedFile.type.startsWith('audio/')) return 'audio';
    if (selectedFile.type.startsWith('video/')) return 'video';
    const extension = getFileExtension(selectedFile.name);
    if (AUDIO_FILE_EXTENSIONS.has(extension)) return 'audio';
    if (VIDEO_FILE_EXTENSIONS.has(extension)) return 'video';
    return 'unknown';
};

/** Waits `ms`, or less when `signal` aborts first (a stopped preparation should not linger). */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
    if (signal?.aborted) {
        resolve();
        return;
    }
    const timerId = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        window.clearTimeout(timerId);
        resolve();
    }, { once: true });
});

/** A preparation request that a stop can abort and that fails with a TimeoutError if the engine stops answering. */
const requestWithinPreparationTimeout = async (
    path: string,
    init: RequestInit = {},
): Promise<Response> => {
    const controller = new AbortController();
    let timedOut = false;
    const timerId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, PREPARATION_REQUEST_TIMEOUT_MS);
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
        return await localEngineClient.request(path, { ...init, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new DOMException('The local engine did not answer in time.', 'TimeoutError');
        throw error;
    } finally {
        window.clearTimeout(timerId);
        callerSignal?.removeEventListener('abort', abortFromCaller);
    }
};

// One sentence for missing required models. Point at 모델 받기 only when Settings can actually download one of them.
const describeMissingModels = (models: ModelStatus[] = [], diarizationDuringAnalysis = false): string => {
    const missing = models.filter(model => model.required && !model.installed);
    // The diarization model is required only while 참석자 구분까지 이어서 실행 is on; turning it off is the quick way through.
    if (diarizationDuringAnalysis && missing.length > 0 && missing.every(model => model.key === 'diarization')) {
        return '참석자 구분 모델이 없어 분석 중에 참석자를 구분할 수 없습니다. 설정에서 참석자 구분까지 이어서 실행을 끄면 대화록부터 만들 수 있습니다.';
    }
    const list = missing.map(model => getUserModelLabel(model)).join(', ') || '필수 모델';
    if (missing.some(model => model.downloadable)) {
        return `분석을 시작하려면 ${list} 준비가 필요합니다. 모델 받기를 누르면 설정에서 바로 받을 수 있습니다.`;
    }
    // The web app's engine is the downloaded connection program; only the desktop app is reinstalled under the brand itself.
    const reinstallTarget = isTauriRuntime() ? BRAND_NAME : LOCAL_ENGINE_NAME;
    return `분석을 시작하려면 ${list} 준비가 필요합니다. 이 모델은 설정에서 받을 수 없으니 ${withJosa(reinstallTarget, '을/를')} 다시 설치해 주세요.`;
};

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_faster_whisper') return '음성 인식 기본 모델';
    if (model.key === 'diarization') return '참석자 구분';
    return model.label;
};

const translateStatusMessage = (message: string): string => {
    const normalized = message.trim();
    const stallSuffix = ' 같은 단계가 오래 걸리고 있습니다. 진행이 바뀌지 않으면 취소 후 다시 시도해 주세요.';
    const isStalled = normalized.endsWith(stallSuffix);
    const baseMessage = isStalled ? normalized.slice(0, -stallSuffix.length) : normalized;
    const chunkMatch = baseMessage.match(/^Transcribing chunk (\d+)\/(\d+)/);
    if (chunkMatch) {
        return `음성 인식 ${chunkMatch[1]}/${chunkMatch[2]} 구간`;
    }

    const statusMap: Record<string, string> = {
        '업로드 파일 저장 완료': '파일 저장 완료',
        '음성 인식 모델 확인 중': '모델 확인 중',
        '음성 인식 모델 준비 완료': '모델 준비 완료',
        'Converting to WAV...': '음성 추출 중',
        'Preparing audio chunks...': '구간 나누는 중',
        '음성 인식이 완료되었습니다. 후처리를 준비하고 있습니다.': '후처리 준비 중',
        'Primary speech recognition failed; using fallback model...': '음성 인식 재시도 중',
        'Speaker Diarization & Alignment...': '참석자 구분 중',
        '화자 구간 분석 완료. 문장 시간과 맞추는 중': '참석자 구간 확인 완료. 문장 시간과 맞추는 중',
        'Summarizing with Local LLM...': '요약 정리 중',
        '대화록 생성이 완료되었습니다. 정리는 회의 기록에서 별도로 실행해 주세요.': '대화록 저장 완료',
        'Saving results...': '저장 중',
    };

    return statusMap[baseMessage] || baseMessage;
};

const formatDuration = (seconds: number): string => {
    const totalSeconds = Math.max(0, Math.round(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) return `${hours}시간 ${minutes}분`;
    if (minutes > 0) return `${minutes}분 ${remainingSeconds}초`;
    return `${remainingSeconds}초`;
};

const formatResumeUpdatedAt = (value?: string): string => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
};

const getResumeUnavailableReasonLabel = (draft: AnalysisResumeDraft): string => {
    if (draft.status === 'active') return '이미 분석이 진행 중입니다. 진행이 끝나거나 중단된 뒤 이어갈 수 있습니다.';
    if (draft.resumeUnavailableReason === 'no-checkpoint') return '재사용 가능한 체크포인트가 없습니다.';
    if (draft.resumeUnavailableReason === 'file-mismatch') return '선택한 파일이 이 기록의 파일과 다릅니다.';
    if (draft.resumeUnavailableReason === 'completed') return '분석이 완료되어 이어할 필요가 없습니다. 결과는 회의 기록에서 확인하세요.';
    if (draft.resumeUnavailableReason === 'not-candidate') return '현재 재사용 후보로 확인되지 않았습니다.';
    if (draft.resumeEligible === false) return '재사용 가능한 진행분이 없습니다.';
    return '';
};

const getResumeStartErrorMessage = (draft: AnalysisResumeDraft): string => {
    if (draft.status === 'active') {
        return '이 분석은 다른 실행에서 진행 중입니다. 상태를 다시 확인하거나 필요하면 기록을 삭제할 수 있습니다.';
    }
    const reason = getResumeUnavailableReasonLabel(draft);
    return reason
        ? `이전 분석 기록을 이어서 진행할 수 없습니다. ${reason}`
        : '이전 분석 기록을 이어서 진행할 수 없습니다. 새 분석으로 시작할 수 있습니다.';
};

const isMatchingResumeDraftFile = (draft: AnalysisResumeDraft, selectedFile: File | null): boolean => {
    if (!selectedFile) return false;
    return (
        draft.sourceFilename === selectedFile.name
        && draft.sourceSize === selectedFile.size
        && draft.sourceLastModified === selectedFile.lastModified
    );
};

const getResumePromptMessage = (candidate: ResumeCandidate): string => {
    const stageLabel = translateStatusMessage(candidate.last_progress?.message || candidate.stage);
    const updatedAt = formatResumeUpdatedAt(candidate.updated_at);
    const chunkLabel = candidate.chunk_count > 0
        ? `음성 인식 ${candidate.completed_chunk_count}/${candidate.chunk_count} 구간 완료`
        : '이전 분석 기록';
    return [
        '같은 파일로 이어서 할 분석을 찾았습니다.',
        updatedAt ? `최근 상태: ${updatedAt}` : undefined,
        stageLabel ? `진행 단계: ${stageLabel}` : undefined,
        chunkLabel,
        '',
        '이전 음성 인식 진행분 재사용을 시도할까요?',
    ].filter(Boolean).join('\n');
};

const sortResumeCandidates = (
    candidates: ResumeCandidate[] = [],
    recommendedJobId?: string | null,
): ResumeCandidate[] => (
    [...candidates].sort((a, b) => {
        if (a.job_id === recommendedJobId) return -1;
        if (b.job_id === recommendedJobId) return 1;
        return 0;
    })
);

const filterPromptableResumeCandidates = (
    candidates: ResumeCandidate[],
    options: {
        suppressed: boolean;
        selectedJobId?: string | null;
    },
): ResumeCandidate[] => (
    candidates.filter(candidate => !options.suppressed || candidate.job_id === options.selectedJobId)
);

const getCompletionResumeNote = (resume?: AnalyzeResult['resume']): string | undefined => {
    if (!resume?.requested) return undefined;
    if (resume.mode === 'fallback_fresh_start') {
        return '이전 분석 기록과 일치하지 않아 이번 분석은 처음부터 다시 진행했습니다.';
    }
    if (resume.mode === 'reused_stt_and_diarization') {
        const reusedChunkCount = resume.reused_chunk_count || 0;
        return reusedChunkCount > 0
            ? `이전 음성 인식 진행분 ${reusedChunkCount}개 구간과 참석자 구분 결과를 재사용했습니다.`
            : '이전 참석자 구분 결과를 재사용했습니다.';
    }
    if (resume.mode === 'reused_diarization') {
        return '이전 참석자 구분 결과를 재사용했습니다.';
    }
    if (resume.mode === 'reused_stt' && (resume.reused_chunk_count || 0) > 0) {
        return `이전 음성 인식 진행분 ${resume.reused_chunk_count}개 구간을 재사용했습니다.`;
    }
    return undefined;
};

const getAutoSaveCompletionNote = (result: AnalyzeResult): string | undefined => {
    const savedKinds = [
        result.auto_saved_files?.hwpx ? '회의록 HWPX' : '',
        result.auto_saved_files?.audio ? '음성 파일' : '',
    ].filter(Boolean);
    const failedKinds = [
        result.auto_save_errors?.hwpx ? `HWPX(${result.auto_save_errors.hwpx})` : '',
        result.auto_save_errors?.audio ? `음성 파일(${result.auto_save_errors.audio})` : '',
    ].filter(Boolean);

    const notes: string[] = [];
    if (savedKinds.length) {
        notes.push(`${savedKinds.join(', ')}을 다운로드 폴더에 자동 저장했습니다.`);
    }
    if (!result.auto_saved_files?.audio && result.outputs?.audio && !result.auto_save_errors?.audio) {
        notes.push('음성 파일은 앱 안에 보관됩니다. 결과 화면에서 필요할 때 저장할 수 있습니다.');
    }
    if (failedKinds.length) {
        notes.push(`${failedKinds.join(', ')} 자동 저장은 실패했습니다.`);
    }
    return notes.length ? notes.join(' ') : undefined;
};

const requestAnalysisStoragePreflight = async (
    selectedFile: File,
    durationSeconds: number | null,
    signal?: AbortSignal,
): Promise<AnalysisStoragePreflightPayload> => {
    const response = await requestWithinPreparationTimeout('/api/analyze/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            file_size: selectedFile.size,
            duration_seconds: durationSeconds,
            source_filename: selectedFile.name,
        }),
        signal,
    });
    if (!response.ok) {
        const detailText = await response.text().catch(() => '');
        let message = detailText;
        if (detailText.startsWith('{')) {
            try {
                const parsedDetail = JSON.parse(detailText) as { detail?: string };
                message = parsedDetail.detail || detailText;
            } catch {
                message = detailText;
            }
        }
        throw new Error(message || '저장 공간을 확인하지 못했습니다.');
    }
    return await response.json() as AnalysisStoragePreflightPayload;
};

const toResumeDraftFileKey = (selectedFile: File): AnalysisResumeDraftFileKey => ({
    sourceFilename: selectedFile.name,
    sourceSize: selectedFile.size,
    sourceLastModified: selectedFile.lastModified,
});

interface MeetingWriterProps {
    onOpenSettings?: () => void;
    analysisStartBlocked?: boolean;
    analysisStartBlockedReason?: string;
    resumeDraftSelectionRequest?: { jobId: string; requestId: number } | null;
    onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
    /** Opens Settings at 문제 해결 (desktop: restart the analysis engine). */
    onOpenTroubleshooting?: () => void;
    /** Opens Settings > 일반 at 분석 장치 (GPU unusable) or 참석자 구분까지 이어서 실행 (its model is missing). */
    onOpenAnalysisSettings?: (section: 'device' | 'diarization') => void;
    /** Shown under the input form while no analysis, completion or resume selection is on screen. */
    idleCompanion?: React.ReactNode;
}

export const MeetingWriter: React.FC<MeetingWriterProps> = ({ onOpenSettings, analysisStartBlocked = false, analysisStartBlockedReason = '진행 중인 분석이 끝나면 새 회의록을 만들 수 있습니다.', resumeDraftSelectionRequest, onRegisterLeaveGuard, onOpenTroubleshooting, onOpenAnalysisSettings, idleCompanion }) => {
    const { snapshot: localEngineConnection, beginTransportCheck, reportTransport, probeLocalEngine } = useLocalEngineConnection();
    const [webConnectionRecoveryStarted, setWebConnectionRecoveryStarted] = useState(false);
    const [connectionCheckRequired, setConnectionCheckRequired] = useState(false);
    // The web build explains local processing once per browser before the user installs the engine.
    const [localProcessingNotice, setLocalProcessingNotice] = useState<LocalProcessingNoticeMode | null>(() => (
        LOCAL_ENGINE_CONNECTION_UI_ENABLED
        && getRuntimeEnvironment().kind === 'web-local-engine'
        && !hasSeenLocalProcessingIntro()
            ? 'intro'
            : null
    ));
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(() => toLocalDateTimeInputValue());
    const [initialDateValue, setInitialDateValue] = useState(date);
    const [meetingPurpose, setMeetingPurpose] = useState('');
    const [selectedReportTemplateId, setSelectedReportTemplateId] = useState(DEFAULT_REPORT_TEMPLATE_ID);
    const [file, setFile] = useState<File | null>(null);
    const [isFileDragActive, setIsFileDragActive] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
    const [analysisNow, setAnalysisNow] = useState(() => Date.now());
    const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
    const analysisPhaseRef = useRef<AnalysisPhase>('idle');
    useEffect(() => {
        analysisPhaseRef.current = analysisPhase;
    }, [analysisPhase]);
    const [isAnalysisStopConfirmOpen, setIsAnalysisStopConfirmOpen] = useState(false);
    const [isRequestingAnalysisStop, setIsRequestingAnalysisStop] = useState(false);
    const [analysisStopRequestedAction, setAnalysisStopRequestedAction] = useState<AnalysisStopAction | null>(null);
    const [statusMessage, setStatusMessage] = useState('');
    const [operationToast, setOperationToast] = useState<AppToastMessage | null>(null);
    const [diarizationDuringAnalysis, setDiarizationDuringAnalysis] = useState(true);
    const [rawStatusMessage, setRawStatusMessage] = useState('');
    const [transcriptReady, setTranscriptReady] = useState(false);
    const [analysisEtaSeconds, setAnalysisEtaSeconds] = useState<number | null>(null);
    const [analysisEtaReceivedAt, setAnalysisEtaReceivedAt] = useState<number | null>(null);
    const transcriptReadyRef = useRef(false);
    const [lastRealProgressAt, setLastRealProgressAt] = useState(() => Date.now());
    const [storedErrorMessage, setErrorMessage] = useState('');
    // Why the analysis failed and, when the transcript was already saved, which meeting holds it.
    const [analysisFailure, setAnalysisFailure] = useState<{ cause: UserErrorCause; savedMeetingId: string | null; onGpu?: boolean } | null>(null);
    const [hasAttemptedStart, setHasAttemptedStart] = useState(false);
    const [fileDurationSeconds, setFileDurationSeconds] = useState<number | null>(null);
    const fileDurationLimitError = getAnalysisDurationLimitError(fileDurationSeconds);
    const errorMessage = (!isAnalyzing && fileDurationLimitError) || storedErrorMessage;
    const [preserveExtractedAudio, setPreserveExtractedAudio] = useState<boolean | null>(null);
    const [autoSaveAudioCopy, setAutoSaveAudioCopy] = useState<boolean | null>(null);
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    // True once the load-time readiness loop gave up without reaching the analysis engine.
    const [readinessTimedOut, setReadinessTimedOut] = useState(false);
    const readinessLoopRef = useRef(0);
    const [isRecheckingEngine, setIsRecheckingEngine] = useState(false);
    // Bumped when an analysis run ends: the background readiness loop stops at `ready`, and a run that found the
    // engine gone leaves `server-waiting`, which disables 분석 시작 until a running check clears it.
    const [readinessLoopKey, setReadinessLoopKey] = useState(0);
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null);
    const [audioExtractFile, setAudioExtractFile] = useState<File | null>(null);
    const [isExtractingAudio, setIsExtractingAudio] = useState(false);
    const [audioExtractNotice, setAudioExtractNotice] = useState<AudioExtractNotice | null>(null);
    const [audioExtractStartedAt, setAudioExtractStartedAt] = useState<number | null>(null);
    const [audioExtractNow, setAudioExtractNow] = useState(() => Date.now());
    const audioExtractRequestRef = useRef(0);
    const resumeSnapshot = useAnalysisResumeSnapshot();
    const resumeDrafts = resumeSnapshot.drafts;
    const canResumeDraft = React.useCallback(
        (draft: AnalysisResumeDraft) => isActionableResumeDraft(draft, resumeSnapshot),
        [resumeSnapshot],
    );
    const [selectedResumeDraftId, setSelectedResumeDraftId] = useState<string | null>(null);
    const [deletingResumeDraftIds, setDeletingResumeDraftIds] = useState<Set<string>>(() => new Set());
    const selectedReportTemplate = useMemo(
        () => getReportTemplateById(selectedReportTemplateId),
        [selectedReportTemplateId],
    );
    const localEngineConnectionRequired = (LOCAL_ENGINE_CONNECTION_UI_ENABLED || webConnectionRecoveryStarted)
        && localEngineConnection.runtime === 'web-local-engine';
    const localEngineAnalysisReady = canUseLocalEngineCapability(localEngineConnection, 'analysis')
        && !localEngineConnection.updateRequired;
    const localEngineAuthorizedForReadiness = localEngineConnection.authorization === 'authenticated'
        && localEngineConnection.capabilities.has('analysis')
        && !localEngineConnection.updateRequired
        && !['unreachable', 'incompatible', 'error'].includes(localEngineConnection.transport);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const autoDerivedTitleRef = useRef<string | null>(null);
    const fileDragDepthRef = useRef(0);
    const fileMetadataRequestRef = useRef(0);
    const fileMetadataCleanupRef = useRef<(() => void) | null>(null);
    const analysisSettingsRequestRef = useRef(0);
    const videoFileInputRef = useRef<HTMLInputElement | null>(null);
    const analysisInFlightRef = useRef(false);
    const analysisAbortControllerRef = useRef<AbortController | null>(null);
    const analysisCancelledRef = useRef(false);
    const analysisJobIdRef = useRef<string | null>(null);
    const analysisResumeDraftIdRef = useRef<string | null>(null);
    const analysisStopActionRef = useRef<AnalysisStopAction | null>(null);
    const analysisStopAcceptedActionRef = useRef<AnalysisStopAction | null>(null);
    const analysisPreserveExistingRef = useRef(false);
    const analysisResumeDraftBeforeRequestRef = useRef<AnalysisResumeDraft | undefined>(undefined);
    const analysisStopDecisionPromiseRef = useRef<Promise<AnalysisStopAction | null> | null>(null);
    const analysisFinalMeetingSavePromiseRef = useRef<Promise<string> | null>(null);
    const transcriptMeetingSavePromiseRef = useRef<Promise<void> | null>(null);
    const transcriptSavedMeetingIdRef = useRef<string | null>(null);
    // Set by 중지 before the analysis stream starts; the run then unwinds without leaving a resume record.
    const analysisPreparationStoppedRef = useRef(false);
    const selectedResumeDraftIdRef = useRef<string | null>(null);
    const queueMeetingMutation = queueAnalysisJobMutation;
    const invalidateFileMetadata = React.useCallback(() => {
        fileMetadataRequestRef.current += 1;
        fileMetadataCleanupRef.current?.();
        fileMetadataCleanupRef.current = null;
    }, []);
    const clearSelectedFileState = React.useCallback(() => {
        invalidateFileMetadata();
        setFile(null);
        setFileDurationSeconds(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }, [invalidateFileMetadata]);

    useEffect(() => () => {
        invalidateFileMetadata();
    }, [invalidateFileMetadata]);

    const updateAnalysisEtaSeconds = React.useCallback((nextEtaSeconds: number | null) => {
        setAnalysisEtaSeconds(currentEtaSeconds => {
            if (nextEtaSeconds === null) {
                setAnalysisEtaReceivedAt(null);
                return null;
            }
            if (currentEtaSeconds !== nextEtaSeconds) {
                setAnalysisEtaReceivedAt(getNowMs());
            }
            return nextEtaSeconds;
        });
    }, []);
    const analysisStalled = isAnalyzing && analysisPhase === 'analyzing' && analysisNow - lastRealProgressAt >= ANALYSIS_STALL_WARNING_MS;
    const showOperationToast = React.useCallback((message: string, tone: AppToastTone = 'neutral') => {
        setOperationToast({
            id: Date.now(),
            message,
            tone,
        });
    }, []);

    const loadAnalysisSettings = React.useCallback(async () => {
        const requestId = analysisSettingsRequestRef.current + 1;
        analysisSettingsRequestRef.current = requestId;
        try {
            const response = await localEngineClient.request('/api/settings');
            if (!response.ok) throw new Error(`settings=${response.status}`);
            const data = await response.json() as AnalysisSettingsResponse;
            if (analysisSettingsRequestRef.current !== requestId) return;
            setDiarizationDuringAnalysis(data.diarization?.generate_during_analysis ?? true);
            setPreserveExtractedAudio(data.privacy?.preserve_extracted_audio ?? true);
            setAutoSaveAudioCopy(data.privacy?.auto_save_audio_copy ?? false);
        } catch (error) {
            if (analysisSettingsRequestRef.current !== requestId) return;
            await writeFrontendLog(`analysis settings load error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            setPreserveExtractedAudio(null);
            setAutoSaveAudioCopy(null);
        }
    }, []);

    const hasDraftableInput = useMemo(() => (
        Boolean(title.trim())
        || Boolean(meetingPurpose.trim())
        || selectedReportTemplateId !== DEFAULT_REPORT_TEMPLATE_ID
        || Boolean(file)
        || Boolean(selectedResumeDraftId)
        || date !== initialDateValue
    ), [date, file, initialDateValue, meetingPurpose, selectedReportTemplateId, selectedResumeDraftId, title]);
    const hasWriterCloseRisk = isAnalyzing || isExtractingAudio || hasDraftableInput;

    useEffect(() => {
        window.dispatchEvent(new CustomEvent('close-guard:state', {
            detail: { source: 'meeting-writer', active: hasWriterCloseRisk },
        }));
        return () => {
            window.dispatchEvent(new CustomEvent('close-guard:state', {
                detail: { source: 'meeting-writer', active: false },
            }));
        };
    }, [hasWriterCloseRisk]);

    useEffect(() => {
        if (!operationToast) return undefined;
        const timerId = window.setTimeout(() => {
            setOperationToast(current => (current?.id === operationToast.id ? null : current));
        }, 5000);
        return () => window.clearTimeout(timerId);
    }, [operationToast]);

    useEffect(() => {
        void loadAnalysisSettings();
        const handleSettingsUpdated = () => {
            void loadAnalysisSettings();
        };
        window.addEventListener('focus', handleSettingsUpdated);
        window.addEventListener('analysis:settings-updated', handleSettingsUpdated);
        return () => {
            window.removeEventListener('focus', handleSettingsUpdated);
            window.removeEventListener('analysis:settings-updated', handleSettingsUpdated);
            analysisSettingsRequestRef.current += 1;
        };
    }, [loadAnalysisSettings]);

    useEffect(() => {
        const active = isAnalyzing;
        const adjustedEtaSeconds = getAdjustedEtaSeconds(analysisEtaSeconds, analysisEtaReceivedAt, analysisNow);
        window.dispatchEvent(new CustomEvent('analysis:status', {
            detail: {
                active,
                progress,
                message: statusMessage,
                rawMessage: rawStatusMessage,
                startedAt: analysisStartedAt,
                stalled: analysisStalled,
                transcriptReady,
                etaSeconds: adjustedEtaSeconds,
                completionVisible: Boolean(completionNotice),
            },
        }));
    }, [analysisEtaReceivedAt, analysisEtaSeconds, analysisNow, analysisStartedAt, analysisStalled, completionNotice, isAnalyzing, progress, rawStatusMessage, statusMessage, transcriptReady]);

    useEffect(() => {
        if (!isAnalyzing) return;
        setAnalysisNow(Date.now());
        const timer = window.setInterval(() => setAnalysisNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isAnalyzing]);

    useEffect(() => {
        selectedResumeDraftIdRef.current = selectedResumeDraftId;
    }, [selectedResumeDraftId]);

    useEffect(() => {
        if (!isExtractingAudio) return;
        setAudioExtractNow(Date.now());
        const timer = window.setInterval(() => setAudioExtractNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isExtractingAudio]);

    const refreshReadiness = useCallback(async (options: ReadinessOptions = {}): Promise<ReadinessCheck> => {
        if (ANALYSIS_MODE !== 'real') {
            setReadinessState('ready');
            setReadinessMessage('');
            return { state: 'ready', message: '' };
        }

        let healthReachable = false;
        const readinessOwner = readinessLoopRef.current;
        const superseded = () => readinessOwner !== readinessLoopRef.current;
        const transportCheckId = localEngineConnectionRequired ? null : beginTransportCheck();
        try {
            const apiBase = await getApiBase();
            await writeFrontendLog(`readiness start soft=${options.soft ? 'true' : 'false'} apiBase=${apiBase}`);
            const healthResponse = await requestWithinPreparationTimeout('/api/health', { signal: options.signal });
            await writeFrontendLog(`readiness health status=${healthResponse.status} ok=${healthResponse.ok}`);
            if (superseded()) return { state: 'checking', message: '' };
            healthReachable = true;
            setReadinessTimedOut(false);
            if (transportCheckId !== null) {
                reportTransport(transportCheckId, transportFromHealthEvidence(true));
            }
            if (healthResponse.status === 401 || healthResponse.status === 403) {
                setConnectionCheckRequired(!isTauriRuntime());
                const message = '연결 상태를 확인해야 분석을 시작할 수 있습니다.';
                setReadinessState('error');
                setReadinessMessage(message);
                return { state: 'error', message };
            }
            if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);

            await healthResponse.json().catch(() => null);

            const modelsResponse = await requestWithinPreparationTimeout('/api/models/status', { signal: options.signal });
            await writeFrontendLog(`readiness models status=${modelsResponse.status} ok=${modelsResponse.ok}`);
            if (superseded()) return { state: 'checking', message: '' };
            if (modelsResponse.status === 401 || modelsResponse.status === 403) {
                setConnectionCheckRequired(!isTauriRuntime());
                const message = '연결 상태를 확인해야 분석을 시작할 수 있습니다.';
                setReadinessState('error');
                setReadinessMessage(message);
                return { state: 'error', message };
            }
            if (!modelsResponse.ok) {
                const body = await modelsResponse.text().catch(() => '');
                await writeFrontendLog(`readiness models non-ok body=${body.slice(0, 500)}`);
                if (superseded()) return { state: 'checking', message: '' };
                const message = options.soft
                    ? '분석 기능을 준비하고 있습니다. 잠시 기다려 주세요.'
                    : isTauriRuntime()
                        ? '모델 상태를 확인하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요.'
                        : `모델 상태를 확인하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 실행한 뒤 다시 확인해 주세요.`;
                setReadinessState(options.soft ? 'server-waiting' : 'error');
                setReadinessMessage(message);
                return { state: options.soft ? 'server-waiting' : 'error', message };
            }

            const payload = await modelsResponse.json() as ModelsPayload;
            await writeFrontendLog(`readiness models payload ready=${payload.ready} count=${payload.models?.length ?? 0} errors=${payload.errors?.join(' | ') ?? ''}`);
            if (superseded()) return { state: 'checking', message: '' };
            setConnectionCheckRequired(false);
            setModelsPayload(payload);

            if (payload.ready) {
                setReadinessState('ready');
                setReadinessMessage('');
                return { state: 'ready', message: '', models: payload };
            }

            // A missing model is fixed first, so it names the banner; otherwise errors[0] is the real cause (e.g. GPU not usable).
            const requiredMissing = payload.models.some(model => model.required && !model.installed);
            const missingMessage = describeMissingModels(payload.models, payload.diarization_generate_during_analysis === true);
            const message = requiredMissing ? missingMessage : payload.errors?.[0] || missingMessage;
            setReadinessState('missing-models');
            setReadinessMessage(message);
            return { state: 'missing-models', message, models: payload };
        } catch (error) {
            // A stop, not an answer from the engine: keep the last known readiness and transport.
            if (superseded() || options.signal?.aborted) return { state: 'server-waiting', message: '', reachable: healthReachable };
            if (transportCheckId !== null) {
                reportTransport(transportCheckId, transportFromHealthEvidence(healthReachable));
            }
            await writeFrontendLog(`readiness error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            if (superseded()) return { state: 'checking', message: '' };
            const message = !options.soft
                ? describeAnalysisError(error, { desktopApp: isTauriRuntime() }).message
                : '분석 기능을 준비하고 있습니다. 첫 실행은 시간이 걸릴 수 있습니다.';
            setReadinessState('server-waiting');
            setReadinessMessage(message);
            return { state: 'server-waiting', message, reachable: healthReachable };
        }
    }, [beginTransportCheck, localEngineConnectionRequired, reportTransport]);

    useEffect(() => {
        if (ANALYSIS_MODE !== 'real') return;
        if (localEngineConnectionRequired && !localEngineAuthorizedForReadiness) {
            setReadinessState('checking');
            setReadinessMessage('');
            return;
        }

        let cancelled = false;
        const syncReadiness = async () => {
            // Only the newest loop keeps polling; focus and settings events start a fresh one.
            const loopId = readinessLoopRef.current + 1;
            readinessLoopRef.current = loopId;
            const superseded = () => cancelled || loopId !== readinessLoopRef.current;
            const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
            let finalCheckDone = false;

            while (!superseded()) {
                const pastDeadline = Date.now() >= deadline;
                // One strict check at the deadline, then soft checks every few seconds until the engine answers.
                const check = await refreshReadiness({ soft: !pastDeadline || finalCheckDone });
                if (superseded()) return;

                if (check.state === 'ready') {
                    // A failure card stays until the user acts on it, and a running analysis keeps its phase.
                    if (!analysisInFlightRef.current && analysisPhaseRef.current !== 'error') {
                        setErrorMessage('');
                        setStatusMessage('');
                        setAnalysisPhase('idle');
                    }
                    return;
                }

                if (check.state === 'missing-models') {
                    // Only a model download can clear this on its own (a GPU or reinstall problem cannot), and it can
                    // finish while Settings is closed: keep a slow, soft check for that case only.
                    const downloadPending = (check.models?.models || []).some(model => model.required && !model.installed && model.downloadable);
                    if (!downloadPending) return;
                    finalCheckDone = true;
                    do {
                        await sleep(READINESS_SLOW_POLL_MS);
                    } while (!superseded() && document.visibilityState === 'hidden');
                    continue;
                }
                if (pastDeadline) {
                    if (check.state === 'error') return;
                    if (check.state === 'server-waiting' && !check.reachable) setReadinessTimedOut(true);
                    finalCheckDone = true;
                }
                await sleep(pastDeadline ? READINESS_SLOW_POLL_MS : BACKEND_READY_INTERVAL_MS);
            }
        };

        const handleSettingsUpdated = () => {
            void syncReadiness();
        };

        void syncReadiness();
        window.addEventListener('focus', syncReadiness);
        window.addEventListener('analysis:settings-updated', handleSettingsUpdated);
        return () => {
            cancelled = true;
            readinessLoopRef.current += 1;
            window.removeEventListener('focus', syncReadiness);
            window.removeEventListener('analysis:settings-updated', handleSettingsUpdated);
        };
    }, [localEngineAuthorizedForReadiness, localEngineConnectionRequired, readinessLoopKey, refreshReadiness]);

    const missingRequiredModels = useMemo(
        () => (modelsPayload?.models || []).filter(model => model.required && !model.installed),
        [modelsPayload],
    );

    const missingFields = useMemo(() => {
        const fields: string[] = [];
        if (!title.trim()) fields.push('회의 제목');
        if (!date) fields.push('일시');
        if (!meetingPurpose.trim()) fields.push('회의 목적');
        if (!file) fields.push('영상·음성 파일');
        return fields;
    }, [date, file, meetingPurpose, title]);

    useEffect(() => {
        if (!onRegisterLeaveGuard) return;
        onRegisterLeaveGuard(() => {
            if (isAnalyzing) {
                return window.confirm('분석이 진행 중입니다. 화면을 이동하면 진행 상태 확인이 어려울 수 있습니다. 이동할까요?');
            }
            if (isExtractingAudio) {
                return window.confirm('음성 추출이 진행 중입니다. 다른 화면으로 이동할까요?');
            }
            if (!hasDraftableInput) return true;
            return window.confirm('작성 중인 내용이 있습니다. 다른 기록으로 이동할까요?');
        });
        return () => {
            onRegisterLeaveGuard(null);
        };
    }, [hasDraftableInput, isAnalyzing, isExtractingAudio, onRegisterLeaveGuard]);

    const selectedResumeDraft = useMemo(
        () => resumeDrafts.find(draft => draft.jobId === selectedResumeDraftId) ?? null,
        [resumeDrafts, selectedResumeDraftId],
    );
    const selectedResumeDraftActive = selectedResumeDraft?.status === 'active';

    const activeResumeDrafts = useMemo(
        () => resumeDrafts.filter(draft => draft.status === 'active'),
        [resumeDrafts],
    );

    const resumeDraftFileMismatch = useMemo(() => {
        if (!selectedResumeDraft || !file) return false;
        return !isMatchingResumeDraftFile(selectedResumeDraft, file);
    }, [file, selectedResumeDraft]);

    const matchingActiveDraft = useMemo(() => {
        if (!file) return null;
        return activeResumeDrafts.find(draft => isMatchingResumeDraftFile(draft, file)) ?? null;
    }, [activeResumeDrafts, file]);

    const resumeSelectionActive = Boolean(selectedResumeDraft);
    const resumeAwaitingFile = Boolean(selectedResumeDraft && !file);
    const selectedResumeDraftUnavailable = Boolean(selectedResumeDraft && !canResumeDraft(selectedResumeDraft));
    const resumeReady = Boolean(selectedResumeDraft && file && !resumeDraftFileMismatch && !selectedResumeDraftUnavailable);
    const hasBlockingReadinessIssue = readinessState === 'missing-models' || readinessState === 'error';
    // Not connected (yet): the engine has not answered, or answered but is still starting up.
    const engineNotConnected = readinessState === 'server-waiting' && !localEngineConnectionRequired;
    const startButtonOperationallyDisabled = isAnalyzing
        || isExtractingAudio
        || Boolean(matchingActiveDraft)
        || selectedResumeDraftUnavailable
        || resumeDraftFileMismatch
        || Boolean(fileDurationLimitError)
        || hasBlockingReadinessIssue
        || engineNotConnected
        || (localEngineConnectionRequired && !localEngineAnalysisReady)
        || (localEngineConnectionRequired && readinessState !== 'ready')
        || analysisStartBlocked;
    const engineUnreachable = readinessTimedOut && engineNotConnected;
    // From the first failed check until the 45s notice: one quiet line, so 분석 시작 is never silently unusable.
    const showEngineCheckingLine = !isAnalyzing && ((engineNotConnected && !readinessTimedOut)
        || (localEngineConnectionRequired && localEngineAnalysisReady
            && !hasBlockingReadinessIssue && readinessState !== 'ready'));
    // The required-field error is shown in the action row (beside 분석 시작) instead of a banner below the fold.
    // Live list of what is still missing after a start attempt; it disappears as soon as the fields are filled.
    const formErrorInline = hasAttemptedStart && missingFields.length > 0 && !localEngineConnectionRequired && !isAnalyzing;
    // In connection mode the connection surface owns connecting; once connected, model readiness speaks here too.
    const showReadinessHint = !isAnalyzing && (localEngineConnectionRequired
        ? localEngineAnalysisReady && hasBlockingReadinessIssue
        : hasBlockingReadinessIssue || engineUnreachable);
    // ready=false can also mean an unusable device or a status error; only offer 모델 받기 when a required model is really missing.
    const requiredModelsAbsent = readinessState === 'missing-models' && missingRequiredModels.length > 0;
    const modelsMissing = requiredModelsAbsent && missingRequiredModels.some(model => model.downloadable);
    // Required models Settings cannot download: reinstalling is the fix, so the row states the cause without a button.
    const modelsNeedReinstall = requiredModelsAbsent && !modelsMissing;
    // Only the diarization model is missing and it is required by 참석자 구분까지 이어서 실행: turning that off is the fix.
    const diarizationSettingBlocks = modelsNeedReinstall && modelsPayload?.diarization_generate_during_analysis === true
        && missingRequiredModels.every(model => model.key === 'diarization');
    // GPU selected but unusable (all models present): switching 분석 장치 to CPU is the fix, not a restart.
    const gpuUnavailable = readinessState === 'missing-models' && !requiredModelsAbsent
        && modelsPayload?.selected_stt_device === 'cuda' && modelsPayload?.stt_device_status?.gpu_usable === false;
    // Where the hint's button leads: missing models -> Settings > 모델; otherwise 문제 해결 (desktop) / 다시 확인 (web).
    const readinessAction: 'models' | 'device' | 'diarization' | 'troubleshoot' | 'recheck' | 'connect' | null = !showReadinessHint
        || (modelsNeedReinstall && !(diarizationSettingBlocks && onOpenAnalysisSettings))
        ? null
        : !isTauriRuntime() && !localEngineConnectionRequired && (engineUnreachable || connectionCheckRequired)
            ? 'connect'
        : diarizationSettingBlocks && onOpenAnalysisSettings
            ? 'diarization'
        : gpuUnavailable && onOpenAnalysisSettings
            ? 'device'
        : modelsMissing && onOpenSettings
            ? 'models'
            : isTauriRuntime() && onOpenTroubleshooting && !localEngineConnectionRequired ? 'troubleshoot' : 'recheck';
    const startButtonDescription = [
        analysisStartBlocked ? 'writer-analysis-start-blocked' : '',
        formErrorInline ? 'writer-form-error' : '',
        showReadinessHint ? 'writer-readiness-hint' : '',
        showEngineCheckingLine ? 'writer-engine-checking' : '',
        localEngineConnectionRequired && !localEngineAnalysisReady ? 'writer-local-engine-requirement' : '',
    ].filter(Boolean).join(' ') || undefined;

    // Title and tone follow the actual cause: a GPU or status problem is not a missing model.
    const readinessBannerTone = modelsMissing ? 'info' : 'error';
    const readinessBannerTitle = modelsMissing ? '준비할 모델' : '분석을 시작할 수 없습니다';

    const recheckDevelopmentReadiness = async (probe: LocalEngineProbePayload) => {
        // A recovered anonymous dev API may have no pairing helper. It must actually accept
        // the usual health/model requests; probe alone never grants authorization.
        if (!import.meta.env.DEV || LOCAL_ENGINE_CONNECTION_UI_ENABLED || probe.update_required
            || probe.api_contract_version !== 1 || !probe.capabilities.includes('analysis')) return;
        const check = await refreshReadiness();
        if (check.state === 'ready' || check.state === 'missing-models') {
            setWebConnectionRecoveryStarted(false);
        }
    };

    const handleCheckWebConnection = async () => {
        // Hand ownership to the coordinator before probing; old anonymous checks must not undo pairing.
        readinessLoopRef.current += 1;
        setReadinessState('checking');
        setReadinessMessage('');
        setWebConnectionRecoveryStarted(true);
        try {
            const probe = await probeLocalEngine({ userInitiated: true });
            if (probe) await recheckDevelopmentReadiness(probe);
        } catch {
            // The connection surface explains the coordinator's current state and recovery action.
        }
    };

    const waitForBackendReady = async (signal?: AbortSignal): Promise<ReadinessCheck> => {
        const deadline = getNowMs() + BACKEND_READY_TIMEOUT_MS;
        setAnalysisPhase('checking-server');

        while (getNowMs() < deadline && !analysisCancelledRef.current) {
            const check = await refreshReadiness({ signal });
            if (analysisCancelledRef.current) break;
            if (check.state === 'ready') return check;
            if (check.state === 'missing-models' || check.state === 'error') return check;

            const remainingSeconds = Math.max(0, Math.ceil((deadline - getNowMs()) / 1000));
            setStatusMessage(`분석 기능을 준비하고 있습니다. 잠시 기다려 주세요. (${remainingSeconds}초)`);
            await sleep(BACKEND_READY_INTERVAL_MS, signal);
        }

        if (analysisCancelledRef.current) {
            return { state: 'error', message: '분석 요청을 중단했습니다.' };
        }

        const message = isTauriRuntime()
            ? DESKTOP_ENGINE_NOT_READY_MESSAGE
            : `이 PC의 분석 기능에 연결하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인한 뒤 다시 시도해 주세요.`;
        setAnalysisPhase('error');
        setAnalysisFailure({ cause: 'engine-disconnected', savedMeetingId: null });
        setErrorMessage(message);
        setStatusMessage('');
        return { state: 'error', message };
    };

    const ensureModelsReady = async (): Promise<boolean> => {
        if (ANALYSIS_MODE !== 'real') return true;

        setAnalysisPhase('checking-models');
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        const check = await waitForBackendReady(analysisAbortControllerRef.current?.signal);
        if (analysisCancelledRef.current) return false;
        if (check.state === 'ready') return true;

        if (check.state === 'missing-models') {
            // Keep refreshReadiness' sentence: it already prefers the engine's own reason over the generic one.
            setReadinessState('missing-models');
            setReadinessMessage(check.message);
            setErrorMessage('');
            setAnalysisPhase('idle');
            return false;
        }

        setErrorMessage(check.message);
        setAnalysisPhase('error');
        return false;
    };

    // Re-check the engine from the not-connected hint without raising status banners.
    const handleRecheckEngine = async () => {
        setIsRecheckingEngine(true);
        try {
            const check = await refreshReadiness();
            if (check.state === 'ready') {
                setErrorMessage('');
                setAnalysisPhase('idle');
            }
        } finally {
            setIsRecheckingEngine(false);
        }
    };

    const handleRefreshReadiness = async () => {
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        const check = await refreshReadiness();
        if (check.state === 'ready') {
            setErrorMessage('');
            setStatusMessage('');
            setAnalysisPhase('idle');
            return;
        }

        // The readiness banner already shows check.message; a second error banner would repeat it.
        setStatusMessage('');
    };

    const saveResumeDraft = (
        status: AnalysisResumeDraftStatus,
        options: {
            jobId?: string | null;
            stage?: string;
            lastMessage?: string;
            lastProgress?: number;
            lastEtaSeconds?: number | null;
            transcriptReady?: boolean;
            errorMessage?: string;
        } = {},
    ): boolean => {
        if (!file) return false;
        const jobId = options.jobId || analysisJobIdRef.current;
        if (!jobId) return false;
        const now = new Date().toISOString();
        const existing = getAnalysisResumeDraft(jobId);
        return upsertAnalysisResumeDraft({
            jobId,
            title: title.trim(),
            date,
            participants: '',
            meetingPurpose: meetingPurpose.trim(),
            selectedReportTemplateId: selectedReportTemplate.id,
            reportTemplate: selectedReportTemplate,
            sourceFilename: file.name,
            sourceSize: file.size,
            sourceLastModified: file.lastModified,
            status,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            stage: options.stage,
            lastMessage: options.lastMessage,
            lastProgress: options.lastProgress,
            lastEtaSeconds: Object.prototype.hasOwnProperty.call(options, 'lastEtaSeconds')
                ? options.lastEtaSeconds
                : existing?.lastEtaSeconds,
            transcriptReady: Boolean(options.transcriptReady || existing?.transcriptReady),
            errorMessage: options.errorMessage,
            resumeEligible: existing?.resumeEligible,
            resumeUnavailableReason: existing?.resumeUnavailableReason,
            completedChunkCount: existing?.completedChunkCount,
        });
    };

    const restoreUnadmittedAnalysis = (jobId: string) => {
        removePendingCancelledAnalysisCleanup(jobId);
        removePendingAnalysisDraftCleanup(jobId);
        const previousDraft = analysisResumeDraftBeforeRequestRef.current;
        if (previousDraft) upsertAnalysisResumeDraft(previousDraft);
        else removeAnalysisResumeDraft(jobId);
    };

    const clearResumeSelectionOnly = () => {
        setSelectedResumeDraftId(null);
        setErrorMessage(current => current.includes('이전 분석 기록') || current.includes('이어받기 기록') ? '' : current);
        setStatusMessage(current => (
            current.includes('이전 음성 인식 진행분 재사용')
            || current.includes('같은 파일을 다시 선택')
                ? ''
                : current
        ));
    };

    const clearResumeDraftSelection = () => {
        clearResumeSelectionOnly();
        clearSelectedFileState();
    };

    const handleStartFreshFromResume = () => {
        if (selectedResumeDraft) {
            suppressResumeCandidateKey(getResumeDraftKey(selectedResumeDraft));
        }
        clearResumeSelectionOnly();
        setStatusMessage('');
        showOperationToast('새 분석을 처음부터 시작합니다.');
    };

    const handleResumeDraftPrepare = React.useCallback((draft: AnalysisResumeDraft) => {
        clearSelectedFileState();
        autoDerivedTitleRef.current = null;
        setTitle(draft.title);
        setDate(draft.date);
        setMeetingPurpose(draft.meetingPurpose || draft.participants || '');
        setSelectedReportTemplateId(draft.selectedReportTemplateId || DEFAULT_REPORT_TEMPLATE_ID);
        setSelectedResumeDraftId(draft.jobId);
        if (canResumeDraft(draft)) {
            unsuppressResumeCandidateKey(getResumeDraftKey(draft));
        }
        setCompletionNotice(null);
        setErrorMessage(canResumeDraft(draft) ? '' : getResumeStartErrorMessage(draft));
        setStatusMessage(draft.lastMessage ? translateStatusMessage(draft.lastMessage) : '');
        setRawStatusMessage(draft.lastMessage || '');
        setProgress(typeof draft.lastProgress === 'number' ? draft.lastProgress : 0);
        updateAnalysisEtaSeconds(typeof draft.lastEtaSeconds === 'number' ? draft.lastEtaSeconds : null);
        transcriptReadyRef.current = Boolean(draft.transcriptReady);
        setTranscriptReady(Boolean(draft.transcriptReady));
    }, [canResumeDraft, clearSelectedFileState, updateAnalysisEtaSeconds]);

    const resumeDraftSelectionJobId = resumeDraftSelectionRequest?.jobId;
    const resumeDraftSelectionRequestId = resumeDraftSelectionRequest?.requestId;
    const handledResumeDraftSelectionRef = useRef<string | null>(null);

    useEffect(() => {
        if (!resumeDraftSelectionJobId) return;
        const selectionKey = `${resumeDraftSelectionRequestId ?? 'legacy'}:${resumeDraftSelectionJobId}`;
        if (handledResumeDraftSelectionRef.current === selectionKey) return;
        handledResumeDraftSelectionRef.current = selectionKey;
        const drafts = listAnalysisResumeDrafts();
        const draft = drafts.find(item => item.jobId === resumeDraftSelectionJobId);
        if (!draft) {
            setSelectedResumeDraftId(null);
            setErrorMessage('선택한 이어서 할 분석을 찾지 못했습니다.');
            return;
        }
        handleResumeDraftPrepare(draft);
    }, [handleResumeDraftPrepare, resumeDraftSelectionJobId, resumeDraftSelectionRequestId]);

    const handleDeleteResumeDraft = async (draft: AnalysisResumeDraft) => {
        if (deletingResumeDraftIds.has(draft.jobId)) return;
        const confirmMessage = draft.status === 'active'
            ? '진행 중이던 분석 기록을 삭제할까요? 실제로 분석이 계속 진행 중이면 삭제되지 않습니다.'
            : '이전 분석 진행 기록을 삭제할까요? 저장된 회의 기록은 삭제하지 않습니다.';
        if (typeof window.confirm === 'function' && !window.confirm(confirmMessage)) {
            return;
        }
        let deleted = false;
        let deletedLocalOnly = false;
        let deleteNotice = '';
        setDeletingResumeDraftIds(current => new Set(current).add(draft.jobId));
        try {
            if (ANALYSIS_MODE === 'real') {
                let response: Response | null = null;
                try {
                    response = await localEngineClient.request(`/api/analyze/drafts/${encodeURIComponent(draft.jobId)}`, {
                        method: 'DELETE',
                    });
                } catch {
                    if (draft.status === 'active') {
                        throw new Error('분석 상태를 확인하지 못했습니다. 중단된 뒤 다시 삭제해 주세요.');
                    }
                    deletedLocalOnly = true;
                }
                if (response && !response.ok && response.status !== 404) {
                    const detail = await response.json().catch(() => null) as { detail?: string } | null;
                    if (response.status === 409 && detail?.detail === 'analysis_job_active') {
                        if (draft.status === 'active') {
                            throw new Error('아직 진행 중인 분석입니다. 중단된 뒤 다시 삭제해 주세요.');
                        }
                        deletedLocalOnly = true;
                    } else {
                        throw new Error('분석 임시 파일을 정리하지 못했습니다.');
                    }
                }
            }
            if (deletedLocalOnly) {
                queuePendingAnalysisDraftCleanup(draft.jobId);
            } else {
                removePendingAnalysisDraftCleanup(draft.jobId);
            }
            removeAnalysisResumeDraft(draft.jobId);
            deleted = true;
            setErrorMessage('');
            deleteNotice = deletedLocalOnly
                ? '이전 분석 기록을 목록에서 삭제했습니다. 임시 파일은 분석 기능이 준비된 뒤 다시 정리할 수 있습니다.'
                : '이전 분석 기록을 삭제했습니다.';
        } catch (error) {
            setErrorMessage(toUserFacingError(error, '분석 기록을 삭제하지 못했습니다.', { desktopApp: isTauriRuntime() }));
        } finally {
            setDeletingResumeDraftIds(current => {
                const next = new Set(current);
                next.delete(draft.jobId);
                return next;
            });
        }
        if (deleted && selectedResumeDraftIdRef.current === draft.jobId) {
            clearResumeDraftSelection();
        }
        if (deleted) {
            setStatusMessage('');
            showOperationToast(deleteNotice);
        }
    };

    const selectMeetingFile = (selectedFile: File | null) => {
        if (isExtractingAudio) return;
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);

        const selectedKind = selectedFile ? getFileKind(selectedFile) : 'unknown';
        if (!selectedFile) {
            setCompletionNotice(null);
            clearSelectedFileState();
            if (autoDerivedTitleRef.current && title === autoDerivedTitleRef.current) {
                autoDerivedTitleRef.current = null;
                setTitle('');
            }
            return;
        }
        if (selectedKind === 'unknown') {
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
            setErrorMessage(file
                ? '지원하지 않는 형식이라 기존 파일을 유지했습니다. 지원하는 음성 파일을 선택해 주세요.'
                : '지원하는 음성 파일을 선택해 주세요. 영상 파일도 사용할 수 있습니다.');
            return;
        }
        setCompletionNotice(null);
        invalidateFileMetadata();
        const metadataRequestId = fileMetadataRequestRef.current;
        setFile(selectedFile);
        setFileDurationSeconds(null);
        const derivedTitle = getMeetingTitleFromFilename(selectedFile.name);
        if (!title.trim() || title === autoDerivedTitleRef.current) {
            autoDerivedTitleRef.current = derivedTitle;
            setTitle(derivedTitle);
        }

        const media = document.createElement(selectedKind === 'video' ? 'video' : 'audio');
        const objectUrl = URL.createObjectURL(selectedFile);
        media.preload = 'metadata';
        let metadataCleanedUp = false;
        const cleanupMetadata = () => {
            if (metadataCleanedUp) return;
            metadataCleanedUp = true;
            media.onloadedmetadata = null;
            media.onerror = null;
            URL.revokeObjectURL(objectUrl);
            if (fileMetadataCleanupRef.current === cleanupMetadata) {
                fileMetadataCleanupRef.current = null;
            }
        };
        fileMetadataCleanupRef.current = cleanupMetadata;
        media.onloadedmetadata = () => {
            if (fileMetadataRequestRef.current === metadataRequestId && Number.isFinite(media.duration)) {
                setFileDurationSeconds(media.duration);
            }
            cleanupMetadata();
        };
        media.onerror = cleanupMetadata;
        media.src = objectUrl;
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        selectMeetingFile(e.target.files?.[0] ?? null);
    };

    const handleMeetingFileDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (isAnalyzing || isExtractingAudio) return;
        fileDragDepthRef.current += 1;
        setIsFileDragActive(true);
    };

    const handleMeetingFileDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (isAnalyzing || isExtractingAudio) return;
        event.dataTransfer.dropEffect = 'copy';
    };

    const handleMeetingFileDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (isAnalyzing || isExtractingAudio) return;
        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
        if (fileDragDepthRef.current === 0) setIsFileDragActive(false);
    };

    const handleMeetingFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        fileDragDepthRef.current = 0;
        setIsFileDragActive(false);
        if (isAnalyzing || isExtractingAudio) return;
        selectMeetingFile(event.dataTransfer.files?.[0] ?? null);
    };

    const clearFile = () => {
        if (isExtractingAudio) return;
        setIsFileDragActive(false);
        clearSelectedFileState();
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        setCompletionNotice(null);
        if (autoDerivedTitleRef.current && title === autoDerivedTitleRef.current) {
            autoDerivedTitleRef.current = null;
            setTitle('');
        }
    };

    const handleAudioExtractFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isExtractingAudio) return;
        const selectedFile = e.target.files?.[0] ?? null;
        audioExtractRequestRef.current += 1;
        setAudioExtractNotice(null);

        if (!selectedFile) {
            setAudioExtractFile(null);
            return;
        }
        if (getFileKind(selectedFile) !== 'video') {
            setAudioExtractFile(null);
            setAudioExtractNotice({
                tone: 'error',
                message: '영상 파일을 선택해 주세요.',
            });
            return;
        }
        setAudioExtractFile(selectedFile);
        if (videoFileInputRef.current) {
            videoFileInputRef.current.value = '';
        }
    };

    const handleExtractAudioCopy = async () => {
        if (!audioExtractFile || isExtractingAudio || audioExtractNotice?.tone === 'success') return;
        const startedAt = Date.now();
        const requestId = audioExtractRequestRef.current + 1;
        audioExtractRequestRef.current = requestId;
        const sourceFile = audioExtractFile;
        const isCurrentRequest = () => audioExtractRequestRef.current === requestId;

        try {
            setIsExtractingAudio(true);
            setAudioExtractStartedAt(startedAt);
            setAudioExtractNow(startedAt);
            setAudioExtractNotice(null);
            setErrorMessage('');

            const formData = new FormData();
            formData.append('file', sourceFile);
            const response = await localEngineClient.request('/api/tools/extract-audio/save-copy', {
                method: 'POST',
                body: formData,
            });
            if (!isCurrentRequest()) return;
            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('앱 화면에서만 음성 파일을 저장할 수 있습니다.');
                }
                throw new Error(await readResponseError(response, '음성 파일로 저장하지 못했습니다.'));
            }

            const data = await response.json().catch(() => null) as { saved_path?: string | null } | null;
            if (!isCurrentRequest()) return;
            setAudioExtractNotice({
                tone: 'success',
                message: '다운로드 폴더에 WAV 파일을 저장했습니다.',
                savedPath: data?.saved_path ?? null,
                elapsedMs: Date.now() - startedAt,
            });
        } catch (error) {
            if (!isCurrentRequest()) return;
            setAudioExtractNotice({
                tone: 'error',
                message: error instanceof Error ? error.message : '음성 파일로 저장하지 못했습니다.',
                elapsedMs: Date.now() - startedAt,
            });
        } finally {
            if (isCurrentRequest()) {
                setIsExtractingAudio(false);
                setAudioExtractStartedAt(null);
            }
        }
    };

    const handleOpenExtractedAudioLocation = async () => {
        if (!audioExtractNotice?.savedPath) return;
        try {
            await openSavedFileLocation(audioExtractNotice.savedPath);
        } catch (error) {
            setAudioExtractNotice({
                tone: 'error',
                message: error instanceof Error ? error.message : '저장 폴더를 열지 못했습니다.',
                savedPath: audioExtractNotice.savedPath,
                elapsedMs: audioExtractNotice.elapsedMs,
            });
        }
    };

    const handleSelectVideoForAudioExtract = () => {
        if (!isAnalyzing && !isExtractingAudio) {
            videoFileInputRef.current?.click();
        }
    };

    const handleStartAnalysis = async () => {
        if (analysisStartBlocked) {
            showOperationToast(analysisStartBlockedReason, 'warning');
            return;
        }
        if (analysisInFlightRef.current || isAnalyzing) {
            return;
        }
        if (fileDurationLimitError) {
            setErrorMessage(fileDurationLimitError);
            return;
        }

        if (resumeAwaitingFile && !selectedResumeDraftUnavailable) {
            fileInputRef.current?.click();
            return;
        }

        if (missingFields.length > 0) {
            setHasAttemptedStart(true);
            setProgress(0);
            setStatusMessage('');
            setCompletionNotice(null);
            setErrorMessage(`${REQUIRED_FIELDS_ERROR_PREFIX}: ${missingFields.join(', ')}`);
            return;
        }

        analysisInFlightRef.current = true;
        analysisCancelledRef.current = false;
        analysisPreparationStoppedRef.current = false;
        transcriptMeetingSavePromiseRef.current = null;
        transcriptSavedMeetingIdRef.current = null;
        setAnalysisFailure(null);
        analysisAbortControllerRef.current = new AbortController();
        const startedAt = getNowMs();
        setAnalysisStartedAt(startedAt);
        setIsAnalyzing(true);
        setAnalysisPhase('checking-server');
        setProgress(0);
        setRawStatusMessage('');
        updateAnalysisEtaSeconds(null);
        setLastRealProgressAt(getNowMs());
        setIsAnalysisStopConfirmOpen(false);
        setAnalysisStopRequestedAction(null);
        setIsRequestingAnalysisStop(false);
        analysisStopActionRef.current = null;
        analysisStopAcceptedActionRef.current = null;
        analysisPreserveExistingRef.current = false;
        analysisResumeDraftBeforeRequestRef.current = undefined;
        analysisStopDecisionPromiseRef.current = null;
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');
        setCompletionNotice(null);
        setAudioExtractFile(null);
        setAudioExtractNotice(null);
        if (videoFileInputRef.current) {
            videoFileInputRef.current.value = '';
        }

        let mediaAdmissionRejected = false;
        try {
            const startSettingsRequestId = analysisSettingsRequestRef.current + 1;
            analysisSettingsRequestRef.current = startSettingsRequestId;
            const settingsResponse = await requestWithinPreparationTimeout('/api/settings', {
                signal: analysisAbortControllerRef.current?.signal,
            });
            if (!settingsResponse.ok) throw new Error('분석 설정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            const latestSettings = await settingsResponse.json() as AnalysisSettingsResponse;
            const latestDiarizationDuringAnalysis = latestSettings.diarization?.generate_during_analysis ?? true;
            if (analysisSettingsRequestRef.current === startSettingsRequestId) {
                setDiarizationDuringAnalysis(latestDiarizationDuringAnalysis);
                setPreserveExtractedAudio(latestSettings.privacy?.preserve_extracted_audio ?? true);
                setAutoSaveAudioCopy(latestSettings.privacy?.auto_save_audio_copy ?? false);
            }
            const modelsReady = await ensureModelsReady();
            if (!modelsReady) return;
            if (analysisCancelledRef.current) return;
            let analysisJobId: string = crypto.randomUUID();
            let resumeRequested = false;
            let resumePayload: ResumeCandidatesPayload | null = null;
            const currentFileResumeKey = getResumeDraftKey({
                sourceFilename: (file as File).name,
                sourceSize: (file as File).size,
                sourceLastModified: (file as File).lastModified,
            });
            const suppressedResumeKeys = new Set(listSuppressedResumeCandidateKeys());
            if (ANALYSIS_MODE === 'real' && file) {
                try {
                    const resumeResponse = await requestWithinPreparationTimeout('/api/analyze/resume-candidates', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            source_filename: file.name,
                            source_size: file.size,
                            source_last_modified: file.lastModified,
                        }),
                        signal: analysisAbortControllerRef.current?.signal,
                    });
                    if (resumeResponse.ok) {
                        resumePayload = await resumeResponse.json() as ResumeCandidatesPayload;
                    }
                } catch {
                    resumePayload = null;
                }
                // The resume check swallows its own failures, so a 중지 during it is noticed here.
                if (analysisCancelledRef.current) return;
            }

            if (selectedResumeDraft) {
                if (!canResumeDraft(selectedResumeDraft)) {
                    setSelectedResumeDraftId(null);
                    setAnalysisPhase('error');
                    setErrorMessage(getResumeStartErrorMessage(selectedResumeDraft));
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                if (!isMatchingResumeDraftFile(selectedResumeDraft, file)) {
                    setAnalysisPhase('error');
                    setErrorMessage('이전 분석 기록을 이어서 진행할 수 없습니다. 선택한 파일이 이 기록의 파일과 다릅니다.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                if (ANALYSIS_MODE === 'real' && !resumePayload) {
                    setAnalysisPhase('error');
                    setErrorMessage('이전 분석 기록의 재사용 가능 여부를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                const allCandidates = sortResumeCandidates(resumePayload?.candidates, resumePayload?.recommended_job_id);
                const activeCandidate = allCandidates.find(candidate => candidate.active) || null;
                if (activeCandidate) {
                    setAnalysisPhase('error');
                    setErrorMessage('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                const orderedCandidates = filterPromptableResumeCandidates(allCandidates, {
                    suppressed: suppressedResumeKeys.has(currentFileResumeKey),
                    selectedJobId: selectedResumeDraft.jobId,
                });
                const matchingCandidate = orderedCandidates.find(candidate => candidate.job_id === selectedResumeDraft.jobId) || null;
                if (!matchingCandidate) {
                    const unavailableReason: AnalysisResumeDraftUnavailableReason = selectedResumeDraft.resumeEligible === false || selectedResumeDraft.completedChunkCount === 0
                        ? 'no-checkpoint'
                        : 'not-candidate';
                    const unavailableMessage = unavailableReason === 'no-checkpoint'
                        ? '재사용 가능한 체크포인트를 찾지 못했습니다.'
                        : '현재 재사용 후보로 확인되지 않았습니다.';
                    markAnalysisResumeDraftUnavailable(selectedResumeDraft.jobId, unavailableReason, {
                        errorMessage: unavailableMessage,
                    });
                    setSelectedResumeDraftId(null);
                    setAnalysisPhase('error');
                    setErrorMessage(`이전 분석 기록을 이어서 진행할 수 없습니다. ${unavailableMessage} 새 분석으로 시작할 수 있습니다.`);
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                analysisJobId = matchingCandidate.job_id;
                resumeRequested = true;
                setStatusMessage('이전 음성 인식 진행분 재사용을 시도합니다.');
            } else if (resumePayload) {
                const allCandidates = sortResumeCandidates(resumePayload.candidates, resumePayload.recommended_job_id);
                const activeCandidate = allCandidates.find(candidate => candidate.active) || null;
                if (activeCandidate) {
                    setAnalysisPhase('error');
                    setErrorMessage('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
                const orderedCandidates = filterPromptableResumeCandidates(allCandidates, {
                    suppressed: suppressedResumeKeys.has(currentFileResumeKey),
                });
                const availableCandidate = orderedCandidates[0] || null;
                if (availableCandidate) {
                    const shouldResume = window.confirm(getResumePromptMessage(availableCandidate));
                    if (shouldResume) {
                        analysisJobId = availableCandidate.job_id;
                        resumeRequested = true;
                        setStatusMessage('이전 음성 인식 진행분 재사용을 시도합니다.');
                    } else {
                        setStatusMessage('새 분석을 처음부터 시작합니다.');
                    }
                }
            }
            if (ANALYSIS_MODE === 'real' && file) {
                setStatusMessage('저장 공간을 확인하고 있습니다.');
                const storagePreflight = await requestAnalysisStoragePreflight(
                    file,
                    fileDurationSeconds,
                    analysisAbortControllerRef.current?.signal,
                );
                if (storagePreflight.ok === false) {
                    // The engine's own sentence says how much space is needed or which folder is unusable; keep it.
                    throw new Error(storagePreflight.message || '저장 공간이 부족합니다. 임시 파일을 정리한 뒤 다시 시도해 주세요.');
                }
                if (storagePreflight.level === 'warning' && storagePreflight.message) {
                    showOperationToast(storagePreflight.message, 'warning');
                }
                setStatusMessage(resumeRequested ? '이전 음성 인식 진행분 재사용을 시도합니다.' : '');
            }
            if (analysisCancelledRef.current) return;
            analysisJobIdRef.current = analysisJobId;
            analysisResumeDraftIdRef.current = analysisJobId;
            if (!claimAnalysisJob(analysisJobId)) {
                throw new Error('분석 기록을 정리하고 있습니다. 잠시 후 다시 시도해 주세요.');
            }
            analysisResumeDraftBeforeRequestRef.current = getAnalysisResumeDraft(analysisJobId);
            const recoverySaved = saveResumeDraft('active', {
                jobId: analysisJobId,
                stage: 'uploaded',
                lastMessage: selectedResumeDraft ? '이전 음성 인식 진행분 재사용을 시도합니다.' : '분석을 시작합니다.',
                lastProgress: 0,
                lastEtaSeconds: null,
            });
            if (!recoverySaved) {
                throw new Error('재시작 복구 정보를 저장할 수 없습니다. 저장 공간과 앱 권한을 확인한 뒤 다시 시도해 주세요.');
            }
            setAnalysisPhase('analyzing');
            transcriptReadyRef.current = false;
            setTranscriptReady(false);
            updateAnalysisEtaSeconds(null);
            setLastRealProgressAt(getNowMs());
            setStatusMessage(current => current || '분석을 시작합니다. 음성 추출과 전사를 진행합니다.');

            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('date', date);
            formData.append('participants', '');
            formData.append('meeting_purpose', meetingPurpose.trim());
            formData.append('selected_report_template_id', selectedReportTemplate.id);
            formData.append('report_template', JSON.stringify(selectedReportTemplate));
            const defaultContextTemplate = getContextTemplateById(DEFAULT_CONTEXT_TEMPLATE_ID);
            formData.append('selected_context_template_id', DEFAULT_CONTEXT_TEMPLATE_ID);
            formData.append('context_template', JSON.stringify(defaultContextTemplate));
            formData.append('selected_term_glossary_ids', '[]');
            formData.append('term_glossaries', '[]');
            formData.append('mode', ANALYSIS_MODE);
            formData.append('job_id', analysisJobId);
            formData.append('file', file as File);
            formData.append('file_size', String((file as File).size));
            formData.append('file_last_modified', String((file as File).lastModified));
            formData.append('resume_requested', resumeRequested ? 'true' : 'false');
            formData.append('diarization_during_analysis', latestDiarizationDuringAnalysis ? 'true' : 'false');
            const response = await localEngineClient.stream('/api/analyze', {
                method: 'POST',
                body: formData,
                headers: { Accept: 'text/event-stream' },
                signal: analysisAbortControllerRef.current.signal,
            });

            if (!response.ok) {
                const errorInfo = await readApiErrorInfo(response, `서버 응답 오류: ${response.status}`);
                mediaAdmissionRejected = errorInfo.code === 'duration_limit_exceeded'
                    || errorInfo.code === 'media_duration_unavailable';
                // Keep legacy string details while also accepting structured backend error codes.
                throw new EngineError(errorInfo.detail || errorInfo.message, errorInfo.code);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('분석 응답 스트림을 읽을 수 없습니다.');
            }

            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let finalData: AnalyzeResult | null = null;
            let transcriptMeetingSaved = false;

            const persistTranscriptMeeting = async (): Promise<void> => {
                if (transcriptMeetingSaved || ANALYSIS_MODE !== 'real') return;
                if (transcriptMeetingSavePromiseRef.current) {
                    await transcriptMeetingSavePromiseRef.current;
                    return;
                }
                const savePromise = (async () => {
                    const partialResponse = await localEngineClient.request(`/api/analyze/${analysisJobId}/partial-result`);
                    if (!partialResponse.ok) {
                        throw new Error(`대화록 중간 저장본을 불러오지 못했습니다: ${partialResponse.status}`);
                    }
                    const partialData = await partialResponse.json() as AnalyzeResult;
                    if (analysisStopAcceptedActionRef.current === 'cancel') return;
                    const partialRecord: MeetingRecord = {
                    id: analysisJobId,
                    date: date.replace('T', ' '),
                    title: title.trim(),
                    participants: '',
                    meetingPurpose: meetingPurpose.trim(),
                    selectedReportTemplateId: partialData.selectedReportTemplateId
                        || partialData.selected_report_template_id
                        || selectedReportTemplate.id,
                    reportTemplate: partialData.reportTemplate
                        || partialData.report_template
                        || selectedReportTemplate,
                    selectedContextTemplateId: partialData.selectedContextTemplateId
                        || partialData.selected_context_template_id
                        || DEFAULT_CONTEXT_TEMPLATE_ID,
                    contextTemplate: partialData.contextTemplate
                        || partialData.context_template
                        || getContextTemplateById(DEFAULT_CONTEXT_TEMPLATE_ID),
                    selectedTermGlossaryIds: partialData.selectedTermGlossaryIds
                        || partialData.selected_term_glossary_ids
                        || [],
                    termGlossaries: partialData.termGlossaries
                        || partialData.term_glossaries
                        || [],
                    summary: partialData.summary || '대화록을 저장했습니다. 참석자 구분을 진행하고 있습니다.',
                    segments: partialData.segments || [],
                    displaySegments: partialData.displaySegments || partialData.display_segments || [],
                    speakerLabels: {},
                    sourceFile: partialData.source_file || file?.name,
                    jobId: partialData.job_id || analysisJobId,
                    topics: [],
                    topicSections: [],
                    participantSummaries: [],
                    speakerContextSummaries: [],
                    generationStatus: {
                        summary: 'not_started',
                        topic_sections: 'not_started',
                        speaker_context_summaries: 'not_started',
                        meeting_report: 'not_started',
                    },
                    actions: [],
                    decisions: [],
                    needsCheck: [],
                    diarizationRequested: partialData.diarizationRequested ?? partialData.diarization_requested ?? true,
                    diarizationApplied: false,
                    diarizationSkipped: false,
                    analysisStatus: 'diarization_in_progress',
                    };
                    const savedMeetingId = await queueMeetingMutation(
                        analysisJobId,
                        () => upsertMeetingRecord(partialRecord),
                    );
                    window.dispatchEvent(new CustomEvent('meetings:updated', {
                        detail: { id: savedMeetingId, openHistory: false },
                    }));
                    transcriptMeetingSaved = true;
                    transcriptSavedMeetingIdRef.current = savedMeetingId;
                })();
                transcriptMeetingSavePromiseRef.current = savePromise;
                try {
                    await savePromise;
                } finally {
                    if (transcriptMeetingSavePromiseRef.current === savePromise) {
                        transcriptMeetingSavePromiseRef.current = null;
                    }
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const boundary = buffer.lastIndexOf('\n\n');
                if (boundary === -1) continue;

                const completeChunk = buffer.slice(0, boundary + 2);
                buffer = buffer.slice(boundary + 2);

                for (const dataStr of parseSseChunk(completeChunk)) {
                    if (dataStr === '[DONE]') continue;

                    let parsed: AnalyzeResult & { message?: string; preserve_existing?: boolean; code?: string };
                    try {
                        parsed = JSON.parse(dataStr) as AnalyzeResult & { message?: string; preserve_existing?: boolean; code?: string };
                    } catch {
                        console.warn('Ignoring malformed SSE event:', dataStr);
                        continue;
                    }
                    if (parsed.preserve_existing === true && (parsed.status === 'stopped' || parsed.status === 'cancelled')) {
                        analysisPreserveExistingRef.current = true;
                    }
                    if (typeof parsed.progress === 'number') {
                        setProgress(Math.min(100, Math.max(0, parsed.progress)));
                    }
                    const parsedEtaSeconds = typeof parsed.eta_seconds === 'number'
                        ? parsed.eta_seconds
                        : typeof parsed.etaSeconds === 'number'
                            ? parsed.etaSeconds
                            : null;
                    updateAnalysisEtaSeconds(parsedEtaSeconds);
                    const nextTranscriptReady = transcriptReadyRef.current
                        || Boolean(parsed.transcript_ready || parsed.transcriptReady || parsed.status === 'completed');
                    if (nextTranscriptReady) {
                        transcriptReadyRef.current = true;
                        setTranscriptReady(true);
                    }
                    if (nextTranscriptReady && !transcriptMeetingSaved) {
                        try {
                            await persistTranscriptMeeting();
                        } catch (error) {
                            await writeFrontendLog(`partial meeting save error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                        }
                    }
                    if (parsed.message && !analysisStopActionRef.current && !analysisPreserveExistingRef.current) {
                        setRawStatusMessage(parsed.message);
                        setStatusMessage(translateStatusMessage(parsed.message));
                        saveResumeDraft('active', {
                            jobId: analysisJobId,
                            stage: parsed.status || 'processing',
                            lastMessage: parsed.message,
                            lastProgress: typeof parsed.progress === 'number' ? parsed.progress : progress,
                            lastEtaSeconds: parsedEtaSeconds,
                            transcriptReady: nextTranscriptReady,
                        });
                    }
                    if (!parsed.heartbeat) {
                        setLastRealProgressAt(getNowMs());
                    }
                    if (parsed.status === 'error') {
                        // `code` (memory, storage, undecodable file, stage timeout) picks the next step on the failure card.
                        throw new EngineError(parsed.message || '분석 중 오류가 발생했습니다.', parsed.code);
                    }
                    if (parsed.status === 'cancelled' || parsed.status === 'stopped') {
                        if (!analysisStopActionRef.current && (parsed.action === 'cancel' || parsed.action === 'stop')) {
                            analysisStopActionRef.current = parsed.action;
                        }
                        analysisCancelledRef.current = true;
                        throw new DOMException(parsed.message || '분석 요청을 중단했습니다.', 'AbortError');
                    }
                    if (parsed.status === 'completed' || parsed.summary) {
                        finalData = parsed;
                    }
                }
            }

            if (!finalData) {
                throw new Error('최종 분석 결과를 수신하지 못했습니다.');
            }
            const pendingStopDecision = analysisStopDecisionPromiseRef.current;
            if (pendingStopDecision) {
                await pendingStopDecision;
            }
            if (analysisStopAcceptedActionRef.current) {
                analysisCancelledRef.current = true;
                throw new DOMException('분석 요청을 중단했습니다.', 'AbortError');
            }

            const newRecord: MeetingRecord = {
                id: analysisJobId,
                date: date.replace('T', ' '),
                title: title.trim(),
                participants: '',
                meetingPurpose: meetingPurpose.trim(),
                selectedReportTemplateId: finalData.selectedReportTemplateId
                    || finalData.selected_report_template_id
                    || finalData.meeting?.selected_report_template_id
                    || selectedReportTemplate.id,
                reportTemplate: finalData.reportTemplate
                    || finalData.report_template
                    || finalData.meeting?.report_template
                    || selectedReportTemplate,
                selectedContextTemplateId: finalData.selectedContextTemplateId
                    || finalData.selected_context_template_id
                    || finalData.meeting?.selected_context_template_id
                    || DEFAULT_CONTEXT_TEMPLATE_ID,
                contextTemplate: finalData.contextTemplate
                    || finalData.context_template
                    || finalData.meeting?.context_template
                    || getContextTemplateById(DEFAULT_CONTEXT_TEMPLATE_ID),
                selectedTermGlossaryIds: finalData.selectedTermGlossaryIds
                    || finalData.selected_term_glossary_ids
                    || finalData.meeting?.selected_term_glossary_ids
                    || [],
                termGlossaries: finalData.termGlossaries
                    || finalData.term_glossaries
                    || finalData.meeting?.term_glossaries
                    || [],
                summary: finalData.summary || '요약 결과가 없습니다.',
                segments: finalData.segments || [],
                displaySegments: finalData.displaySegments || finalData.display_segments || [],
                speakerLabels: {},
                sourceFile: finalData.meeting?.source_file || file?.name,
                jobId: finalData.outputs?.job_id || finalData.meeting?.job_id,
                topics: finalData.topics || [],
                topicSections: finalData.topicSections || finalData.topic_sections || [],
                participantSummaries: finalData.participantSummaries || finalData.participant_summaries || [],
                speakerContextSummaries: finalData.speakerContextSummaries || finalData.speaker_context_summaries || [],
                generationStatus: finalData.generationStatus || finalData.generation_status || {},
                actions: finalData.actions || [],
                decisions: finalData.decisions || [],
                needsCheck: finalData.needsCheck || finalData.needs_check || [],
                analysisStatus: 'completed',
                diarizationSkipped: finalData.diarizationSkipped ?? finalData.diarization_skipped ?? false,
                diarizationApplied: finalData.diarizationApplied ?? finalData.diarization_applied,
                diarizationRequested: finalData.diarizationRequested ?? finalData.diarization_requested,
                diarizationSkipMessage: finalData.diarizationSkipMessage || finalData.diarization_skip_message || '',
                diarizationSkipReason: finalData.diarizationSkipReason || finalData.diarization_skip_reason || '',
                diarizationDeferred: finalData.diarizationDeferred ?? finalData.diarization_deferred ?? false,
                diarizationDeferMessage: finalData.diarizationDeferMessage || finalData.diarization_defer_message || '',
                outputFiles: finalData.outputs,
            };

            const completedJobId = newRecord.jobId || analysisJobId;
            const finalMeetingSavePromise = queueMeetingMutation(
                completedJobId,
                () => upsertMeetingRecord(newRecord),
            );
            analysisFinalMeetingSavePromiseRef.current = finalMeetingSavePromise;
            let savedMeetingId: string;
            try {
                savedMeetingId = await finalMeetingSavePromise;
            } finally {
                if (analysisFinalMeetingSavePromiseRef.current === finalMeetingSavePromise) {
                    analysisFinalMeetingSavePromiseRef.current = null;
                }
            }
            const pendingStopDecisionAfterSave = analysisStopDecisionPromiseRef.current;
            if (pendingStopDecisionAfterSave) {
                await pendingStopDecisionAfterSave;
            }
            if (analysisStopAcceptedActionRef.current) {
                analysisCancelledRef.current = true;
                throw new DOMException('분석 요청을 중단했습니다.', 'AbortError');
            }
            const completedDraftMessage = '분석이 완료되어 이어할 필요가 없습니다. 결과는 회의 기록에서 확인하세요.';
            if (file) {
                markAnalysisResumeDraftsForKeyUnavailable(
                    toResumeDraftFileKey(file),
                    'completed',
                    {
                        status: 'completed',
                        errorMessage: completedDraftMessage,
                        exceptJobId: null,
                    },
                );
            }
            markAnalysisResumeDraftUnavailable(
                completedJobId,
                'completed',
                {
                    status: 'completed',
                    errorMessage: completedDraftMessage,
                },
            );
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: savedMeetingId, openHistory: false } }));
            const completedElapsedMs = getNowMs() - startedAt;
            setProgress(100);
            setRawStatusMessage('');
            updateAnalysisEtaSeconds(null);
            setStatusMessage('회의록을 저장했습니다.');
            setCompletionNotice({
                meetingId: savedMeetingId,
                detailTab: (() => {
                    const summary = finalData.summary?.trim();
                    const summaryStatus = finalData.generationStatus?.summary
                        ?? finalData.generation_status?.summary;
                    return summary && (!summaryStatus || summaryStatus === 'completed')
                        ? 'summary'
                        : 'script';
                })(),
                elapsedMs: completedElapsedMs,
                title: newRecord.title,
                sourceFilename: file?.name || newRecord.sourceFile || '음성 파일',
                note: getCompletionResumeNote(finalData.resume),
                autoSaveNote: getAutoSaveCompletionNote(finalData),
            });
            autoDerivedTitleRef.current = null;
            setTitle('');
            setMeetingPurpose('');
            setSelectedReportTemplateId(DEFAULT_REPORT_TEMPLATE_ID);
            const nextInitialDate = toLocalDateTimeInputValue();
            setInitialDateValue(nextInitialDate);
            setDate(nextInitialDate);
            clearResumeDraftSelection();
        } catch (error) {
            // A terminal response can arrive before its cancel ACK. Keep ownership until
            // the ACK identifies whether this attempt ever took over the existing job.
            const pendingStopDecision = analysisStopDecisionPromiseRef.current;
            if (pendingStopDecision) await pendingStopDecision;
            if (analysisCancelledRef.current || (error instanceof DOMException && error.name === 'AbortError')) {
                // Stopped before the stream started: nothing to resume; `finally` returns to the input.
                if (analysisPreparationStoppedRef.current) return;
                const requestedStopAction = analysisStopActionRef.current;
                const existingDraft = analysisResumeDraftIdRef.current
                    ? getAnalysisResumeDraft(analysisResumeDraftIdRef.current)
                    : undefined;
                if (analysisPreserveExistingRef.current) {
                    const unadmittedJobId = analysisResumeDraftIdRef.current;
                    if (unadmittedJobId) restoreUnadmittedAnalysis(unadmittedJobId);
                } else if (requestedStopAction === 'cancel') {
                    const cancelledJobId = analysisResumeDraftIdRef.current;
                    if (file) {
                        suppressResumeCandidateKey(getResumeDraftKey(toResumeDraftFileKey(file)));
                    }
                    if (cancelledJobId) {
                        removeAnalysisResumeDraft(cancelledJobId);
                        queuePendingAnalysisDraftCleanup(cancelledJobId);
                    }
                } else if (existingDraft?.status !== 'cancelled' && existingDraft?.status !== 'stopped') {
                    saveResumeDraft('stopped', {
                        stage: 'stopped',
                        lastMessage: existingDraft?.lastMessage || rawStatusMessage || statusMessage,
                        lastProgress: typeof existingDraft?.lastProgress === 'number'
                            ? existingDraft.lastProgress
                            : progress,
                        lastEtaSeconds: null,
                    });
                }
                const stoppedJobId = existingDraft?.jobId || analysisResumeDraftIdRef.current;
                if (!analysisPreserveExistingRef.current && requestedStopAction !== 'cancel' && stoppedJobId && (transcriptReadyRef.current || existingDraft?.transcriptReady)) {
                    try {
                        await queueMeetingMutation(
                            stoppedJobId,
                            () => updateMeetingAnalysisStatus(stoppedJobId, 'diarization_stopped'),
                        );
                    } catch (statusError) {
                        await writeFrontendLog(`stopped meeting status error ${statusError instanceof Error ? `${statusError.name}: ${statusError.message}` : String(statusError)}`);
                    }
                }
                setProgress(0);
                setRawStatusMessage('');
                updateAnalysisEtaSeconds(null);
                setStatusMessage('');
                showOperationToast(requestedStopAction === 'cancel'
                    ? '분석을 취소했습니다.'
                    : '분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.', 'warning');
                setErrorMessage('');
                return;
            }
            const failure = describeAnalysisError(error, { desktopApp: isTauriRuntime() });
            const message = failure.message;
            // GPU guidance only when this run used the GPU and the engine's own text names it: a host RAM failure
            // (bad_alloc) while 분석 장치 is GPU is not helped by switching to CPU.
            const rawFailureText = error instanceof Error ? error.message : String(error);
            const failedOnGpuRun = modelsPayload?.selected_stt_device === 'cuda'
                && (failure.cause === 'gpu' || /cuda|cublas|cudnn|gpu/i.test(rawFailureText));
            await writeFrontendLog(`analysis failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            const failedJobId = analysisResumeDraftIdRef.current;
            if (mediaAdmissionRejected || analysisPreserveExistingRef.current) {
                // Admission did not change backend progress; keep the matching local recovery state too.
                if (failedJobId) restoreUnadmittedAnalysis(failedJobId);
            } else {
                saveResumeDraft('failed', {
                    stage: 'failed',
                    lastMessage: rawStatusMessage || statusMessage,
                    lastProgress: progress,
                    lastEtaSeconds: null,
                    errorMessage: message,
                });
            }
            const transcriptKept = !mediaAdmissionRejected && !analysisPreserveExistingRef.current && failedJobId && transcriptReadyRef.current;
            if (transcriptKept) {
                try {
                    await queueMeetingMutation(
                        failedJobId,
                        () => updateMeetingAnalysisStatus(failedJobId, 'diarization_failed'),
                    );
                } catch (statusError) {
                    await writeFrontendLog(`failed meeting status error ${statusError instanceof Error ? `${statusError.name}: ${statusError.message}` : String(statusError)}`);
                }
            }
            // The meeting already holds the transcript: say so first and lead to it (WR-3).
            const savedMeetingId = transcriptKept ? transcriptSavedMeetingIdRef.current : null;
            setAnalysisPhase('error');
            setAnalysisFailure({ cause: failure.cause, savedMeetingId, onGpu: failedOnGpuRun });
            // With the transcript saved, what is left is finished from the meeting itself, so the sentence names that
            // step (with its cause) instead of telling the user to rerun the whole analysis.
            const unfinishedStep = diarizationDuringAnalysis ? '참석자 구분' : '남은 분석';
            const causeClause = TRANSCRIPT_KEPT_CAUSE_CLAUSES[failure.cause] ?? '';
            setErrorMessage(savedMeetingId ? `대화록은 저장했습니다. ${causeClause}${unfinishedStep}을 마치지 못했습니다.` : message);
            setRawStatusMessage('');
            updateAnalysisEtaSeconds(null);
            setStatusMessage('');
            setProgress(0);
        } finally {
            analysisInFlightRef.current = false;
            analysisAbortControllerRef.current = null;
            releaseAnalysisJob(analysisJobIdRef.current);
            analysisJobIdRef.current = null;
            analysisResumeDraftIdRef.current = null;
            analysisStopActionRef.current = null;
            analysisStopAcceptedActionRef.current = null;
            analysisPreserveExistingRef.current = false;
            analysisResumeDraftBeforeRequestRef.current = undefined;
            analysisStopDecisionPromiseRef.current = null;
            analysisFinalMeetingSavePromiseRef.current = null;
            setIsAnalyzing(false);
            setIsAnalysisStopConfirmOpen(false);
            setAnalysisStopRequestedAction(null);
            setIsRequestingAnalysisStop(false);
            setAnalysisStartedAt(null);
            setAnalysisPhase(current => (current === 'error' ? 'error' : 'idle'));
            setReadinessLoopKey(key => key + 1);
            if (analysisPreparationStoppedRef.current) {
                analysisPreparationStoppedRef.current = false;
                setAnalysisPhase('idle');
                setAnalysisFailure(null);
                setErrorMessage('');
                setStatusMessage('');
                setProgress(0);
                showOperationToast('분석을 중지했습니다.', 'warning');
            }
        }
    };

    // Before the analysis stream starts there is no job to keep or cancel: abort the preparation and let the run unwind.
    const handleStopPreparation = () => {
        if (!isAnalyzing || analysisPreparationStoppedRef.current) return;
        if (analysisJobIdRef.current) {
            setIsAnalysisStopConfirmOpen(true);
            return;
        }
        analysisPreparationStoppedRef.current = true;
        analysisCancelledRef.current = true;
        setIsAnalysisStopConfirmOpen(false);
        setAnalysisStopRequestedAction('stop');
        analysisAbortControllerRef.current?.abort();
    };

    const handleOpenAnalysisStopConfirm = () => {
        if (!isAnalyzing) return;
        setIsAnalysisStopConfirmOpen(true);
        setErrorMessage('');
    };

    const handleStopAnalysis = async (action: AnalysisStopAction) => {
        if (!isAnalyzing || analysisStopRequestedAction) return;

        const jobId = analysisJobIdRef.current;
        setIsRequestingAnalysisStop(true);
        setAnalysisStopRequestedAction(action);
        analysisStopActionRef.current = action;
        const pendingMessage = action === 'stop'
            ? '분석을 중지하고 있습니다. 현재 처리 중인 구간이 끝나면 이어하기 기록으로 남깁니다.'
            : '분석을 취소하고 있습니다. 현재 처리 중인 구간이 끝나면 진행 중 기록을 끝냅니다.';
        setStatusMessage(pendingMessage);

        if (!jobId) {
            // No job yet: the run unwinds itself instead of resetting state under a request that is still in flight.
            handleStopPreparation();
            return;
        }

        if (action === 'cancel' && !queuePendingCancelledAnalysisCleanup(jobId)) {
            setIsRequestingAnalysisStop(false);
            setAnalysisStopRequestedAction(null);
            analysisStopActionRef.current = null;
            setErrorMessage('취소 후 정리 정보를 저장할 수 없습니다. 저장 공간과 앱 권한을 확인한 뒤 다시 시도해 주세요.');
            showOperationToast('취소 정보를 저장하지 못했습니다.', 'error');
            return;
        }
        const stopDecisionPromise = (async (): Promise<AnalysisStopAction | null> => {
            try {
                const response = await localEngineClient.request(`/api/analyze/${encodeURIComponent(jobId)}/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action }),
                });
                const payload = await response.json().catch(() => null) as { cancel_requested?: boolean; preserve_existing?: boolean } | null;
                if (response.ok && payload?.cancel_requested) {
                    if (payload.preserve_existing === true) analysisPreserveExistingRef.current = true;
                    analysisStopAcceptedActionRef.current = action;
                    return action;
                }
            } catch {
                // Treat an unavailable decision as a rejected stop request.
            }
            return null;
        })();
        analysisStopDecisionPromiseRef.current = stopDecisionPromise;
        const acceptedAction = await stopDecisionPromise;
        if (analysisStopDecisionPromiseRef.current === stopDecisionPromise) {
            analysisStopDecisionPromiseRef.current = null;
        }
        setIsRequestingAnalysisStop(false);
        const cancelAccepted = acceptedAction === action;

        if (!cancelAccepted) {
            if (action === 'cancel') {
                removePendingCancelledAnalysisCleanup(jobId);
                removePendingAnalysisDraftCleanup(jobId);
            }
            setAnalysisStopRequestedAction(null);
            analysisStopActionRef.current = null;
            setIsAnalysisStopConfirmOpen(false);
            setStatusMessage('중지할 분석을 찾지 못했습니다.');
            showOperationToast('중지할 분석을 찾지 못했습니다.', 'neutral');
            return;
        }
        if (analysisPreserveExistingRef.current) {
            restoreUnadmittedAnalysis(jobId);
            setErrorMessage('');
            setIsAnalysisStopConfirmOpen(false);
            return;
        }
        if (action === 'cancel') {
            queuePendingAnalysisDraftCleanup(jobId);
        }

        const pendingTranscriptSave = transcriptMeetingSavePromiseRef.current;
        if (pendingTranscriptSave) {
            try {
                await pendingTranscriptSave;
            } catch (error) {
                await writeFrontendLog(`pending transcript save before ${action} error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            }
        }
        const pendingFinalMeetingSave = analysisFinalMeetingSavePromiseRef.current;
        if (pendingFinalMeetingSave) {
            try {
                await pendingFinalMeetingSave;
            } catch (error) {
                await writeFrontendLog(`pending final meeting save before ${action} error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            }
        }

        if (action === 'stop') {
            saveResumeDraft('stopped', {
                jobId,
                stage: 'stopped',
                lastMessage: rawStatusMessage || statusMessage,
                lastProgress: progress,
                lastEtaSeconds: null,
            });
            if (transcriptReadyRef.current) {
                try {
                    await queueMeetingMutation(
                        jobId,
                        () => updateMeetingAnalysisStatus(jobId, 'diarization_stopped'),
                    );
                } catch (error) {
                    await writeFrontendLog(`stopped meeting status error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                }
            }
        } else {
            if (file) {
                suppressResumeCandidateKey(getResumeDraftKey(toResumeDraftFileKey(file)));
            }
            removeAnalysisResumeDraft(jobId);
            try {
                await queueMeetingMutation(jobId, () => deleteMeetingRecordForJob(jobId));
                window.dispatchEvent(new CustomEvent('meetings:updated', {
                    detail: { id: jobId, openHistory: false },
                }));
            } catch (error) {
                await writeFrontendLog(`cancelled meeting cleanup error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            }
        }
        setErrorMessage('');
        setIsAnalysisStopConfirmOpen(false);
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT));
        }, 1_500);
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT));
        }, 5_000);
    };

    const buttonLabel = (() => {
        if (selectedResumeDraftActive) return '진행 중';
        if (matchingActiveDraft) return '진행 중';
        if (selectedResumeDraftUnavailable) return '이어하기 불가';
        if (resumeSelectionActive && !resumeReady) return '같은 파일 선택';
        if (hasBlockingReadinessIssue) return '준비 필요';
        if (resumeReady) return '이어하기';
        return '분석 시작';
    })();

    const handleOpenCompletedMeeting = () => {
        if (!completionNotice) return;
        window.dispatchEvent(new CustomEvent('meetings:updated', {
            detail: {
                id: completionNotice.meetingId,
                openHistory: true,
                detailTab: completionNotice.detailTab,
            },
        }));
        setCompletionNotice(null);
        setStatusMessage('');
    };

    const handleReturnToAnalysisInput = () => {
        setAnalysisPhase('idle');
        setAnalysisFailure(null);
        setErrorMessage('');
        setStatusMessage('');
        setRawStatusMessage('');
        setProgress(0);
        updateAnalysisEtaSeconds(null);
        window.requestAnimationFrame(() => {
            document.getElementById('meeting-title')?.focus();
        });
    };

    // The file could not be read: back to the form with the file cleared and the picker open; the rest is kept.
    const handleChooseAnotherFile = () => {
        handleReturnToAnalysisInput();
        clearSelectedFileState();
        window.requestAnimationFrame(() => fileInputRef.current?.click());
    };

    // The transcript was saved before the failure; open that meeting like 결과 보기 after a completed analysis.
    const handleOpenFailedMeeting = () => {
        const meetingId = analysisFailure?.savedMeetingId;
        if (!meetingId) return;
        // The form's content now lives in that meeting, so clear it as a completed analysis does;
        // otherwise leaving the writer would ask about unsaved input.
        autoDerivedTitleRef.current = null;
        setTitle('');
        setMeetingPurpose('');
        setSelectedReportTemplateId(DEFAULT_REPORT_TEMPLATE_ID);
        const nextInitialDate = toLocalDateTimeInputValue();
        setInitialDateValue(nextInitialDate);
        setDate(nextInitialDate);
        clearResumeDraftSelection();
        clearSelectedFileState();
        setAnalysisPhase('idle');
        setAnalysisFailure(null);
        setErrorMessage('');
        setStatusMessage('');
        // Open after the cleared form is committed, so the writer's leave guard sees no input.
        window.requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('meetings:updated', {
                detail: { id: meetingId, openHistory: true, detailTab: 'script' },
            }));
        });
    };

    // Engine unreachable (web): check again; once it answers, return to the form where 분석 시작 is ready.
    const handleRecheckAfterFailure = async () => {
        setIsRecheckingEngine(true);
        try {
            const check = await refreshReadiness();
            if (check.state === 'server-waiting') {
                showOperationToast(`아직 ${LOCAL_ENGINE_NAME}에 닿지 않습니다. ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`, 'warning');
                return;
            }
            handleReturnToAnalysisInput();
        } finally {
            setIsRecheckingEngine(false);
        }
    };

    const showProgressBar = isAnalyzing;
    const fileKind = file ? getFileKind(file) : null;
    const hasAudioExtractFile = Boolean(audioExtractFile);
    const audioExtractSaved = audioExtractNotice?.tone === 'success';
    const audioExtractFailed = audioExtractNotice?.tone === 'error';
    const showAnalysisFailure = !isAnalyzing && analysisPhase === 'error' && Boolean(errorMessage);
    const failureCause = analysisFailure?.cause ?? 'other';
    // Out of memory on the GPU, or the GPU failing at run time: retrying on the GPU fails the same way. Once 분석 장치
    // is CPU, 다시 시도 is the next step again.
    const failedOnGpuMemory = failureCause === 'memory' && Boolean(analysisFailure?.onGpu);
    const failedOnGpu = Boolean(analysisFailure?.onGpu) && (failureCause === 'gpu' || failureCause === 'memory')
        && modelsPayload?.selected_stt_device !== 'cpu' && Boolean(onOpenAnalysisSettings);
    const failureAction: 'open-result' | 'troubleshoot' | 'recheck' | 'choose-file' | 'device' | 'retry' = analysisFailure?.savedMeetingId
        ? 'open-result'
        : failedOnGpu
            ? 'device'
        : failureCause === 'engine-disconnected'
            ? (isTauriRuntime() && onOpenTroubleshooting ? 'troubleshoot' : 'recheck')
            : failureCause === 'unsupported-file'
                ? 'choose-file'
                : 'retry';
    const showAnalysisPanel = isAnalyzing || showAnalysisFailure;
    const progressPercent = Math.min(100, Math.max(0, progress));
    const elapsedMs = analysisStartedAt ? analysisNow - analysisStartedAt : 0;
    const elapsedLabel = formatAnalysisDuration(elapsedMs);
    const audioExtractElapsedMs = isExtractingAudio && audioExtractStartedAt
        ? audioExtractNow - audioExtractStartedAt
        : audioExtractNotice?.elapsedMs ?? 0;
    const audioExtractElapsedLabel = formatAnalysisDuration(audioExtractElapsedMs);
    const audioExtractMessage = isExtractingAudio
        ? '영상에서 음성만 WAV로 저장하고 있습니다.'
        : audioExtractNotice?.message ?? '영상에서 음성만 WAV로 저장합니다.';
    const audioExtractButtonTitle = (isExtractingAudio || audioExtractNotice?.elapsedMs !== undefined)
        ? `${audioExtractMessage} 소요 시간 ${audioExtractElapsedLabel}`
        : audioExtractMessage;
    const audioExtractStatusVisible = !resumeSelectionActive && !isAnalyzing && (hasAudioExtractFile || isExtractingAudio || Boolean(audioExtractNotice));
    const audioExtractStatusTone: 'info' | 'warning' | 'error' | 'success' | 'neutral' = audioExtractFailed
        ? 'error'
        : audioExtractSaved
            ? 'success'
            : isExtractingAudio
                ? 'info'
                : 'neutral';
    const audioExtractStatusHeading = isExtractingAudio
        ? '음성 추출 중'
        : audioExtractSaved
            ? '음성 추출 완료'
            : audioExtractFailed
                ? '음성 추출 실패'
                : '영상 선택됨';
    const audioExtractStatusMessage = isExtractingAudio
        ? `선택한 영상에서 음성만 추출하고 있습니다. 소요 시간 ${audioExtractElapsedLabel}`
        : audioExtractSaved
            ? `${audioExtractMessage} 소요 시간 ${audioExtractElapsedLabel}`
            : audioExtractFailed
                ? audioExtractMessage
                : '저장을 누르면 선택한 영상의 WAV 사본을 다운로드 폴더에 저장합니다.';
    const selectedFileMeta = file
        ? [
            fileKind === 'video' ? '영상' : fileKind === 'audio' ? '음성' : '파일',
            formatFileSize(file.size),
            fileDurationSeconds ? formatDuration(fileDurationSeconds) : null,
        ].filter(Boolean).join(' · ')
        : '음성 파일을 선택해 주세요.';
    const selectedFileGuidance = file
        ? getSelectedFileProcessingGuidance(fileDurationSeconds, diarizationDuringAnalysis)
        : null;
    const filePrivacyMessage = preserveExtractedAudio === true && autoSaveAudioCopy === true
        ? '회의록과 분석용 음성을 이 PC에 보관하고, 다운로드 폴더에도 음성 사본을 저장합니다.'
        : preserveExtractedAudio === false
        ? '회의록은 이 PC에만 보관하고, 분석용 임시 음성은 완료 후 삭제합니다.'
        : preserveExtractedAudio === true
            ? '회의록과 분석용 음성을 이 PC에만 보관합니다.'
            // Before (or without) an engine answer the local-only promise still holds; the exact wording follows the setting.
            : '회의록은 이 PC에만 보관합니다.';

    const currentStatusMessage = statusMessage || getFallbackAnalysisMessage(analysisPhase, progressPercent);
    const transcriptProgressPercent = getTranscriptReadyProgressPercent(
        progressPercent,
        rawStatusMessage || currentStatusMessage,
        transcriptReady,
    );
    const analysisProgressGuidance = getAnalysisProgressGuidance(
        fileDurationSeconds,
        transcriptReady,
        diarizationDuringAnalysis,
    );
    const writerHeading = completionNotice
        ? '분석 완료'
        : showAnalysisFailure
            ? '분석을 마치지 못했습니다'
                : showAnalysisPanel
                    ? '분석 진행'
                : resumeSelectionActive
                    ? selectedResumeDraftActive ? '분석 상태' : '이어하기'
                    : '새 회의록';

    const showInputForm = !showAnalysisPanel && !completionNotice;

    return (
        <div className="writer-shell" data-settings-focus-scope>
            {operationToast && (
                <AppToast
                    message={operationToast.message}
                    tone={operationToast.tone}
                    closeLabel="작업 알림 닫기"
                    onClose={() => setOperationToast(null)}
                />
            )}
            {localProcessingNotice && (
                <LocalProcessingNotice
                    key={localProcessingNotice}
                    mode={localProcessingNotice}
                    runtime={localEngineConnection.runtime}
                    storageMessage={filePrivacyMessage}
                    onClose={() => setLocalProcessingNotice(null)}
                />
            )}
            <div className="writer-header">
                <div>
                    <h2 className="page-title">{writerHeading}</h2>
                </div>
            </div>

            <div className="writer-panel">
                {resumeSelectionActive && (
                    <div className="detail-inline-note flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>{selectedResumeDraftActive
                            ? '다른 실행에서 진행 중인 분석입니다. 상태를 다시 확인하거나 필요하면 기록을 삭제할 수 있습니다.'
                            : '이전 분석 기록을 이어서 진행합니다. 같은 음성 파일을 다시 선택한 뒤 이어하기를 시작하세요.'}</span>
                        <div className="flex shrink-0 gap-2">
                            {!selectedResumeDraftActive && (
                                <Button variant="outline" onClick={handleStartFreshFromResume} disabled={isAnalyzing}>
                                    새 분석
                                </Button>
                            )}
                            {selectedResumeDraft && (
                                <Button
                                    variant="outline"
                                    onClick={() => void handleDeleteResumeDraft(selectedResumeDraft)}
                                    disabled={isAnalyzing || deletingResumeDraftIds.has(selectedResumeDraft.jobId)}
                                    aria-label={`${selectedResumeDraft.title || selectedResumeDraft.sourceFilename} 분석 기록 삭제`}
                                >
                                    {deletingResumeDraftIds.has(selectedResumeDraft.jobId)
                                        ? <Loader2 size={15} className="animate-spin" />
                                        : <Trash2 size={15} />}
                                    {deletingResumeDraftIds.has(selectedResumeDraft.jobId) ? '삭제 중' : '삭제'}
                                </Button>
                            )}
                        </div>
                    </div>
                )}

                {showInputForm && (<div className="writer-input-grid">
                <section className="writer-section">
                    <div className="writer-section-heading">
                        <h3>{resumeSelectionActive ? '같은 영상·음성 파일 선택 *' : '영상·음성 파일 *'}</h3>
                    </div>
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept={ACCEPTED_MEETING_MEDIA}
                        onChange={handleFileChange}
                        disabled={isAnalyzing || isExtractingAudio}
                        className="sr-only"
                        id="meeting-file-input"
                        required
                        aria-required="true"
                        aria-hidden="true"
                        tabIndex={-1}
                        hidden
                    />
                    {SHOW_AUDIO_EXTRACT_TOOL && (<input
                        type="file"
                        ref={videoFileInputRef}
                        accept="video/*,.mp4,.mov,.mkv,.avi,.webm"
                        onChange={handleAudioExtractFileChange}
                        disabled={isAnalyzing || isExtractingAudio}
                        className="sr-only"
                        aria-hidden="true"
                        tabIndex={-1}
                        hidden
                    />)}
                    {!file ? (
                        <div
                            role="button"
                            tabIndex={isAnalyzing || isExtractingAudio ? -1 : 0}
                            aria-controls="meeting-file-input"
                            aria-invalid={hasAttemptedStart && !file}
                            aria-describedby={hasAttemptedStart && !file ? 'writer-form-error' : undefined}
                            aria-disabled={isAnalyzing || isExtractingAudio}
                            aria-label="필수: 영상 또는 음성 파일 선택"
                            data-settings-focus-fallback
                            className={`file-drop-zone ${isFileDragActive ? 'file-drop-zone-active' : ''}`}
                            onClick={() => {
                                if (!isAnalyzing && !isExtractingAudio) fileInputRef.current?.click();
                            }}
                            onKeyDown={(event) => {
                                if (isAnalyzing || isExtractingAudio) return;
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    fileInputRef.current?.click();
                                }
                            }}
                            onDragEnter={handleMeetingFileDragEnter}
                            onDragOver={handleMeetingFileDragOver}
                            onDragLeave={handleMeetingFileDragLeave}
                            onDrop={handleMeetingFileDrop}
                        >
                            <div className="file-drop-zone-empty">
                                <div className="icon-badge">
                                    <UploadCloud size={22} />
                                </div>
                                <div className="file-drop-copy min-w-0">
                                    <div className="file-drop-title">영상 또는 음성 파일을 놓아주세요</div>
                                </div>
                                <span className="file-drop-zone-action" aria-hidden="true">파일 선택</span>
                                <div className="file-drop-format-list" aria-label="지원 형식">
                                    {['MP4', 'MOV', 'WAV', 'MP3', 'M4A'].map(format => (
                                        <span key={format}>{format}</span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="selected-file-card">
                            <div className="selected-file-main">
                                <div className="icon-badge">
                                    <FileAudio size={20} />
                                </div>
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-foreground" title={file.name}>
                                        {file.name}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">{selectedFileMeta}</div>
                                </div>
                            </div>
                            <div className="selected-file-actions">
                                <Button
                                    variant="outline"
                                    className="detail-action-button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isAnalyzing || isExtractingAudio}
                                >
                                    파일 바꾸기
                                </Button>
                                {!isAnalyzing && (
                                    <IconButton
                                        variant="outline"
                                        icon={<X size={16} />}
                                        onClick={clearFile}
                                        disabled={isExtractingAudio}
                                        aria-label={`${file.name} 제거`}
                                        title="파일 제거"
                                    />
                                )}
                            </div>
                        </div>
                    )}
                    <div className="writer-file-support">
                    <div className="writer-file-privacy-slot">
                        <div className="writer-file-privacy-note">
                            <ShieldCheck size={15} aria-hidden="true" />
                            <span>음성·영상과 대화록은 이 PC에서 처리합니다.</span>
                            <button
                                type="button"
                                className="writer-file-privacy-link"
                                aria-haspopup="dialog"
                                onClick={() => setLocalProcessingNotice('help')}
                            >
                                처리 방식
                            </button>
                        </div>
                    </div>
                    {selectedFileGuidance && (
                        <div className="detail-inline-note">
                            {selectedFileGuidance}
                        </div>
                    )}
                    {selectedResumeDraft && (
                        <div className={`text-xs ${resumeDraftFileMismatch || selectedResumeDraftUnavailable ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {selectedResumeDraftUnavailable
                                ? getResumeStartErrorMessage(selectedResumeDraft)
                                : resumeAwaitingFile
                                ? `${selectedResumeDraft.sourceFilename} 파일을 다시 선택해 주세요.`
                                : resumeDraftFileMismatch
                                    ? `선택한 파일이 다릅니다. ${selectedResumeDraft.sourceFilename} 파일을 다시 선택해 주세요.`
                            : '같은 파일을 확인했습니다. 이어하기를 시작할 수 있습니다.'}
                        </div>
                    )}
                    {matchingActiveDraft && !isAnalyzing && (
                        <div className="text-xs text-muted-foreground">
                            같은 파일 분석이 이미 진행 중입니다. 먼저 상태를 확인해 주세요.
                        </div>
                    )}
                    {SHOW_AUDIO_EXTRACT_TOOL && !resumeSelectionActive && !isAnalyzing && (
                        <div className="writer-file-tools">
                            <Button
                                variant="outline"
                                className="detail-action-button"
                                onClick={handleSelectVideoForAudioExtract}
                                disabled={isExtractingAudio}
                                title="음성을 추출할 영상 파일을 선택합니다."
                                aria-describedby="audio-extract-help"
                            >
                                <FileAudio size={15} />
                                {hasAudioExtractFile ? audioExtractSaved ? '다른 영상' : '영상 변경' : '음성 추출'}
                            </Button>
                            {hasAudioExtractFile ? (
                                <Button
                                    variant="outline"
                                    className="detail-action-button"
                                    onClick={handleExtractAudioCopy}
                                    disabled={isExtractingAudio || audioExtractSaved}
                                    title={audioExtractButtonTitle}
                                >
                                    {isExtractingAudio ? (
                                        <Loader2 size={15} className="animate-spin" />
                                    ) : audioExtractSaved ? (
                                        <CheckCircle2 size={15} />
                                    ) : (
                                        <FolderOpen size={15} />
                                    )}
                                    {isExtractingAudio ? '저장 중' : audioExtractSaved ? '저장됨' : audioExtractFailed ? '다시 저장' : '저장'}
                                </Button>
                            ) : null}
                            <span
                                id="audio-extract-help"
                                className="sr-only"
                            >
                                영상에서 음성만 WAV 파일로 저장합니다. 회의록 분석은 시작하지 않습니다.
                            </span>
                            <span
                                title="영상에서 음성만 WAV 파일로 저장합니다. 회의록 분석은 시작하지 않습니다."
                                className="inline-flex text-muted-foreground"
                                aria-hidden="true"
                            >
                                <CircleHelp size={14} />
                            </span>
                        </div>
                    )}
                    </div>
                </section>

                <div className="writer-info-column">
                    <section className="writer-section writer-info-section">
                    <div className="writer-section-heading">
                        <h3>회의 정보</h3>
                    </div>
                    <div className="writer-field-grid">
                        <div className="writer-field writer-field-wide">
                            <label htmlFor="meeting-title">회의 제목 *</label>
                            <Input
                                id="meeting-title"
                                required
                                aria-required="true"
                                aria-invalid={hasAttemptedStart && !title.trim()}
                                aria-describedby={hasAttemptedStart && !title.trim() ? 'writer-form-error' : undefined}
                                value={title}
                                onChange={event => {
                                    autoDerivedTitleRef.current = null;
                                    setTitle(event.target.value);
                                }}
                                placeholder="예: 2026년 상반기 기획 회의"
                                disabled={isAnalyzing}
                            />
                        </div>
                        <div className="writer-field">
                            <label htmlFor="meeting-date">일시 *</label>
                            <Input id="meeting-date" type="datetime-local" value={date} onChange={e => setDate(e.target.value)} required aria-required="true" aria-invalid={hasAttemptedStart && !date} aria-describedby={hasAttemptedStart && !date ? 'writer-form-error' : undefined} disabled={isAnalyzing} />
                        </div>
                        <div className="writer-field">
                            <label htmlFor="meeting-purpose">회의 목적 *</label>
                            <Input id="meeting-purpose" value={meetingPurpose} onChange={e => setMeetingPurpose(e.target.value)} placeholder="예: 월간 현황 점검, 후속 조치 중심" required aria-required="true" aria-invalid={hasAttemptedStart && !meetingPurpose.trim()} aria-describedby={hasAttemptedStart && !meetingPurpose.trim() ? 'writer-form-error' : undefined} disabled={isAnalyzing} />
                        </div>
                    </div>
                    </section>
                </div>
                    <div className={`writer-action-bar ${localEngineConnectionRequired ? 'writer-action-bar-connection' : ''}`} aria-live="polite" aria-busy={isAnalyzing}>
                        {localEngineConnectionRequired && (
                            <LocalEngineConnectionSurface
                                analysisPrerequisitesMissing={readinessState !== 'ready'}
                                connectionRequested={webConnectionRecoveryStarted}
                                onProbeCompleted={webConnectionRecoveryStarted ? recheckDevelopmentReadiness : undefined}
                            />
                        )}
                        {(formErrorInline || showReadinessHint || showEngineCheckingLine) && (
                            <div className="writer-action-notes">
                        {formErrorInline && (
                            <p id="writer-form-error" className="writer-action-hint writer-action-hint-error">
                                {`${REQUIRED_FIELDS_ERROR_PREFIX}: ${missingFields.join(', ')}`}
                            </p>
                        )}
                        {showEngineCheckingLine && (
                            <p id="writer-engine-checking" className="writer-action-hint">
                                <Loader2 size={13} className="mr-1.5 inline-block animate-spin align-[-2px] motion-reduce:animate-none" aria-hidden="true" />
                                {isTauriRuntime() ? '분석 기능 준비 중'
                                    : localEngineConnectionRequired ? '분석 준비 확인 중' : `${LOCAL_ENGINE_NAME} 확인 중`}
                            </p>
                        )}
                        {showReadinessHint && (
                            <p id="writer-readiness-hint" className="writer-action-hint">
                                {engineUnreachable
                                    ? isTauriRuntime()
                                        ? DESKTOP_ENGINE_NOT_READY_MESSAGE
                                        : '분석 기능의 응답이 없습니다. 연결 상태를 확인해 주세요.'
                                    : connectionCheckRequired
                                        ? '연결 상태를 확인해야 분석을 시작할 수 있습니다.'
                                    : modelsMissing
                                        ? '분석에 필요한 모델이 아직 없습니다. 모델을 받으면 바로 시작할 수 있습니다.'
                                        : modelsNeedReinstall
                                            ? diarizationSettingBlocks
                                                ? '참석자 구분 모델이 없습니다. 참석자 구분까지 이어서 실행을 끄면 대화록부터 만들 수 있습니다.'
                                                : '필요한 모델이 없어 분석을 시작할 수 없습니다.'
                                            : gpuUnavailable
                                                ? 'GPU를 쓸 수 없습니다. 분석 장치를 CPU로 바꾸면 바로 시작할 수 있습니다.'
                                                : '분석 환경을 확인해야 합니다. 아래 안내를 확인하세요.'}
                            </p>
                        )}
                            </div>
                        )}
                        {readinessAction === 'models' && (
                            <Button variant="outline" className="writer-hint-action" onClick={onOpenSettings}>
                                <Download size={15} aria-hidden="true" />
                                모델 받기
                            </Button>
                        )}
                        {readinessAction === 'device' && (
                            <Button variant="outline" className="writer-hint-action" onClick={() => onOpenAnalysisSettings?.('device')}>
                                <Settings size={15} aria-hidden="true" />
                                분석 장치 설정
                            </Button>
                        )}
                        {readinessAction === 'diarization' && (
                            <Button variant="outline" className="writer-hint-action" onClick={() => onOpenAnalysisSettings?.('diarization')}>
                                <Settings size={15} aria-hidden="true" />
                                참석자 구분 설정
                            </Button>
                        )}
                        {readinessAction === 'troubleshoot' && (
                            <Button variant="outline" className="writer-hint-action" onClick={onOpenTroubleshooting}>
                                <Settings size={15} aria-hidden="true" />
                                문제 해결
                            </Button>
                        )}
                        {readinessAction === 'recheck' && (
                            <Button variant="outline" className="writer-hint-action" onClick={() => void handleRecheckEngine()} disabled={isRecheckingEngine}>
                                <RefreshCw size={15} className={isRecheckingEngine ? 'animate-spin' : ''} aria-hidden="true" />
                                {isRecheckingEngine ? '확인 중' : '다시 확인'}
                            </Button>
                        )}
                        {readinessAction === 'connect' && (
                            <Button variant="outline" className="writer-hint-action" onClick={() => void handleCheckWebConnection()}>
                                <RefreshCw size={15} aria-hidden="true" />
                                연결 확인
                            </Button>
                        )}
                        <div className="writer-primary-actions">
                            <Button className={`writer-start-button ${localEngineConnectionRequired && !localEngineAnalysisReady ? 'writer-start-button-connection-pending' : ''}`} onClick={handleStartAnalysis} disabled={startButtonOperationallyDisabled} aria-describedby={startButtonDescription} data-incomplete={missingFields.length > 0 ? 'true' : undefined} data-settings-focus-fallback>
                                {isAnalyzing && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                                {isAnalyzing ? '분석 중' : buttonLabel}
                            </Button>
                        </div>
                    </div>
                </div>)}

                {showAnalysisPanel && (
                <div className={`writer-analysis-panel ${showAnalysisFailure ? 'writer-analysis-panel-error' : ''}`}>
                    <div className="writer-analysis-file">
                        <div className="icon-badge">
                            <FileAudio size={20} aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="writer-analysis-title">{title || '새 회의록'}</div>
                            <div className="writer-analysis-meta">
                                {file?.name ? `${file.name} · ${selectedFileMeta}` : selectedFileMeta}
                            </div>
                        </div>
                    </div>
                    {showAnalysisFailure ? (
                        <div className="writer-analysis-result" role="alert">
                            <div className="writer-analysis-status-icon writer-analysis-status-icon-error">
                                <AlertCircle size={18} aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="writer-analysis-result-message break-words">
                                    {failedOnGpuMemory ? 'GPU 메모리가 부족해 분석을 마치지 못했습니다.' : errorMessage}
                                </div>
                                {failureAction === 'device' && failedOnGpuMemory && (
                                    <p className="mt-1 text-sm text-muted-foreground">분석 장치를 CPU로 바꾸면 GPU 메모리와 상관없이 분석할 수 있습니다. CPU는 더 오래 걸릴 수 있습니다.</p>
                                )}
                                {/* The primary action follows the cause: saved transcript, connection, unreadable file, or a retry. */}
                                <div className="writer-analysis-result-actions">
                                    {failureAction === 'open-result' && (
                                        <Button variant="primary" onClick={handleOpenFailedMeeting}>
                                            결과 보기
                                        </Button>
                                    )}
                                    {failureAction === 'device' && (
                                        <Button variant="primary" onClick={() => onOpenAnalysisSettings?.('device')}>
                                            <Settings size={14} aria-hidden="true" />
                                            분석 장치 설정
                                        </Button>
                                    )}
                                    {failureAction === 'troubleshoot' && (
                                        <Button variant="primary" onClick={onOpenTroubleshooting}>
                                            <Settings size={14} aria-hidden="true" />
                                            문제 해결
                                        </Button>
                                    )}
                                    {failureAction === 'recheck' && (
                                        <Button variant="primary" onClick={() => void handleRecheckAfterFailure()} disabled={isRecheckingEngine}>
                                            <RefreshCw size={14} className={isRecheckingEngine ? 'animate-spin' : ''} aria-hidden="true" />
                                            {isRecheckingEngine ? '확인 중' : '다시 확인'}
                                        </Button>
                                    )}
                                    {failureAction === 'choose-file' && (
                                        <Button variant="primary" onClick={handleChooseAnotherFile}>
                                            <UploadCloud size={14} aria-hidden="true" />
                                            다른 파일 선택
                                        </Button>
                                    )}
                                    {/* After a saved transcript the rest is finished from the meeting, so 결과 보기 stands alone. */}
                                    {failureAction !== 'recheck' && failureAction !== 'choose-file' && failureAction !== 'open-result' && (
                                        <Button
                                            variant={failureAction === 'retry' ? 'primary' : 'outline'}
                                            onClick={handleStartAnalysis}
                                            disabled={analysisStartBlocked}
                                            aria-describedby={analysisStartBlocked ? 'writer-analysis-start-blocked' : undefined}
                                        >
                                            <RefreshCw size={14} aria-hidden="true" />
                                            다시 시도
                                        </Button>
                                    )}
                                    {failureAction !== 'open-result' && (
                                        <Button variant="outline" onClick={handleReturnToAnalysisInput}>
                                            입력 확인
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                    <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" aria-live="polite">
                        <div className="flex min-w-0 flex-1 gap-3">
                            <div className={`writer-analysis-status-icon ${analysisStalled ? 'writer-analysis-status-icon-warning' : ''}`}>
                                {analysisStalled
                                    ? <AlertCircle size={18} aria-hidden="true" />
                                    : progressPercent >= 100
                                        ? <CheckCircle2 size={18} aria-hidden="true" />
                                        : <Loader2 size={18} className="animate-spin" aria-hidden="true" />}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="writer-analysis-status-row">
                                    <div className="text-sm font-semibold text-foreground">
                                        {currentStatusMessage}
                                    </div>
                                    <span className="writer-analysis-percent">{Math.round(transcriptProgressPercent)}%</span>
                                </div>
                                <div className="writer-analysis-state-note">
                                    {analysisStalled && (
                                        <span>현재 단계가 예상보다 오래 걸리고 있습니다. 진행 상태가 바뀌는지 잠시 확인해 주세요.</span>
                                    )}
                                </div>
                                <ProgressBar
                                    value={transcriptProgressPercent}
                                    size="sm"
                                    tone={errorMessage ? 'error' : 'primary'}
                                    className="mt-3"
                                    label="대화록 생성률"
                                />
                            </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-3 text-left sm:min-w-[6.5rem] sm:text-right">
                            <div className="flex flex-wrap gap-5 sm:justify-end">
                                <div>
                                    <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                        <span>경과 시간</span>
                                    </div>
                                    <div className="writer-analysis-elapsed">{elapsedLabel}</div>
                                </div>
                            </div>
                            {/* Before the stream starts there is nothing to keep or cancel, so 중지 acts at once. */}
                            {analysisPhase !== 'analyzing' && !analysisStopRequestedAction && (
                                <Button
                                    variant="outline"
                                    className="h-8 px-3 text-xs sm:self-end"
                                    onClick={handleStopPreparation}
                                >
                                    <Square size={13} aria-hidden="true" />
                                    중지
                                </Button>
                            )}
                            {analysisPhase === 'analyzing' && !isAnalysisStopConfirmOpen && !analysisStopRequestedAction && (
                                <Button
                                    variant="outline"
                                    className="h-8 px-3 text-xs sm:self-end"
                                    onClick={handleOpenAnalysisStopConfirm}
                                    disabled={isRequestingAnalysisStop}
                                    title="분석을 중지하거나 취소합니다."
                                >
                                    <Square size={13} aria-hidden="true" />
                                    중지/취소
                                </Button>
                            )}
                            {analysisStopRequestedAction && (
                                <div className="writer-analysis-stop-requested sm:self-end">
                                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                                    {analysisStopRequestedAction === 'stop' ? '중지 중' : '취소 중'}
                                </div>
                            )}
                        </div>
                    </div>
                    {analysisProgressGuidance && (
                        <div className="detail-inline-note mt-3">
                            {analysisProgressGuidance}
                        </div>
                    )}
                    {isAnalysisStopConfirmOpen && (
                        <div className="analysis-stop-panel" role="group" aria-label="분석 중지 또는 취소 방식 선택">
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-foreground">분석을 어떻게 처리할까요?</div>
                                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                    중지하면 같은 파일로 이어서 분석할 수 있습니다. 취소하면 이번 분석의 임시 대화록은 삭제합니다. 완료·중지·실패한 회의록, 본문을 수정·확정한 대화록과 정리 결과는 남깁니다.
                                </div>
                            </div>
                            <div className="analysis-stop-actions">
                                <Button
                                    variant="outline"
                                    onClick={() => handleStopAnalysis('stop')}
                                    disabled={isRequestingAnalysisStop}
                                    aria-label="이어하기 기록을 남기고 분석 중지"
                                    title="이어서 진행할 수 있게 중지"
                                >
                                    {isRequestingAnalysisStop && analysisStopRequestedAction === 'stop' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                                    중지
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => handleStopAnalysis('cancel')}
                                    disabled={isRequestingAnalysisStop}
                                    aria-label="진행 중 기록을 끝내고 분석 취소"
                                    title="진행 중 기록을 끝냄"
                                >
                                    {isRequestingAnalysisStop && analysisStopRequestedAction === 'cancel' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                    취소
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={() => setIsAnalysisStopConfirmOpen(false)}
                                    disabled={isRequestingAnalysisStop}
                                >
                                    계속
                                </Button>
                            </div>
                        </div>
                    )}
                    </>
                    )}
                </div>
            )}

                {completionNotice && (
                    <StatusBanner
                        tone="success"
                        heading={completionNotice.title}
                        className="writer-completion-panel"
                        action={(
                            <Button onClick={handleOpenCompletedMeeting}>
                                결과 보기
                            </Button>
                        )}
                    >
                        <div className="writer-completion-record">
                            <span className="break-all text-sm text-muted-foreground">{completionNotice.sourceFilename}</span>
                        </div>
                        <div>
                            소요 시간 {formatAnalysisDuration(completionNotice.elapsedMs)}.{' '}
                            {completionNotice.detailTab === 'summary'
                                ? '기록 정리에서 핵심 결과를 확인하세요.'
                                : '대화록을 확인하고 필요한 정리를 실행하세요.'}
                        </div>
                        {completionNotice.note && (
                            <div className="mt-2 text-sm text-muted-foreground">{completionNotice.note}</div>
                        )}
                        {completionNotice.autoSaveNote && (
                            <div className="mt-2 text-sm text-muted-foreground">{completionNotice.autoSaveNote}</div>
                        )}
                    </StatusBanner>
                )}
                {SHOW_AUDIO_EXTRACT_TOOL && audioExtractStatusVisible && (
                    <StatusBanner
                        tone={audioExtractStatusTone}
                        heading={audioExtractStatusHeading}
                        className="mt-3"
                        action={audioExtractNotice?.savedPath && isTauriRuntime() ? (
                            <Button variant="outline" className="status-action-button" onClick={handleOpenExtractedAudioLocation}>
                                <FolderOpen size={15} />
                                폴더 열기
                            </Button>
                        ) : undefined}
                    >
                        {audioExtractStatusMessage}
                    </StatusBanner>
                )}
            </div>

            {analysisStartBlocked && (
                <p id="writer-analysis-start-blocked" className="writer-analysis-blocked-note" role="status">
                    {analysisStartBlockedReason}
                </p>
            )}

            {hasBlockingReadinessIssue && (
                <StatusBanner tone={readinessBannerTone}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-2">
                            <AlertCircle size={18} />
                            <div>
                                <div className="font-semibold">{readinessBannerTitle}</div>
                                <div className="mt-1">
                                    {gpuUnavailable
                                        ? '이 PC에서 GPU 가속을 쓸 수 있는 환경이 아직 준비되지 않았습니다. 설정에서 분석 장치를 CPU로 바꾸면 분석할 수 있습니다.'
                                        : readinessMessage}
                                </div>
                            </div>
                        </div>
                        {/* The way forward (모델 받기 / 문제 해결 / 다시 확인) sits beside 분석 시작; only add a recheck here when it is not already there. */}
                        {readinessAction !== 'recheck' && (
                            <div className="flex shrink-0 gap-2">
                                <Button variant="outline" className="status-action-button" onClick={() => void handleRefreshReadiness()} disabled={isAnalyzing}>
                                    <RefreshCw size={15} aria-hidden="true" />
                                    다시 확인
                                </Button>
                            </div>
                        )}
                    </div>
                </StatusBanner>
            )}

            {errorMessage && !showAnalysisFailure && !(errorMessage.startsWith(REQUIRED_FIELDS_ERROR_PREFIX) && !localEngineConnectionRequired) && (
                <StatusBanner id="writer-form-error" tone="error">
                    {errorMessage}
                </StatusBanner>
            )}

            {statusMessage && !showAnalysisPanel && !completionNotice && !operationToast && (
                <StatusBanner tone="neutral">
                    {statusMessage}
                </StatusBanner>
            )}


            {showProgressBar && !showAnalysisPanel && (
                <ProgressBar value={transcriptProgressPercent} tone={errorMessage ? 'error' : 'primary'} label="대화록 생성률" />
            )}

            {showInputForm && !resumeSelectionActive && !isAnalyzing && idleCompanion}
        </div>
    );
};
