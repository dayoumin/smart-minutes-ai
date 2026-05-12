import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Settings, UploadCloud, X } from 'lucide-react';
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

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const BACKEND_READY_TIMEOUT_MS = 45_000;
const BACKEND_READY_INTERVAL_MS = 1_000;
const ANALYSIS_STALL_WARNING_MS = 120_000;

const formatElapsedDuration = (milliseconds: number): string => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}시간 ${remainingMinutes}분`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const getChunkProgress = (message: string): { current: number; total: number } | null => {
    const match = message.trim().match(/^Transcribing chunk (\d+)\/(\d+)/);
    if (!match) return null;
    return {
        current: Number(match[1]),
        total: Number(match[2]),
    };
};

const formatEstimatedRemaining = (elapsedMs: number, message: string, stalled: boolean): string => {
    if (stalled) return '확인 필요';
    const chunk = getChunkProgress(message);
    if (!chunk || chunk.current <= 0 || chunk.total <= chunk.current) return '측정 중';
    const estimatedTotalMs = (elapsedMs / chunk.current) * chunk.total;
    return `약 ${formatElapsedDuration(estimatedTotalMs - elapsedMs)}`;
};

interface AnalyzeResult {
    status?: string;
    heartbeat?: boolean;
    progress?: number;
    summary?: string;
    segments?: MeetingSegment[];
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
    meeting?: {
        source_file?: string;
        job_id?: string;
    };
    outputs?: {
        job_id?: string;
        json?: string | null;
        txt?: string | null;
        md?: string | null;
        docx?: string | null;
        hwpx?: string | null;
    };
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

interface ReadinessCheck {
    state: ReadinessState;
    message: string;
    models?: ModelsPayload;
}

interface ReadinessOptions {
    soft?: boolean;
}

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
    if (model.key === 'diarization') return '화자 구분';
    return model.label;
};

const translateStatusMessage = (message: string): string => {
    const normalized = message.trim();
    const chunkMatch = normalized.match(/^Transcribing chunk (\d+)\/(\d+)/);
    if (chunkMatch) {
        return `음성 인식 중입니다. 현재 ${chunkMatch[1]}/${chunkMatch[2]} 구간을 처리하고 있습니다.`;
    }

    const statusMap: Record<string, string> = {
        '업로드 파일 저장 완료': '파일을 안전하게 저장했습니다.',
        '음성 인식 모델 확인 중': '음성 인식 모델을 확인하고 있습니다.',
        '음성 인식 모델 준비 완료': '음성 인식 모델 준비가 끝났습니다.',
        'Converting to WAV...': '영상에서 음성을 추출하고 WAV로 변환하고 있습니다.',
        'Preparing audio chunks...': '긴 음성을 분석하기 좋은 구간으로 나누고 있습니다.',
        'Primary speech recognition failed; using fallback model...': '음성 인식 방식을 바꾸어 다시 시도하고 있습니다.',
        'Speaker Diarization & Alignment...': '말한 사람과 시간을 구분하고 문장을 맞추고 있습니다.',
        'Summarizing with Local LLM...': '회의 내용을 요약하고 주요 주제를 정리하고 있습니다.',
        'Saving results...': '회의록과 다운로드 파일을 저장하고 있습니다.',
    };

    return statusMap[normalized] || normalized;
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

interface MeetingWriterProps {
    onOpenSettings?: () => void;
}

export const MeetingWriter: React.FC<MeetingWriterProps> = ({ onOpenSettings }) => {
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
    const [participants, setParticipants] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
    const [analysisNow, setAnalysisNow] = useState(() => Date.now());
    const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
    const [statusMessage, setStatusMessage] = useState('');
    const [rawStatusMessage, setRawStatusMessage] = useState('');
    const [lastRealProgressAt, setLastRealProgressAt] = useState(() => Date.now());
    const [errorMessage, setErrorMessage] = useState('');
    const [fileDurationSeconds, setFileDurationSeconds] = useState<number | null>(null);
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const analysisInFlightRef = useRef(false);
    const analysisAbortControllerRef = useRef<AbortController | null>(null);
    const analysisCancelledRef = useRef(false);
    const analysisJobIdRef = useRef<string | null>(null);
    const analysisStalled = isAnalyzing && analysisPhase === 'analyzing' && analysisNow - lastRealProgressAt >= ANALYSIS_STALL_WARNING_MS;

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
            },
        }));
    }, [analysisStartedAt, analysisStalled, isAnalyzing, progress, rawStatusMessage, statusMessage]);

    useEffect(() => {
        if (!isAnalyzing) return;
        setAnalysisNow(Date.now());
        const timer = window.setInterval(() => setAnalysisNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isAnalyzing]);

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
        if (!participants.trim()) fields.push('참석자');
        if (!file) fields.push('음성 파일');
        return fields;
    }, [date, file, participants, title]);

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
        const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
        setAnalysisPhase('checking-server');

        while (Date.now() < deadline && !analysisCancelledRef.current) {
            const check = await refreshReadiness();
            if (check.state === 'ready') return check;
            if (check.state === 'missing-models' || check.state === 'error') return check;

            const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
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

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0] ?? null;
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        setFileDurationSeconds(null);
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
            setErrorMessage(`필수 항목을 확인해 주세요: ${missingFields.join(', ')}`);
            return;
        }

        analysisInFlightRef.current = true;
        analysisCancelledRef.current = false;
        analysisAbortControllerRef.current = new AbortController();
        const analysisJobId = crypto.randomUUID();
        analysisJobIdRef.current = analysisJobId;
        setAnalysisStartedAt(Date.now());
        setIsAnalyzing(true);
        setAnalysisPhase('checking-server');
        setProgress(0);
        setRawStatusMessage('');
        setLastRealProgressAt(Date.now());
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');

        try {
            const modelsReady = await ensureModelsReady();
            if (!modelsReady) return;
            if (analysisCancelledRef.current) return;
            setAnalysisPhase('analyzing');
            setLastRealProgressAt(Date.now());
            setStatusMessage('분석을 시작합니다. 음성 추출과 전사를 진행합니다.');

            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('date', date);
            formData.append('participants', participants.trim());
            formData.append('mode', ANALYSIS_MODE);
            formData.append('job_id', analysisJobId);
            formData.append('file', file as File);

            const apiBase = await getApiBase();
            const response = await fetch(`${apiBase}/api/analyze`, {
                method: 'POST',
                body: formData,
                headers: { Accept: 'text/event-stream' },
                signal: analysisAbortControllerRef.current.signal,
            });

            if (!response.ok) {
                throw new Error(`서버 응답 오류: ${response.status}`);
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
                    if (parsed.message) {
                        setRawStatusMessage(parsed.message);
                        setStatusMessage(translateStatusMessage(parsed.message));
                    }
                    if (!parsed.heartbeat) {
                        setLastRealProgressAt(Date.now());
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
                participants: participants.trim(),
                summary: finalData.summary || '요약 결과가 없습니다.',
                segments: finalData.segments || [],
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
                outputFiles: finalData.outputs,
            };

            await addMeeting(newRecord);
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: newRecord.id, openHistory: true } }));
            setProgress(100);
            setRawStatusMessage('');
            setStatusMessage('회의록 저장이 완료되었습니다.');
            setTitle('');
            setParticipants('');
            setFile(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (error) {
            if (analysisCancelledRef.current || (error instanceof DOMException && error.name === 'AbortError')) {
                setProgress(0);
                setRawStatusMessage('');
                setStatusMessage('분석 요청을 중단했습니다. 백그라운드 정리는 잠시 걸릴 수 있습니다.');
                setErrorMessage('');
                return;
            }
            const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
            setAnalysisPhase('error');
            setErrorMessage(message);
            setRawStatusMessage('');
            setStatusMessage('');
            setProgress(0);
        } finally {
            analysisInFlightRef.current = false;
            analysisAbortControllerRef.current = null;
            analysisJobIdRef.current = null;
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
            setStatusMessage('취소할 분석 작업을 찾지 못했습니다. 이미 완료되었거나 정리 중일 수 있습니다.');
            return;
        }

        analysisCancelledRef.current = true;
        analysisAbortControllerRef.current?.abort();
        analysisInFlightRef.current = false;
        setIsAnalyzing(false);
        setAnalysisPhase('idle');
        setProgress(0);
        setErrorMessage('');
        setRawStatusMessage('');
        setStatusMessage('분석 요청을 중단했습니다. 백그라운드 정리는 잠시 걸릴 수 있습니다.');
    };

    const buttonLabel = (() => {
        return 'AI 분석 시작';
    })();

    const showProgressBar = isAnalyzing;
    const fileKind = file ? getFileKind(file) : null;
    const showAnalysisPanel = isAnalyzing;
    const progressPercent = Math.min(100, Math.max(0, progress));
    const elapsedMs = analysisStartedAt ? analysisNow - analysisStartedAt : 0;
    const elapsedLabel = formatElapsedDuration(elapsedMs);
    const remainingLabel = formatEstimatedRemaining(elapsedMs, rawStatusMessage, analysisStalled);
    const selectedFileMeta = file
        ? [
            fileKind === 'video' ? '영상' : fileKind === 'audio' ? '음성' : '파일',
            formatFileSize(file.size),
            fileDurationSeconds ? formatDuration(fileDurationSeconds) : null,
        ].filter(Boolean).join(' · ')
        : '음성 파일을 선택해 주세요.';
    const currentStatusMessage = statusMessage || (
        analysisPhase === 'checking-server'
            ? '분석 기능을 확인하고 있습니다.'
            : analysisPhase === 'checking-models'
                ? '모델 준비 상태를 확인하고 있습니다.'
                : '분석을 준비하고 있습니다.'
    );

    return (
        <div className="flex h-full w-full max-w-[48rem] flex-col gap-5 mx-auto pt-1">
            <div>
                <h2 className="text-lg font-semibold text-foreground">새 회의록 작성</h2>
            </div>

            <div className="app-panel p-4 flex flex-col gap-5 sm:p-6">
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
                        <label className="text-[13px] font-semibold text-foreground" htmlFor="meeting-participants">참석자 *</label>
                        <Input id="meeting-participants" value={participants} onChange={e => setParticipants(e.target.value)} placeholder="예: 홍길동, 김철수" disabled={isAnalyzing} />
                    </div>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <label className="text-[13px] font-semibold text-foreground">음성 파일 *</label>
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
                        className={`file-drop-zone ${file ? 'file-drop-zone-selected' : ''}`}
                        onClick={() => {
                            if (!file && !isAnalyzing) fileInputRef.current?.click();
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
                                {!file ? (
                                    <Button
                                        variant="outline"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            fileInputRef.current?.click();
                                        }}
                                        disabled={isAnalyzing}
                                    >
                                        음성 파일 선택
                                    </Button>
                                ) : (
                                    <IconButton
                                        variant="outline"
                                        className="border-border text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                        icon={<X size={16} />}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            clearFile();
                                        }}
                                        disabled={isAnalyzing}
                                        aria-label="음성 파일 제거"
                                        title="음성 파일 제거"
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {!isAnalyzing && (
                    <div className="flex justify-end border-t border-border/70 pt-5">
                        <Button className="min-w-40 px-6 py-3 text-sm" onClick={handleStartAnalysis}>
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

            {statusMessage && !showAnalysisPanel && (
                <StatusBanner tone="neutral">
                    {statusMessage}
                </StatusBanner>
            )}

            {showAnalysisPanel && (
                <div className="app-panel border-primary/20 bg-primary/5 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-3">
                            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                                {progressPercent >= 100 ? <CheckCircle2 size={18} /> : <Loader2 size={18} className="animate-spin" />}
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-foreground">
                                    회의록을 분석하고 있습니다
                                </div>
                                <div className="mt-1 text-sm text-muted-foreground">
                                    {currentStatusMessage}
                                </div>
                                {analysisStalled && (
                                    <div className="mt-2 text-xs font-medium text-destructive">
                                        같은 단계가 2분 이상 이어지고 있습니다. 진행이 바뀌지 않으면 분석을 취소하고 다시 시도해 주세요.
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-start gap-3">
                            <div className="text-right">
                                <div className="text-lg font-semibold text-primary">{elapsedLabel}</div>
                                <div className="text-xs text-muted-foreground">경과 시간</div>
                            </div>
                            <div className="text-right">
                                <div className="text-lg font-semibold text-foreground">{remainingLabel}</div>
                                <div className="text-xs text-muted-foreground">예상 남은 시간</div>
                            </div>
                            <Button
                                variant="outline"
                                className="border-border text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                onClick={handleCancelAnalysis}
                            >
                                분석 취소
                            </Button>
                        </div>
                    </div>

                    <div className="mt-3 text-xs text-muted-foreground">
                        파일 크기와 PC 성능에 따라 분석 시간은 달라집니다.
                    </div>
                </div>
            )}

            {showProgressBar && !showAnalysisPanel && (
                <ProgressBar value={progress} tone={errorMessage ? 'error' : 'primary'} />
            )}
        </div>
    );
};
