import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, ExternalLink, RefreshCw, X } from 'lucide-react';
import { Button } from './Button';
import {
    DEFAULT_DOWNLOAD_FORMAT,
    DownloadFormat,
    getDownloadFormatPreference,
    setDownloadFormatPreference,
} from './downloadPreferences';
import { getApiBase } from './apiBase';

const SETTINGS_FETCH_TIMEOUT_MS = 20_000;

interface ModelStatus {
    key: string;
    label: string;
    repo_id: string | null;
    path: string;
    installed: boolean;
    required: boolean;
    gated: boolean;
    requires_token: boolean;
    token_available: boolean;
    license_name: string;
    license_url: string;
    manual_note: string;
    downloadable: boolean;
}

interface SettingsPayload {
    processing?: {
        long_audio_chunk_seconds?: number;
        enable_long_audio_chunking?: boolean;
    };
    summary?: {
        provider?: string;
        model?: string;
    };
    diarization?: {
        enabled?: boolean;
    };
    stt?: {
        language?: string;
        device?: 'auto' | 'cpu' | 'cuda';
    };
    preprocessing?: {
        enabled?: boolean;
        normalize_audio?: boolean;
        normalization_mode?: 'auto' | 'loudnorm' | 'dynaudnorm' | 'speechnorm';
    };
}

interface ModelsPayload {
    ready: boolean;
    models: ModelStatus[];
}

interface SettingsProps {
    onClose: () => void;
}

type SettingsTab = 'models' | 'analysis' | 'about';

const modelPageUrl = (model: ModelStatus): string | null => {
    if (model.license_url) return model.license_url;
    if (model.repo_id) return `https://huggingface.co/${model.repo_id}`;
    return null;
};

const displayPath = (path: string): string => path.replace(/^\\\\\?\\/, '');

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_primary') return '음성 인식 모델';
    if (model.key === 'diarization') return '화자 분리 모델';
    return model.label;
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SETTINGS_FETCH_TIMEOUT_MS);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        window.clearTimeout(timeoutId);
    }
};

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState<SettingsTab>('models');
    const [, setSettings] = useState<SettingsPayload | null>(null);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    const [apiBase, setApiBase] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [chunkSeconds, setChunkSeconds] = useState(30);
    const [chunkingEnabled, setChunkingEnabled] = useState(true);
    const [diarizationEnabled, setDiarizationEnabled] = useState(true);
    const [sttDevice, setSttDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
    const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>(DEFAULT_DOWNLOAD_FORMAT);
    const [preprocessingEnabled, setPreprocessingEnabled] = useState(true);
    const [normalizeAudio, setNormalizeAudio] = useState(true);
    const [normalizationMode, setNormalizationMode] = useState<'auto' | 'loudnorm' | 'dynaudnorm' | 'speechnorm'>('auto');

    const missingModels = useMemo(
        () => (models?.models || []).filter(model => model.required && !model.installed && model.key !== 'stt_fallback'),
        [models],
    );

    const userVisibleModels = useMemo(
        () => (models?.models || []).filter(model => model.required && model.key !== 'stt_fallback'),
        [models],
    );

    const modelSummary = useMemo(() => {
        if (isLoading) return '상태 확인 중';
        if (errorMessage) return '연결 확인 필요';
        if (!models) return '모델 상태 확인 전';
        if (models.ready) return '필수 모델 준비됨';
        return `${missingModels.length}개 모델 필요`;
    }, [errorMessage, isLoading, missingModels.length, models]);

    const loadSettings = async () => {
        setIsLoading(true);
        setErrorMessage('');
        setMessage('');
        try {
            const base = await getApiBase();
            setApiBase(base);
            const [settingsResponse, modelsResponse] = await Promise.all([
                fetchWithTimeout(`${base}/api/settings`),
                fetchWithTimeout(`${base}/api/models/status`),
            ]);

            if (!settingsResponse.ok || !modelsResponse.ok) {
                throw new Error(`분석 기능 응답을 확인하지 못했습니다. settings=${settingsResponse.status}, models=${modelsResponse.status}`);
            }

            const nextSettings = await settingsResponse.json() as SettingsPayload;
            const nextModels = await modelsResponse.json() as ModelsPayload;
            setSettings(nextSettings);
            setModels(nextModels);
            setChunkSeconds(nextSettings.processing?.long_audio_chunk_seconds ?? 30);
            setChunkingEnabled(nextSettings.processing?.enable_long_audio_chunking ?? true);
            setDiarizationEnabled(nextSettings.diarization?.enabled ?? true);
            setSttDevice(nextSettings.stt?.device ?? 'auto');
            setPreprocessingEnabled(nextSettings.preprocessing?.enabled ?? true);
            setNormalizeAudio(nextSettings.preprocessing?.normalize_audio ?? true);
            setNormalizationMode(nextSettings.preprocessing?.normalization_mode ?? 'auto');
        } catch (error) {
            setModels(null);
            const isTimeout = error instanceof Error && error.name === 'AbortError';
            setErrorMessage(
                isTimeout
                    ? '분석 기능 응답이 지연되고 있습니다. 앱을 켠 직후라면 잠시 후 상태 새로고침을 눌러 주세요.'
                    : '분석 기능에 연결할 수 없습니다. 앱을 다시 실행한 뒤 상태 새로고침을 눌러 주세요.',
            );
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        setDownloadFormat(getDownloadFormatPreference());
        void loadSettings();
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        const previousOverflow = document.body.style.overflow;

        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose]);

    const handleOpenModelPages = () => {
        const candidates = missingModels.length
            ? missingModels
            : (models?.models || []).filter(model => model.downloadable || model.license_url || model.repo_id);

        if (!candidates.length) {
            setMessage('열 수 있는 모델 페이지가 없습니다.');
            return;
        }

        candidates.slice(0, 3).forEach(model => {
            const url = modelPageUrl(model);
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
        setMessage('모델 페이지를 열었습니다. 수동으로 받은 모델은 표시된 배치 위치에 넣고 상태 새로고침을 눌러 주세요.');
    };

    const handleCopyPath = async (path: string) => {
        await navigator.clipboard.writeText(displayPath(path));
        setMessage('모델 배치 경로를 복사했습니다.');
    };

    const handleSaveSettings = async () => {
        setIsSaving(true);
        setErrorMessage('');
        setMessage('');
        setDownloadFormatPreference(downloadFormat);

        try {
            const base = apiBase || await getApiBase();
            const response = await fetchWithTimeout(`${base}/api/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    processing: {
                        enable_long_audio_chunking: chunkingEnabled,
                        long_audio_chunk_seconds: chunkSeconds,
                    },
                    diarization: {
                        enabled: diarizationEnabled,
                    },
                    stt: {
                        device: sttDevice,
                    },
                    preprocessing: {
                        enabled: preprocessingEnabled,
                        normalize_audio: normalizeAudio,
                        normalization_mode: normalizationMode,
                    },
                }),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.detail || `설정 저장 실패: ${response.status}`);
            }

            const nextSettings = await response.json() as SettingsPayload;
            setSettings(nextSettings);
            setMessage('저장했습니다. 다음 분석부터 적용됩니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    const tabs: Array<{ key: SettingsTab; label: string }> = [
        { key: 'models', label: '모델' },
        { key: 'analysis', label: '분석' },
        { key: 'about', label: '정보' },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/45 p-4">
            <div className="flex h-[88vh] max-h-[760px] min-h-[520px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">시스템 설정</h2>
                        <p className="mt-1 text-xs text-muted-foreground">{modelSummary}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        aria-label="설정 닫기"
                        title="닫기"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="flex border-b border-border px-5">
                    {tabs.map(tab => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setActiveTab(tab.key)}
                            className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
                    {errorMessage && (
                        <div className="mb-4 flex gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            <AlertCircle size={18} />
                            <span>{errorMessage}</span>
                        </div>
                    )}
                    {message && (
                        <div className="mb-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                            {message}
                        </div>
                    )}

                    {activeTab === 'models' && (
                        <section className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="text-base font-semibold text-foreground">모델 준비</h3>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        필수 모델이 없으면 모델 페이지에서 받은 뒤 아래 위치에 넣습니다.
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline" onClick={() => void loadSettings()} disabled={isLoading || isSaving}>
                                        <RefreshCw size={16} />
                                        상태 새로고침
                                    </Button>
                                    <Button onClick={handleOpenModelPages} disabled={isLoading}>
                                        <ExternalLink size={16} />
                                        모델 받는 곳
                                    </Button>
                                </div>
                            </div>

                            <div className="rounded-md border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                                <div className="font-medium text-foreground">회사 PC 사용 요약</div>
                                <p className="mt-1">
                                    `Smart Minutes AI.exe`만 따로 옮기지 말고 `Smart Minutes AI` 폴더 전체를 옮기세요.
                                    필요한 모델은 실행 파일 옆 `models` 폴더 바로 아래에 넣습니다.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-3">
                                {userVisibleModels.map(model => (
                                    <div key={model.key} className="rounded-md border border-border bg-muted/20 p-4">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <div className="font-medium text-foreground">{getUserModelLabel(model)}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    회의록 분석에 필요한 모델입니다.
                                                </div>
                                            </div>
                                            <span className={`inline-flex w-fit items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold ${model.installed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                                {model.installed ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                                                {model.installed ? '준비됨' : '필요함'}
                                            </span>
                                        </div>

                                        <div className="mt-3">
                                            <div className="mb-1 text-xs font-medium text-foreground">배치 위치</div>
                                            <div className="flex items-start gap-2">
                                                <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                                                    {displayPath(model.path)}
                                                </code>
                                                {!model.path.startsWith('ollama:') && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleCopyPath(model.path)}
                                                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground"
                                                        title="경로 복사"
                                                        aria-label="경로 복사"
                                                    >
                                                        <Copy size={15} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {!model.installed && (
                                            <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                                {model.manual_note || '모델 페이지에서 파일을 받은 뒤 위 배치 위치에 넣어 주세요.'}
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {isLoading && !userVisibleModels.length && (
                                    <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
                                        모델 상태를 불러오는 중입니다.
                                    </div>
                                )}
                                {!isLoading && !userVisibleModels.length && !errorMessage && (
                                    <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
                                        모델 상태 정보가 없습니다. 상태 새로고침을 눌러 다시 확인해 주세요.
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {activeTab === 'analysis' && (
                        <section className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="text-base font-semibold text-foreground">분석 방식</h3>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        대부분은 기본값으로 충분합니다. 긴 파일 처리나 다운로드 형식만 필요할 때 조정하세요.
                                    </p>
                                </div>
                                <Button onClick={handleSaveSettings} disabled={isLoading || isSaving}>
                                    {isSaving ? '저장 중...' : '저장'}
                                </Button>
                            </div>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={diarizationEnabled}
                                    onChange={event => setDiarizationEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">화자 분리 사용</span>
                                    <span className="text-sm text-muted-foreground">누가 말했는지 자동으로 나눕니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={chunkingEnabled}
                                    onChange={event => setChunkingEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">긴 파일 자동 분할</span>
                                    <span className="text-sm text-muted-foreground">긴 음성/영상을 작은 구간으로 나누어 메모리 부담을 줄입니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={preprocessingEnabled}
                                    onChange={event => setPreprocessingEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">음성 전처리 사용</span>
                                    <span className="text-sm text-muted-foreground">입력 음성을 분석하기 좋은 형태로 정리합니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={normalizeAudio}
                                    onChange={event => setNormalizeAudio(event.target.checked)}
                                    disabled={!preprocessingEnabled}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">음량 자동 보정</span>
                                    <span className="text-sm text-muted-foreground">작은 음성은 키우고 과한 처리는 피합니다.</span>
                                </span>
                            </label>

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">음량 보정 방식</span>
                                <select
                                    value={normalizationMode}
                                    onChange={event => setNormalizationMode(event.target.value as typeof normalizationMode)}
                                    disabled={!preprocessingEnabled || !normalizeAudio}
                                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 disabled:opacity-60"
                                >
                                    <option value="auto">자동</option>
                                    <option value="loudnorm">표준 보정</option>
                                    <option value="speechnorm">작은 목소리 보정</option>
                                    <option value="dynaudnorm">동적 보정</option>
                                </select>
                                <span className="mt-2 block text-sm text-muted-foreground">
                                    기본값은 자동입니다. 작은 목소리 보정은 녹음이 작을 때만 비교용으로 사용하세요.
                                </span>
                            </label>

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">다운로드 형식</span>
                                <select
                                    value={downloadFormat}
                                    onChange={event => setDownloadFormat(event.target.value as DownloadFormat)}
                                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2"
                                >
                                    <option value="hwpx">HWPX</option>
                                    <option value="md">MD</option>
                                    <option value="txt">TXT</option>
                                    <option value="docx">DOCX</option>
                                </select>
                                <span className="mt-2 block text-sm text-muted-foreground">
                                    회의 상세의 다운로드 아이콘은 이 형식으로 저장합니다.
                                </span>
                            </label>
                        </section>
                    )}

                    {activeTab === 'about' && (
                        <section className="flex flex-col gap-4 text-sm">
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">Smart Minutes AI</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    음성 파일과 회의 녹화 영상에서 회의록, 화자별 발화, 다운로드 파일을 만드는 로컬 데스크탑 앱입니다.
                                </p>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">회사 PC 사용 안내</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    회사 PC에서는 zip을 풀고 `Smart Minutes AI` 폴더 전체를 같은 위치에 둡니다. 필요한 모델이 없으면 실제 분석은 시작되지 않습니다.
                                    누락된 모델은 `models` 폴더에 넣은 뒤 상태 새로고침을 누르세요.
                                </p>
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
