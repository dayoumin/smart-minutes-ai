import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, Copy, RefreshCw, Settings } from 'lucide-react';
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
    label: string;
    installed: boolean;
    required: boolean;
    path?: string;
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
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [readinessState, setReadinessState] = useState<ReadinessState>('checking');
    const [readinessMessage, setReadinessMessage] = useState('분석 서버를 확인하고 있습니다.');
    const [modelsPayload, setModelsPayload] = useState<ModelsPayload | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const missingRequiredModels = useMemo(
        () => (modelsPayload?.models || []).filter(model => model.required && !model.installed),
        [modelsPayload],
    );
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
                const message = '8000번 포트를 다른 서버가 사용 중입니다. 실행 중인 Python/FastAPI 서버를 종료하고 앱을 다시 실행해 주세요.';
                setReadinessState('error');
                setReadinessMessage(message);
                return { state: 'error', message };
            }

            const modelsResponse = await fetch(`${apiBase}/api/models/status`);
            if (!modelsResponse.ok) {
                const message = '모델 상태 API를 찾지 못했습니다. 이전 버전 백엔드가 실행 중일 수 있으니 앱과 Python 서버를 모두 종료한 뒤 다시 실행해 주세요.';
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
            const message = '분석 서버를 준비하고 있습니다. 첫 실행은 30초 이상 걸릴 수 있습니다.';
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
            setStatusMessage(`분석 서버를 준비하고 있습니다. 잠시 기다려 주세요. (${remainingSeconds}초)`);
            await sleep(BACKEND_READY_INTERVAL_MS);
        }

        const message = '분석 서버가 아직 준비되지 않았습니다. 앱을 닫았다가 다시 실행하고 2~3분 정도 기다려 주세요.';
        setErrorMessage(message);
        return { state: 'error', message };
    };

    const ensureModelsReady = async (): Promise<boolean> => {
        if (ANALYSIS_MODE !== 'real') return true;

        setStatusMessage('분석 환경을 확인하고 있습니다.');
        const check = await waitForBackendReady();
        if (check.state !== 'ready') {
            setErrorMessage(check.message);
            return false;
        }

        const missingModels = (check.models?.models || [])
            .filter(model => model.required && !model.installed);
        if (missingModels.length === 0) return true;

        const missing = missingModels.map(model => model.label).join(', ');
        setErrorMessage(`실제 로컬 분석에 필요한 모델이 없습니다: ${missing}`);
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

        if (!selectedFile) {
            setFile(null);
            return;
        }

        setFile(selectedFile);
    };

    const handleStartAnalysis = async () => {
        if (!title.trim() || !date || !participants.trim() || !file) {
            setErrorMessage('회의 제목, 일시, 참석자, 음성/영상 파일을 모두 입력해 주세요.');
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
            formData.append('file', file);

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
                throw new Error('응답 스트림을 읽을 수 없습니다.');
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
                sourceFile: finalData.meeting?.source_file || file.name,
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
        if (isAnalyzing) return `분석 진행 중... (${progress}%)`;
        return 'AI 분석 시작';
    })();

    const showReadinessIssue = hasBlockingReadinessIssue;
    const progressBarClass = errorMessage
        ? 'bg-red-500'
        : isAnalyzing
            ? 'bg-primary'
            : 'bg-primary';

    return (
        <div className="flex flex-col h-full gap-6 max-w-3xl mx-auto w-full">
            <h2 className="text-h3 font-semibold text-primary mb-2">새 회의록 작성</h2>
            <p className="text-sm text-muted-foreground -mt-4">
                음성 파일과 회의 녹화 영상을 모두 업로드할 수 있습니다. 영상은 서버에서 음성 트랙만 추출한 뒤 분석합니다.
            </p>

            <div className="bg-background border border-border rounded-lg p-6 flex flex-col gap-5 shadow-sm">
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
                        className="file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer text-sm text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                        지원 형식: MP3, WAV, M4A, AAC, FLAC, MP4, MOV, MKV, AVI, WEBM. 큰 파일은 차단하지 않고 음성 변환 후 설정된 길이로 나누어 처리합니다.
                    </p>
                    {file && (
                        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                            <div className="font-medium">{file.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {getFileKind(file) === 'video' ? '영상 파일' : getFileKind(file) === 'audio' ? '음성 파일' : '알 수 없는 형식'} · {formatFileSize(file.size)}
                            </div>
                            {file.size >= LARGE_FILE_WARNING_BYTES && (
                                <div className="mt-2 text-xs text-amber-700">
                                    큰 파일은 업로드와 음성 추출에 시간이 오래 걸릴 수 있습니다. 분석은 음성 트랙을 만든 뒤 청크 단위로 나누어 진행합니다.
                                </div>
                            )}
                            {getFileKind(file) === 'video' && (
                                <div className="mt-2 text-xs text-muted-foreground">
                                    영상 자체를 분석하지 않고 음성만 WAV로 변환합니다. 메모리 부담은 원본 영상 길이보다 추출된 음성 길이와 청크 설정의 영향을 더 크게 받습니다.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {showReadinessIssue && (
                <div className={`rounded-md border px-4 py-3 text-sm ${hasBlockingReadinessIssue ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-2">
                            <AlertCircle size={18} />
                            <div>
                                <div className="font-semibold">{hasBlockingReadinessIssue ? '분석을 시작할 수 없습니다' : '분석 서버 준비 중'}</div>
                                <div className="mt-1">{readinessMessage}</div>
                            </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                            <Button variant="outline" onClick={() => void refreshReadiness()} disabled={isAnalyzing}>
                                <RefreshCw size={15} />
                                새로고침
                            </Button>
                            {hasBlockingReadinessIssue && (
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
                                <div key={model.label} className="rounded-md border border-red-200 bg-white/70 p-3 text-xs text-red-800">
                                    <div className="font-semibold">{model.label} 배치 필요</div>
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
                                        <button
                                            type="button"
                                            onClick={onOpenSettings}
                                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 font-medium"
                                        >
                                            설정에서 보기
                                        </button>
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

            {(isAnalyzing || progress > 0 || errorMessage) && (
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div className={`${progressBarClass} h-2.5 rounded-full transition-all duration-300 ease-in-out`} style={{ width: `${errorMessage ? Math.max(progress, 8) : progress}%` }} />
                </div>
            )}
        </div>
    );
};
