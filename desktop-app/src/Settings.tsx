import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, Trash2, X } from 'lucide-react';
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

const DEFAULT_SUMMARY_MODEL_OPTIONS: SummaryModelOption[] = [
    {
        model: 'gemma4:e2b',
        label: '권장 2B',
        description: '용량과 속도를 우선할 때 사용합니다.',
        url: 'https://ollama.com/library/gemma4%3Ae2b',
        command: 'ollama run gemma4:e2b',
        source: 'recommended',
    },
    {
        model: 'gemma4:e4b',
        label: '선택 4B',
        description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.',
        url: 'https://ollama.com/library/gemma4%3Ae4b',
        command: 'ollama run gemma4:e4b',
        source: 'recommended',
    },
];

const SUMMARY_MODEL_ALIASES: Record<string, string> = {
    'gemma4:2b': 'gemma4:e2b',
    'gemma4:4b': 'gemma4:e4b',
};

const normalizeSummaryModelName = (model?: string): string => {
    const trimmed = (model || '').trim();
    return SUMMARY_MODEL_ALIASES[trimmed] || trimmed;
};

const isLocalSummaryModel = (model?: string): boolean => {
    const value = (model || '').trim();
    return Boolean(
        value
        && (
            value.startsWith('.')
            || value.includes('\\')
            || /^[A-Za-z]:/.test(value)
            || value.endsWith('.gguf')
            || value.endsWith('.bin')
        ),
    );
};

const isOllamaSummaryModel = (model?: string): boolean => Boolean(model && !isLocalSummaryModel(model));

interface SummaryModelOption {
    model?: string;
    label?: string;
    description?: string;
    url?: string;
    command?: string;
    source?: 'recommended' | 'user' | 'installed' | 'configured';
    managed_by_app?: boolean;
}

interface ModelStatus {
    key: string;
    label: string;
    repo_id: string | null;
    path: string;
    configured_model?: string;
    installed_model?: string;
    installed_models?: string[];
    installed: boolean;
    required: boolean;
    gated: boolean;
    requires_token: boolean;
    token_available: boolean;
    license_name: string;
    license_url: string;
    manual_note: string;
    install_url?: string;
    install_command?: string;
    install_options?: SummaryModelOption[];
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
        model_options?: SummaryModelOption[];
        user_models?: SummaryModelOption[];
    };
    diarization?: {
        enabled?: boolean;
        generate_during_analysis?: boolean;
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
    system_profile?: {
        memory_gb?: number | null;
    };
    summary_model_recommendation?: {
        model: string;
        basis?: string;
        message?: string;
    };
    stt_device_status?: {
        selected_device_allowed?: string[];
        recommended_device?: 'cpu' | 'cuda';
        gpu_detected?: boolean;
        gpu_usable?: boolean;
        gpu_reason?: string;
    };
    errors?: string[];
}

interface OllamaPullStatus {
    model: string;
    active: boolean;
    status: 'idle' | 'starting' | 'running' | 'completed' | 'failed';
    message: string;
    started_at?: string;
    updated_at?: string;
    exit_code?: number | null;
    error?: string;
}

interface SettingsProps {
    onClose: () => void;
    analysisActive?: boolean;
    initialTab?: SettingsTab;
}

export type SettingsTab = 'general' | 'models';

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_faster_whisper') return '음성 인식 모델';
    if (model.key === 'diarization') return '참석자 구분';
    if (model.key === 'llm') return '회의 요약';
    return model.label;
};

const getModelUsageText = (model: ModelStatus): string => {
    if (model.key === 'llm') return '전체 요약과 주제별 정리에 사용합니다.';
    if (model.key === 'stt_faster_whisper') return '대화록 작성에 필요합니다.';
    if (model.key === 'diarization') return '참석자 구분을 사용할 때 필요합니다.';
    return '회의록 분석에 필요합니다.';
};

const getModelStatusFailureMessage = (error: unknown): string => {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return isTimeout
        ? '앱 안의 분석 프로그램이 모델과 GPU 상태 요청에 늦게 응답하고 있습니다. 잠시 후 자동으로 다시 확인합니다.'
        : '앱 안의 분석 프로그램에서 모델과 GPU 상태를 확인하지 못했습니다. 잠시 후 자동으로 다시 확인합니다.';
};

const getSettingsFailureMessage = (error: unknown): string => {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return isTimeout
        ? '앱 안의 분석 프로그램 응답이 지연되어 설정을 불러오지 못했습니다. 잠시 후 자동으로 다시 확인합니다.'
        : '앱 안의 분석 프로그램에 연결하지 못해 설정을 불러오지 못했습니다. 데스크톱 앱이면 일반 탭의 서버 재시작을 사용해 주세요.';
};

const formatMemoryGb = (memoryGb?: number | null): string => {
    if (typeof memoryGb !== 'number' || !Number.isFinite(memoryGb) || memoryGb <= 0) {
        return '';
    }
    return Number.isInteger(memoryGb) ? `${memoryGb}GB` : `${memoryGb.toFixed(1)}GB`;
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

export const Settings: React.FC<SettingsProps> = ({ onClose, analysisActive = false, initialTab = 'general' }) => {
    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    const [apiBase, setApiBase] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isRestartingBackend, setIsRestartingBackend] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [modelStatusErrorMessage, setModelStatusErrorMessage] = useState('');
    const [diarizationDuringAnalysis, setDiarizationDuringAnalysis] = useState(false);
    const [sttDevice, setSttDevice] = useState<'cpu' | 'cuda'>('cpu');
    const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>(DEFAULT_DOWNLOAD_FORMAT);
    const [preprocessingEnabled, setPreprocessingEnabled] = useState(true);
    const [preserveExtractedAudio, setPreserveExtractedAudio] = useState(true);
    const [autoSaveHwpxCopy, setAutoSaveHwpxCopy] = useState(false);
    const [autoSaveAudioCopy, setAutoSaveAudioCopy] = useState(false);
    const [summaryModelInput, setSummaryModelInput] = useState('');
    const [customSummaryModelInput, setCustomSummaryModelInput] = useState('');
    const [ollamaPulls, setOllamaPulls] = useState<Record<string, OllamaPullStatus>>({});
    const [deletingOllamaModels, setDeletingOllamaModels] = useState<Record<string, boolean>>({});
    const [lastModelStatusCheck, setLastModelStatusCheck] = useState('');
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const mountedRef = useRef(true);
    const modelStatusRequestIdRef = useRef(0);
    const pullRequestIdsRef = useRef<Record<string, number>>({});
    const lastSavedGeneralKeyRef = useRef('');

    const analysisModels = useMemo(
        () => (models?.models || []).filter(
            model => model.key === 'stt_faster_whisper' || model.key === 'diarization',
        ),
        [models],
    );
    const summaryModelStatus = useMemo(
        () => (models?.models || []).find(model => model.key === 'llm') || null,
        [models],
    );
    const summaryModelOptions = useMemo(() => {
        const recommendedModel = models?.summary_model_recommendation?.model || DEFAULT_SUMMARY_MODEL_OPTIONS[0]?.model || '';
        const configuredModel = normalizeSummaryModelName(summaryModelStatus?.configured_model || settings?.summary?.model);
        const baseOptions = [
            ...DEFAULT_SUMMARY_MODEL_OPTIONS,
            ...(settings?.summary?.model_options || []),
            ...(settings?.summary?.user_models || []),
            ...(summaryModelStatus?.install_options || []),
        ];
        const configuredOption: SummaryModelOption[] = configuredModel && !baseOptions.some(option => option.model === configuredModel)
            ? [{
                model: configuredModel,
                label: isLocalSummaryModel(configuredModel) ? '현재 로컬 모델' : '현재 설정',
                description: isLocalSummaryModel(configuredModel)
                    ? '기존 설정에 저장된 로컬 요약 모델 파일입니다.'
                    : '현재 설정에 저장된 요약 모델입니다.',
                source: 'configured' as const,
            }]
            : [];
        const options = [...configuredOption, ...baseOptions];
        const seen = new Set<string>();
        const filtered = options.filter(option => {
            const model = normalizeSummaryModelName(option.model);
            if (!model || seen.has(model)) return false;
            seen.add(model);
            return true;
        });
        return filtered.sort((left, right) => {
            if (left.model === recommendedModel) return -1;
            if (right.model === recommendedModel) return 1;
            return 0;
        });
    }, [models?.summary_model_recommendation?.model, settings, summaryModelStatus]);

    const applySettingsToForm = useCallback((nextSettings: SettingsPayload) => {
        setDiarizationDuringAnalysis(nextSettings.diarization?.generate_during_analysis ?? false);
        setSttDevice(nextSettings.stt?.device === 'cuda' ? 'cuda' : 'cpu');
        setPreprocessingEnabled(nextSettings.preprocessing?.enabled ?? true);
        setPreserveExtractedAudio(nextSettings.privacy?.preserve_extracted_audio ?? true);
        setAutoSaveHwpxCopy(nextSettings.privacy?.auto_save_hwpx_copy ?? false);
        setAutoSaveAudioCopy(nextSettings.privacy?.auto_save_audio_copy ?? false);
        const nextSummaryModel = normalizeSummaryModelName(nextSettings.summary?.model);
        setSummaryModelInput(nextSummaryModel);
    }, []);

    const generalSettingsKey = useCallback((values: {
        downloadFormat: DownloadFormat;
        diarizationDuringAnalysis: boolean;
        sttDevice: 'cpu' | 'cuda';
        preprocessingEnabled: boolean;
        preserveExtractedAudio: boolean;
        autoSaveHwpxCopy: boolean;
        autoSaveAudioCopy: boolean;
    }) => JSON.stringify(values), []);

    useEffect(() => {
        if (!preserveExtractedAudio) {
            setAutoSaveAudioCopy(false);
        }
    }, [preserveExtractedAudio]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            modelStatusRequestIdRef.current += 1;
            pullRequestIdsRef.current = {};
        };
    }, []);

    const loadModelsStatus = useCallback(async (base: string, options: { surfaceErrors?: boolean } = {}): Promise<ModelsPayload | null> => {
        const requestId = modelStatusRequestIdRef.current + 1;
        modelStatusRequestIdRef.current = requestId;
        try {
            const modelsResponse = await fetchWithTimeout(`${base}/api/models/status`);
            if (!modelsResponse.ok) {
                throw new Error(`models=${modelsResponse.status}`);
            }
            const nextModels = await modelsResponse.json() as ModelsPayload;
            if (!mountedRef.current || modelStatusRequestIdRef.current !== requestId) {
                return null;
            }
            setModels(nextModels);
            setModelStatusErrorMessage('');
            setErrorMessage(previous => (
                previous.includes('분석 기능에 연결')
                || previous.includes('모델 상태')
                || previous.includes('분석 기능 응답')
                    ? ''
                    : previous
            ));
            setLastModelStatusCheck(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
            window.dispatchEvent(new Event('analysis:settings-updated'));
            return nextModels;
        } catch (error) {
            if (!mountedRef.current || modelStatusRequestIdRef.current !== requestId) {
                return null;
            }
            if (options.surfaceErrors !== false) {
                setModels(null);
            }
            setModelStatusErrorMessage(getModelStatusFailureMessage(error));
            return null;
        }
    }, []);

    const updateOllamaPullStatus = useCallback((status: OllamaPullStatus) => {
        setOllamaPulls(previous => ({ ...previous, [status.model]: status }));
    }, []);

    const isCurrentPullRequest = useCallback((modelName: string, requestId: number) => (
        mountedRef.current && pullRequestIdsRef.current[modelName] === requestId
    ), []);

    const pollOllamaPullStatus = useCallback(async (base: string, modelName: string, requestId: number) => {
        for (let attempt = 0; attempt < 600; attempt += 1) {
            await new Promise(resolve => window.setTimeout(resolve, 2000));
            if (!isCurrentPullRequest(modelName, requestId)) return;
            const response = await fetchWithTimeout(`${base}/api/models/ollama/pull-status?model=${encodeURIComponent(modelName)}`);
            if (!response.ok) throw new Error(`pull-status=${response.status}`);
            const status = await response.json() as OllamaPullStatus;
            if (!isCurrentPullRequest(modelName, requestId)) return;
            updateOllamaPullStatus(status);
            if (!status.active) {
                if (status.status === 'completed') {
                    await loadModelsStatus(base, { surfaceErrors: false });
                    if (!isCurrentPullRequest(modelName, requestId)) return;
                    setMessage(status.message || '모델 받기가 완료되었습니다.');
                } else if (status.status === 'failed') {
                    setErrorMessage(status.message || '모델을 받지 못했습니다.');
                }
                return;
            }
        }
        throw new Error('모델 받기 상태 확인 시간이 초과되었습니다.');
    }, [isCurrentPullRequest, loadModelsStatus, updateOllamaPullStatus]);

    const handleDownloadOllamaModel = useCallback(async (modelName?: string) => {
        const targetModel = normalizeSummaryModelName(modelName || summaryModelInput);
        if (!targetModel) {
            setErrorMessage('받을 모델명을 입력해 주세요.');
            return;
        }

        setErrorMessage('');
        setMessage('');
        const requestId = (pullRequestIdsRef.current[targetModel] || 0) + 1;
        pullRequestIdsRef.current[targetModel] = requestId;
        try {
            const base = apiBase || await getApiBase();
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            setApiBase(base);
            const response = await fetchWithTimeout(`${base}/api/models/ollama/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: targetModel }),
            });
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.detail || `모델 받기 시작 실패: ${response.status}`);
            }
            const status = await response.json() as OllamaPullStatus;
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            updateOllamaPullStatus(status);
            if (status.active) {
                setMessage(status.message || `${targetModel} 모델을 받는 중입니다.`);
                void pollOllamaPullStatus(base, targetModel, requestId).catch(error => {
                    if (!isCurrentPullRequest(targetModel, requestId)) return;
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            } else if (status.status === 'completed') {
                await loadModelsStatus(base, { surfaceErrors: false });
                if (!isCurrentPullRequest(targetModel, requestId)) return;
                setMessage(status.message || `${targetModel} 모델이 준비되었습니다.`);
            } else {
                setErrorMessage(status.message || `${targetModel} 모델을 받지 못했습니다.`);
            }
        } catch (error) {
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            setErrorMessage(error instanceof Error ? error.message : '모델 받기를 시작하지 못했습니다.');
        }
    }, [apiBase, isCurrentPullRequest, loadModelsStatus, pollOllamaPullStatus, summaryModelInput, updateOllamaPullStatus]);

    const handleDeleteOllamaModel = useCallback(async (modelName: string, deleteFiles = false) => {
        const targetModel = normalizeSummaryModelName(modelName);
        if (!targetModel) return;
        const confirmMessage = deleteFiles
            ? `${targetModel} 모델을 이 PC의 Ollama 저장소에서 삭제할까요? 다른 앱에서 같은 모델을 사용 중이면 다시 받아야 합니다.`
            : `${targetModel} 모델을 앱의 추가한 모델 목록에서 제거할까요? PC에 설치된 모델 파일은 삭제하지 않습니다.`;
        if (!window.confirm(confirmMessage)) {
            return;
        }

        setErrorMessage('');
        setMessage('');
        setDeletingOllamaModels(previous => ({ ...previous, [targetModel]: true }));
        try {
            const base = apiBase || await getApiBase();
            setApiBase(base);
            const response = await fetchWithTimeout(`${base}/api/models/ollama/model?model=${encodeURIComponent(targetModel)}${deleteFiles ? '&delete_files=true' : ''}`, {
                method: 'DELETE',
            });
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.detail || `모델 삭제 실패: ${response.status}`);
            }
            const payload = await response.json() as { message?: string };
            const settingsResponse = await fetchWithTimeout(`${base}/api/settings`);
            if (settingsResponse.ok) {
                const nextSettings = await settingsResponse.json() as SettingsPayload;
                setSettings(nextSettings);
                applySettingsToForm(nextSettings);
            }
            await loadModelsStatus(base, { surfaceErrors: false });
            setMessage(payload.message || (deleteFiles ? `${targetModel} 모델을 삭제했습니다.` : `${targetModel} 모델을 목록에서 제거했습니다.`));
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '모델 목록 변경 중 오류가 발생했습니다.');
        } finally {
            setDeletingOllamaModels(previous => ({ ...previous, [targetModel]: false }));
        }
    }, [apiBase, applySettingsToForm, loadModelsStatus]);

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
            lastSavedGeneralKeyRef.current = generalSettingsKey({
                downloadFormat: getDownloadFormatPreference(),
                diarizationDuringAnalysis: nextSettings.diarization?.generate_during_analysis ?? false,
                sttDevice: nextSettings.stt?.device === 'cuda' ? 'cuda' : 'cpu',
                preprocessingEnabled: nextSettings.preprocessing?.enabled ?? true,
                preserveExtractedAudio: nextSettings.privacy?.preserve_extracted_audio ?? true,
                autoSaveHwpxCopy: nextSettings.privacy?.auto_save_hwpx_copy ?? false,
                autoSaveAudioCopy: nextSettings.privacy?.auto_save_audio_copy ?? false,
            });
            const nextModels = await loadModelsStatus(base);
            return Boolean(nextModels);
        } catch (error) {
            setSettings(null);
            setModels(null);
            setModelStatusErrorMessage('');
            setErrorMessage(getSettingsFailureMessage(error));
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [applySettingsToForm, generalSettingsKey, loadModelsStatus]);

    useEffect(() => {
        setDownloadFormat(getDownloadFormatPreference());
        void loadSettings();
    }, [loadSettings]);

    useEffect(() => {
        if (settings || isLoading || !errorMessage.includes('설정을 불러오지 못했습니다')) return;
        const timeoutId = window.setTimeout(() => {
            void loadSettings();
        }, 5000);
        return () => window.clearTimeout(timeoutId);
    }, [errorMessage, isLoading, loadSettings, settings]);

    useEffect(() => {
        if (activeTab !== 'models' || !apiBase) return;
        const intervalId = window.setInterval(() => {
            void loadModelsStatus(apiBase, { surfaceErrors: false });
        }, 5000);
        return () => window.clearInterval(intervalId);
    }, [activeTab, apiBase, loadModelsStatus]);

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

    const saveGeneralSettings = useCallback(async () => {
        if (!settings) {
            setErrorMessage('설정을 아직 불러오지 못했습니다. 잠시 후 다시 저장해 주세요.');
            return;
        }

        setIsSaving(true);
        setSaveState('saving');
        setErrorMessage('');
        setMessage('');
        try {
            const base = apiBase || await getApiBase();
            const response = await fetchWithTimeout(`${base}/api/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    diarization: {
                        generate_during_analysis: diarizationDuringAnalysis,
                    },
                    stt: {
                        selected_model: 'faster-whisper-large-v3',
                        device: sttDevice,
                    },
                    preprocessing: {
                        enabled: preprocessingEnabled,
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
            lastSavedGeneralKeyRef.current = generalSettingsKey({
                downloadFormat,
                diarizationDuringAnalysis,
                sttDevice,
                preprocessingEnabled,
                preserveExtractedAudio,
                autoSaveHwpxCopy,
                autoSaveAudioCopy,
            });
            setSaveState('saved');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
            setSaveState('idle');
        } finally {
            setIsSaving(false);
        }
    }, [
        apiBase,
        applySettingsToForm,
        autoSaveAudioCopy,
        autoSaveHwpxCopy,
        diarizationDuringAnalysis,
        downloadFormat,
        generalSettingsKey,
        loadModelsStatus,
        preserveExtractedAudio,
        preprocessingEnabled,
        settings,
        sttDevice,
    ]);

    const handleSaveSummaryModel = useCallback(async (modelOverride?: string) => {
        if (!settings) {
            setErrorMessage('설정을 아직 불러오지 못했습니다. 잠시 후 다시 저장해 주세요.');
            return;
        }

        setIsSaving(true);
        setSaveState('saving');
        setErrorMessage('');
        setMessage('');
        try {
            const summaryModel = normalizeSummaryModelName(modelOverride ?? summaryModelInput);
            if (!summaryModel) {
                throw new Error('회의 요약 모델명을 입력하거나 권장 모델을 선택해 주세요.');
            }
            const base = apiBase || await getApiBase();
            const response = await fetchWithTimeout(`${base}/api/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    summary: {
                        provider: 'ollama',
                        model: summaryModel,
                    },
                }),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.detail || `요약 모델 저장 실패: ${response.status}`);
            }

            const nextSettings = await response.json() as SettingsPayload;
            setSettings(nextSettings);
            applySettingsToForm(nextSettings);
            await loadModelsStatus(base, { surfaceErrors: false });
            setSaveState('saved');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '요약 모델 저장 중 오류가 발생했습니다.');
            setSaveState('idle');
        } finally {
            setIsSaving(false);
        }
    }, [apiBase, applySettingsToForm, loadModelsStatus, settings, summaryModelInput]);

    useEffect(() => {
        if (!settings || isLoading || isSaving || isRestartingBackend) return;
        const nextKey = generalSettingsKey({
            downloadFormat,
            diarizationDuringAnalysis,
            sttDevice,
            preprocessingEnabled,
            preserveExtractedAudio,
            autoSaveHwpxCopy,
            autoSaveAudioCopy,
        });
        if (nextKey === lastSavedGeneralKeyRef.current) return;
        const timeoutId = window.setTimeout(() => {
            void saveGeneralSettings();
        }, 600);
        return () => window.clearTimeout(timeoutId);
    }, [
        autoSaveAudioCopy,
        autoSaveHwpxCopy,
        diarizationDuringAnalysis,
        downloadFormat,
        generalSettingsKey,
        isLoading,
        isRestartingBackend,
        isSaving,
        preserveExtractedAudio,
        preprocessingEnabled,
        saveGeneralSettings,
        settings,
        sttDevice,
    ]);

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
            setMessage(
                ready
                    ? '분석 서버를 다시 시작하고 상태를 확인했습니다.'
                    : '분석 서버를 다시 시작했습니다. 모델 상태는 잠시 후 자동으로 다시 확인합니다.',
            );
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '분석 서버를 다시 시작하지 못했습니다.');
        } finally {
            setIsRestartingBackend(false);
        }
    };

    const tabs: Array<{ key: SettingsTab; label: string }> = [
        { key: 'general', label: '일반' },
        { key: 'models', label: '모델' },
    ];
    const canRestartBackend = isTauriRuntime() && !analysisActive && !isLoading && !isSaving && !isRestartingBackend;
    const gpuUsable = Boolean(models?.stt_device_status?.gpu_usable);
    const gpuDetected = Boolean(models?.stt_device_status?.gpu_detected);
    const gpuReason = models?.stt_device_status?.gpu_reason || 'CPU를 기본으로 사용합니다.';
    const selectedSummaryModel = normalizeSummaryModelName(summaryModelInput);
    const selectedSummaryPull = selectedSummaryModel ? ollamaPulls[selectedSummaryModel] : undefined;
    const installedSummaryModels = new Set(
        (summaryModelStatus?.installed_models?.length
            ? summaryModelStatus.installed_models
            : summaryModelStatus?.installed_model
                ? [summaryModelStatus.installed_model]
                : summaryModelStatus?.installed && summaryModelStatus.configured_model
                    ? [summaryModelStatus.configured_model]
                    : []
        ).map(normalizeSummaryModelName),
    );
    const configuredSummaryModel = normalizeSummaryModelName(settings?.summary?.model);
    const selectedSummaryInstalled = Boolean(selectedSummaryModel && installedSummaryModels.has(selectedSummaryModel));
    const isSummaryOptionInstalled = (modelName?: string) => Boolean(modelName && installedSummaryModels.has(modelName));
    const selectedSummaryCanPull = summaryModelOptions.some(option => normalizeSummaryModelName(option.model) === selectedSummaryModel && isOllamaSummaryModel(option.model));
    const customSummaryModel = normalizeSummaryModelName(customSummaryModelInput);
    const customSummaryInstalled = Boolean(customSummaryModel && installedSummaryModels.has(customSummaryModel));
    const customSummaryPull = customSummaryModel ? ollamaPulls[customSummaryModel] : undefined;
    const customSummaryPullActive = Boolean(customSummaryPull?.active);
    const gpuStatusText = gpuUsable
        ? '이 PC는 GPU 가속을 사용할 수 있습니다.'
        : gpuDetected
            ? `GPU는 감지됐지만 CUDA 런타임이 필요합니다. ${gpuReason}`
            : gpuReason;
    const systemMemoryLabel = formatMemoryGb(models?.system_profile?.memory_gb);
    const recommendationLabel = systemMemoryLabel ? `메모리 ${systemMemoryLabel} 기준 권장` : '메모리 기준 권장';
    const recommendedSummaryModel = models?.summary_model_recommendation?.model || summaryModelOptions[0]?.model || '';
    const recommendationMessage = models?.summary_model_recommendation?.message || '';
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[var(--bg-overlay)] p-4">
            <div className="relative flex max-h-[88vh] min-h-[360px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
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

                {(errorMessage || message) && (
                    <div className="pointer-events-none absolute right-5 top-[8.5rem] z-20 flex w-[calc(100%-2.5rem)] max-w-xl flex-col gap-2">
                        {errorMessage && (
                            <StatusBanner tone="error" heading="설정 확인 실패">
                                {errorMessage}
                            </StatusBanner>
                        )}
                        {message && (
                            <StatusBanner tone="neutral">
                                {message}
                            </StatusBanner>
                        )}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
                    {activeTab === 'general' && (
                        <section id="settings-general-panel" role="tabpanel" aria-labelledby="settings-general-tab" className="flex flex-col gap-3">
                            {saveState !== 'idle' && (
                                <div className="flex justify-end text-xs text-muted-foreground">
                                    {saveState === 'saving' ? '저장 중' : '저장됨'}
                                </div>
                            )}

                            <div className="grid gap-3 lg:grid-cols-2">
                                <label className="rounded-md border border-border bg-muted/20 p-3">
                                    <span className="block text-sm font-medium text-foreground">다운로드 형식</span>
                                    <select
                                        value={downloadFormat}
                                        onChange={event => setDownloadFormat(event.target.value as DownloadFormat)}
                                        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2"
                                    >
                                        <option value="hwpx">HWPX</option>
                                        <option value="docx">DOCX</option>
                                        <option value="txt">TXT</option>
                                        <option value="md">MD</option>
                                    </select>
                                </label>

                                <label className="rounded-md border border-border bg-muted/20 p-3">
                                    <span className="block text-sm font-medium text-foreground">분석 장치</span>
                                    <select
                                        value={sttDevice}
                                        onChange={event => setSttDevice(event.target.value as typeof sttDevice)}
                                        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2"
                                    >
                                        <option value="cpu">CPU 기본 사용</option>
                                        <option value="cuda" disabled={!gpuUsable}>GPU 가속 사용</option>
                                    </select>
                                    <span className="mt-1 block text-xs text-muted-foreground">
                                        {modelStatusErrorMessage || gpuStatusText}
                                    </span>
                                </label>
                            </div>

                            <div className="grid gap-3 lg:grid-cols-2">
                                <label className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={diarizationDuringAnalysis}
                                        onChange={event => setDiarizationDuringAnalysis(event.target.checked)}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-foreground">참석자 구분까지 진행</span>
                                        <span className="text-xs text-muted-foreground">대화록 뒤에 바로 이어서 실행합니다.</span>
                                    </span>
                                </label>

                                <label className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={preprocessingEnabled}
                                        onChange={event => setPreprocessingEnabled(event.target.checked)}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-foreground">음성 정리</span>
                                        <span className="text-xs text-muted-foreground">분석하기 좋은 형태로 정리합니다.</span>
                                    </span>
                                </label>

                                <div className="rounded-md border border-border bg-muted/20 p-3">
                                    <label className="flex items-start gap-3">
                                        <input
                                            type="checkbox"
                                            className="mt-1"
                                            checked={preserveExtractedAudio}
                                            onChange={event => setPreserveExtractedAudio(event.target.checked)}
                                        />
                                        <span>
                                            <span className="block text-sm font-medium text-foreground">음성 재생 파일 보관</span>
                                            <span className="text-xs text-muted-foreground">다시 듣기와 나중에 참석자 구분에 사용합니다.</span>
                                        </span>
                                    </label>
                                    <label className="mt-3 flex items-start gap-3 border-t border-border/70 pt-3">
                                        <input
                                            type="checkbox"
                                            className="mt-1"
                                            checked={autoSaveAudioCopy}
                                            onChange={event => setAutoSaveAudioCopy(event.target.checked)}
                                            disabled={!preserveExtractedAudio}
                                        />
                                        <span>
                                            <span className="block text-sm font-medium text-foreground">음성 파일 자동 저장</span>
                                            <span className="text-xs text-muted-foreground">보관한 음성을 다운로드 폴더에도 저장합니다.</span>
                                        </span>
                                    </label>
                                </div>

                                <label className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={autoSaveHwpxCopy}
                                        onChange={event => setAutoSaveHwpxCopy(event.target.checked)}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-foreground">HWPX 자동 저장</span>
                                        <span className="text-xs text-muted-foreground">분석 후 회의록 파일을 다운로드 폴더에 저장합니다.</span>
                                    </span>
                                </label>
                            </div>

                            {isTauriRuntime() && (
                                <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <div className="text-sm font-medium text-foreground">문제 해결</div>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            분석 기능이 응답하지 않을 때만 서버를 다시 시작하세요.
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
                        </section>
                    )}

                    {activeTab === 'models' && (
                        <section id="settings-models-panel" role="tabpanel" aria-labelledby="settings-models-tab" className="flex flex-col gap-4">
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="flex flex-col gap-1">
                                    <div className="text-base font-semibold text-foreground">분석 필수 모델</div>
                                    {modelStatusErrorMessage ? (
                                        <div className="text-xs text-muted-foreground">
                                            상태 확인 실패. 앱 안의 분석 프로그램 응답을 기다리고 있습니다.
                                        </div>
                                    ) : lastModelStatusCheck && (
                                        <div className="text-xs text-muted-foreground">자동 확인 {lastModelStatusCheck}</div>
                                    )}
                                </div>

                                {isLoading && !models ? (
                                    <div className="mt-3 rounded-md border border-border bg-background p-4 text-center text-sm text-muted-foreground">
                                        모델 상태를 불러오는 중입니다.
                                    </div>
                                ) : analysisModels.length > 0 ? (
                                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                        {analysisModels.map(model => {
                                            const modelUrl = model.install_url || model.license_url || '';
                                            const modelName = model.repo_id || model.label;
                                            return (
                                                <div key={model.key} className="rounded-md border border-border bg-background p-3 text-sm">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="text-sm font-semibold text-foreground">{getUserModelLabel(model)}</div>
                                                            {modelUrl ? (
                                                                <div className="mt-1">
                                                                    <a
                                                                        href={modelUrl}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="block break-all text-xs font-medium text-primary hover:underline"
                                                                        aria-label={`${modelName} 모델 페이지`}
                                                                    >
                                                                        {modelName}
                                                                    </a>
                                                                    {!model.installed && (
                                                                        <span className="mt-0.5 block text-[11px] text-muted-foreground">모델 페이지에서 받아 안내된 폴더에 넣어 주세요.</span>
                                                                    )}
                                                                </div>
                                                            ) : (
                                                                <span className="mt-1 block break-all text-xs font-medium text-muted-foreground">{modelName}</span>
                                                            )}
                                                            <div className="mt-1 text-xs text-muted-foreground">{getModelUsageText(model)}</div>
                                                        </div>
                                                        <span className={`status-pill status-${model.installed ? 'success' : 'warning'} shrink-0`}>
                                                            {model.installed ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                                                            {model.installed ? '준비됨' : '받기 필요'}
                                                        </span>
                                                    </div>
                                                    {!model.installed && (
                                                        <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                                            <div>{model.manual_note || '필요한 파일을 models 폴더에 넣으면 자동으로 확인합니다.'}</div>
                                                            {model.requires_token && (
                                                                <div className="mt-1">Hugging Face 로그인과 사용 동의가 필요할 수 있습니다.</div>
                                                            )}
                                                            {model.install_command && (
                                                                <div className="mt-2 font-mono text-[11px] text-foreground">{model.install_command}</div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
                                        {modelStatusErrorMessage || errorMessage
                                            ? '모델 파일이 없다는 뜻은 아닙니다. 앱 안의 분석 프로그램 연결이 회복되면 자동으로 다시 확인합니다.'
                                            : '필수 모델 상태를 아직 확인하지 못했습니다.'}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="flex flex-col gap-1">
                                    <div>
                                        <div className="text-base font-semibold text-foreground">회의 요약 모델</div>
                                    </div>
                                </div>

                                {summaryModelOptions.length > 0 && (
                                    <label className="mt-4 block">
                                        <span className="text-xs font-semibold text-muted-foreground">모델 선택</span>
                                        <div className="mt-2">
                                            <select
                                                value={summaryModelInput}
                                                onChange={event => setSummaryModelInput(event.target.value)}
                                                className="w-full rounded-md border border-input bg-background px-3 py-2"
                                            >
                                                {summaryModelOptions.map(option => (
                                                    <option key={option.model} value={option.model}>
                                                        {option.model === recommendedSummaryModel ? `${option.model} (${recommendationLabel})` : option.model}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        {recommendationMessage && (
                                            <span className="mt-2 block text-xs text-muted-foreground">{recommendationMessage}</span>
                                        )}
                                        {selectedSummaryModel && !selectedSummaryInstalled && (
                                            <span className="mt-2 block text-xs text-muted-foreground">
                                                {selectedSummaryCanPull
                                                    ? '선택한 모델은 아직 준비되지 않았습니다. 아래 카드에서 받기를 누르면 완료 후 사용할 수 있습니다.'
                                                    : '선택한 모델은 아직 준비되지 않았습니다. 설치 안내를 확인해 주세요.'}
                                            </span>
                                        )}
                                    </label>
                                )}
                                {selectedSummaryPull?.message && (
                                    <div className="mt-2 text-xs text-muted-foreground">{selectedSummaryPull.message}</div>
                                )}
                                {summaryModelOptions.length > 0 && (
                                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                        {summaryModelOptions.map((option, index) => {
                                            const optionModel = normalizeSummaryModelName(option.model);
                                            const pullStatus = optionModel ? ollamaPulls[optionModel] : undefined;
                                            const pullActive = Boolean(pullStatus?.active);
                                            const optionCanPull = isOllamaSummaryModel(optionModel);
                                            const optionInstalled = isSummaryOptionInstalled(optionModel);
                                            const optionName = option.model || option.label || '모델';
                                            const optionSelected = Boolean(optionModel && optionModel === configuredSummaryModel);
                                            const optionRecommended = Boolean(optionModel && optionModel === recommendedSummaryModel);
                                            const optionDeleting = Boolean(optionModel && deletingOllamaModels[optionModel]);
                                            const optionRemovable = option.source === 'user' && !optionSelected;
                                            const optionFileDeletable = Boolean(option.managed_by_app && optionInstalled && optionCanPull && !optionSelected);
                                            return (
                                                <div key={optionModel || option.url || option.command || `summary-model-${index}`} className="rounded-md border border-border bg-background p-3 text-sm">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                {option.url ? (
                                                                    <a
                                                                        href={option.url}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        aria-label={`${optionName} 모델 페이지`}
                                                                        className="block break-all text-sm font-semibold text-primary hover:underline"
                                                                    >
                                                                        {optionName}
                                                                    </a>
                                                                ) : (
                                                                    <span className="block break-all text-sm font-semibold text-foreground">{optionName}</span>
                                                                )}
                                                                {optionRecommended && <span className="status-pill status-neutral">{recommendationLabel}</span>}
                                                            </div>
                                                            {option.label && option.label !== optionName && <span className="mt-0.5 block text-xs font-medium text-muted-foreground">{option.label}</span>}
                                                            {option.description && <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>}
                                                        </div>
                                                        {optionSelected && optionInstalled ? (
                                                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                                <span className="status-pill status-success">
                                                                    <CheckCircle2 size={13} />
                                                                    사용 중
                                                                </span>
                                                                {optionCanPull && (
                                                                    <Button
                                                                        variant="outline"
                                                                        className="h-8 shrink-0 px-3 text-xs"
                                                                        aria-label={`${optionName} 모델 다시 받기`}
                                                                        onClick={() => void handleDownloadOllamaModel(optionModel)}
                                                                        disabled={pullActive}
                                                                    >
                                                                        {pullActive ? '확인 중' : '다시 받기'}
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        ) : optionInstalled ? (
                                                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                                <Button
                                                                    className="h-8 shrink-0 px-3 text-xs"
                                                                    aria-label={`${optionName} 모델 사용`}
                                                                    onClick={() => {
                                                                        setSummaryModelInput(optionModel);
                                                                        void handleSaveSummaryModel(optionModel);
                                                                    }}
                                                                    disabled={optionDeleting || pullActive || isSaving}
                                                                >
                                                                    사용
                                                                </Button>
                                                                {optionCanPull && (
                                                                    <Button
                                                                        variant="outline"
                                                                        className="h-8 shrink-0 px-3 text-xs"
                                                                        aria-label={`${optionName} 모델 다시 받기`}
                                                                        onClick={() => void handleDownloadOllamaModel(optionModel)}
                                                                        disabled={pullActive || optionDeleting}
                                                                    >
                                                                        {pullActive ? '확인 중' : '다시 받기'}
                                                                    </Button>
                                                                )}
                                                                {(optionRemovable || optionFileDeletable) && (
                                                                    <Button
                                                                        variant="outline"
                                                                        className="h-8 shrink-0 px-3 text-xs"
                                                                        aria-label={`${optionName} ${optionFileDeletable ? 'PC 모델 삭제' : '목록 제거'}`}
                                                                        onClick={() => void handleDeleteOllamaModel(optionModel, optionFileDeletable)}
                                                                        disabled={optionDeleting || pullActive}
                                                                    >
                                                                        <Trash2 size={13} />
                                                                        {optionDeleting ? '처리 중' : optionFileDeletable ? 'PC 삭제' : '목록 제거'}
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        ) : optionModel && optionCanPull && (
                                                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                                <Button
                                                                    className="h-8 shrink-0 px-3 text-xs"
                                                                    aria-label={`${optionName} 모델 받기`}
                                                                    onClick={() => void handleDownloadOllamaModel(optionModel)}
                                                                    disabled={pullActive}
                                                                >
                                                                    {pullActive ? '받는 중' : '받기'}
                                                                </Button>
                                                                {optionRemovable && (
                                                                    <Button
                                                                        variant="outline"
                                                                        className="h-8 shrink-0 px-3 text-xs"
                                                                        aria-label={`${optionName} 목록 제거`}
                                                                        onClick={() => void handleDeleteOllamaModel(optionModel, false)}
                                                                        disabled={optionDeleting || pullActive}
                                                                    >
                                                                        <Trash2 size={13} />
                                                                        {optionDeleting ? '처리 중' : '목록 제거'}
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {pullStatus?.message && <span className="mt-2 block text-[11px] text-muted-foreground">{pullStatus.message}</span>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                <div className="mt-4 border-t border-border pt-4">
                                    <label htmlFor="custom-summary-model" className="text-xs font-semibold text-muted-foreground">다른 모델명 추가</label>
                                    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                        <input
                                            id="custom-summary-model"
                                            value={customSummaryModelInput}
                                            onChange={event => setCustomSummaryModelInput(event.target.value)}
                                            placeholder="예: llama3.2:3b"
                                            className="w-full rounded-md border border-input bg-background px-3 py-2"
                                        />
                                        <Button
                                            variant={customSummaryInstalled ? 'primary' : 'outline'}
                                            className="h-10 shrink-0 px-4"
                                            disabled={!customSummaryModel || customSummaryPullActive || (customSummaryInstalled && isSaving)}
                                            aria-label={`${customSummaryModel ? `직접 입력 ${customSummaryModel}` : '직접 입력 요약'} 모델 ${customSummaryInstalled ? '사용' : '받기'}`}
                                            onClick={() => {
                                                if (!customSummaryModel) return;
                                                setSummaryModelInput(customSummaryModel);
                                                if (customSummaryInstalled) {
                                                    void handleSaveSummaryModel(customSummaryModel);
                                                } else {
                                                    void handleDownloadOllamaModel(customSummaryModel);
                                                }
                                            }}
                                        >
                                            {!customSummaryModel
                                                ? '추가'
                                                : customSummaryPullActive
                                                    ? '받는 중'
                                                    : customSummaryInstalled
                                                        ? '사용'
                                                        : '받기'}
                                        </Button>
                                    </div>
                                    <span className="mt-2 block text-xs text-muted-foreground">Ollama에 설치된 모델명이나 받을 모델명을 입력합니다.</span>
                                    {customSummaryPull?.message && (
                                        <span className="mt-2 block text-xs text-muted-foreground">{customSummaryPull.message}</span>
                                    )}
                                </div>
                            </div>
                        </section>
                    )}

                </div>
            </div>
        </div>
    );
};
