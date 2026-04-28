import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, Copy, RefreshCw, Settings, UploadCloud, X } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { addMeeting, MeetingRecord, MeetingSegment } from './meetingRepository';
import { getApiBase } from './apiBase';

const ANALYSIS_MODE = import.meta.env.VITE_ANALYSIS_MODE ?? 'real';
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
const BACKEND_READY_TIMEOUT_MS = 240_000;
const BACKEND_READY_INTERVAL_MS = 3_000;

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
}

type ReadinessState = 'checking' | 'server-waiting' | 'ready' | 'missing-models' | 'error';

interface ReadinessCheck {
    state: ReadinessState;
    message: string;
    models?: ModelsPayload;
}

interface DownloadEvent {
    type?: string;
    status?: string;
    progress?: number;
    message?: string;
    model?: string;
    models?: ModelStatus[];
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

interface MeetingWriterProps {
    onOpenSettings?: () => void;
}

export const MeetingWriter: React.FC<MeetingWriterProps> = ({ onOpenSettings }) => {
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
    const [participants, setParticipants] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isDownloadingModels, setIsDownloadingModels] = useState(false);
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

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

    const refreshReadiness = async (): Promise<ReadinessCheck> => {
        if (ANALYSIS_MODE !== 'real') {
            setReadinessState('ready');
            setReadinessMessage('');
            return { state: 'ready', message: '' };
        }

        try {
            const apiBase = await getApiBase();
            const healthResponse = await fetch(`${apiBase}/api/health`);
            if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);

            const healthPayload = await healthResponse.json().catch(() => null) as { ok?: boolean; service?: string } | null;
            if (!healthPayload?.ok || healthPayload.service !== 'NIFS AI Meeting API') {
                const message = '다른 서버가 분석 서버 주소를 사용 중입니다. 실행 중인 Python/FastAPI 서버를 종료하고 앱을 다시 실행해 주세요.';
                setReadinessState('error');
                setReadinessMessage(message);
                return { state: 'error', message };
            }

            const modelsResponse = await fetch(`${apiBase}/api/models/status`);
            if (!modelsResponse.ok) {
                const message = '모델 상태를 확인하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요.';
                setReadinessState('error');
                setReadinessMessage(message);
                return { state: 'error', message };
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
                .map(model => model.label)
                .join(', ');
            const message = `필수 모델이 없습니다: ${missing}`;
            setReadinessState('missing-models');
            setReadinessMessage(message);
            return { state: 'missing-models', message, models: payload };
        } catch {
            const message = '로컬 분석 서버를 준비하고 있습니다. 첫 실행은 시간이 걸릴 수 있습니다.';
            setReadinessState('server-waiting');
            setReadinessMessage(message);
            return { state: 'server-waiting', message };
        }
    };

    const waitForBackendReady = async (): Promise<ReadinessCheck> => {
        const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const check = await refreshReadiness();
            if (check.state === 'ready') return check;
            if (check.state === 'missing-models' || check.state === 'error') return check;

            const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            setStatusMessage(`로컬 분석 서버를 준비하고 있습니다. 잠시 기다려 주세요. (${remainingSeconds}초)`);
            await sleep(BACKEND_READY_INTERVAL_MS);
        }

        const message = '로컬 분석 서버가 아직 준비되지 않았습니다. 앱을 종료한 뒤 다시 실행해 주세요.';
        setErrorMessage(message);
        return { state: 'error', message };
    };

    const downloadModels = async (models: ModelStatus[]): Promise<boolean> => {
        const downloadableModels = models.filter(model => model.downloadable !== false);
        if (!downloadableModels.length) {
            setErrorMessage('자동 다운로드할 수 없는 모델입니다. 설정에서 모델 위치를 확인해 주세요.');
            return false;
        }

        const modelList = downloadableModels
            .map(model => `- ${model.label}\n  ${displayPath(model.path)}`)
            .join('\n');
        const tokenRequired = downloadableModels.some(model => model.requires_token);
        const tokenNote = tokenRequired
            ? '\n\nHugging Face 권한이 필요한 모델입니다. 토큰이 없거나 약관에 동의하지 않았다면 다운로드가 실패할 수 있습니다.'
            : '';

        const confirmed = window.confirm(
            `음성 분석에 필요한 모델이 없습니다.\n\n확인을 누르면 프로그램 하위에 아래 폴더가 생성되고 모델 다운로드를 시작합니다.\n\n${modelList}${tokenNote}\n\n다운로드에는 시간이 오래 걸릴 수 있습니다. 진행할까요?`,
        );

        if (!confirmed) {
            setErrorMessage('모델 다운로드를 취소했습니다. 필수 모델이 준비되어야 분석할 수 있습니다.');
            return false;
        }

        setIsDownloadingModels(true);
        setProgress(0);
        setStatusMessage('모델 다운로드를 시작합니다.');

        try {
            const apiBase = await getApiBase();
            const response = await fetch(`${apiBase}/api/models/download`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify({ models: downloadableModels.map(model => model.key) }),
            });

            if (!response.ok) {
                throw new Error(`모델 다운로드 요청 실패: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('모델 다운로드 응답을 읽을 수 없습니다.');

            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let completed = false;

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

                    const parsed = JSON.parse(dataStr) as DownloadEvent;
                    if (typeof parsed.progress === 'number') {
                        setProgress(Math.min(100, Math.max(0, parsed.progress)));
                    }
                    if (parsed.message) {
                        setStatusMessage(parsed.message);
                    }
                    if (parsed.type === 'error' || parsed.status === 'error') {
                        throw new Error(parsed.message || '모델 다운로드에 실패했습니다.');
                    }
                    if (parsed.status === 'completed') {
                        completed = true;
                    }
                }
            }

            if (!completed) {
                throw new Error('모델 다운로드 완료 응답을 받지 못했습니다.');
            }

            setProgress(100);
            setStatusMessage('모델 다운로드가 완료되었습니다. 분석을 계속합니다.');
            const nextCheck = await refreshReadiness();
            if (nextCheck.state !== 'ready') {
                setErrorMessage(nextCheck.message || '모델 다운로드 후에도 분석 준비가 완료되지 않았습니다.');
                return false;
            }
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : '모델 다운로드 중 오류가 발생했습니다.';
            setErrorMessage(message);
            return false;
        } finally {
            setIsDownloadingModels(false);
        }
    };

    const ensureModelsReady = async (): Promise<boolean> => {
        if (ANALYSIS_MODE !== 'real') return true;

        setStatusMessage('분석 환경을 확인하고 있습니다.');
        const check = await waitForBackendReady();
        if (check.state === 'ready') return true;

        if (check.state === 'missing-models') {
            const missingModels = (check.models?.models || []).filter(model => model.required && !model.installed);
            return downloadModels(missingModels);
        }

        setErrorMessage(check.message);
        return false;
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
        setFile(selectedFile);
    };

    const clearFile = () => {
        setFile(null);
        setErrorMessage('');
        setStatusMessage('');
        setProgress(0);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleStartAnalysis = async () => {
        if (missingFields.length > 0) {
            setProgress(0);
            setStatusMessage('');
            setErrorMessage(`필수 항목을 확인해 주세요: ${missingFields.join(', ')}`);
            return;
        }

        setIsAnalyzing(true);
        setProgress(0);
        setStatusMessage('분석 환경을 확인하고 있습니다.');
        setErrorMessage('');

        try {
            const modelsReady = await ensureModelsReady();
            if (!modelsReady) return;

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
                        setStatusMessage(parsed.message);
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
            window.dispatchEvent(new Event('meetings:updated'));
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
            setErrorMessage(message);
            setStatusMessage('');
        } finally {
            setIsAnalyzing(false);
        }
    };

    const buttonLabel = (() => {
        if (isDownloadingModels) return `모델 다운로드 중... (${progress}%)`;
        if (isAnalyzing) return `분석 진행 중... (${progress}%)`;
        return 'AI 분석 시작';
    })();

    const progressBarClass = errorMessage ? 'bg-red-500' : 'bg-primary';
    const showProgressBar = isAnalyzing || isDownloadingModels || progress > 0;
    const fileKind = file ? getFileKind(file) : null;

    return (
        <div className="flex flex-col h-full gap-6 max-w-3xl mx-auto w-full">
            <h2 className="text-h3 font-semibold text-primary mb-2">새 회의록 작성</h2>
            <p className="text-sm text-muted-foreground -mt-4">
                음성 파일과 회의 녹화 영상을 모두 업로드할 수 있습니다. 영상은 서버에서 음성 트랙만 추출한 뒤 분석합니다.
            </p>

            <div className="bg-background border border-border rounded-lg p-4 flex flex-col gap-5 shadow-sm sm:p-6">
                <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">회의 제목 *</label>
                    <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="예: 2026년 상반기 기획 회의" disabled={isAnalyzing} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground">일시 *</label>
                        <Input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} disabled={isAnalyzing} />
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground">참석자 *</label>
                        <Input value={participants} onChange={e => setParticipants(e.target.value)} placeholder="예: 홍길동, 김철수" disabled={isAnalyzing} />
                    </div>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <label className="text-sm font-medium text-foreground">음성/영상 파일 첨부 *</label>
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
                                        {file
                                            ? `${fileKind === 'video' ? '영상 파일' : fileKind === 'audio' ? '음성 파일' : '알 수 없는 형식'} · ${formatFileSize(file.size)}`
                                            : '오디오 또는 영상 파일을 선택해 주세요.'}
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
                    <p className="text-xs text-muted-foreground">
                        지원 형식: MP3, WAV, M4A, AAC, FLAC, MP4, MOV, MKV, AVI, WEBM. 큰 파일은 차단하지 않고 음성 변환 후 설정된 길이로 나누어 처리합니다.
                    </p>
                    {file && (
                        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                            <div className="font-medium">{file.name}</div>
                            {file.size >= LARGE_FILE_WARNING_BYTES && (
                                <div className="mt-2 text-xs text-amber-700">
                                    큰 파일은 업로드와 음성 추출에 시간이 오래 걸릴 수 있습니다. 분석은 음성 트랙을 만든 뒤 청크 단위로 나누어 진행합니다.
                                </div>
                            )}
                            {fileKind === 'video' && (
                                <div className="mt-2 text-xs text-muted-foreground">
                                    영상 자체를 분석하지 않고 음성만 WAV로 변환합니다. 메모리 부담은 원본 영상 길이보다 추출된 음성 길이와 청크 설정의 영향을 더 크게 받습니다.
                                </div>
                            )}
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
                            <Button variant="outline" onClick={() => void refreshReadiness()} disabled={isAnalyzing}>
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
                                    <div className="font-semibold">{model.label} 필요</div>
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

            {statusMessage && (
                <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                    {statusMessage}
                </div>
            )}

            <Button className="w-full py-3 text-base" onClick={handleStartAnalysis} disabled={isAnalyzing}>
                {buttonLabel}
            </Button>

            {showProgressBar && (
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div className={`${progressBarClass} h-2.5 rounded-full transition-all duration-300 ease-in-out`} style={{ width: `${progress}%` }} />
                </div>
            )}
        </div>
    );
};
