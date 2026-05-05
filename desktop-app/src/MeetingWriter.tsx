import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Loader2, RefreshCw, Settings, UploadCloud, X } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { addMeeting, MeetingRecord, MeetingSegment } from './meetingRepository';
import { getApiBase } from './apiBase';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
const BACKEND_READY_TIMEOUT_MS = 45_000;
const BACKEND_READY_INTERVAL_MS = 1_000;

interface AnalyzeResult {
    status?: string;
    progress?: number;
    summary?: string;
    segments?: MeetingSegment[];
    topics?: string[];
    actions?: string[];
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

const displayPath = (path = ''): string => path.replace(/^\\\\\?\\/, '');
const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_primary') return '음성 인식';
    if (model.key === 'diarization') return '발화자 구분';
    return model.label;
};

const translateStatusMessage = (message: string): string => {
    const normalized = message.trim();
    const statusMap: Record<string, string> = {
        '업로드 파일 저장 완료': '파일을 안전하게 저장했습니다.',
        '음성 인식 모델 확인 중': '음성 인식 모델을 확인하고 있습니다.',
        '음성 인식 모델 준비 완료': '음성 인식 모델 준비가 끝났습니다.',
        'Cohere STT 모델 확인 중': '음성 인식 모델을 확인하고 있습니다.',
        'Cohere STT 모델 준비 완료': '음성 인식 모델 준비가 끝났습니다.',
        'Converting to WAV...': '영상에서 음성을 추출하고 WAV로 변환하고 있습니다.',
        'Preparing audio chunks...': '긴 음성을 분석하기 좋은 구간으로 나누고 있습니다.',
        'Primary speech recognition failed; using fallback model...': '음성 인식 방식을 바꾸어 다시 시도하고 있습니다.',
        'Speaker Diarization & Alignment...': '화자를 분리하고 발화 시간과 문장을 맞추고 있습니다.',
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
    const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [fileDurationSeconds, setFileDurationSeconds] = useState<number | null>(null);
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const analysisInFlightRef = useRef(false);

    useEffect(() => {
        const active = isAnalyzing;
        window.dispatchEvent(new CustomEvent('analysis:status', {
            detail: {
                active,
                progress,
                message: statusMessage,
            },
        }));
    }, [isAnalyzing, progress, statusMessage]);

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

        void syncReadiness();
        window.addEventListener('focus', syncReadiness);
        return () => {
            cancelled = true;
            window.removeEventListener('focus', syncReadiness);
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
        if (!file) fields.push('음성/영상 파일');
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
            const healthResponse = await fetch(`${apiBase}/api/health`);
            if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);

            await healthResponse.json().catch(() => null);

            const modelsResponse = await fetch(`${apiBase}/api/models/status`);
            if (!modelsResponse.ok) {
                const message = options.soft
                    ? '분석 기능을 준비하고 있습니다. 잠시 기다려 주세요.'
                    : '모델 상태를 확인하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요.';
                setReadinessState(options.soft ? 'server-waiting' : 'error');
                setReadinessMessage(message);
                return { state: options.soft ? 'server-waiting' : 'error', message };
            }

            const payload = await modelsResponse.json() as ModelsPayload;
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

        while (Date.now() < deadline) {
            const check = await refreshReadiness();
            if (check.state === 'ready') return check;
            if (check.state === 'missing-models' || check.state === 'error') return check;

            const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            setStatusMessage(`분석 기능을 준비하고 있습니다. 잠시 기다려 주세요. (${remainingSeconds}초)`);
            await sleep(BACKEND_READY_INTERVAL_MS);
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
        if (check.state === 'ready') return true;

        if (check.state === 'missing-models') {
            const missingModels = (check.models?.models || []).filter(model => model.required && !model.installed);
            const missingList = missingModels.map(model => getUserModelLabel(model)).join(', ');
            setErrorMessage(
                `필수 모델이 없습니다${missingList ? `: ${missingList}` : ''}. 설정에서 넣을 위치를 확인하고, 관리자가 지정한 모델 파일을 models 폴더에 복사한 뒤 새로고침해 주세요.`,
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

    const handleCopyPath = async (path?: string) => {
        if (!path) return;
        await navigator.clipboard.writeText(displayPath(path));
        setStatusMessage('모델 배치 경로를 복사했습니다.');
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
        setIsAnalyzing(true);
        setAnalysisPhase('checking-server');
        setProgress(0);
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');

        try {
            const modelsReady = await ensureModelsReady();
            if (!modelsReady) return;
            setAnalysisPhase('analyzing');
            setStatusMessage('분석을 시작합니다. 음성 추출과 전사를 진행합니다.');

            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('date', date);
            formData.append('participants', participants.trim());
            formData.append('mode', ANALYSIS_MODE);
            formData.append('file', file as File);

            const apiBase = await getApiBase();
            const response = await fetch(`${apiBase}/api/analyze`, {
                method: 'POST',
                body: formData,
                headers: { Accept: 'text/event-stream' },
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
                        setStatusMessage(translateStatusMessage(parsed.message));
                    }
                    if (parsed.status === 'error') {
                        throw new Error(parsed.message || '분석 중 오류가 발생했습니다.');
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
                actions: finalData.actions || [],
                outputFiles: finalData.outputs,
            };

            await addMeeting(newRecord);
            window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: newRecord.id } }));
            setProgress(100);
            setStatusMessage('회의록 저장이 완료되었습니다.');
            setTitle('');
            setParticipants('');
            setFile(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
            setAnalysisPhase('error');
            setErrorMessage(message);
            setStatusMessage('');
        } finally {
            analysisInFlightRef.current = false;
            setIsAnalyzing(false);
            setAnalysisPhase(current => (current === 'error' ? 'error' : 'idle'));
        }
    };

    const buttonLabel = (() => {
        if (isAnalyzing && analysisPhase === 'checking-server') return '분석 기능 확인 중...';
        if (isAnalyzing && analysisPhase === 'checking-models') return '모델 준비 상태 확인 중...';
        if (isAnalyzing && progress <= 0) return '분석 준비 중...';
        if (isAnalyzing) return `분석 진행 중... (${progress}%)`;
        return 'AI 분석 시작';
    })();

    const progressBarClass = errorMessage ? 'bg-red-500' : 'bg-primary';
    const showProgressBar = isAnalyzing || progress > 0;
    const fileKind = file ? getFileKind(file) : null;
    const showAnalysisPanel = isAnalyzing;
    const progressPercent = Math.min(100, Math.max(0, progress));
    const selectedFileMeta = file
        ? [
            fileKind === 'video' ? '영상' : fileKind === 'audio' ? '음성' : '파일',
            formatFileSize(file.size),
            fileDurationSeconds ? formatDuration(fileDurationSeconds) : null,
        ].filter(Boolean).join(' · ')
        : '파일을 선택해 주세요.';
    const isLongMedia = Boolean(fileDurationSeconds && fileDurationSeconds >= 3 * 60 * 60);
    const currentStatusMessage = statusMessage || (
        analysisPhase === 'checking-server'
            ? '분석 기능을 확인하고 있습니다.'
            : analysisPhase === 'checking-models'
                ? '모델 준비 상태를 확인하고 있습니다.'
                : '분석을 준비하고 있습니다.'
    );

    return (
        <div className="flex flex-col h-full gap-6 max-w-3xl mx-auto w-full">
            <h2 className="text-h3 font-semibold text-primary mb-2">새 회의록 작성</h2>
            <p className="text-sm text-muted-foreground -mt-4">
                음성 파일과 회의 녹화 영상을 업로드해 회의록을 만듭니다.
            </p>

            <div className="app-panel p-4 flex flex-col gap-5 sm:p-6">
                <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="meeting-title">회의 제목 *</label>
                    <Input id="meeting-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="예: 2026년 상반기 기획 회의" disabled={isAnalyzing} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground" htmlFor="meeting-date">일시 *</label>
                        <Input id="meeting-date" type="datetime-local" value={date} onChange={e => setDate(e.target.value)} disabled={isAnalyzing} />
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground" htmlFor="meeting-participants">참석자 *</label>
                        <Input id="meeting-participants" value={participants} onChange={e => setParticipants(e.target.value)} placeholder="예: 홍길동, 김철수" disabled={isAnalyzing} />
                    </div>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <label className="text-sm font-medium text-foreground">회의 파일 *</label>
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.mp4,.mov,.mkv,.avi,.webm"
                        onChange={handleFileChange}
                        disabled={isAnalyzing}
                        className="sr-only"
                        id="meeting-file-input"
                    />
                    <div className="rounded-md border border-dashed border-border bg-muted/20 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
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
                                <Button
                                    variant="outline"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isAnalyzing}
                                >
                                    파일 선택
                                </Button>
                                {file && (
                                    <Button
                                        variant="outline"
                                        className="h-10 w-10 border-red-200 p-0 text-red-500 hover:bg-red-50"
                                        onClick={clearFile}
                                        disabled={isAnalyzing}
                                        aria-label="선택한 파일 제거"
                                        title="선택한 파일 제거"
                                    >
                                        <X size={16} />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">지원 형식: MP3, WAV, M4A, AAC, FLAC, MP4, MOV, MKV, AVI, WEBM</p>
                    {file && (file.size >= LARGE_FILE_WARNING_BYTES || isLongMedia) && (
                        <div className="status-note border-amber-200 bg-amber-50 text-amber-800">
                            긴 파일은 음성만 추출한 뒤 나누어 분석합니다. 처리 시간은 파일 길이와 PC 성능에 따라 달라집니다.
                        </div>
                    )}
                </div>
            </div>

            {hasBlockingReadinessIssue && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-2">
                            <AlertCircle size={18} />
                            <div>
                                <div className="font-semibold">분석을 시작할 수 없습니다</div>
                                <div className="mt-1">{readinessMessage}</div>
                            </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                            <Button variant="outline" onClick={() => void handleRefreshReadiness()} disabled={isAnalyzing}>
                                <RefreshCw size={15} />
                                새로고침
                            </Button>
                            {onOpenSettings && (
                                <Button variant="outline" onClick={onOpenSettings} disabled={isAnalyzing}>
                                    <Settings size={15} />
                                    설정
                                </Button>
                            )}
                        </div>
                    </div>

                    {missingRequiredModels.length > 0 && (
                        <div className="mt-3 space-y-2">
                            {missingRequiredModels.map(model => (
                                <div key={model.key} className="rounded-md border border-red-200 bg-white/70 p-3 text-xs text-red-800">
                                    <div className="font-semibold">{getUserModelLabel(model)} 필요</div>
                                    <div className="mt-1 break-all">{displayPath(model.path)}</div>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleCopyPath(model.path)}
                                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 font-medium"
                                        >
                                            <Copy size={13} />
                                            경로 복사
                                        </button>
                                        {onOpenSettings && (
                                            <button
                                                type="button"
                                                onClick={onOpenSettings}
                                                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 font-medium"
                                            >
                                                설정에서 보기
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {errorMessage && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {errorMessage}
                </div>
            )}

            {statusMessage && !showAnalysisPanel && (
                <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                    {statusMessage}
                </div>
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
                            </div>
                        </div>
                        <div className="shrink-0 text-right">
                            <div className="text-2xl font-semibold text-primary">{progressPercent}%</div>
                            <div className="text-xs text-muted-foreground">진행률</div>
                        </div>
                    </div>

                    <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            className={`${progressBarClass} h-2.5 rounded-full transition-all duration-500 ease-out`}
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                </div>
            )}

            <Button className="w-full py-3 text-base" onClick={handleStartAnalysis} disabled={isAnalyzing}>
                {buttonLabel}
            </Button>

            {showProgressBar && !showAnalysisPanel && (
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div className={`${progressBarClass} h-2.5 rounded-full transition-all duration-300 ease-in-out`} style={{ width: `${progress}%` }} />
                </div>
            )}
        </div>
    );
};
