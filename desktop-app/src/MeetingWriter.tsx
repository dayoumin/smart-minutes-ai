import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleHelp, FileAudio, FolderOpen, Loader2, Pause, Play, RefreshCw, Settings, Square, Trash2, UploadCloud, X } from 'lucide-react';
import {
    ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT,
    AnalysisResumeDraft,
    AnalysisResumeDraftFileKey,
    AnalysisResumeDraftStatus,
    AnalysisResumeDraftUnavailableReason,
    getAnalysisResumeDraft,
    getResumeDraftKey,
    listAnalysisResumeDrafts,
    listPendingAnalysisDraftCleanups,
    listSuppressedResumeCandidateKeys,
    markAnalysisResumeDraftUnavailable,
    markAnalysisResumeDraftsForKeyUnavailable,
    queuePendingAnalysisDraftCleanup,
    removeAnalysisResumeDraft,
    removePendingAnalysisDraftCleanup,
    suppressResumeCandidateKey,
    unsuppressResumeCandidateKey,
    upsertAnalysisResumeDraft,
} from './analysisResumeDrafts';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Input } from './Input';
import {
    addMeeting,
    MeetingGenerationStatus,
    MeetingParticipantSummary,
    MeetingRecord,
    MeetingSegment,
    MeetingSpeakerContextSummary,
    MeetingTopicSection,
} from './meetingRepository';
import { getApiBase, isTauriRuntime, openSavedFileLocation, writeFrontendLog } from './apiBase';
import { ProgressBar } from './ProgressBar';
import { StatusBanner } from './StatusBanner';
import { formatAnalysisDuration, formatTranscriptReadyEstimate, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const BACKEND_READY_TIMEOUT_MS = 45_000;
const BACKEND_READY_INTERVAL_MS = 1_000;
const ANALYSIS_STALL_WARNING_MS = 120_000;
const LONG_MEDIA_NOTICE_SECONDS = 30 * 60;
const VERY_LONG_MEDIA_NOTICE_SECONDS = 90 * 60;
const PARTICIPANT_SEPARATION_CAUTION_SECONDS = 140 * 60;
const getNowMs = (): number => Date.now();

const getSelectedFileProcessingGuidance = (durationSeconds: number | null): string | null => {
    if (!durationSeconds || durationSeconds < LONG_MEDIA_NOTICE_SECONDS) return null;
    if (durationSeconds >= PARTICIPANT_SEPARATION_CAUTION_SECONDS) {
        return '매우 긴 파일입니다. 대화록을 먼저 저장합니다. 참석자 구분은 PC 상태에 따라 결과 화면에서 실행하지 못할 수 있습니다.';
    }
    if (durationSeconds >= VERY_LONG_MEDIA_NOTICE_SECONDS) {
        return '긴 파일입니다. 대화록을 먼저 저장하고, 참석자 구분과 정리는 결과 화면에서 실행할 수 있습니다.';
    }
    return '긴 파일입니다. 대화록을 먼저 저장한 뒤 참석자 구분과 정리를 결과 화면에서 실행할 수 있습니다.';
};

const getAnalysisProgressGuidance = (durationSeconds: number | null, isTranscriptReady: boolean): string | null => {
    if (!durationSeconds || durationSeconds < LONG_MEDIA_NOTICE_SECONDS) return null;
    if (isTranscriptReady) {
        return '대화록 저장이 끝나면 결과 화면에서 참석자 구분과 정리를 실행할 수 있습니다.';
    }
    if (durationSeconds >= VERY_LONG_MEDIA_NOTICE_SECONDS) {
        return '파일이 길어 시간이 오래 걸릴 수 있습니다. 대화록 예상은 저장 기준이며, 완료된 진행분은 이어서 사용할 수 있게 남깁니다.';
    }
    return '대화록 예상은 저장 기준입니다. 참석자 구분과 정리는 결과 화면에서 실행할 수 있습니다.';
};

interface AnalyzeResult {
    status?: string;
    heartbeat?: boolean;
    progress?: number;
    eta_seconds?: number | null;
    etaSeconds?: number | null;
    total_audio_seconds?: number;
    totalAudioSeconds?: number;
    completed_audio_seconds?: number;
    completedAudioSeconds?: number;
    transcript_ready?: boolean;
    transcriptReady?: boolean;
    summary?: string;
    segments?: MeetingSegment[];
    display_segments?: MeetingSegment[];
    displaySegments?: MeetingSegment[];
    topics?: string[];
    topic_sections?: MeetingTopicSection[];
    topicSections?: MeetingTopicSection[];
    participant_summaries?: MeetingParticipantSummary[];
    participantSummaries?: MeetingParticipantSummary[];
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    generation_status?: MeetingGenerationStatus;
    generationStatus?: MeetingGenerationStatus;
    actions?: string[];
    decisions?: string[];
    needs_check?: string[];
    needsCheck?: string[];
    diarization_skipped?: boolean;
    diarizationSkipped?: boolean;
    diarization_applied?: boolean;
    diarizationApplied?: boolean;
    diarization_requested?: boolean;
    diarizationRequested?: boolean;
    diarization_skip_message?: string;
    diarizationSkipMessage?: string;
    diarization_skip_reason?: string;
    diarizationSkipReason?: string;
    diarization_deferred?: boolean;
    diarizationDeferred?: boolean;
    diarization_defer_message?: string;
    diarizationDeferMessage?: string;
    meeting?: {
        source_file?: string;
        job_id?: string;
        meeting_purpose?: string;
    };
    outputs?: {
        job_id?: string;
        json?: string | null;
        txt?: string | null;
        md?: string | null;
        docx?: string | null;
        hwpx?: string | null;
        audio?: string | null;
    };
    auto_saved_files?: Partial<Record<'hwpx' | 'audio', string>>;
    auto_save_errors?: Partial<Record<'hwpx' | 'audio', string>>;
    action?: string;
    resume?: {
        requested?: boolean;
        mode?: string;
        message?: string;
        fallback_reason?: string | null;
        reused_chunk_count?: number;
    };
}

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

interface DraftStatusPayload {
    drafts?: Array<{
        job_id: string;
        status: 'active' | 'cancelled' | 'failed' | 'completed' | 'stopped' | 'missing';
        stage?: string;
        updated_at?: string;
        resume_supported?: boolean;
        completed_chunk_count?: number;
        last_progress?: {
            message?: string;
            progress?: number;
            status?: string;
            transcript_ready?: boolean;
            transcriptReady?: boolean;
            eta_seconds?: number | null;
            etaSeconds?: number | null;
        };
        last_error?: string;
    }>;
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
    elapsedMs: number;
    note?: string;
    autoSaveNote?: string;
}

interface OperationToast {
    id: number;
    message: string;
    tone: 'warning' | 'neutral' | 'error';
}

interface ReadinessCheck {
    state: ReadinessState;
    message: string;
    models?: ModelsPayload;
}

interface ReadinessOptions {
    soft?: boolean;
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

const getFileKind = (selectedFile: File): 'audio' | 'video' | 'unknown' => {
    if (selectedFile.type.startsWith('audio/')) return 'audio';
    if (selectedFile.type.startsWith('video/')) return 'video';
    const extension = getFileExtension(selectedFile.name);
    if (AUDIO_FILE_EXTENSIONS.has(extension)) return 'audio';
    if (VIDEO_FILE_EXTENSIONS.has(extension)) return 'video';
    return 'unknown';
};

const readResponseError = async (response: Response, fallback: string): Promise<string> => {
    const detailText = await response.text().catch(() => '');
    if (detailText.startsWith('{')) {
        try {
            const parsedDetail = JSON.parse(detailText) as { detail?: string };
            return parsedDetail.detail || fallback;
        } catch {
            return fallback;
        }
    }
    return detailText || fallback;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

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
        return `음성 인식 ${chunkMatch[1]}/${chunkMatch[2]} 처리 중`;
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

const getResumeDraftStatusLabel = (status: AnalysisResumeDraftStatus): string => {
    if (status === 'active') return '진행 중이던 분석';
    if (status === 'completed') return '정리됨';
    if (status === 'unavailable') return '이어하기 불가';
    if (status === 'stopped') return '중단됨';
    if (status === 'cancelled') return '사용자 취소';
    return '오류로 중단';
};

const getResumeDraftTone = (status: AnalysisResumeDraftStatus): 'info' | 'warning' | 'error' | 'success' => {
    if (status === 'active') return 'info';
    if (status === 'completed') return 'success';
    if (status === 'unavailable') return 'warning';
    if (status === 'stopped') return 'warning';
    if (status === 'cancelled') return 'warning';
    return 'error';
};

const canResumeDraft = (draft: AnalysisResumeDraft): boolean => (
    draft.status !== 'active'
    && draft.status !== 'completed'
    && draft.status !== 'unavailable'
    && draft.resumeEligible !== false
);

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
        '같은 파일의 미완료 분석 후보를 찾았습니다.',
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
    apiBase: string,
    selectedFile: File,
    durationSeconds: number | null,
    signal?: AbortSignal,
): Promise<AnalysisStoragePreflightPayload> => {
    const response = await fetch(`${apiBase}/api/analyze/preflight`, {
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
    resumeDraftSelectionRequest?: { jobId: string; requestId: number } | null;
    onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
}

export const MeetingWriter: React.FC<MeetingWriterProps> = ({ onOpenSettings, resumeDraftSelectionRequest, onRegisterLeaveGuard }) => {
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
    const [initialDateValue, setInitialDateValue] = useState(date);
    const [meetingPurpose, setMeetingPurpose] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
    const [analysisNow, setAnalysisNow] = useState(() => Date.now());
    const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
    const [isAnalysisStopConfirmOpen, setIsAnalysisStopConfirmOpen] = useState(false);
    const [isRequestingAnalysisStop, setIsRequestingAnalysisStop] = useState(false);
    const [analysisStopRequestedAction, setAnalysisStopRequestedAction] = useState<AnalysisStopAction | null>(null);
    const [statusMessage, setStatusMessage] = useState('');
    const [operationToast, setOperationToast] = useState<OperationToast | null>(null);
    const [rawStatusMessage, setRawStatusMessage] = useState('');
    const [transcriptReady, setTranscriptReady] = useState(false);
    const [analysisEtaSeconds, setAnalysisEtaSeconds] = useState<number | null>(null);
    const transcriptReadyRef = useRef(false);
    const [lastRealProgressAt, setLastRealProgressAt] = useState(() => Date.now());
    const [errorMessage, setErrorMessage] = useState('');
    const [fileDurationSeconds, setFileDurationSeconds] = useState<number | null>(null);
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null);
    const [audioExtractFile, setAudioExtractFile] = useState<File | null>(null);
    const [isExtractingAudio, setIsExtractingAudio] = useState(false);
    const [audioExtractNotice, setAudioExtractNotice] = useState<AudioExtractNotice | null>(null);
    const [audioExtractStartedAt, setAudioExtractStartedAt] = useState<number | null>(null);
    const [audioExtractNow, setAudioExtractNow] = useState(() => Date.now());
    const audioExtractRequestRef = useRef(0);
    const [resumeDrafts, setResumeDrafts] = useState<AnalysisResumeDraft[]>([]);
    const [selectedResumeDraftId, setSelectedResumeDraftId] = useState<string | null>(null);
    const [deletingResumeDraftIds, setDeletingResumeDraftIds] = useState<Set<string>>(() => new Set());
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const videoFileInputRef = useRef<HTMLInputElement | null>(null);
    const analysisInFlightRef = useRef(false);
    const analysisAbortControllerRef = useRef<AbortController | null>(null);
    const analysisCancelledRef = useRef(false);
    const analysisJobIdRef = useRef<string | null>(null);
    const analysisResumeDraftIdRef = useRef<string | null>(null);
    const analysisStopActionRef = useRef<AnalysisStopAction | null>(null);
    const selectedResumeDraftIdRef = useRef<string | null>(null);
    const cleanupRetryInFlightRef = useRef(false);
    const analysisStalled = isAnalyzing && analysisPhase === 'analyzing' && analysisNow - lastRealProgressAt >= ANALYSIS_STALL_WARNING_MS;
    const showOperationToast = React.useCallback((message: string, tone: OperationToast['tone'] = 'neutral') => {
        setOperationToast({
            id: Date.now(),
            message,
            tone,
        });
    }, []);
    const hasDraftableInput = useMemo(() => (
        Boolean(title.trim())
        || Boolean(meetingPurpose.trim())
        || Boolean(file)
        || Boolean(selectedResumeDraftId)
        || date !== initialDateValue
    ), [date, file, initialDateValue, meetingPurpose, selectedResumeDraftId, title]);
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
        const active = isAnalyzing;
        window.dispatchEvent(new CustomEvent('analysis:status', {
            detail: {
                active,
                progress,
                message: statusMessage,
                rawMessage: rawStatusMessage,
                startedAt: analysisStartedAt,
                stalled: analysisStalled,
                transcriptReady,
                etaSeconds: analysisEtaSeconds,
            },
        }));
    }, [analysisEtaSeconds, analysisStartedAt, analysisStalled, isAnalyzing, progress, rawStatusMessage, statusMessage, transcriptReady]);

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

    useEffect(() => {
        const syncDrafts = async () => {
            const localDrafts = listAnalysisResumeDrafts();
            setResumeDrafts(localDrafts);

            if (ANALYSIS_MODE !== 'real') return;
            const retryPendingCleanups = async (apiBase: string) => {
                if (cleanupRetryInFlightRef.current) return;
                const pendingJobIds = listPendingAnalysisDraftCleanups();
                if (pendingJobIds.length === 0) return;
                cleanupRetryInFlightRef.current = true;
                try {
                    for (const jobId of pendingJobIds) {
                        try {
                            const response = await fetch(`${apiBase}/api/analyze/drafts/${encodeURIComponent(jobId)}`, {
                                method: 'DELETE',
                            });
                            if (response.ok || response.status === 404) {
                                removePendingAnalysisDraftCleanup(jobId);
                            }
                        } catch {
                            // Keep the cleanup queued until the backend is available again.
                        }
                    }
                } finally {
                    cleanupRetryInFlightRef.current = false;
                }
            };

            let apiBase: string;
            try {
                apiBase = await getApiBase();
            } catch {
                return;
            }
            await retryPendingCleanups(apiBase);
            if (localDrafts.length === 0) return;

            try {
                const response = await fetch(`${apiBase}/api/analyze/draft-statuses`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_ids: localDrafts.map(draft => draft.jobId) }),
                });
                if (!response.ok) return;
                const payload = await response.json() as DraftStatusPayload;
                const remoteDrafts = payload.drafts || [];
                const now = new Date().toISOString();

                for (const draft of localDrafts) {
                    const currentDraft = getAnalysisResumeDraft(draft.jobId);
                    if (!currentDraft) {
                        continue;
                    }
                    if (currentDraft.status === 'completed' || currentDraft.status === 'unavailable') {
                        continue;
                    }
                    const remote = remoteDrafts.find(item => item.job_id === draft.jobId);
                    if (!remote || remote.status === 'missing') {
                        markAnalysisResumeDraftUnavailable(draft.jobId, 'no-checkpoint', {
                            errorMessage: '재사용 가능한 체크포인트를 찾지 못했습니다.',
                            updatedAt: now,
                        });
                        continue;
                    }
                    if (remote.status === 'completed') {
                        markAnalysisResumeDraftsForKeyUnavailable(
                            {
                                sourceFilename: draft.sourceFilename,
                                sourceSize: draft.sourceSize,
                                sourceLastModified: draft.sourceLastModified,
                            },
                            'completed',
                            {
                                status: 'completed',
                                errorMessage: '분석이 완료되어 이어할 필요가 없습니다. 결과는 회의 기록에서 확인하세요.',
                                updatedAt: now,
                                clearSuppression: false,
                            },
                        );
                        continue;
                    }

                    const keepLocalCancellation = (remote.status === 'active' || remote.status === 'cancelled')
                        && (currentDraft.status === 'cancelled' || currentDraft.status === 'stopped');
                    const nextStatus: AnalysisResumeDraftStatus = keepLocalCancellation
                        ? currentDraft.status
                        : remote.status === 'cancelled'
                        ? 'cancelled'
                        : remote.status === 'active'
                            ? 'active'
                            : remote.status === 'stopped'
                                ? 'stopped'
                                : 'failed';
                    const resumeEligible = Boolean(remote.resume_supported) && Number(remote.completed_chunk_count || 0) > 0;
                    const nextDraft: AnalysisResumeDraft = {
                        ...currentDraft,
                        status: nextStatus,
                        updatedAt: remote.updated_at || now,
                        stage: remote.stage || currentDraft.stage,
                        lastMessage: remote.last_progress?.message || currentDraft.lastMessage,
                        lastProgress: typeof remote.last_progress?.progress === 'number'
                            ? remote.last_progress.progress
                            : currentDraft.lastProgress,
                        lastEtaSeconds: remote.last_progress && Object.prototype.hasOwnProperty.call(remote.last_progress, 'eta_seconds')
                            ? (typeof remote.last_progress.eta_seconds === 'number' ? remote.last_progress.eta_seconds : null)
                            : remote.last_progress && Object.prototype.hasOwnProperty.call(remote.last_progress, 'etaSeconds')
                                ? (typeof remote.last_progress.etaSeconds === 'number' ? remote.last_progress.etaSeconds : null)
                                : currentDraft.lastEtaSeconds,
                        transcriptReady: Boolean(remote.last_progress?.transcript_ready || remote.last_progress?.transcriptReady || currentDraft.transcriptReady),
                        errorMessage: remote.last_error || (resumeEligible ? undefined : currentDraft.errorMessage),
                        resumeEligible,
                        resumeUnavailableReason: resumeEligible ? undefined : currentDraft.resumeUnavailableReason,
                        completedChunkCount: Number(remote.completed_chunk_count || 0),
                    };
                    if (
                        nextDraft.status !== currentDraft.status
                        || nextDraft.updatedAt !== currentDraft.updatedAt
                        || nextDraft.stage !== currentDraft.stage
                        || nextDraft.lastMessage !== currentDraft.lastMessage
                        || nextDraft.lastProgress !== currentDraft.lastProgress
                        || nextDraft.lastEtaSeconds !== currentDraft.lastEtaSeconds
                        || nextDraft.transcriptReady !== currentDraft.transcriptReady
                        || nextDraft.errorMessage !== currentDraft.errorMessage
                        || nextDraft.resumeEligible !== currentDraft.resumeEligible
                        || nextDraft.completedChunkCount !== currentDraft.completedChunkCount
                    ) {
                        upsertAnalysisResumeDraft(nextDraft);
                    }
                }

                setResumeDrafts(listAnalysisResumeDrafts());
            } catch {
                // Keep local draft snapshot when backend state is unavailable.
            }
        };
        void syncDrafts();
        const handleSyncDrafts = () => {
            void syncDrafts();
        };
        window.addEventListener('focus', handleSyncDrafts);
        window.addEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, handleSyncDrafts);
        return () => {
            window.removeEventListener('focus', handleSyncDrafts);
            window.removeEventListener(ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT, handleSyncDrafts);
        };
    }, []);

    useEffect(() => {
        if (ANALYSIS_MODE !== 'real') return;

        let cancelled = false;
        const syncReadiness = async () => {
            const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;

            while (!cancelled && Date.now() < deadline) {
                const check = await refreshReadiness({ soft: true });
                if (cancelled) return;

                if (check.state === 'ready') {
                    setErrorMessage('');
                    setStatusMessage('');
                    setAnalysisPhase('idle');
                    return;
                }

                if (check.state === 'missing-models') return;
                await sleep(BACKEND_READY_INTERVAL_MS);
            }

            if (!cancelled) {
                const check = await refreshReadiness();
                if (check.state === 'ready') {
                    setErrorMessage('');
                    setStatusMessage('');
                    setAnalysisPhase('idle');
                }
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
            window.removeEventListener('focus', syncReadiness);
            window.removeEventListener('analysis:settings-updated', handleSettingsUpdated);
        };
    }, []);

    const missingRequiredModels = useMemo(
        () => (modelsPayload?.models || []).filter(model => model.required && !model.installed),
        [modelsPayload],
    );

    const missingFields = useMemo(() => {
        const fields: string[] = [];
        if (!title.trim()) fields.push('회의 제목');
        if (!date) fields.push('일시');
        if (!meetingPurpose.trim()) fields.push('회의 목적/정리 맥락');
        if (!file) fields.push('음성 파일');
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

    const activeResumeDrafts = useMemo(
        () => resumeDrafts.filter(draft => draft.status === 'active'),
        [resumeDrafts],
    );

    const activeResumeDraftKeys = useMemo(
        () => new Set(activeResumeDrafts.map(draft => getResumeDraftKey(draft))),
        [activeResumeDrafts],
    );

    const resumableResumeDrafts = useMemo(
        () => resumeDrafts.filter(
            draft => draft.status !== 'active'
                && canResumeDraft(draft)
                && !activeResumeDraftKeys.has(getResumeDraftKey(draft)),
        ),
        [activeResumeDraftKeys, resumeDrafts],
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
    const startButtonDisabled = isAnalyzing
        || isExtractingAudio
        || Boolean(matchingActiveDraft)
        || selectedResumeDraftUnavailable
        || resumeDraftFileMismatch
        || missingFields.length > 0;

    const hasBlockingReadinessIssue = readinessState === 'missing-models' || readinessState === 'error';
    const readinessBannerTone = readinessState === 'missing-models' ? 'info' : 'error';
    const readinessBannerTitle = readinessState === 'missing-models' ? '분석 준비가 필요합니다' : '분석을 시작할 수 없습니다';

    const refreshReadiness = async (options: ReadinessOptions = {}): Promise<ReadinessCheck> => {
        if (ANALYSIS_MODE !== 'real') {
            setReadinessState('ready');
            setReadinessMessage('');
            return { state: 'ready', message: '' };
        }

        try {
            const apiBase = await getApiBase();
            await writeFrontendLog(`readiness start soft=${options.soft ? 'true' : 'false'} apiBase=${apiBase}`);
            const healthResponse = await fetch(`${apiBase}/api/health`);
            await writeFrontendLog(`readiness health status=${healthResponse.status} ok=${healthResponse.ok}`);
            if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);

            await healthResponse.json().catch(() => null);

            const modelsResponse = await fetch(`${apiBase}/api/models/status`);
            await writeFrontendLog(`readiness models status=${modelsResponse.status} ok=${modelsResponse.ok}`);
            if (!modelsResponse.ok) {
                const body = await modelsResponse.text().catch(() => '');
                await writeFrontendLog(`readiness models non-ok body=${body.slice(0, 500)}`);
                const message = options.soft
                    ? '분석 기능을 준비하고 있습니다. 잠시 기다려 주세요.'
                    : '모델 상태를 확인하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요.';
                setReadinessState(options.soft ? 'server-waiting' : 'error');
                setReadinessMessage(message);
                return { state: options.soft ? 'server-waiting' : 'error', message };
            }

            const payload = await modelsResponse.json() as ModelsPayload;
            await writeFrontendLog(`readiness models payload ready=${payload.ready} count=${payload.models?.length ?? 0} errors=${payload.errors?.join(' | ') ?? ''}`);
            setModelsPayload(payload);

            if (payload.ready) {
                setReadinessState('ready');
                setReadinessMessage('');
                return { state: 'ready', message: '', models: payload };
            }

            const missing = payload.models
                .filter(model => model.required && !model.installed)
                .map(model => getUserModelLabel(model))
                .join(', ');
            const message = payload.errors?.[0] || `분석을 시작하려면 ${missing || '필수 모델'} 준비가 필요합니다. 모델 탭에서 받을 수 있는 항목은 바로 받을 수 있습니다.`;
            setReadinessState('missing-models');
            setReadinessMessage(message);
            return { state: 'missing-models', message, models: payload };
        } catch (error) {
            await writeFrontendLog(`readiness error ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            const message = error instanceof Error && !options.soft
                ? `분석 기능을 준비하고 있습니다. ${error.message}`
                : '분석 기능을 준비하고 있습니다. 첫 실행은 시간이 걸릴 수 있습니다.';
            setReadinessState('server-waiting');
            setReadinessMessage(message);
            return { state: 'server-waiting', message };
        }
    };

    const waitForBackendReady = async (): Promise<ReadinessCheck> => {
        const deadline = getNowMs() + BACKEND_READY_TIMEOUT_MS;
        setAnalysisPhase('checking-server');

        while (getNowMs() < deadline && !analysisCancelledRef.current) {
            const check = await refreshReadiness();
            if (check.state === 'ready') return check;
            if (check.state === 'missing-models' || check.state === 'error') return check;

            const remainingSeconds = Math.max(0, Math.ceil((deadline - getNowMs()) / 1000));
            setStatusMessage(`분석 기능을 준비하고 있습니다. 잠시 기다려 주세요. (${remainingSeconds}초)`);
            await sleep(BACKEND_READY_INTERVAL_MS);
        }

        if (analysisCancelledRef.current) {
            return { state: 'error', message: '분석 요청을 중단했습니다.' };
        }

        const message = isTauriRuntime()
            ? '분석 기능이 아직 준비되지 않았습니다. 앱을 종료한 뒤 다시 실행해 주세요.'
            : '분석 서버가 아직 준비되지 않았습니다. 백엔드 서버를 실행한 뒤 다시 시도해 주세요.';
        setAnalysisPhase('error');
        setErrorMessage(message);
        setStatusMessage('');
        return { state: 'error', message };
    };

    const ensureModelsReady = async (): Promise<boolean> => {
        if (ANALYSIS_MODE !== 'real') return true;

        setAnalysisPhase('checking-models');
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        const check = await waitForBackendReady();
        if (analysisCancelledRef.current) return false;
        if (check.state === 'ready') return true;

        if (check.state === 'missing-models') {
            const missingModels = (check.models?.models || []).filter(model => model.required && !model.installed);
            const missingList = missingModels.map(model => getUserModelLabel(model)).join(', ');
            setReadinessState('missing-models');
            setReadinessMessage(
                `분석을 시작하려면 ${missingList || '필수 모델'} 준비가 필요합니다. 모델 탭에서 받을 수 있는 항목은 바로 받을 수 있습니다.`,
            );
            setErrorMessage('');
            setAnalysisPhase('idle');
            return false;
        }

        setErrorMessage(check.message);
        setAnalysisPhase('error');
        return false;
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

        setErrorMessage(check.state === 'server-waiting' ? '' : check.message);
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
    ) => {
        if (!file) return;
        const jobId = options.jobId || analysisJobIdRef.current;
        if (!jobId) return;
        const now = new Date().toISOString();
        const existing = getAnalysisResumeDraft(jobId);
        upsertAnalysisResumeDraft({
            jobId,
            title: title.trim(),
            date,
            participants: '',
            meetingPurpose: meetingPurpose.trim(),
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
        setFile(null);
        setFileDurationSeconds(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleStartFreshFromResume = () => {
        if (selectedResumeDraft) {
            suppressResumeCandidateKey(getResumeDraftKey(selectedResumeDraft));
        }
        clearResumeSelectionOnly();
        setStatusMessage('새 분석을 처음부터 시작합니다.');
    };

    const handleResumeDraftPrepare = (draft: AnalysisResumeDraft) => {
        setTitle(draft.title);
        setDate(draft.date);
        setMeetingPurpose(draft.meetingPurpose || draft.participants || '');
        setSelectedResumeDraftId(draft.jobId);
        if (canResumeDraft(draft)) {
            unsuppressResumeCandidateKey(getResumeDraftKey(draft));
        }
        setCompletionNotice(null);
        setErrorMessage(canResumeDraft(draft) ? '' : getResumeStartErrorMessage(draft));
        setStatusMessage(draft.lastMessage ? translateStatusMessage(draft.lastMessage) : '');
        setRawStatusMessage(draft.lastMessage || '');
        setProgress(typeof draft.lastProgress === 'number' ? draft.lastProgress : 0);
        setAnalysisEtaSeconds(typeof draft.lastEtaSeconds === 'number' ? draft.lastEtaSeconds : null);
        transcriptReadyRef.current = Boolean(draft.transcriptReady);
        setTranscriptReady(Boolean(draft.transcriptReady));
    };

    const resumeDraftSelectionJobId = resumeDraftSelectionRequest?.jobId;
    const resumeDraftSelectionRequestId = resumeDraftSelectionRequest?.requestId;

    useEffect(() => {
        if (!resumeDraftSelectionJobId) return;
        const drafts = listAnalysisResumeDrafts();
        setResumeDrafts(drafts);
        const draft = drafts.find(item => item.jobId === resumeDraftSelectionJobId);
        if (!draft) {
            setSelectedResumeDraftId(null);
            setErrorMessage('선택한 미완료 분석 기록을 찾지 못했습니다.');
            return;
        }
        handleResumeDraftPrepare(draft);
    }, [resumeDraftSelectionJobId, resumeDraftSelectionRequestId]);

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
                const apiBase = await getApiBase();
                let response: Response | null = null;
                try {
                    response = await fetch(`${apiBase}/api/analyze/drafts/${encodeURIComponent(draft.jobId)}`, {
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
            setErrorMessage(error instanceof Error ? error.message : '분석 기록을 삭제하지 못했습니다.');
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
            setStatusMessage(deleteNotice);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isExtractingAudio) return;
        const selectedFile = e.target.files?.[0] ?? null;
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        setFileDurationSeconds(null);
        setCompletionNotice(null);
        setFile(selectedFile);

        const selectedKind = selectedFile ? getFileKind(selectedFile) : 'unknown';
        if (!selectedFile || selectedKind === 'unknown') return;

        const media = document.createElement(selectedKind === 'video' ? 'video' : 'audio');
        const objectUrl = URL.createObjectURL(selectedFile);
        media.preload = 'metadata';
        media.onloadedmetadata = () => {
            if (Number.isFinite(media.duration)) {
                setFileDurationSeconds(media.duration);
            }
            URL.revokeObjectURL(objectUrl);
        };
        media.onerror = () => URL.revokeObjectURL(objectUrl);
        media.src = objectUrl;
    };

    const clearFile = () => {
        if (isExtractingAudio) return;
        setFile(null);
        setFileDurationSeconds(null);
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        setCompletionNotice(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
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

            const apiBase = await getApiBase();
            const formData = new FormData();
            formData.append('file', sourceFile);
            const response = await fetch(`${apiBase}/api/tools/extract-audio/save-copy`, {
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
        if (analysisInFlightRef.current || isAnalyzing) {
            return;
        }

        if (missingFields.length > 0) {
            setProgress(0);
            setStatusMessage('');
            setCompletionNotice(null);
            setErrorMessage(`필수 항목을 확인해 주세요: ${missingFields.join(', ')}`);
            return;
        }

        analysisInFlightRef.current = true;
        analysisCancelledRef.current = false;
        analysisAbortControllerRef.current = new AbortController();
        const startedAt = getNowMs();
        setAnalysisStartedAt(startedAt);
        setIsAnalyzing(true);
        setAnalysisPhase('checking-server');
        setProgress(0);
        setRawStatusMessage('');
        setAnalysisEtaSeconds(null);
        setLastRealProgressAt(getNowMs());
        setIsAnalysisStopConfirmOpen(false);
        setAnalysisStopRequestedAction(null);
        setIsRequestingAnalysisStop(false);
        analysisStopActionRef.current = null;
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');
        setCompletionNotice(null);
        setAudioExtractFile(null);
        setAudioExtractNotice(null);
        if (videoFileInputRef.current) {
            videoFileInputRef.current.value = '';
        }

        try {
            const modelsReady = await ensureModelsReady();
            if (!modelsReady) return;
            if (analysisCancelledRef.current) return;
            const apiBase = await getApiBase();
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
                    const resumeResponse = await fetch(`${apiBase}/api/analyze/resume-candidates`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            source_filename: file.name,
                            source_size: file.size,
                            source_last_modified: file.lastModified,
                        }),
                    });
                    if (resumeResponse.ok) {
                        resumePayload = await resumeResponse.json() as ResumeCandidatesPayload;
                    }
                } catch {
                    resumePayload = null;
                }
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
                    setResumeDrafts(listAnalysisResumeDrafts());
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
                    apiBase,
                    file,
                    fileDurationSeconds,
                    analysisAbortControllerRef.current?.signal,
                );
                if (storagePreflight.ok === false) {
                    throw new Error(storagePreflight.message || '저장 공간이 부족합니다. 임시 파일을 정리한 뒤 다시 시도해 주세요.');
                }
                if (storagePreflight.level === 'warning' && storagePreflight.message) {
                    showOperationToast(storagePreflight.message, 'warning');
                }
                setStatusMessage(resumeRequested ? '이전 음성 인식 진행분 재사용을 시도합니다.' : '');
            }
            analysisJobIdRef.current = analysisJobId;
            analysisResumeDraftIdRef.current = analysisJobId;
            saveResumeDraft('active', {
                jobId: analysisJobId,
                stage: 'uploaded',
                lastMessage: selectedResumeDraft ? '이전 음성 인식 진행분 재사용을 시도합니다.' : '분석을 시작합니다.',
                lastProgress: 0,
            });
            setAnalysisPhase('analyzing');
            transcriptReadyRef.current = false;
            setTranscriptReady(false);
            setAnalysisEtaSeconds(null);
            setLastRealProgressAt(getNowMs());
            setStatusMessage(current => current || '분석을 시작합니다. 음성 추출과 전사를 진행합니다.');

            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('date', date);
            formData.append('participants', '');
            formData.append('meeting_purpose', meetingPurpose.trim());
            formData.append('mode', ANALYSIS_MODE);
            formData.append('job_id', analysisJobId);
            formData.append('file', file as File);
            formData.append('file_size', String((file as File).size));
            formData.append('file_last_modified', String((file as File).lastModified));
            formData.append('resume_requested', resumeRequested ? 'true' : 'false');
            const response = await fetch(`${apiBase}/api/analyze`, {
                method: 'POST',
                body: formData,
                headers: { Accept: 'text/event-stream' },
                signal: analysisAbortControllerRef.current.signal,
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
                throw new Error(message || `서버 응답 오류: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('분석 응답 스트림을 읽을 수 없습니다.');
            }

            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let finalData: AnalyzeResult | null = null;

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

                    let parsed: AnalyzeResult & { message?: string };
                    try {
                        parsed = JSON.parse(dataStr) as AnalyzeResult & { message?: string };
                    } catch {
                        console.warn('Ignoring malformed SSE event:', dataStr);
                        continue;
                    }
                    if (typeof parsed.progress === 'number') {
                        setProgress(Math.min(100, Math.max(0, parsed.progress)));
                    }
                    const parsedEtaSeconds = typeof parsed.eta_seconds === 'number'
                        ? parsed.eta_seconds
                        : typeof parsed.etaSeconds === 'number'
                            ? parsed.etaSeconds
                            : null;
                    setAnalysisEtaSeconds(parsedEtaSeconds);
                    const nextTranscriptReady = transcriptReadyRef.current
                        || Boolean(parsed.transcript_ready || parsed.transcriptReady || parsed.status === 'completed');
                    if (nextTranscriptReady) {
                        transcriptReadyRef.current = true;
                        setTranscriptReady(true);
                    }
                    if (parsed.message && !analysisStopActionRef.current) {
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
                        throw new Error(parsed.message || '분석 중 오류가 발생했습니다.');
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

            const newRecord: MeetingRecord = {
                id: crypto.randomUUID(),
                date: date.replace('T', ' '),
                title: title.trim(),
                participants: '',
                meetingPurpose: meetingPurpose.trim(),
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
                diarizationSkipped: finalData.diarizationSkipped ?? finalData.diarization_skipped ?? false,
                diarizationApplied: finalData.diarizationApplied ?? finalData.diarization_applied,
                diarizationRequested: finalData.diarizationRequested ?? finalData.diarization_requested,
                diarizationSkipMessage: finalData.diarizationSkipMessage || finalData.diarization_skip_message || '',
                diarizationSkipReason: finalData.diarizationSkipReason || finalData.diarization_skip_reason || '',
                diarizationDeferred: finalData.diarizationDeferred ?? finalData.diarization_deferred ?? false,
                diarizationDeferMessage: finalData.diarizationDeferMessage || finalData.diarization_defer_message || '',
                outputFiles: finalData.outputs,
            };

            await addMeeting(newRecord);
            const completedJobId = newRecord.jobId || analysisJobId;
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
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: newRecord.id, openHistory: false } }));
            const completedElapsedMs = getNowMs() - startedAt;
            setProgress(100);
            setRawStatusMessage('');
            setAnalysisEtaSeconds(null);
            setStatusMessage('회의록을 저장했습니다.');
            setCompletionNotice({
                meetingId: newRecord.id,
                elapsedMs: completedElapsedMs,
                note: getCompletionResumeNote(finalData.resume),
                autoSaveNote: getAutoSaveCompletionNote(finalData),
            });
            setTitle('');
            setMeetingPurpose('');
            const nextInitialDate = new Date().toISOString().slice(0, 16);
            setInitialDateValue(nextInitialDate);
            setDate(nextInitialDate);
            setFile(null);
            clearResumeDraftSelection();
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (error) {
            if (analysisCancelledRef.current || (error instanceof DOMException && error.name === 'AbortError')) {
                const requestedStopAction = analysisStopActionRef.current;
                const existingDraft = analysisResumeDraftIdRef.current
                    ? getAnalysisResumeDraft(analysisResumeDraftIdRef.current)
                    : undefined;
                if (requestedStopAction === 'cancel') {
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
                    });
                }
                setResumeDrafts(listAnalysisResumeDrafts());
                setProgress(0);
                setRawStatusMessage('');
                setAnalysisEtaSeconds(null);
                setStatusMessage(requestedStopAction === 'cancel'
                    ? '분석을 취소했습니다.'
                    : '분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.');
                showOperationToast(requestedStopAction === 'cancel'
                    ? '분석을 취소했습니다.'
                    : '분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.', 'warning');
                setErrorMessage('');
                return;
            }
            const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
            saveResumeDraft('failed', {
                stage: 'failed',
                lastMessage: rawStatusMessage || statusMessage,
                lastProgress: progress,
                errorMessage: message,
            });
            setAnalysisPhase('error');
            setErrorMessage(message);
            setRawStatusMessage('');
            setAnalysisEtaSeconds(null);
            setStatusMessage('');
            setProgress(0);
        } finally {
            analysisInFlightRef.current = false;
            analysisAbortControllerRef.current = null;
            analysisJobIdRef.current = null;
            analysisResumeDraftIdRef.current = null;
            analysisStopActionRef.current = null;
            setIsAnalyzing(false);
            setIsAnalysisStopConfirmOpen(false);
            setAnalysisStopRequestedAction(null);
            setIsRequestingAnalysisStop(false);
            setAnalysisStartedAt(null);
            setAnalysisPhase(current => (current === 'error' ? 'error' : 'idle'));
        }
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
            : '분석을 취소하고 있습니다. 현재 처리 중인 구간이 끝나면 이어하기 기록을 제거합니다.';
        setStatusMessage(pendingMessage);

        if (!jobId) {
            analysisCancelledRef.current = true;
            analysisAbortControllerRef.current?.abort();
            analysisInFlightRef.current = false;
            setIsAnalyzing(false);
            setAnalysisPhase('idle');
            setProgress(0);
            setErrorMessage('');
            setRawStatusMessage('');
            setAnalysisEtaSeconds(null);
            setIsAnalysisStopConfirmOpen(false);
            setAnalysisStopRequestedAction(null);
            setIsRequestingAnalysisStop(false);
            analysisStopActionRef.current = null;
            setStatusMessage(action === 'cancel' ? '분석을 취소했습니다.' : '분석을 중지했습니다.');
            showOperationToast(action === 'cancel' ? '분석을 취소했습니다.' : '분석을 중지했습니다.', 'warning');
            return;
        }

        let cancelAccepted = false;
        try {
            const apiBase = await getApiBase();
            const response = await fetch(`${apiBase}/api/analyze/${encodeURIComponent(jobId)}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            const payload = await response.json().catch(() => null) as { cancel_requested?: boolean } | null;
            cancelAccepted = response.ok && Boolean(payload?.cancel_requested);
        } catch {
            // Keep cancelAccepted false.
        } finally {
            setIsRequestingAnalysisStop(false);
        }

        if (!cancelAccepted) {
            setAnalysisStopRequestedAction(null);
            analysisStopActionRef.current = null;
            setIsAnalysisStopConfirmOpen(false);
            setStatusMessage('중지할 분석을 찾지 못했습니다.');
            showOperationToast('중지할 분석을 찾지 못했습니다.', 'neutral');
            return;
        }

        if (action === 'stop') {
            saveResumeDraft('stopped', {
                jobId,
                stage: 'stopped',
                lastMessage: rawStatusMessage || statusMessage,
                lastProgress: progress,
            });
        } else {
            if (file) {
                suppressResumeCandidateKey(getResumeDraftKey(toResumeDraftFileKey(file)));
            }
            removeAnalysisResumeDraft(jobId);
            queuePendingAnalysisDraftCleanup(jobId);
        }
        setResumeDrafts(listAnalysisResumeDrafts());
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
        if (matchingActiveDraft) return '진행 중';
        if (selectedResumeDraftUnavailable) return '이어하기 불가';
        if (resumeSelectionActive && !resumeReady) return '같은 파일 선택';
        if (resumeReady) return '이어하기';
        return '분석 시작';
    })();

    const handleOpenCompletedMeeting = () => {
        if (!completionNotice) return;
        window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: completionNotice.meetingId, openHistory: true } }));
        setCompletionNotice(null);
        setStatusMessage('');
    };

    const showProgressBar = isAnalyzing;
    const fileKind = file ? getFileKind(file) : null;
    const hasAudioExtractFile = Boolean(audioExtractFile);
    const audioExtractSaved = audioExtractNotice?.tone === 'success';
    const audioExtractFailed = audioExtractNotice?.tone === 'error';
    const showAnalysisPanel = isAnalyzing;
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
        ? '오디오 추출 중'
        : audioExtractSaved
            ? '오디오 저장 완료'
            : audioExtractFailed
                ? '오디오 추출 실패'
                : '영상 선택됨';
    const audioExtractStatusMessage = isExtractingAudio
        ? `선택한 영상에서 음성만 추출하고 있습니다. 소요 시간 ${audioExtractElapsedLabel}`
        : audioExtractSaved
            ? `${audioExtractMessage} 소요 시간 ${audioExtractElapsedLabel}`
            : audioExtractFailed
                ? audioExtractMessage
                : '다운로드를 누르면 선택한 영상을 WAV 파일로 저장합니다.';
    const selectedFileMeta = file
        ? [
            fileKind === 'video' ? '영상' : fileKind === 'audio' ? '음성' : '파일',
            formatFileSize(file.size),
            fileDurationSeconds ? formatDuration(fileDurationSeconds) : null,
        ].filter(Boolean).join(' · ')
        : '음성/영상 파일을 선택해 주세요.';
    const selectedFileGuidance = file ? getSelectedFileProcessingGuidance(fileDurationSeconds) : null;
    const currentStatusMessage = statusMessage || getFallbackAnalysisMessage(analysisPhase, progressPercent);
    const transcriptEstimateLabel = formatTranscriptReadyEstimate(
        elapsedMs,
        progressPercent,
        rawStatusMessage || currentStatusMessage,
        transcriptReady,
        analysisEtaSeconds,
    );
    const transcriptProgressPercent = getTranscriptReadyProgressPercent(
        progressPercent,
        rawStatusMessage || currentStatusMessage,
        transcriptReady,
    );
    const analysisProgressGuidance = getAnalysisProgressGuidance(fileDurationSeconds, transcriptReady);

    return (
        <div className="flex h-full w-full max-w-[48rem] flex-col gap-5 mx-auto pt-1">
            {operationToast && (
                <div className={`operation-toast status-${operationToast.tone}`} role="status" aria-live="polite">
                    <span className="font-semibold">{operationToast.message}</span>
                    <button
                        type="button"
                        className="operation-toast-close"
                        aria-label="알림 닫기"
                        onClick={() => setOperationToast(null)}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}
            <div>
                <h2 className="text-lg font-semibold text-foreground">{resumeSelectionActive ? '이어하기' : '새 회의록 작성'}</h2>
            </div>

            <div className="app-panel p-4 flex flex-col gap-5 sm:p-6">
                {resumeSelectionActive && (
                    <div className="detail-inline-note flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>이전 분석 기록을 이어서 진행합니다. 같은 음성 파일을 다시 선택한 뒤 이어하기를 시작하세요.</span>
                        <div className="flex shrink-0 gap-2">
                            <Button variant="outline" onClick={handleStartFreshFromResume} disabled={isAnalyzing}>
                                새 분석
                            </Button>
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
                <div className="flex flex-col gap-2">
                    <label className="text-[13px] font-semibold text-foreground" htmlFor="meeting-title">회의 제목 *</label>
                    <Input id="meeting-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="예: 2026년 상반기 기획 회의" disabled={isAnalyzing} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-[13px] font-semibold text-foreground" htmlFor="meeting-date">일시 *</label>
                        <Input id="meeting-date" type="datetime-local" value={date} onChange={e => setDate(e.target.value)} disabled={isAnalyzing} />
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-[13px] font-semibold text-foreground" htmlFor="meeting-purpose">회의 목적/정리 맥락 *</label>
                        <Input id="meeting-purpose" value={meetingPurpose} onChange={e => setMeetingPurpose(e.target.value)} placeholder="예: 월간 사업 현황 점검, 결정사항과 후속 조치 중심" disabled={isAnalyzing} />
                    </div>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <label className="text-[13px] font-semibold text-foreground" htmlFor="meeting-file-input">
                        {resumeSelectionActive ? '같은 음성/영상 파일 선택 *' : '음성/영상 파일 *'}
                    </label>
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept={ACCEPTED_MEETING_MEDIA}
                        onChange={handleFileChange}
                        disabled={isAnalyzing || isExtractingAudio}
                        className="sr-only"
                        id="meeting-file-input"
                    />
                    <input
                        type="file"
                        ref={videoFileInputRef}
                        accept="video/*,.mp4,.mov,.mkv,.avi,.webm"
                        onChange={handleAudioExtractFileChange}
                        disabled={isAnalyzing || isExtractingAudio}
                        className="sr-only"
                        aria-hidden="true"
                        tabIndex={-1}
                    />
                    <div
                        role="button"
                        tabIndex={isAnalyzing || isExtractingAudio ? -1 : 0}
                        aria-controls="meeting-file-input"
                        aria-disabled={isAnalyzing || isExtractingAudio}
                        className={`file-drop-zone ${file ? 'file-drop-zone-selected' : ''}`}
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
                    >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="file-upload-icon">
                                    <UploadCloud size={20} />
                                </div>
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-foreground">
                                        {file ? file.name : '선택된 파일 없음'}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {selectedFileMeta}
                                    </div>
                                </div>
                            </div>
                            <div className="flex shrink-0 gap-2">
                                {file && !isAnalyzing && (
                                    <IconButton
                                        variant="outline"
                                        className="border-border text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                        icon={<X size={16} />}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            clearFile();
                                        }}
                                        onKeyDown={(event) => {
                                            event.stopPropagation();
                                        }}
                                        disabled={isAnalyzing || isExtractingAudio}
                                        aria-label="음성 파일 제거"
                                        title="음성 파일 제거"
                                    />
                                )}
                            </div>
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
                </div>

                {!isAnalyzing && (
                    <div className="flex flex-col gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
                        {!resumeSelectionActive ? (
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                                <Button
                                    variant="outline"
                                    className="detail-action-button"
                                    onClick={handleSelectVideoForAudioExtract}
                                    disabled={isExtractingAudio}
                                    title="오디오를 추출할 영상 파일을 선택합니다."
                                >
                                    <UploadCloud size={15} />
                                    {hasAudioExtractFile ? audioExtractSaved ? '다른 영상' : '영상 변경' : '오디오 추출'}
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
                                            <FileAudio size={15} />
                                        )}
                                        {isExtractingAudio ? '추출 중' : audioExtractSaved ? '완료' : audioExtractFailed ? '다시 다운로드' : '다운로드'}
                                    </Button>
                                ) : null}
                                <span
                                    title="영상 파일을 고른 뒤 다운로드를 누르면 회의록 없이 WAV 파일만 저장합니다."
                                    aria-label="오디오 추출 도움말"
                                    className="inline-flex items-center text-muted-foreground"
                                    tabIndex={0}
                                >
                                    <CircleHelp size={14} />
                                </span>
                            </div>
                        ) : (
                            <div />
                        )}
                        <Button onClick={handleStartAnalysis} disabled={startButtonDisabled}>
                            {buttonLabel}
                        </Button>
                    </div>
                )}
                {audioExtractStatusVisible && (
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

            {(activeResumeDrafts.length > 0 || resumableResumeDrafts.length > 0) && !isAnalyzing && (
                <div className="app-panel resume-drafts-panel p-4 sm:p-5">
                    {activeResumeDrafts.length > 0 && (
                        <div>
                            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                <span>진행 중이던 분석 기록</span>
                                <span
                                    title="다른 창이나 이전 실행에서 아직 끝나지 않은 분석입니다."
                                    className="inline-flex items-center text-muted-foreground"
                                >
                                    <CircleHelp size={14} />
                                </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                실제로 진행 중이면 삭제되지 않고, 오래된 기록은 정리할 수 있습니다.
                            </div>
                            <div className="mt-3 grid gap-2">
                                {activeResumeDrafts.map(draft => {
                                    const isSelected = selectedResumeDraftId === draft.jobId;
                                    const isDeleting = deletingResumeDraftIds.has(draft.jobId);
                                    return (
                                    <div
                                        key={draft.jobId}
                                        className={`resume-draft-card status-info ${isSelected ? 'resume-draft-card-selected' : ''}`}
                                    >
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <button
                                                type="button"
                                                className="min-w-0 flex-1 text-left"
                                                onClick={() => handleResumeDraftPrepare(draft)}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <div className="truncate text-sm font-semibold text-foreground">{draft.title || '진행 중인 분석'}</div>
                                                    {isSelected && <span className="status-pill status-info">선택됨</span>}
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    <span className="status-pill status-info">{getResumeDraftStatusLabel(draft.status)}</span>
                                                    <span className="ml-2">{draft.sourceFilename}</span>
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {formatResumeUpdatedAt(draft.updatedAt)}{draft.lastMessage ? ` · ${translateStatusMessage(draft.lastMessage)}` : ''}
                                                </div>
                                            </button>
                                            <IconButton
                                                variant="outline"
                                                icon={isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                                onClick={() => handleDeleteResumeDraft(draft)}
                                                disabled={isDeleting}
                                                aria-label={`${draft.title || draft.sourceFilename} 분석 기록 삭제`}
                                                title="분석 기록 삭제"
                                            />
                                        </div>
                                    </div>
                                );
                                })}
                            </div>
                        </div>
                    )}
                    {resumableResumeDrafts.length > 0 && (
                        <div className={activeResumeDrafts.length > 0 ? 'mt-5 border-t border-border pt-5' : ''}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                    <span>이전 분석 기록</span>
                                    <span
                                        title="같은 파일을 선택하면 이전 진행분 재사용을 시도합니다."
                                        className="inline-flex items-center text-muted-foreground"
                                    >
                                        <CircleHelp size={14} />
                                    </span>
                                </div>
                            </div>
                            <div className="mt-3 grid gap-2">
                                {resumableResumeDrafts.map(draft => {
                                    const isSelected = selectedResumeDraftId === draft.jobId;
                                    const toneClass = getResumeDraftTone(draft.status);
                                    const draftCanResume = canResumeDraft(draft);
                                    const unavailableReason = getResumeUnavailableReasonLabel(draft);
                                    const showUnavailableBadge = !draftCanResume && draft.status !== 'completed';
                                    const isDeleting = deletingResumeDraftIds.has(draft.jobId);
                                    const detailTextClass = draft.status === 'completed'
                                        ? 'text-muted-foreground'
                                        : 'text-destructive';
                                    return (
                                        <div
                                            key={draft.jobId}
                                            className={`resume-draft-card status-${toneClass} ${isSelected ? 'resume-draft-card-selected' : ''}`}
                                        >
                                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                <button
                                                    type="button"
                                                    className="min-w-0 flex-1 text-left"
                                                    onClick={() => handleResumeDraftPrepare(draft)}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <div className="truncate text-sm font-semibold text-foreground">{draft.title || '이전 분석'}</div>
                                                        {isSelected && (
                                                            <span className="status-pill status-info">{resumeReady ? '이어하기 준비' : '같은 파일 필요'}</span>
                                                        )}
                                                        {showUnavailableBadge && (
                                                            <span className={`status-pill status-${toneClass}`}>이어하기 불가</span>
                                                        )}
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        <span className={`status-pill status-${toneClass}`}>{getResumeDraftStatusLabel(draft.status)}</span>
                                                        <span className="ml-2">{draft.sourceFilename}</span>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {formatResumeUpdatedAt(draft.updatedAt)}{draft.lastMessage ? ` · ${translateStatusMessage(draft.lastMessage)}` : ''}
                                                    </div>
                                                    {draft.errorMessage && (
                                                        <div className={`mt-1 text-xs ${detailTextClass}`}>{draft.errorMessage}</div>
                                                    )}
                                                    {!draft.errorMessage && unavailableReason && (
                                                        <div className="mt-1 text-xs text-muted-foreground">{unavailableReason}</div>
                                                    )}
                                                </button>
                                                <div className="flex shrink-0 gap-2">
                                                    {draftCanResume && (
                                                        <IconButton
                                                            variant={isSelected ? 'secondary' : 'outline'}
                                                            icon={<Play size={16} />}
                                                            onClick={() => handleResumeDraftPrepare(draft)}
                                                            disabled={isDeleting}
                                                            aria-label={isSelected ? '이어하기 선택됨' : '이어하기'}
                                                            title={isSelected ? '이어하기 선택됨' : '이어하기'}
                                                        />
                                                    )}
                                                    <IconButton
                                                        variant="outline"
                                                        icon={isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                                        onClick={() => handleDeleteResumeDraft(draft)}
                                                        disabled={isDeleting}
                                                        aria-label={`${draft.title || draft.sourceFilename} 분석 기록 삭제`}
                                                        title="분석 기록 삭제"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {hasBlockingReadinessIssue && (
                <StatusBanner tone={readinessBannerTone}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-2">
                            <AlertCircle size={18} />
                            <div>
                                <div className="font-semibold">{readinessBannerTitle}</div>
                                <div className="mt-1">{readinessMessage}</div>
                            </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                            <Button variant="outline" className="status-action-button" onClick={() => void handleRefreshReadiness()} disabled={isAnalyzing}>
                                <RefreshCw size={15} />
                                새로고침
                            </Button>
                            {onOpenSettings && (
                                <Button variant="outline" className="status-action-button" onClick={onOpenSettings} disabled={isAnalyzing}>
                                    <Settings size={15} />
                                    설정
                                </Button>
                            )}
                        </div>
                    </div>

                    {missingRequiredModels.length > 0 && (
                        <div className="mt-3 space-y-2">
                            {missingRequiredModels.map(model => (
                                <div key={model.key} className="status-detail-card">
                                    <div className="font-semibold">{getUserModelLabel(model)} 준비 필요</div>
                                    <div className="mt-1 text-muted-foreground">모델 탭에서 받거나, 준비된 파일을 models 폴더에 넣은 뒤 상태를 새로고침하세요.</div>
                                    {onOpenSettings && (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={onOpenSettings}
                                                className="status-action-button h-7 px-2"
                                            >
                                                모델 준비
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </StatusBanner>
            )}

            {errorMessage && (
                <StatusBanner tone="error">
                    {errorMessage}
                </StatusBanner>
            )}

            {statusMessage && !showAnalysisPanel && !completionNotice && !operationToast && (
                <StatusBanner tone="neutral">
                    {statusMessage}
                </StatusBanner>
            )}

            {completionNotice && (
                <StatusBanner
                    tone="success"
                    heading="분석이 완료되었습니다"
                    action={(
                        <Button onClick={handleOpenCompletedMeeting}>
                            결과 보기
                        </Button>
                    )}
                >
                    <div>소요 시간 {formatAnalysisDuration(completionNotice.elapsedMs)}. 결과 보기를 눌러 회의록을 확인하세요.</div>
                    {completionNotice.note && (
                        <div className="mt-2 text-sm text-muted-foreground">{completionNotice.note}</div>
                    )}
                    {completionNotice.autoSaveNote && (
                        <div className="mt-2 text-sm text-muted-foreground">{completionNotice.autoSaveNote}</div>
                    )}
                </StatusBanner>
            )}

            {showAnalysisPanel && (
                <div className="app-panel border-primary/20 bg-primary/5 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 flex-1 gap-3">
                            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                                {progressPercent >= 100 ? <CheckCircle2 size={18} /> : <Loader2 size={18} className="animate-spin" />}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-foreground">
                                    {currentStatusMessage}
                                </div>
                                {analysisStalled && (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        현재 단계가 계속 진행 중입니다.
                                    </div>
                                )}
                                <ProgressBar
                                    value={transcriptProgressPercent}
                                    size="sm"
                                    tone={errorMessage ? 'error' : 'primary'}
                                    className="mt-3"
                                    label="대화록 생성률"
                                />
                            </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-3 text-left sm:text-right">
                            <div className="flex flex-wrap gap-5 sm:justify-end">
                                <div>
                                    <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                        <span>경과 시간</span>
                                        <span title="분석을 시작한 뒤 지난 시간입니다." className="inline-flex items-center">
                                            <CircleHelp size={13} />
                                        </span>
                                    </div>
                                    <div className="mt-1 text-sm font-semibold text-primary">{elapsedLabel}</div>
                                </div>
                                <div>
                                    <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                        <span>대화록 예상</span>
                                        <span title="대화록이 저장될 때까지의 추정 시간입니다. 참석자 구분과 기록 정리는 포함하지 않습니다." className="inline-flex items-center">
                                            <CircleHelp size={13} />
                                        </span>
                                    </div>
                                    <div className="mt-1 text-sm font-semibold text-foreground">{transcriptEstimateLabel}</div>
                                </div>
                            </div>
                            {!isAnalysisStopConfirmOpen && !analysisStopRequestedAction && (
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
                                <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground sm:self-end">
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
                                    중지하면 같은 파일로 이어서 진행할 수 있고, 취소하면 이어하기 기록을 남기지 않습니다.
                                </div>
                            </div>
                            <div className="analysis-stop-actions">
                                <Button
                                    variant="outline"
                                    className="h-8 px-3 text-xs"
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
                                    className="h-8 px-3 text-xs"
                                    onClick={() => handleStopAnalysis('cancel')}
                                    disabled={isRequestingAnalysisStop}
                                    aria-label="이어하기 기록을 남기지 않고 분석 취소"
                                    title="이어하기 기록을 남기지 않음"
                                >
                                    {isRequestingAnalysisStop && analysisStopRequestedAction === 'cancel' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                    취소
                                </Button>
                                <Button
                                    variant="secondary"
                                    className="h-8 px-3 text-xs"
                                    onClick={() => setIsAnalysisStopConfirmOpen(false)}
                                    disabled={isRequestingAnalysisStop}
                                >
                                    계속
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {showProgressBar && !showAnalysisPanel && (
                <ProgressBar value={transcriptProgressPercent} tone={errorMessage ? 'error' : 'primary'} label="대화록 생성률" />
            )}
        </div>
    );
};
