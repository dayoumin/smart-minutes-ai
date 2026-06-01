import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { Button } from './Button';
import { StatusBanner } from './StatusBanner';
import {
    DEFAULT_DOWNLOAD_FORMAT,
    DownloadFormat,
    getDownloadFormatPreference,
    setDownloadFormatPreference,
} from './downloadPreferences';
import { getApiBase, isTauriRuntime, restartDesktopBackend } from './apiBase';

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
        auto_skip_long_audio?: boolean;
        max_duration_seconds?: number;
        max_waveform_mb?: number;
    };
    stt?: {
        language?: string;
        device?: 'auto' | 'cpu' | 'cuda';
        selected_model?: 'faster-whisper-large-v3';
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
    privacy?: {
        preserve_extracted_audio?: boolean;
        auto_save_hwpx_copy?: boolean;
        auto_save_audio_copy?: boolean;
    };
}

interface ModelsPayload {
    ready: boolean;
    models: ModelStatus[];
    selected_stt_device?: 'cpu' | 'cuda';
    stt_device_status?: {
        selected_device_allowed?: string[];
        recommended_device?: 'cpu' | 'cuda';
        gpu_detected?: boolean;
        gpu_usable?: boolean;
        gpu_reason?: string;
    };
    errors?: string[];
}

interface SettingsProps {
    onClose: () => void;
    analysisActive?: boolean;
}

type SettingsTab = 'general' | 'models' | 'advanced';

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_faster_whisper') return '기본 음성 인식 파일';
    if (model.key === 'diarization') return '참석자 구분';
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

export const Settings: React.FC<SettingsProps> = ({ onClose, analysisActive = false }) => {
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    const [apiBase, setApiBase] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isRestartingBackend, setIsRestartingBackend] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [chunkSeconds, setChunkSeconds] = useState(30);
    const [chunkingEnabled, setChunkingEnabled] = useState(true);
    const [diarizationEnabled, setDiarizationEnabled] = useState(false);
    const [sttDevice, setSttDevice] = useState<'cpu' | 'cuda'>('cpu');
    const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>(DEFAULT_DOWNLOAD_FORMAT);
    const [preprocessingEnabled, setPreprocessingEnabled] = useState(true);
    const [normalizeAudio, setNormalizeAudio] = useState(true);
    const [normalizationMode, setNormalizationMode] = useState<'auto' | 'loudnorm' | 'dynaudnorm' | 'speechnorm'>('auto');
    const [preserveExtractedAudio, setPreserveExtractedAudio] = useState(true);
    const [autoSaveHwpxCopy, setAutoSaveHwpxCopy] = useState(false);
    const [autoSaveAudioCopy, setAutoSaveAudioCopy] = useState(false);

    const userVisibleModels = useMemo(
        () => (models?.models || []).filter(
            model => model.key === 'stt_faster_whisper' || model.key === 'diarization',
        ),
        [models],
    );

    const applySettingsToForm = useCallback((nextSettings: SettingsPayload) => {
        setChunkSeconds(nextSettings.processing?.long_audio_chunk_seconds ?? 30);
        setChunkingEnabled(nextSettings.processing?.enable_long_audio_chunking ?? true);
        setDiarizationEnabled(nextSettings.diarization?.enabled ?? false);
        setSttDevice(nextSettings.stt?.device === 'cuda' ? 'cuda' : 'cpu');
        setPreprocessingEnabled(nextSettings.preprocessing?.enabled ?? true);
        setNormalizeAudio(nextSettings.preprocessing?.normalize_audio ?? true);
        setNormalizationMode(nextSettings.preprocessing?.normalization_mode ?? 'auto');
        setPreserveExtractedAudio(nextSettings.privacy?.preserve_extracted_audio ?? true);
        setAutoSaveHwpxCopy(nextSettings.privacy?.auto_save_hwpx_copy ?? false);
        setAutoSaveAudioCopy(nextSettings.privacy?.auto_save_audio_copy ?? false);
    }, []);

    useEffect(() => {
        if (!preserveExtractedAudio) {
            setAutoSaveAudioCopy(false);
        }
    }, [preserveExtractedAudio]);

    const loadModelsStatus = useCallback(async (base: string, options: { surfaceErrors?: boolean } = {}): Promise<ModelsPayload | null> => {
        try {
            const modelsResponse = await fetchWithTimeout(`${base}/api/models/status`);
            if (!modelsResponse.ok) {
                throw new Error(`models=${modelsResponse.status}`);
            }
            const nextModels = await modelsResponse.json() as ModelsPayload;
            setModels(nextModels);
            return nextModels;
        } catch (error) {
            setModels(null);
            if (options.surfaceErrors !== false) {
                const isTimeout = error instanceof Error && error.name === 'AbortError';
                setErrorMessage(
                    isTimeout
                        ? '분석 준비 상태 응답이 지연되고 있습니다. 잠시 후 상태 새로고침을 눌러 주세요.'
                        : '분석 준비 상태를 불러오지 못했습니다. 상태 새로고침을 눌러 다시 확인해 주세요.',
                );
            }
            return null;
        }
    }, []);

    const loadSettings = useCallback(async (): Promise<boolean> => {
        setIsLoading(true);
        setErrorMessage('');
        setMessage('');
        try {
            const base = await getApiBase();
            setApiBase(base);
            const settingsResponse = await fetchWithTimeout(`${base}/api/settings`);

            if (!settingsResponse.ok) {
                throw new Error(`settings=${settingsResponse.status}`);
            }

            const nextSettings = await settingsResponse.json() as SettingsPayload;
            setSettings(nextSettings);
            applySettingsToForm(nextSettings);
            const nextModels = await loadModelsStatus(base);
            return Boolean(nextModels);
        } catch (error) {
            setSettings(null);
            setModels(null);
            const isTimeout = error instanceof Error && error.name === 'AbortError';
            setErrorMessage(
                isTimeout
                    ? '분석 기능 응답이 지연되고 있습니다. 앱을 켠 직후라면 잠시 후 상태 새로고침을 눌러 주세요.'
                    : '분석 기능에 연결할 수 없습니다. 앱을 다시 실행한 뒤 상태 새로고침을 눌러 주세요.',
            );
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [applySettingsToForm, loadModelsStatus]);

    useEffect(() => {
        setDownloadFormat(getDownloadFormatPreference());
        void loadSettings();
    }, [loadSettings]);

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

    const handleSaveSettings = async () => {
        if (!settings) {
            setErrorMessage('설정을 아직 불러오지 못했습니다. 상태 새로고침 후 다시 저장해 주세요.');
            return;
        }

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
                        selected_model: 'faster-whisper-large-v3',
                        device: sttDevice,
                    },
                    preprocessing: {
                        enabled: preprocessingEnabled,
                        normalize_audio: normalizeAudio,
                        normalization_mode: normalizationMode,
                    },
                    privacy: {
                        preserve_extracted_audio: preserveExtractedAudio,
                        auto_save_hwpx_copy: autoSaveHwpxCopy,
                        auto_save_audio_copy: autoSaveAudioCopy,
                    },
                }),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.detail || `설정 저장 실패: ${response.status}`);
            }

            const nextSettings = await response.json() as SettingsPayload;
            setSettings(nextSettings);
            applySettingsToForm(nextSettings);
            setDownloadFormatPreference(downloadFormat);
            await loadModelsStatus(base, { surfaceErrors: false });
            window.dispatchEvent(new Event('analysis:settings-updated'));
            setMessage('저장했습니다. 다운로드 형식은 바로 반영되고, 분석 옵션은 다음 분석부터 적용됩니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleRestartBackend = async () => {
        if (analysisActive) {
            setErrorMessage('분석 중에는 분석 서버를 다시 시작할 수 없습니다. 진행 중인 분석을 중단하거나 완료한 뒤 다시 시도해 주세요.');
            return;
        }

        setIsRestartingBackend(true);
        setErrorMessage('');
        setMessage('');
        try {
            const base = await restartDesktopBackend();
            setApiBase(base);
            const ready = await loadSettings();
            if (ready) {
                setMessage('분석 서버를 다시 시작하고 상태를 확인했습니다.');
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '분석 서버를 다시 시작하지 못했습니다.');
        } finally {
            setIsRestartingBackend(false);
        }
    };

    const tabs: Array<{ key: SettingsTab; label: string }> = [
        { key: 'general', label: '일반' },
        { key: 'models', label: '분석 준비' },
        { key: 'advanced', label: '고급' },
    ];
    const canSaveSettings = !isLoading && !isSaving && !isRestartingBackend && settings !== null;
    const canRestartBackend = isTauriRuntime() && !analysisActive && !isLoading && !isSaving && !isRestartingBackend;
    const gpuUsable = Boolean(models?.stt_device_status?.gpu_usable);
    const gpuDetected = Boolean(models?.stt_device_status?.gpu_detected);
    const gpuReason = models?.stt_device_status?.gpu_reason || 'GPU 가속은 조건을 확인한 뒤에만 사용하세요.';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[var(--bg-overlay)] p-4">
            <div className="flex h-[88vh] max-h-[760px] min-h-[520px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">시스템 설정</h2>
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
                        <StatusBanner tone="error" className="mb-4">
                            <AlertCircle size={18} />
                            <span>{errorMessage}</span>
                        </StatusBanner>
                    )}
                    {message && (
                        <StatusBanner tone="neutral" className="mb-4">
                            {message}
                        </StatusBanner>
                    )}

                    {activeTab === 'general' && (
                        <section id="settings-general-panel" role="tabpanel" aria-labelledby="settings-general-tab" className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="section-title">일반 설정</h3>
                                    <p className="section-description">자주 쓰는 옵션만 모았습니다. 대부분은 그대로 두면 됩니다.</p>
                                </div>
                                <Button onClick={handleSaveSettings} disabled={!canSaveSettings}>
                                    {isSaving ? '저장 중...' : '저장'}
                                </Button>
                            </div>

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">다운로드 형식</span>
                                <select
                                    value={downloadFormat}
                                    onChange={event => setDownloadFormat(event.target.value as DownloadFormat)}
                                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2"
                                >
                                    <option value="hwpx">HWPX</option>
                                    <option value="docx">DOCX</option>
                                    <option value="txt">TXT</option>
                                    <option value="md">MD</option>
                                </select>
                                <span className="mt-2 block text-sm text-muted-foreground">
                                    회의록 화면의 다운로드 아이콘은 이 형식으로 저장합니다.
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={diarizationEnabled}
                                    onChange={event => setDiarizationEnabled(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">참석자 구분</span>
                                    <span className="text-sm text-muted-foreground">누가 말했는지 자동으로 나눕니다. 긴 파일은 먼저 대화록과 요약을 만듭니다.</span>
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
                                    <span className="text-sm text-muted-foreground">분석하기 좋은 형태로 음성을 정리합니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={preserveExtractedAudio}
                                    onChange={event => setPreserveExtractedAudio(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">음성 재생 파일 보관</span>
                                    <span className="text-sm text-muted-foreground">결과 화면에서 다시 듣거나 참석자 구분을 나중에 실행해야 할 때만 내부 음성 파일을 남깁니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={autoSaveHwpxCopy}
                                    onChange={event => setAutoSaveHwpxCopy(event.target.checked)}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">HWPX 자동 저장</span>
                                    <span className="text-sm text-muted-foreground">분석이 끝나면 회의록 HWPX 파일을 다운로드 폴더에 저장합니다.</span>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
                                <input
                                    type="checkbox"
                                    checked={autoSaveAudioCopy}
                                    onChange={event => setAutoSaveAudioCopy(event.target.checked)}
                                    disabled={!preserveExtractedAudio}
                                />
                                <span>
                                    <span className="block font-medium text-foreground">음성 파일 자동 저장</span>
                                    <span className="text-sm text-muted-foreground">음성 재생 파일을 보관할 때만 다운로드 폴더에도 저장합니다. 영상만 음성으로 바꿀 때는 작성 화면의 음성 추출을 사용하세요.</span>
                                </span>
                            </label>
                        </section>
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
                                <div className="font-medium text-foreground">분석 파일 준비</div>
                                <p className="mt-1">
                                    필요한 파일을 앱 폴더의 `models` 폴더에 넣은 뒤 상태 새로고침을 누르세요.
                                </p>
                            </div>

                            {isTauriRuntime() && (
                                <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <div className="font-medium text-foreground">분석 서버</div>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            분석 기능이 응답하지 않거나 파이썬 오류가 의심될 때만 다시 시작하세요.
                                        </p>
                                        {analysisActive && (
                                            <p className="mt-2 text-xs text-muted-foreground">
                                                진행 중인 분석이 끝난 뒤 다시 시작할 수 있습니다.
                                            </p>
                                        )}
                                        {apiBase && (
                                            <p className="mt-2 text-xs text-muted-foreground">
                                                연결 주소: {apiBase}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        variant="outline"
                                        onClick={() => void handleRestartBackend()}
                                        disabled={!canRestartBackend}
                                        title={analysisActive ? '진행 중인 분석이 끝난 뒤 다시 시작할 수 있습니다.' : '분석 서버를 다시 시작합니다.'}
                                    >
                                        <RefreshCw size={16} className={isRestartingBackend ? 'animate-spin' : ''} />
                                        {isRestartingBackend ? '재시작 중...' : '서버 재시작'}
                                    </Button>
                                </div>
                            )}

                            <div className="grid grid-cols-1 gap-3">
                                {userVisibleModels.map(model => (
                                    <div key={model.key} className="rounded-md border border-border bg-muted/20 p-4">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <div className="font-medium text-foreground">{getUserModelLabel(model)}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">회의록 분석에 필요합니다.</div>
                                            </div>
                                            <span className={`status-pill ${model.installed ? 'status-success' : 'status-warning'}`}>
                                                {model.installed ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                                                {model.installed ? '준비됨' : '필요함'}
                                            </span>
                                        </div>

                                        {!model.installed && (
                                            <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                                필요한 파일을 `models` 폴더에 넣은 뒤 상태 새로고침을 누르세요.
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

                    {activeTab === 'advanced' && (
                        <section id="settings-advanced-panel" role="tabpanel" aria-labelledby="settings-advanced-tab" className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h3 className="section-title">고급 분석 설정</h3>
                                    <p className="section-description">분석 결과를 비교하거나 문제가 있을 때만 조정하세요.</p>
                                </div>
                                <Button onClick={handleSaveSettings} disabled={!canSaveSettings}>
                                    {isSaving ? '저장 중...' : '저장'}
                                </Button>
                            </div>

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">분석 장치</span>
                                <select
                                    value={sttDevice}
                                    onChange={event => setSttDevice(event.target.value as typeof sttDevice)}
                                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2"
                                >
                                    <option value="cpu">CPU 기본 사용</option>
                                    <option value="cuda" disabled={!gpuUsable}>GPU 가속 사용</option>
                                </select>
                                <span className="mt-2 block text-sm text-muted-foreground">
                                    기본값은 CPU입니다. GPU는 NVIDIA GPU와 CUDA 실행 조건이 모두 준비된 경우에만 켤 수 있습니다.
                                </span>
                                <span className="mt-2 block text-xs text-muted-foreground">
                                    {gpuUsable
                                        ? '이 PC는 GPU 가속 조건을 충족했습니다. 필요할 때만 GPU를 사용하세요.'
                                        : gpuDetected
                                            ? `GPU를 찾았지만 아직 바로 쓰지 않습니다. ${gpuReason}`
                                            : gpuReason}
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

                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
