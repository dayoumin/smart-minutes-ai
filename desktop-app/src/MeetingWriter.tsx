import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleHelp, Loader2, Play, RefreshCw, Settings, UploadCloud, X } from 'lucide-react';
import {
    ANALYSIS_RESUME_DRAFTS_UPDATED_EVENT,
    AnalysisResumeDraft,
    AnalysisResumeDraftFileKey,
    AnalysisResumeDraftStatus,
    AnalysisResumeDraftUnavailableReason,
    dismissAnalysisResumeDraft,
    getAnalysisResumeDraft,
    getResumeDraftKey,
    listAnalysisResumeDrafts,
    listSuppressedResumeCandidateKeys,
    markAnalysisResumeDraftUnavailable,
    markAnalysisResumeDraftsForKeyUnavailable,
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
import { getApiBase, writeFrontendLog } from './apiBase';
import { ProgressBar } from './ProgressBar';
import { StatusBanner } from './StatusBanner';
import { formatAnalysisDuration, formatTranscriptReadyEstimate, getTranscriptReadyProgressPercent } from './analysisTimeEstimate';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const BACKEND_READY_TIMEOUT_MS = 45_000;
const BACKEND_READY_INTERVAL_MS = 1_000;
const ANALYSIS_STALL_WARNING_MS = 120_000;
const getNowMs = (): number => Date.now();

interface AnalyzeResult {
    status?: string;
    heartbeat?: boolean;
    progress?: number;
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

type ReadinessState = 'checking' | 'server-waiting' | 'ready' | 'missing-models' | 'error';
type AnalysisPhase = 'idle' | 'checking-server' | 'checking-models' | 'analyzing' | 'error';

interface CompletionNotice {
    meetingId: string;
    elapsedMs: number;
    note?: string;
    autoSaveNote?: string;
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

const getFileKind = (selectedFile: File): 'audio' | 'video' | 'unknown' => {
    if (selectedFile.type.startsWith('audio/')) return 'audio';
    if (selectedFile.type.startsWith('video/')) return 'video';
    return 'unknown';
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
    const failedKinds = [
        result.auto_save_errors?.hwpx ? `HWPX(${result.auto_save_errors.hwpx})` : '',
        result.auto_save_errors?.audio ? `음성 파일(${result.auto_save_errors.audio})` : '',
    ].filter(Boolean);

    const notes: string[] = [];
    if (failedKinds.length) {
        notes.push(`${failedKinds.join(', ')} 자동 저장은 실패했습니다.`);
    }
    return notes.length ? notes.join(' ') : undefined;
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
    const [statusMessage, setStatusMessage] = useState('');
    const [rawStatusMessage, setRawStatusMessage] = useState('');
    const [transcriptReady, setTranscriptReady] = useState(false);
    const transcriptReadyRef = useRef(false);
    const [lastRealProgressAt, setLastRealProgressAt] = useState(() => Date.now());
    const [errorMessage, setErrorMessage] = useState('');
    const [fileDurationSeconds, setFileDurationSeconds] = useState<number | null>(null);
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null);
    const [resumeDrafts, setResumeDrafts] = useState<AnalysisResumeDraft[]>([]);
    const [selectedResumeDraftId, setSelectedResumeDraftId] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const analysisInFlightRef = useRef(false);
    const analysisAbortControllerRef = useRef<AbortController | null>(null);
    const analysisCancelledRef = useRef(false);
    const analysisJobIdRef = useRef<string | null>(null);
    const analysisResumeDraftIdRef = useRef<string | null>(null);
    const analysisStalled = isAnalyzing && analysisPhase === 'analyzing' && analysisNow - lastRealProgressAt >= ANALYSIS_STALL_WARNING_MS;
    const hasDraftableInput = useMemo(() => (
        Boolean(title.trim())
        || Boolean(meetingPurpose.trim())
        || Boolean(file)
        || Boolean(selectedResumeDraftId)
        || date !== initialDateValue
    ), [date, file, initialDateValue, meetingPurpose, selectedResumeDraftId, title]);
    const hasWriterCloseRisk = isAnalyzing || hasDraftableInput;

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
            },
        }));
    }, [analysisStartedAt, analysisStalled, isAnalyzing, progress, rawStatusMessage, statusMessage, transcriptReady]);

    useEffect(() => {
        if (!isAnalyzing) return;
        setAnalysisNow(Date.now());
        const timer = window.setInterval(() => setAnalysisNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isAnalyzing]);

    useEffect(() => {
        const syncDrafts = async () => {
            const localDrafts = listAnalysisResumeDrafts();
            setResumeDrafts(localDrafts);

            if (ANALYSIS_MODE !== 'real') return;
            if (localDrafts.length === 0) return;

            try {
                const apiBase = await getApiBase();
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
                    if (draft.status === 'completed' || draft.status === 'unavailable') {
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

                    const nextStatus: AnalysisResumeDraftStatus = remote.status === 'cancelled'
                        ? 'cancelled'
                        : remote.status === 'active'
                            ? 'active'
                            : remote.status === 'stopped'
                                ? 'stopped'
                                : 'failed';
                    const resumeEligible = Boolean(remote.resume_supported) && Number(remote.completed_chunk_count || 0) > 0;
                    const nextDraft: AnalysisResumeDraft = {
                        ...draft,
                        status: nextStatus,
                        updatedAt: remote.updated_at || now,
                        stage: remote.stage || draft.stage,
                        lastMessage: remote.last_progress?.message || draft.lastMessage,
                        lastProgress: typeof remote.last_progress?.progress === 'number'
                            ? remote.last_progress.progress
                            : draft.lastProgress,
                        transcriptReady: Boolean(remote.last_progress?.transcript_ready || remote.last_progress?.transcriptReady || draft.transcriptReady),
                        errorMessage: remote.last_error || draft.errorMessage,
                        resumeEligible,
                        completedChunkCount: Number(remote.completed_chunk_count || 0),
                    };
                    const currentDraft = getAnalysisResumeDraft(draft.jobId);
                    if (!currentDraft) {
                        continue;
                    }
                    if (currentDraft.status === 'completed' || currentDraft.status === 'unavailable') {
                        continue;
                    }
                    if (
                        nextDraft.status !== draft.status
                        || nextDraft.updatedAt !== draft.updatedAt
                        || nextDraft.stage !== draft.stage
                        || nextDraft.lastMessage !== draft.lastMessage
                        || nextDraft.lastProgress !== draft.lastProgress
                        || nextDraft.transcriptReady !== draft.transcriptReady
                        || nextDraft.errorMessage !== draft.errorMessage
                        || nextDraft.resumeEligible !== draft.resumeEligible
                        || nextDraft.completedChunkCount !== draft.completedChunkCount
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
            if (!hasDraftableInput) return true;
            return window.confirm('작성 중인 내용이 있습니다. 다른 기록으로 이동할까요?');
        });
        return () => {
            onRegisterLeaveGuard(null);
        };
    }, [hasDraftableInput, isAnalyzing, onRegisterLeaveGuard]);

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
        || Boolean(matchingActiveDraft)
        || selectedResumeDraftUnavailable
        || resumeDraftFileMismatch
        || missingFields.length > 0;

    const hasBlockingReadinessIssue = readinessState === 'missing-models' || readinessState === 'error';

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
            const message = payload.errors?.[0] || `필수 모델이 없습니다: ${missing || '모델 파일'}`;
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

        const message = '분석 기능이 아직 준비되지 않았습니다. 앱을 종료한 뒤 다시 실행해 주세요.';
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
            setErrorMessage(
                `필수 모델이 없습니다${missingList ? `: ${missingList}` : ''}. 필요한 파일을 models 폴더에 넣은 뒤 설정에서 상태를 새로고침해 주세요.`,
            );
            setAnalysisPhase('error');
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
        if (draft.status === 'active') {
            setErrorMessage('진행 중인 분석 기록은 중단된 뒤 삭제할 수 있습니다.');
            return;
        }
        if (typeof window.confirm === 'function' && !window.confirm('이전 분석 진행 기록을 삭제할까요? 저장된 회의 기록은 삭제하지 않습니다.')) {
            return;
        }
        let deleted = false;
        try {
            if (ANALYSIS_MODE === 'real') {
                const apiBase = await getApiBase();
                const response = await fetch(`${apiBase}/api/analyze/drafts/${encodeURIComponent(draft.jobId)}`, {
                    method: 'DELETE',
                });
                if (!response.ok && response.status !== 404) {
                    const detail = await response.json().catch(() => null) as { detail?: string } | null;
                    if (response.status === 409 && detail?.detail === 'analysis_job_active') {
                        throw new Error('아직 진행 중인 분석입니다. 중단된 뒤 다시 삭제해 주세요.');
                    }
                    throw new Error('분석 임시 파일을 정리하지 못했습니다.');
                }
            }
            dismissAnalysisResumeDraft(draft);
            deleted = true;
            setErrorMessage('');
            setStatusMessage('이전 분석 기록을 삭제했습니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '분석 기록을 삭제하지 못했습니다.');
        }
        if (deleted && selectedResumeDraftId === draft.jobId) {
            clearResumeDraftSelection();
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0] ?? null;
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        setFileDurationSeconds(null);
        setCompletionNotice(null);
        setFile(selectedFile);

        if (!selectedFile || getFileKind(selectedFile) === 'unknown') return;

        const media = document.createElement(selectedFile.type.startsWith('video/') ? 'video' : 'audio');
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
        setLastRealProgressAt(getNowMs());
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');
        setCompletionNotice(null);

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
                const orderedCandidates = [...(resumePayload?.candidates || [])].sort((a, b) => {
                    if (a.job_id === resumePayload?.recommended_job_id) return -1;
                    if (b.job_id === resumePayload?.recommended_job_id) return 1;
                    return 0;
                }).filter(candidate => !suppressedResumeKeys.has(currentFileResumeKey) || candidate.job_id === selectedResumeDraft.jobId);
                const activeCandidate = orderedCandidates.find(candidate => candidate.active) || null;
                if (activeCandidate) {
                    setAnalysisPhase('error');
                    setErrorMessage('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
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
                const orderedCandidates = [...(resumePayload.candidates || [])].sort((a, b) => {
                    if (a.job_id === resumePayload.recommended_job_id) return -1;
                    if (b.job_id === resumePayload.recommended_job_id) return 1;
                    return 0;
                }).filter(() => !suppressedResumeKeys.has(currentFileResumeKey));
                const activeCandidate = orderedCandidates.find(candidate => candidate.active) || null;
                if (activeCandidate) {
                    setAnalysisPhase('error');
                    setErrorMessage('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.');
                    setStatusMessage('');
                    setProgress(0);
                    return;
                }
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
                    const nextTranscriptReady = transcriptReadyRef.current
                        || Boolean(parsed.transcript_ready || parsed.transcriptReady || parsed.status === 'completed');
                    if (nextTranscriptReady) {
                        transcriptReadyRef.current = true;
                        setTranscriptReady(true);
                    }
                    if (parsed.message) {
                        setRawStatusMessage(parsed.message);
                        setStatusMessage(translateStatusMessage(parsed.message));
                        saveResumeDraft('active', {
                            jobId: analysisJobId,
                            stage: parsed.status || 'processing',
                            lastMessage: parsed.message,
                            lastProgress: typeof parsed.progress === 'number' ? parsed.progress : progress,
                            transcriptReady: nextTranscriptReady,
                        });
                    }
                    if (!parsed.heartbeat) {
                        setLastRealProgressAt(getNowMs());
                    }
                    if (parsed.status === 'error') {
                        throw new Error(parsed.message || '분석 중 오류가 발생했습니다.');
                    }
                    if (parsed.status === 'cancelled') {
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
                setProgress(0);
                setRawStatusMessage('');
                setStatusMessage('분석을 중단했습니다.');
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
            setStatusMessage('');
            setProgress(0);
        } finally {
            analysisInFlightRef.current = false;
            analysisAbortControllerRef.current = null;
            analysisJobIdRef.current = null;
            analysisResumeDraftIdRef.current = null;
            setIsAnalyzing(false);
            setAnalysisStartedAt(null);
            setAnalysisPhase(current => (current === 'error' ? 'error' : 'idle'));
        }
    };

    const handleCancelAnalysis = async () => {
        if (!isAnalyzing) return;
        if (!window.confirm('진행 중인 분석을 취소할까요?')) return;

        const jobId = analysisJobIdRef.current;
        let cancelAccepted = false;
        if (jobId) {
            try {
                const apiBase = await getApiBase();
                const response = await fetch(`${apiBase}/api/analyze/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
                const payload = await response.json().catch(() => null) as { cancel_requested?: boolean } | null;
                cancelAccepted = response.ok && Boolean(payload?.cancel_requested);
            } catch {
                cancelAccepted = false;
            }
        }

        if (jobId && !cancelAccepted) {
            setStatusMessage('취소할 분석을 찾지 못했습니다.');
            return;
        }

        saveResumeDraft('cancelled', {
            jobId,
            stage: 'cancelled',
            lastMessage: rawStatusMessage || statusMessage,
            lastProgress: progress,
        });
        analysisCancelledRef.current = true;
        analysisAbortControllerRef.current?.abort();
        analysisInFlightRef.current = false;
        setIsAnalyzing(false);
        setAnalysisPhase('idle');
        setProgress(0);
        setErrorMessage('');
        setRawStatusMessage('');
        setStatusMessage('분석을 중단했습니다.');
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
    const showAnalysisPanel = isAnalyzing;
    const progressPercent = Math.min(100, Math.max(0, progress));
    const elapsedMs = analysisStartedAt ? analysisNow - analysisStartedAt : 0;
    const elapsedLabel = formatAnalysisDuration(elapsedMs);
    const selectedFileMeta = file
        ? [
            fileKind === 'video' ? '영상' : fileKind === 'audio' ? '음성' : '파일',
            formatFileSize(file.size),
            fileDurationSeconds ? formatDuration(fileDurationSeconds) : null,
        ].filter(Boolean).join(' · ')
        : '음성 파일을 선택해 주세요.';
    const currentStatusMessage = statusMessage || getFallbackAnalysisMessage(analysisPhase, progressPercent);
    const transcriptEstimateLabel = formatTranscriptReadyEstimate(
        elapsedMs,
        progressPercent,
        rawStatusMessage || currentStatusMessage,
        transcriptReady,
    );
    const transcriptProgressPercent = getTranscriptReadyProgressPercent(
        progressPercent,
        rawStatusMessage || currentStatusMessage,
        transcriptReady,
    );

    return (
        <div className="flex h-full w-full max-w-[48rem] flex-col gap-5 mx-auto pt-1">
            <div>
                <h2 className="text-lg font-semibold text-foreground">{resumeSelectionActive ? '이어하기' : '새 회의록 작성'}</h2>
            </div>

            {(activeResumeDrafts.length > 0 || resumableResumeDrafts.length > 0) && !isAnalyzing && (
                <div className="app-panel p-4 sm:p-5">
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
                                완료되거나 중단될 때까지 목록에 유지됩니다.
                            </div>
                            <div className="mt-3 grid gap-2">
                                {activeResumeDrafts.map(draft => {
                                    const isSelected = selectedResumeDraftId === draft.jobId;
                                    return (
                                    <button
                                        key={draft.jobId}
                                        type="button"
                                        className={`resume-draft-card w-full text-left status-info ${isSelected ? 'resume-draft-card-selected' : ''}`}
                                        onClick={() => handleResumeDraftPrepare(draft)}
                                    >
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="min-w-0">
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
                                            </div>
                                        </div>
                                    </button>
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
                                                            aria-label={isSelected ? '이어하기 선택됨' : '이어하기'}
                                                            title={isSelected ? '이어하기 선택됨' : '이어하기'}
                                                        />
                                                    )}
                                                    <IconButton
                                                        variant="outline"
                                                        icon={<X size={16} />}
                                                        onClick={() => handleDeleteResumeDraft(draft)}
                                                        aria-label="분석 기록 삭제"
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

            <div className="app-panel p-4 flex flex-col gap-5 sm:p-6">
                {resumeSelectionActive && (
                    <div className="detail-inline-note flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>이전 분석 기록을 이어서 진행합니다. 같은 음성 파일을 다시 선택한 뒤 이어하기를 시작하세요.</span>
                        <Button variant="outline" onClick={clearResumeSelectionOnly} disabled={isAnalyzing}>
                            새 분석
                        </Button>
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
                        {resumeSelectionActive ? '같은 음성 파일 선택 *' : '음성 파일 *'}
                    </label>
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.mp4,.mov,.mkv,.avi,.webm"
                        onChange={handleFileChange}
                        disabled={isAnalyzing}
                        className="sr-only"
                        id="meeting-file-input"
                    />
                    <div
                        role="button"
                        tabIndex={isAnalyzing ? -1 : 0}
                        aria-controls="meeting-file-input"
                        aria-disabled={isAnalyzing}
                        className={`file-drop-zone ${file ? 'file-drop-zone-selected' : ''}`}
                        onClick={() => {
                            if (!isAnalyzing) fileInputRef.current?.click();
                        }}
                        onKeyDown={(event) => {
                            if (isAnalyzing) return;
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
                                        disabled={isAnalyzing}
                                        aria-label="음성 파일 제거"
                                        title="음성 파일 제거"
                                    />
                                )}
                            </div>
                        </div>
                    </div>
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
                    <div className="flex justify-end border-t border-border/70 pt-5">
                        <Button onClick={handleStartAnalysis} disabled={startButtonDisabled}>
                            {buttonLabel}
                        </Button>
                    </div>
                )}
            </div>

            {hasBlockingReadinessIssue && (
                <StatusBanner tone="error">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-2">
                            <AlertCircle size={18} />
                            <div>
                                <div className="font-semibold">분석을 시작할 수 없습니다</div>
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
                                    <div className="font-semibold">{getUserModelLabel(model)} 필요</div>
                                    <div className="mt-1 text-muted-foreground">필요한 파일을 models 폴더에 넣은 뒤 상태를 새로고침하세요.</div>
                                    {onOpenSettings && (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={onOpenSettings}
                                                className="status-action-button h-7 px-2"
                                            >
                                                설정 열기
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

            {statusMessage && !showAnalysisPanel && !completionNotice && (
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
                        <div className="flex shrink-0 items-start gap-3">
                            <div className="text-right">
                                <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                    <span>경과 시간</span>
                                    <span title="분석을 시작한 뒤 지난 시간입니다." className="inline-flex items-center">
                                        <CircleHelp size={13} />
                                    </span>
                                </div>
                                <div className="mt-1 text-sm font-semibold text-primary">{elapsedLabel}</div>
                            </div>
                            <div className="text-right">
                                <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                    <span>예상 시간</span>
                                    <span title="대화록이 저장될 때까지의 추정 시간입니다. 참석자 구분과 정리, 요약은 포함하지 않습니다." className="inline-flex items-center">
                                        <CircleHelp size={13} />
                                    </span>
                                </div>
                                <div className="mt-1 text-sm font-semibold text-foreground">{transcriptEstimateLabel}</div>
                            </div>
                            <IconButton
                                variant="outline"
                                className="h-9 w-9 border-border text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                icon={<X size={16} />}
                                onClick={handleCancelAnalysis}
                                aria-label="분석 취소"
                                title="분석 취소"
                            />
                        </div>
                    </div>
                </div>
            )}

            {showProgressBar && !showAnalysisPanel && (
                <ProgressBar value={transcriptProgressPercent} tone={errorMessage ? 'error' : 'primary'} label="대화록 생성률" />
            )}
        </div>
    );
};
