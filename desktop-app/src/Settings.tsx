import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, RefreshCw, X } from 'lucide-react';
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
    paths?: {
        output_dir?: string;
        temp_dir?: string;
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

const displayPath = (path: string): string => path.replace(/^\\\\\?\\/, '');

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_primary') return '음성 인식';
    if (model.key === 'diarization') return '발화자 구분';
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
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
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

    const handleCopyPath = async (path: string) => {
        await navigator.clipboard.writeText(displayPath(path));
        setMessage('모델 배치 경로를 복사했습니다.');
    };

    const handleSaveSettings = async () => {
        setIsSaving(true);
        setErrorMessage('');
        setMessage('');
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
            setDownloadFormatPreference(downloadFormat);
            setMessage('저장했습니다. 다음 분석부터 적용됩니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    const tabs: Array<{ key: SettingsTab; label: string }> = [
        { key: 'models', label: '분석 준비' },
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

                <div className="tab-list px-5" role="tablist" aria-label="시스템 설정">
                    {tabs.map(tab => (
                        <button
                            key={tab.key}
                            type="button"
                            id={`settings-${tab.key}-tab`}
                            role="tab"
                            aria-selected={activeTab === tab.key}
                            aria-controls={`settings-${tab.key}-panel`}
                            onClick={() => setActiveTab(tab.key)}
                            className={`tab-button py-3 ${activeTab === tab.key ? 'tab-button-active' : ''}`}
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
                        <section id="settings-models-panel" role="tabpanel" aria-labelledby="settings-models-tab" className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="section-title">분석 준비</h3>
                                    <p className="section-description">필수 모델이 준비되어야 분석을 시작할 수 있습니다.</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline" onClick={() => void loadSettings()} disabled={isLoading || isSaving}>
                                        <RefreshCw size={16} />
                                        상태 새로고침
                                    </Button>
                                </div>
                            </div>

                            <div className="rounded-md border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                                <div className="font-medium text-foreground">회사 PC 사용 요약</div>
                                <p className="mt-1">
                                    `Smart Minutes AI` 폴더 전체를 옮기고, 관리자가 지정한 모델 파일을 실행 파일 옆 `models` 폴더에 넣습니다.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-3">
                                {userVisibleModels.map(model => (
                                    <div key={model.key} className="rounded-md border border-border bg-muted/20 p-4">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <div className="font-medium text-foreground">{getUserModelLabel(model)}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">회의록 분석에 필요합니다.</div>
                                            </div>
                                            <span className={`inline-flex w-fit items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold ${model.installed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                                {model.installed ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                                                {model.installed ? '준비됨' : '필요함'}
                                            </span>
                                        </div>

                                        <div className="mt-3">
                                            <div className="mb-1 text-xs font-medium text-foreground">넣을 위치</div>
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
                                                {model.manual_note || '모델 페이지에서 파일을 받은 뒤 위 위치에 넣어 주세요.'}
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
                        <section id="settings-analysis-panel" role="tabpanel" aria-labelledby="settings-analysis-tab" className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="section-title">분석 방식</h3>
                                    <p className="section-description">대부분은 기본값으로 충분합니다. 필요할 때만 조정하세요.</p>
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
                                    <span className="block font-medium text-foreground">발화자 구분</span>
                                    <span className="text-sm text-muted-foreground">말한 사람을 자동으로 나눕니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={chunkingEnabled}
                                    onChange={event => setChunkingEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">긴 파일 나누기</span>
                                    <span className="text-sm text-muted-foreground">긴 파일을 작은 구간으로 나눠 처리합니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={preprocessingEnabled}
                                    onChange={event => setPreprocessingEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">음성 정리</span>
                                    <span className="text-sm text-muted-foreground">분석하기 좋은 형태로 입력 음성을 정리합니다.</span>
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
                                    <span className="block font-medium text-foreground">음량 보정</span>
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
                                    다운로드 아이콘을 누르면 이 형식으로 저장합니다.
                                </span>
                            </label>
                        </section>
                    )}

                    {activeTab === 'about' && (
                        <section id="settings-about-panel" role="tabpanel" aria-labelledby="settings-about-tab" className="flex flex-col gap-4 text-sm">
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">Smart Minutes AI</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    음성 파일과 회의 녹화 영상에서 회의록과 발화 기록을 만드는 로컬 데스크탑 앱입니다.
                                </p>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">회사 PC 사용 안내</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    회사 PC에서는 zip을 풀고 `Smart Minutes AI` 폴더 전체를 같은 위치에 둡니다. 필요한 모델이 없으면 실제 분석은 시작되지 않습니다.
                                    누락된 모델은 `models` 폴더에 넣은 뒤 상태 새로고침을 누르세요.
                                </p>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">저장 위치</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    분석 결과와 임시 파일은 실행 폴더 하위의 backend 폴더 기준으로 저장됩니다.
                                </p>
                                <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                                    <code className="break-all rounded-md border border-border bg-background px-3 py-2">
                                        결과: {settings?.paths?.output_dir ?? './outputs'}
                                    </code>
                                    <code className="break-all rounded-md border border-border bg-background px-3 py-2">
                                        임시 파일: {settings?.paths?.temp_dir ?? './temp'}
                                    </code>
                                </div>
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
