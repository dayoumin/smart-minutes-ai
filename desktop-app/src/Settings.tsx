import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, Loader2, Mail, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { AppToast, Button, ProgressBar, StatusBanner } from './components/common';
import {
    DEFAULT_DOWNLOAD_FORMAT,
    DownloadFormat,
    getDownloadFormatPreference,
    setDownloadFormatPreference,
} from './downloadPreferences';
import { getApiBase, getDesktopActionHeaders, isTauriRuntime, openExternalUrl, restartDesktopBackend } from './apiBase';
import { localEngineClient, toLocalEngineApiPath } from './localEngineClient';
import { requestFiniteEngineJson } from './localEngineClientCore';
import { readApiErrorMessage } from './apiError';
import { LocalEngineConnectionHelp } from './LocalEngineConnectionHelp';
import { OllamaModelSearch } from './OllamaModelSearch';
import { SettingsHint } from './SettingsHint';
import { LOCAL_ENGINE_NAME, withJosa } from './brand';
import { beginSettingsUpdateActivity } from './updateActivity';

const SETTINGS_FETCH_TIMEOUT_MS = 20_000;
// A stopped engine is retried quietly, backing off so an idle Settings dialog does not keep the network busy.
const SETTINGS_RETRY_BASE_MS = 5000;
const SETTINGS_RETRY_MAX_MS = 30_000;
const SETTINGS_NOTICE_AUTO_DISMISS_MS = 7000;
const OLLAMA_INSTALL_URL = 'https://ollama.com/download/windows';
const OLLAMA_INSTALL_OPENED_NOTICE = '설치한 뒤 이 화면으로 돌아오면 자동으로 확인합니다.';
const SUPPORT_EMAIL_WORK = 'ecomarine@korea.kr';
const SUPPORT_EMAIL_PERSONAL = 'ecomarin@naver.com';
const SUPPORT_EMAIL_PERSONAL_FROM = new Date(2027, 3, 1);

const getSupportContactEmail = (now = new Date()): string => (
    now < SUPPORT_EMAIL_PERSONAL_FROM ? SUPPORT_EMAIL_WORK : SUPPORT_EMAIL_PERSONAL
);

const getOllamaInstallFailedNotice = (): string => (
    `요약 프로그램 설치 페이지를 열지 못했습니다. 회사 보안 정책 또는 인터넷 연결 문제일 수 있습니다. 계속 실패하면 ${getSupportContactEmail()}으로 문의해 주세요.`
);

const DEFAULT_SUMMARY_MODEL_OPTIONS: SummaryModelOption[] = [
    {
        model: 'gemma4:e2b',
        label: '2B',
        description: '용량과 속도를 우선할 때 사용합니다.',
        url: 'https://ollama.com/library/gemma4%3Ae2b',
        command: 'ollama run gemma4:e2b',
        source: 'recommended',
    },
    {
        model: 'gemma4:e4b',
        label: '4B',
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
    size?: string;
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
    inventory_checked?: boolean;
    ollama_available?: boolean;
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
    ollama_runtime_status?: OllamaRuntimeDownloadStatus;
    ollama_connection?: OllamaConnectionStatus;
    summary_reason?: string;
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
    status: 'idle' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
    message: string;
    started_at?: string;
    updated_at?: string;
    exit_code?: number | null;
    error?: string;
    error_code?: string;
    progress_percent?: number | null;
    eta_seconds?: number | null;
    cancel_requested?: boolean;
}

interface ModelDownloadStatus {
    key: string;
    active: boolean;
    status: 'idle' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
    message: string;
    target_path?: string;
    started_at?: string;
    updated_at?: string;
    error?: string;
    downloaded_bytes?: number;
    expected_bytes?: number;
    progress_percent?: number | null;
    eta_seconds?: number | null;
    cancel_requested?: boolean;
}

interface OllamaRuntimeDownloadStatus {
    key: string;
    available: boolean;
    active: boolean;
    status: 'idle' | 'starting' | 'running' | 'extracting' | 'installing' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'update_required';
    message: string;
    target_path?: string;
    executable_path?: string;
    download_url?: string;
    started_at?: string;
    updated_at?: string;
    error?: string;
    error_code?: string;
    downloaded_bytes?: number;
    expected_bytes?: number;
    progress_percent?: number | null;
    eta_seconds?: number | null;
    cancel_requested?: boolean;
    update_required?: boolean;
}

interface OllamaConnectionStatus {
    status?: 'missing' | 'managed_ready' | 'managed_stopped' | 'managed_starting' | 'system_ready' | 'system_stopped';
    source?: 'none' | 'managed' | 'system';
    executable_available?: boolean;
    server_ready?: boolean;
    can_auto_start?: boolean;
    managed_runtime_available?: boolean;
    executable_path?: string;
}

const isOllamaMissingPullStatus = (status?: { error?: string; model?: string }): boolean => (
    Boolean(status?.model) && status?.error === 'ollama executable not found'
);

interface SettingsProps {
    onClose: () => void;
    analysisActive?: boolean;
    initialTab?: SettingsTab;
    /** Scroll a section into view on open (the writer's 문제 해결 button). */
    initialSection?: SettingsSection;
    /** Retained for callers using the former cleanup surface. */
    onMeetingsDeleted?: (ids: string[]) => void;
}

export type SettingsTab = 'general' | 'models';
/** Where a writer shortcut lands inside 일반: 문제 해결 (재시작), 분석 장치, or 참석자 구분까지 이어서 실행. */
export type SettingsSection = 'troubleshooting' | 'device' | 'diarization';

const getUserModelLabel = (model: ModelStatus): string => {
    if (model.key === 'stt_faster_whisper') return '음성 인식 모델';
    if (model.key === 'diarization') return '참석자 구분 모델';
    if (model.key === 'llm') return '회의 요약';
    return model.label;
};

const formatModelDownloadBytes = (bytes?: number): string => {
    if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
    return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
};

const formatModelDownloadEta = (seconds?: number | null): string => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return '1분 미만 남음';
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `약 ${minutes}분 남음`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `약 ${hours}시간 ${restMinutes}분 남음` : `약 ${hours}시간 남음`;
};

const getModelDownloadProgressText = (status?: ModelDownloadStatus): string => {
    if (!status?.active) return '';
    if (status.status === 'cancelling') return '';
    const downloaded = formatModelDownloadBytes(status.downloaded_bytes);
    const expected = formatModelDownloadBytes(status.expected_bytes);
    const percent = typeof status.progress_percent === 'number' && Number.isFinite(status.progress_percent)
        ? `${Math.max(0, Math.min(100, Number(status.progress_percent))).toFixed(1)}%`
        : '';
    const eta = formatModelDownloadEta(status.eta_seconds);
    const parts = [
        percent && `${percent} 진행`,
        downloaded && expected ? `${downloaded} / ${expected}` : downloaded,
        eta,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : '계산 중';
};

const getModelDownloadProgressPercent = (status?: ModelDownloadStatus): number => {
    if (!status?.active || typeof status.progress_percent !== 'number' || !Number.isFinite(status.progress_percent)) return 0;
    return Math.max(0, Math.min(100, Number(status.progress_percent)));
};

const getModelDownloadStatusMessage = (status?: ModelDownloadStatus): string => {
    if (status?.active) return '';
    if (!status?.message || status.message === '모델 받기를 시작합니다.') return '';
    return status.message;
};

const getOllamaRuntimeProgressText = (status?: OllamaRuntimeDownloadStatus | null): string => {
    if (!status?.active) return '';
    if (status.status === 'cancelling') return '';
    if (status.status === 'extracting') return '설치하는 중';
    const downloaded = formatModelDownloadBytes(status.downloaded_bytes);
    const expected = formatModelDownloadBytes(status.expected_bytes);
    const percent = typeof status.progress_percent === 'number' && Number.isFinite(status.progress_percent)
        ? `${Math.max(0, Math.min(100, Number(status.progress_percent))).toFixed(1)}% 진행`
        : '';
    const eta = formatModelDownloadEta(status.eta_seconds);
    const parts = [
        percent,
        downloaded && expected ? `${downloaded} / ${expected}` : downloaded,
        eta,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : '계산 중';
};

const getOllamaRuntimeProgressPercent = (status?: OllamaRuntimeDownloadStatus | null): number => {
    if (!status?.active || typeof status.progress_percent !== 'number' || !Number.isFinite(status.progress_percent)) return 0;
    return Math.max(0, Math.min(100, Number(status.progress_percent)));
};

const getOllamaPullProgressPercent = (status?: OllamaPullStatus): number => {
    if (!status?.active || typeof status.progress_percent !== 'number' || !Number.isFinite(status.progress_percent)) return 0;
    return Math.max(0, Math.min(100, Number(status.progress_percent)));
};

const getOllamaPullProgressText = (status?: OllamaPullStatus): string => {
    if (!status?.active) return '';
    if (status.status === 'cancelling') return '';
    const percent = typeof status.progress_percent === 'number' && Number.isFinite(status.progress_percent)
        ? `${Math.max(0, Math.min(100, Number(status.progress_percent))).toFixed(1)}% 진행`
        : '';
    const eta = formatModelDownloadEta(status.eta_seconds);
    const parts = [percent, eta].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : '계산 중';
};

// The banner adds the automatic-recheck sentence and the runtime's next step once (SB-2).
const getModelStatusFailureMessage = (error: unknown): string => {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return isTimeout
        ? '모델 상태 확인이 지연되고 있습니다.'
        : '모델 상태를 확인하지 못했습니다.';
};

// 재시작 exists only in the desktop app (설정 > 일반 > 문제 해결); the web app's engine is the separate LOCAL_ENGINE_NAME program.
const getEngineRecoveryStep = (): string => (
    isTauriRuntime() ? '계속 실패하면 재시작을 눌러 주세요.' : `계속 실패하면 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`
);

const isModelStatusCheckFailure = (message: string): boolean => (
    message.includes('모델 상태') || message.includes('확인하지 못했습니다') || message.includes('지연')
);

// A timed-out read is still a failure to the user; "불러오는 중" inside an error popup read as endless loading.
const getSettingsFailureMessage = (): string => (
    `설정을 불러오지 못했습니다. 잠시 후 자동으로 다시 확인합니다. ${getEngineRecoveryStep()}`
);

const fetchWithTimeout = (url: string, init: RequestInit = {}): Promise<Response> => (
    requestFiniteEngineJson(localEngineClient, toLocalEngineApiPath(url), init, SETTINGS_FETCH_TIMEOUT_MS)
);

export const Settings: React.FC<SettingsProps> = ({ onClose, analysisActive = false, initialTab = 'general', initialSection }) => {
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
    // Status side requests wait until the engine has answered once; a stopped engine only gets the settings retry.
    const engineAnswered = Boolean(settings);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    // A failed refresh is not evidence that missing program files have been repaired.
    const [modelRepairKeys, setModelRepairKeys] = useState<string[]>([]);
    const requiresModelRepair = modelRepairKeys.some(key => key !== 'diarization' || settings?.diarization?.generate_during_analysis !== false);
    const [apiBase, setApiBase] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isRestartingBackend, setIsRestartingBackend] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [ollamaInstallPrompted, setOllamaInstallPrompted] = useState(false);
    const [ollamaInstallNoticeMessage, setOllamaInstallNoticeMessage] = useState('');
    const [supportContactVisible, setSupportContactVisible] = useState(false);
    const [modelStatusErrorMessage, setModelStatusErrorMessage] = useState('');
    // A repeated failure sets the same text, so this round keeps the automatic model-status retry scheduled.
    const [modelStatusRetryRound, setModelStatusRetryRound] = useState(0);
    const [diarizationDuringAnalysis, setDiarizationDuringAnalysis] = useState(false);
    const [sttDevice, setSttDevice] = useState<'cpu' | 'cuda'>('cpu');
    const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>(DEFAULT_DOWNLOAD_FORMAT);
    const [preserveExtractedAudio, setPreserveExtractedAudio] = useState(true);
    const [autoSaveHwpxCopy, setAutoSaveHwpxCopy] = useState(false);
    const [autoSaveAudioCopy, setAutoSaveAudioCopy] = useState(false);
    const [modelRevealRequest, setModelRevealRequest] = useState(initialTab === 'models' ? 1 : 0);
    const [summaryModelInput, setSummaryModelInput] = useState('');
    const [customSummaryModelInput, setCustomSummaryModelInput] = useState('');
    const [customSummarySearching, setCustomSummarySearching] = useState(false);
    const [searchView, setSearchView] = useState(false);
    const [searchResults, setSearchResults] = useState<SummaryModelOption[]>([]);
    const [searchError, setSearchError] = useState('');
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchPage, setSearchPage] = useState(0);
    const [addingModel, setAddingModel] = useState('');
    const [modelPage, setModelPage] = useState(0);
    const [selectionFocusModel, setSelectionFocusModel] = useState('');
    const selectionFocusOriginRef = useRef<Element | null>(null);
    const lastAddedModelRef = useRef('');
    const searchWasVisibleRef = useRef(false);
    const [searchReturnTarget, setSearchReturnTarget] = useState<string | null>(null);
    const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
    const customSearchRequestRef = useRef(0);
    const [ollamaPulls, setOllamaPulls] = useState<Record<string, OllamaPullStatus>>({});
    const [ollamaRuntimeDownload, setOllamaRuntimeDownload] = useState<OllamaRuntimeDownloadStatus | null>(null);
    const [modelDownloads, setModelDownloads] = useState<Record<string, ModelDownloadStatus>>({});
    const [deletingOllamaModels, setDeletingOllamaModels] = useState<Record<string, boolean>>({});
    const settingsWorkActive = isSaving || isRestartingBackend
        || Object.values(deletingOllamaModels).some(Boolean)
        || Object.values(modelDownloads).some(status => status.active)
        || Boolean(ollamaRuntimeDownload?.active)
        || Object.values(ollamaPulls).some(status => status.active);
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('backend-task:state', {
            detail: { source: 'settings-status', active: settingsWorkActive },
        }));
    }, [settingsWorkActive]);
    useEffect(() => () => {
        window.dispatchEvent(new CustomEvent('backend-task:state', {
            detail: { source: 'settings-status', active: false },
        }));
    }, []);
    const [isCheckingModels, setIsCheckingModels] = useState(false);
    const [isConnectingSummary, setIsConnectingSummary] = useState(false);
    const [summaryConnectionError, setSummaryConnectionError] = useState('');
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [openSummaryModelMenu, setOpenSummaryModelMenu] = useState('');
    const [modelDeleteConfirmation, setModelDeleteConfirmation] = useState<{ model: string; deleteFiles: boolean } | null>(null);
    const modelDeleteConfirmationRef = useRef<{ model: string; deleteFiles: boolean } | null>(null);
    const modelDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
    const [modelDeleteReturnModel, setModelDeleteReturnModel] = useState('');
    const mountedRef = useRef(true);
    const modelStatusRequestIdRef = useRef(0);
    const pullRequestIdsRef = useRef<Record<string, number>>({});
    const ollamaRuntimeRequestIdRef = useRef(0);
    const ollamaRuntimePollingRequestIdRef = useRef<number | null>(null);
    const modelDownloadRequestIdsRef = useRef<Record<string, number>>({});
    const restoredOllamaPullsRef = useRef<Record<string, number>>({});
    const lastSavedGeneralKeyRef = useRef('');
    const currentGeneralKeyRef = useRef('');
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const summaryModelMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const summaryModelMenuFocusEdgeRef = useRef<'first' | 'last'>('first');
    const summaryModelSearchRef = useRef<HTMLInputElement | null>(null);
    const previouslyFocusedElementRef = useRef<HTMLElement | null>(
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );


    const initialSectionHandledRef = useRef(false);
    const [highlightedSetting, setHighlightedSetting] = useState<string | null>(null);
    const highlightFrameRef = useRef(0);
    const highlightSetting = useCallback((id: string) => {
        setHighlightedSetting(null);
        window.cancelAnimationFrame(highlightFrameRef.current);
        highlightFrameRef.current = window.requestAnimationFrame(() => setHighlightedSetting(id));
    }, []);
    useEffect(() => () => window.cancelAnimationFrame(highlightFrameRef.current), []);
    useEffect(() => {
        if (!highlightedSetting) return;
        const timeout = window.setTimeout(() => setHighlightedSetting(null), 1800);
        return () => window.clearTimeout(timeout);
    }, [highlightedSetting]);
    const openModelSettings = () => {
        setModelRevealRequest(value => value + 1);
    };
    useEffect(() => {
        if (!modelRevealRequest) return;
        let focusFrame = 0;
        const frame = window.requestAnimationFrame(() => {
            focusFrame = window.requestAnimationFrame(() => {
                const target = document.getElementById('settings-analysis-models');
                if (!target) return;
                target.scrollIntoView({ block: 'nearest' });
                target.focus({ preventScroll: true });
                highlightSetting(target.id);

            });
        });
        return () => {
            window.cancelAnimationFrame(frame);
            window.cancelAnimationFrame(focusFrame);
        };
    }, [modelRevealRequest, highlightSetting]);
    const restartButtonRef = useRef<HTMLButtonElement | null>(null);
    const connectionHelpRef = useRef<HTMLDivElement | null>(null);
    const supportReturnFocusRef = useRef<HTMLElement | null>(null);
    const supportCloseRef = useRef<HTMLButtonElement | null>(null);
    const deviceSelectRef = useRef<HTMLSelectElement | null>(null);
    const diarizationToggleRef = useRef<HTMLInputElement | null>(null);
    const restartFocusPendingRef = useRef(false);
    const closeSupportContact = useCallback(() => {
        setSupportContactVisible(false);
        const opener = supportReturnFocusRef.current;
        const target = opener?.isConnected && opener.getClientRects().length > 0 && !opener.matches(':disabled')
            ? opener : connectionHelpRef.current || dialogRef.current;
        target?.focus({ preventScroll: true });
        supportReturnFocusRef.current = null;
    }, []);
    useEffect(() => {
        if (!supportContactVisible) return;
        supportCloseRef.current?.focus({ preventScroll: true });
    }, [supportContactVisible]);
    const focusAnalysisSetting = (target: 'device' | 'diarization') => {
        const control = target === 'device' ? deviceSelectRef.current : diarizationToggleRef.current;
        control?.scrollIntoView({ block: 'center' });
        control?.focus({ preventScroll: true });
        highlightSetting(target === 'device' ? 'settings-analysis-device' : 'settings-analysis-diarization');
    };
    useEffect(() => {
        // Scroll once when opened from a writer shortcut (문제 해결 / 분석 장치 / 참석자 구분), not on every return to the 일반 tab.
        if (!initialSection || initialSectionHandledRef.current) return undefined;
        // Analysis controls only exist once settings have loaded; 재시작 is there from the start.
        if (initialSection !== 'troubleshooting' && (!settings || isRestartingBackend)) return undefined;
        let focusFrame = 0;
        const frame = window.requestAnimationFrame(() => {
            // Mark done only once it runs: StrictMode's mount-unmount-mount cancels the first frame.
            const sectionId = initialSection === 'device'
                ? 'settings-analysis-device'
                : initialSection === 'diarization' ? 'settings-analysis-diarization' : 'settings-troubleshooting';
            document.getElementById(sectionId)?.scrollIntoView({ block: 'center' });
            // The dialog focuses its close button on the first frame; the user came for this control, so move there next.
            focusFrame = window.requestAnimationFrame(() => {
                const target = initialSection === 'device'
                    ? deviceSelectRef.current
                    : initialSection === 'diarization' ? diarizationToggleRef.current
                        : isTauriRuntime() ? restartButtonRef.current : connectionHelpRef.current;
                if (target && !target.matches(':disabled')) {
                    target.focus({ preventScroll: true });
                    highlightSetting(sectionId);
                    initialSectionHandledRef.current = true;
                }
            });
        });
        return () => {
            window.cancelAnimationFrame(frame);
            window.cancelAnimationFrame(focusFrame);
        };
    }, [highlightSetting, initialSection, isRestartingBackend, settings]);

    useEffect(() => {
        const previouslyFocusedElement = previouslyFocusedElementRef.current;
        const returnFocusScope = previouslyFocusedElement?.closest<HTMLElement>('[data-settings-focus-scope]');
        const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
        return () => {
            window.cancelAnimationFrame(focusFrame);
            const canRestoreFocus = (element: HTMLElement) => (
                element.isConnected
                && !element.matches(':disabled, [aria-disabled="true"]')
                && element.getClientRects().length > 0
                && window.getComputedStyle(element).visibility === 'visible'
            );
            if (previouslyFocusedElement && canRestoreFocus(previouslyFocusedElement)) {
                previouslyFocusedElement.focus();
                return;
            }
            // Model readiness can remove the opener. Stay within its original
            // work surface so a hidden writer never receives another screen's focus.
            const fallback = returnFocusScope?.querySelectorAll<HTMLElement>('[data-settings-focus-fallback]');
            Array.from(fallback ?? []).find(canRestoreFocus)?.focus();
        };
    }, []);

    const analysisModels = useMemo(
        () => (models?.models || []).filter(
            model => model.key === 'stt_faster_whisper',
        ),
        [models],
    );
    const summaryModelStatus = useMemo(
        () => (models?.models || []).find(model => model.key === 'llm') || null,
        [models],
    );
    const summaryModelOptions = useMemo(() => {
        const configuredModel = normalizeSummaryModelName(settings?.summary?.model || summaryModelStatus?.configured_model);
        const baseOptions: SummaryModelOption[] = [
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
        const options = [...baseOptions, ...configuredOption];
        const seen = new Set<string>();
        const filtered = options.filter(option => {
            const model = normalizeSummaryModelName(option.model);
            if (!model || seen.has(model)) return false;
            seen.add(model);
            return true;
        });
        // Selection and readiness only change row controls, never catalog order.
        return filtered;
    }, [settings, summaryModelStatus]);

    const inventoryConfirmed = Boolean(summaryModelStatus && summaryModelStatus.inventory_checked !== false
        && (summaryModelStatus.inventory_checked === true || summaryModelStatus.installed || summaryModelStatus.installed_models?.length));
    const modelPageCount = Math.max(1, Math.ceil(summaryModelOptions.length / 4));
    const visibleModelPage = Math.min(modelPage, modelPageCount - 1);
    const visibleSummaryModels = summaryModelOptions.slice(visibleModelPage * 4, visibleModelPage * 4 + 4);

    useEffect(() => {
        const wasVisible = searchWasVisibleRef.current;
        searchWasVisibleRef.current = searchView;
        if (searchView === wasVisible) return;
        if (searchView) {
            setSearchReturnTarget(null);
            const frame = window.requestAnimationFrame(() => summaryModelSearchRef.current?.focus());
            return () => window.cancelAnimationFrame(frame);
        }
        setSearchReturnTarget(lastAddedModelRef.current);
        lastAddedModelRef.current = '';
    }, [searchView]);

    useEffect(() => {
        if (searchView || searchReturnTarget === null) return;
        const index = summaryModelOptions.findIndex(option => normalizeSummaryModelName(option.model) === searchReturnTarget);
        if (searchReturnTarget && index < 0) return;
        if (index >= 0 && visibleModelPage !== Math.floor(index / 4)) {
            setModelPage(Math.floor(index / 4));
            return;
        }
        const frame = window.requestAnimationFrame(() => {
            // Keep the request across page/list renders. Only clear it after the
            // correct page exists, and don't steal focus if the user moved on.
            const active = document.activeElement;
            if (active === document.body || active === dialogRef.current) {
                const row = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('[data-model-name]') ?? [])
                    .find(element => element.dataset.modelName === searchReturnTarget);
                const target = row?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? row ?? summaryModelSearchRef.current;
                target?.focus({ preventScroll: true });
            }
            setSearchReturnTarget(null);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [searchReturnTarget, searchView, summaryModelOptions, visibleModelPage]);

    useEffect(() => {
        if (!selectionFocusModel || isSaving || searchView) return;
        const index = summaryModelOptions.findIndex(option => normalizeSummaryModelName(option.model) === selectionFocusModel);
        if (index < 0) return;
        const targetPage = Math.floor(index / 4);
        if (visibleModelPage !== targetPage) {
            // The rows no longer reorder on selection. Preserve a page the user
            // visited while this save was pending instead of pulling them back.
            setSelectionFocusModel('');
            selectionFocusOriginRef.current = null;
            return;
        }
        const frame = window.requestAnimationFrame(() => {
            const active = document.activeElement;
            // A delayed save must not take focus from a different control the user opened meanwhile.
            if (active === document.body || active === selectionFocusOriginRef.current || active === dialogRef.current) {
                const row = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('[data-model-name]') ?? [])
                    .find(element => element.dataset.modelName === selectionFocusModel);
                row?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)')?.focus({ preventScroll: true });
            }
            setSelectionFocusModel('');
            selectionFocusOriginRef.current = null;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isSaving, searchView, selectionFocusModel, summaryModelOptions, visibleModelPage]);

    const applyGeneralSettingsToForm = useCallback((nextSettings: SettingsPayload) => {
        setDiarizationDuringAnalysis(nextSettings.diarization?.generate_during_analysis ?? false);
        setSttDevice(nextSettings.stt?.device === 'cuda' ? 'cuda' : 'cpu');
        setPreserveExtractedAudio(nextSettings.privacy?.preserve_extracted_audio ?? true);
        setAutoSaveHwpxCopy(nextSettings.privacy?.auto_save_hwpx_copy ?? false);
        setAutoSaveAudioCopy(nextSettings.privacy?.auto_save_audio_copy ?? false);
    }, []);

    const applySettingsToForm = useCallback((nextSettings: SettingsPayload) => {
        applyGeneralSettingsToForm(nextSettings);
        setSummaryModelInput(normalizeSummaryModelName(nextSettings.summary?.model));
    }, [applyGeneralSettingsToForm]);

    // Engine-backed values only: the download format is a browser preference saved on change.
    const generalSettingsKey = useCallback((values: {
        diarizationDuringAnalysis: boolean;
        sttDevice: 'cpu' | 'cuda';
        preserveExtractedAudio: boolean;
        autoSaveHwpxCopy: boolean;
        autoSaveAudioCopy: boolean;
    }) => JSON.stringify(values), []);

    useEffect(() => {
        if (!preserveExtractedAudio && autoSaveAudioCopy) {
            setAutoSaveAudioCopy(false);
        }
    }, [autoSaveAudioCopy, preserveExtractedAudio]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            modelDeleteConfirmationRef.current = null;
            modelStatusRequestIdRef.current += 1;
            ollamaRuntimeRequestIdRef.current += 1;
            ollamaRuntimePollingRequestIdRef.current = null;
            pullRequestIdsRef.current = {};
        };
    }, []);

    const loadModelsStatus = useCallback(async (base: string, options: { surfaceErrors?: boolean; showChecking?: boolean } = {}): Promise<ModelsPayload | null> => {
        const requestId = modelStatusRequestIdRef.current + 1;
        modelStatusRequestIdRef.current = requestId;
        const showChecking = options.showChecking === true;
        if (showChecking) setIsCheckingModels(true);
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
            setModelRepairKeys(nextModels.models.filter(model => model.required && !model.installed && !model.downloadable).map(model => model.key));
            if (nextModels.ollama_runtime_status) {
                setOllamaRuntimeDownload(nextModels.ollama_runtime_status);
            }
            const payloadError = nextModels.errors?.find(Boolean) || '';
            setModelStatusErrorMessage(payloadError);
            setModelStatusRetryRound(0);
            setErrorMessage(previous => (
                previous.includes('분석 기능에 연결')
                || previous.includes('모델 상태')
                || previous.includes('분석 기능 응답')
                    ? ''
                    : previous
            ));
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
            setModelStatusRetryRound(round => round + 1);
            return null;
        } finally {
            if (showChecking && mountedRef.current) {
                setIsCheckingModels(false);
            }
        }
    }, []);

    const handleConnectSummaryModels = async () => {
        if (!apiBase || isConnectingSummary) return;
        const finishUpdateActivity = beginSettingsUpdateActivity();
        setIsConnectingSummary(true);
        setSummaryConnectionError('');
        try {
            const response = await fetchWithTimeout(`${apiBase}/api/models/ollama/connect`, { method: 'POST' });
            if (!response.ok) {
                if (response.status === 404) {
                    setSummaryConnectionError('연결 프로그램을 업데이트한 뒤 다시 확인해 주세요.');
                    return;
                }
                throw new Error('summary connection failed');
            }
            await loadModelsStatus(apiBase, { surfaceErrors: false });
        } catch {
            if (mountedRef.current) setSummaryConnectionError('요약 프로그램에 연결하지 못했습니다. 다시 시도해 주세요.');
        } finally {
            if (mountedRef.current) setIsConnectingSummary(false);
            finishUpdateActivity();
        }
    };

    useEffect(() => {
        if (!apiBase || !engineAnswered) return;
        let refreshing = false;
        const refreshOnReturn = () => {
            if (document.visibilityState === 'hidden' || refreshing) return;
            refreshing = true;
            void loadModelsStatus(apiBase, { surfaceErrors: false }).finally(() => { refreshing = false; });
        };
        window.addEventListener('focus', refreshOnReturn);
        document.addEventListener('visibilitychange', refreshOnReturn);
        return () => {
            window.removeEventListener('focus', refreshOnReturn);
            document.removeEventListener('visibilitychange', refreshOnReturn);
        };
    }, [apiBase, engineAnswered, loadModelsStatus]);

    const handleRefreshModelsStatus = useCallback(async () => {
        setErrorMessage('');
        setMessage('');
        try {
            const base = apiBase || await getApiBase();
            setApiBase(base);
            await loadModelsStatus(base, { surfaceErrors: false, showChecking: true });
        } catch {
            setModelStatusErrorMessage('모델 상태를 확인하지 못했습니다.');
        }
    }, [apiBase, loadModelsStatus]);

    const updateModelDownloadStatus = useCallback((status: ModelDownloadStatus) => {
        setModelDownloads(previous => ({ ...previous, [status.key]: status }));
    }, []);

    const isCurrentModelDownloadRequest = useCallback((modelKey: string, requestId: number) => (
        mountedRef.current && modelDownloadRequestIdsRef.current[modelKey] === requestId
    ), []);

    const pollModelDownloadStatus = useCallback(async (base: string, modelKey: string, requestId: number) => {
        for (let attempt = 0; attempt < 7200; attempt += 1) {
            await new Promise(resolve => window.setTimeout(resolve, 2000));
            if (!isCurrentModelDownloadRequest(modelKey, requestId)) return;
            const response = await fetchWithTimeout(`${base}/api/models/download-status?key=${encodeURIComponent(modelKey)}`);
            if (!response.ok) throw new Error(`download-status=${response.status}`);
            const status = await response.json() as ModelDownloadStatus;
            if (!isCurrentModelDownloadRequest(modelKey, requestId)) return;
            updateModelDownloadStatus(status);
            if (!status.active) {
                if (status.status === 'completed') {
                    await loadModelsStatus(base, { surfaceErrors: false });
                    if (!isCurrentModelDownloadRequest(modelKey, requestId)) return;
                    setMessage('');
                } else if (status.status === 'failed') {
                    setMessage('');
                    setErrorMessage('');
                } else if (status.status === 'cancelled') {
                    setMessage('');
                    setErrorMessage('');
                }
                return;
            }
        }
        throw new Error('모델 받기 상태 확인 시간이 초과되었습니다.');
    }, [isCurrentModelDownloadRequest, loadModelsStatus, updateModelDownloadStatus]);

    const handleDownloadModel = useCallback(async (model: ModelStatus) => {
        if (!model.downloadable) {
            setErrorMessage('이 모델은 앱에서 직접 받을 수 없습니다.');
            return;
        }

        const finishUpdateActivity = beginSettingsUpdateActivity();
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        const requestId = (modelDownloadRequestIdsRef.current[model.key] || 0) + 1;
        modelDownloadRequestIdsRef.current[model.key] = requestId;
        try {
            const base = apiBase || await getApiBase();
            if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
            setApiBase(base);
            const response = await fetchWithTimeout(`${base}/api/models/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: model.key }),
            });
            if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response, '음성 인식 모델 받기를 시작하지 못했습니다. 다시 시도해 주세요.'));
            }
            const status = await response.json() as ModelDownloadStatus;
            if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
            updateModelDownloadStatus(status);
            if (status.active) {
                setMessage('');
                void pollModelDownloadStatus(base, model.key, requestId).catch(error => {
                    if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
                    setMessage('');
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            } else if (status.status === 'completed') {
                await loadModelsStatus(base, { surfaceErrors: false });
                if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
                setMessage('');
            } else {
                setMessage('');
                setErrorMessage('');
            }
        } catch (error) {
            if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
            setMessage('');
            setErrorMessage(error instanceof Error ? error.message : '모델 받기를 시작하지 못했습니다.');
        } finally {
            finishUpdateActivity();
        }
    }, [apiBase, isCurrentModelDownloadRequest, loadModelsStatus, pollModelDownloadStatus, updateModelDownloadStatus]);

    const handleStopModelDownload = useCallback(async (modelKey: string) => {
        const requestId = modelDownloadRequestIdsRef.current[modelKey] || 1;
        modelDownloadRequestIdsRef.current[modelKey] = requestId;
        setErrorMessage('');
        setMessage('');
        try {
            const base = apiBase || await getApiBase();
            setApiBase(base);
            const response = await fetchWithTimeout(`${base}/api/models/download/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: modelKey }),
            });
            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response, '음성 인식 모델 받기를 중지하지 못했습니다. 다시 시도해 주세요.'));
            }
            const status = await response.json() as ModelDownloadStatus;
            updateModelDownloadStatus(status);
            if (status.active) {
                void pollModelDownloadStatus(base, modelKey, requestId).catch(error => {
                    if (!isCurrentModelDownloadRequest(modelKey, requestId)) return;
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '모델 받기를 중지하지 못했습니다.');
        }
    }, [apiBase, isCurrentModelDownloadRequest, pollModelDownloadStatus, updateModelDownloadStatus]);

    const updateOllamaRuntimeDownloadStatus = useCallback((status: OllamaRuntimeDownloadStatus) => {
        setOllamaRuntimeDownload(status);
        if (status.status === 'completed' && status.update_required === false) {
            setOllamaPulls(previous => Object.fromEntries(Object.entries(previous)
                .filter(([, pull]) => pull.error_code !== 'runtime_update_required')));
        }
    }, []);

    const isCurrentOllamaRuntimeRequest = useCallback((requestId: number) => (
        mountedRef.current && ollamaRuntimeRequestIdRef.current === requestId
    ), []);

    const pollOllamaRuntimeDownloadStatus = useCallback(async (base: string, requestId: number) => {
        for (let attempt = 0; attempt < 7200; attempt += 1) {
            await new Promise(resolve => window.setTimeout(resolve, 2000));
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            const response = await fetchWithTimeout(`${base}/api/models/ollama/runtime-status`);
            if (!response.ok) throw new Error(`ollama-runtime-status=${response.status}`);
            const status = await response.json() as OllamaRuntimeDownloadStatus;
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            updateOllamaRuntimeDownloadStatus(status);
            if (!status.active) {
                if (status.status === 'completed') {
                    await loadModelsStatus(base, { surfaceErrors: false });
                    if (!isCurrentOllamaRuntimeRequest(requestId)) return;
                    setMessage('');
                    setErrorMessage('');
                } else if (status.status === 'failed') {
                    setMessage('');
                    setErrorMessage(status.update_required ? '' : status.message || '요약 프로그램을 받지 못했습니다.');
                } else if (status.status === 'cancelled') {
                    setMessage('');
                    setErrorMessage('');
                }
                return;
            }
        }
        throw new Error('요약 프로그램 받기 상태 확인 시간이 초과되었습니다.');
    }, [isCurrentOllamaRuntimeRequest, loadModelsStatus, updateOllamaRuntimeDownloadStatus]);

    const beginOllamaRuntimePolling = useCallback((base: string, requestId: number) => {
        if (ollamaRuntimePollingRequestIdRef.current === requestId) return;
        ollamaRuntimePollingRequestIdRef.current = requestId;
        void pollOllamaRuntimeDownloadStatus(base, requestId).catch(error => {
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            setMessage('');
            setErrorMessage(error instanceof Error ? error.message : '요약 프로그램 받기 상태를 확인하지 못했습니다.');
        }).finally(() => {
            if (ollamaRuntimePollingRequestIdRef.current === requestId) {
                ollamaRuntimePollingRequestIdRef.current = null;
            }
        });
    }, [isCurrentOllamaRuntimeRequest, pollOllamaRuntimeDownloadStatus]);

    const handleDownloadOllamaRuntime = useCallback(async (update = false) => {
        const finishUpdateActivity = beginSettingsUpdateActivity();
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        const requestId = ollamaRuntimeRequestIdRef.current + 1;
        ollamaRuntimeRequestIdRef.current = requestId;
        try {
            const base = apiBase || await getApiBase();
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            setApiBase(base);
            const desktopActionHeaders = await getDesktopActionHeaders();
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            const response = await fetchWithTimeout(`${base}/api/models/ollama/runtime/download${update ? '?update=true' : ''}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...desktopActionHeaders },
            });
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            if (!response.ok) {
                if (!isCurrentOllamaRuntimeRequest(requestId)) return;
                throw new Error(await readApiErrorMessage(response, '요약 프로그램 받기를 시작하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'));
            }
            const status = await response.json() as OllamaRuntimeDownloadStatus;
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            updateOllamaRuntimeDownloadStatus(status);
            if (status.active) {
                beginOllamaRuntimePolling(base, requestId);
            } else if (status.status === 'completed') {
                await loadModelsStatus(base, { surfaceErrors: false });
                if (!isCurrentOllamaRuntimeRequest(requestId)) return;
                setMessage('');
                setErrorMessage('');
            } else if (status.status === 'failed') {
                setErrorMessage(status.update_required ? '' : status.message || '요약 프로그램을 받지 못했습니다.');
            }
        } catch (error) {
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            setMessage('');
            setErrorMessage(error instanceof Error ? error.message : '요약 프로그램 받기를 시작하지 못했습니다.');
        } finally {
            finishUpdateActivity();
        }
    }, [apiBase, beginOllamaRuntimePolling, isCurrentOllamaRuntimeRequest, loadModelsStatus, updateOllamaRuntimeDownloadStatus]);

    const handleStopOllamaRuntimeDownload = useCallback(async () => {
        const requestId = ollamaRuntimeRequestIdRef.current + 1;
        ollamaRuntimeRequestIdRef.current = requestId;
        setErrorMessage('');
        setMessage('');
        try {
            const base = apiBase || await getApiBase();
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            setApiBase(base);
            const desktopActionHeaders = await getDesktopActionHeaders();
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            const response = await fetchWithTimeout(`${base}/api/models/ollama/runtime/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...desktopActionHeaders },
            });
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            if (!response.ok) {
                if (!isCurrentOllamaRuntimeRequest(requestId)) return;
                throw new Error(await readApiErrorMessage(response, '요약 프로그램 받기를 중지하지 못했습니다. 다시 시도해 주세요.'));
            }
            const status = await response.json() as OllamaRuntimeDownloadStatus;
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            updateOllamaRuntimeDownloadStatus(status);
            if (status.active) {
                beginOllamaRuntimePolling(base, requestId);
            }
        } catch (error) {
            if (!isCurrentOllamaRuntimeRequest(requestId)) return;
            setErrorMessage(error instanceof Error ? error.message : '요약 프로그램 받기를 중지하지 못했습니다.');
        }
    }, [apiBase, beginOllamaRuntimePolling, isCurrentOllamaRuntimeRequest, updateOllamaRuntimeDownloadStatus]);

    const updateOllamaPullStatus = useCallback((status: OllamaPullStatus) => {
        setOllamaPulls(previous => ({ ...previous, [status.model]: status }));
    }, []);

    const isCurrentPullRequest = useCallback((modelName: string, requestId: number) => (
        mountedRef.current && pullRequestIdsRef.current[modelName] === requestId
    ), []);

    const pollOllamaPullStatus = useCallback(async (base: string, modelName: string, requestId: number) => {
        for (let attempt = 0; attempt < 7200; attempt += 1) {
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
                    setMessage('');
                } else if (status.status === 'failed') {
                    setMessage('');
                    setErrorMessage(status.error_code === 'runtime_update_required' ? '' : status.message || '모델을 받지 못했습니다.');
                } else if (status.status === 'cancelled') {
                    setMessage('');
                    setErrorMessage('');
                }
                return;
            }
        }
        throw new Error('모델 받기 상태 확인 시간이 초과되었습니다.');
    }, [isCurrentPullRequest, loadModelsStatus, updateOllamaPullStatus]);

    const handleDownloadOllamaModel = useCallback(async (
        modelName?: string,
    ) => {
        const targetModel = normalizeSummaryModelName(modelName || summaryModelInput);
        const setDownloadErrorMessage = setErrorMessage;
        if (!targetModel) {
            setDownloadErrorMessage('받을 모델명을 입력해 주세요.');
            return;
        }

        const finishUpdateActivity = beginSettingsUpdateActivity();
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
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
                throw new Error(await readApiErrorMessage(response, '요약 모델 받기를 시작하지 못했습니다. 모델 이름과 요약 프로그램 상태를 확인해 주세요.'));
            }
            const status = await response.json() as OllamaPullStatus;
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            updateOllamaPullStatus(status);
            if (!status.active && status.status === 'failed' && isOllamaMissingPullStatus(status)) {
                setMessage('');
                setOllamaInstallNoticeMessage('요약 프로그램을 먼저 받은 뒤 요약 모델을 받을 수 있습니다.');
                setOllamaInstallPrompted(true);
                setErrorMessage('');
                return;
            }
            if (status.active) {
                setMessage('');
                void pollOllamaPullStatus(base, targetModel, requestId).catch(error => {
                    if (!isCurrentPullRequest(targetModel, requestId)) return;
                    setDownloadErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            } else if (status.status === 'completed') {
                await loadModelsStatus(base, { surfaceErrors: false });
                if (!isCurrentPullRequest(targetModel, requestId)) return;
                setMessage('');
            } else {
                setMessage('');
                setDownloadErrorMessage(status.error_code === 'runtime_update_required' ? '' : status.message || `${targetModel} 모델을 받지 못했습니다.`);
            }
        } catch (error) {
            if (!isCurrentPullRequest(targetModel, requestId)) return;
            setMessage('');
            setDownloadErrorMessage(error instanceof Error ? error.message : '모델 받기를 시작하지 못했습니다.');
        } finally {
            finishUpdateActivity();
        }
    }, [apiBase, isCurrentPullRequest, loadModelsStatus, pollOllamaPullStatus, summaryModelInput, updateOllamaPullStatus]);

    const handleStopOllamaModelDownload = useCallback(async (modelName: string) => {
        const targetModel = normalizeSummaryModelName(modelName);
        if (!targetModel) return;
        const requestId = pullRequestIdsRef.current[targetModel] || 1;
        pullRequestIdsRef.current[targetModel] = requestId;
        setErrorMessage('');
        setMessage('');
        try {
            const base = apiBase || await getApiBase();
            setApiBase(base);
            const response = await fetchWithTimeout(`${base}/api/models/ollama/pull/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: targetModel }),
            });
            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response, '요약 모델 받기를 중지하지 못했습니다. 다시 시도해 주세요.'));
            }
            const status = await response.json() as OllamaPullStatus;
            updateOllamaPullStatus(status);
            if (status.active) {
                void pollOllamaPullStatus(base, targetModel, requestId).catch(error => {
                    if (!isCurrentPullRequest(targetModel, requestId)) return;
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '모델 받기를 중지하지 못했습니다.');
        }
    }, [apiBase, isCurrentPullRequest, pollOllamaPullStatus, updateOllamaPullStatus]);

    const handleDeleteOllamaModel = useCallback(async (modelName: string, deleteFiles = false, replacementModel = '') => {
        const targetModel = normalizeSummaryModelName(modelName);
        if (!targetModel) return;
        const replacement = normalizeSummaryModelName(replacementModel);

        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        const finishUpdateActivity = beginSettingsUpdateActivity();
        setDeletingOllamaModels(previous => ({ ...previous, [targetModel]: true }));
        try {
            const base = apiBase || await getApiBase();
            setApiBase(base);
            const params = new URLSearchParams({ model: targetModel });
            if (deleteFiles) params.set('delete_files', 'true');
            if (replacement) params.set('replacement_model', replacement);
            const response = await fetchWithTimeout(`${base}/api/models/ollama/model?${params.toString()}`, {
                method: 'DELETE',
            });
            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response, '요약 모델을 삭제하지 못했습니다. 사용 중인지 확인한 뒤 다시 시도해 주세요.'));
            }
            const payload = await response.json() as { message?: string; replacement_model?: string };
            let nextSettings: SettingsPayload | null = null;
            try {
                const settingsResponse = await fetchWithTimeout(`${base}/api/settings`);
                if (settingsResponse.ok) nextSettings = await settingsResponse.json() as SettingsPayload;
            } catch {
                // DELETE already succeeded; a failed optional refresh must not leave
                // the removed model on screen or report the deletion as failed.
            }
            if (!mountedRef.current) return;
            // A delete owns only this model's membership. Old GET responses must not
            // replace a newer choice, registration, or another completed deletion.
            const remainingTarget = nextSettings?.summary?.user_models?.find(option => normalizeSummaryModelName(option.model) === targetModel);
            setSettings(current => {
                if (!current) return current;
                const userModels = (current.summary?.user_models || []).filter(option => normalizeSummaryModelName(option.model) !== targetModel);
                if (remainingTarget) userModels.push(remainingTarget);
                const useReplacement = Boolean(payload.replacement_model) && normalizeSummaryModelName(current.summary?.model) === targetModel;
                return { ...current, summary: { ...current.summary, user_models: userModels,
                    ...(useReplacement ? { provider: 'ollama', model: payload.replacement_model } : {}) } };
            });
            if (payload.replacement_model) setSummaryModelInput(current => normalizeSummaryModelName(current) === targetModel ? normalizeSummaryModelName(payload.replacement_model) : current);
            await loadModelsStatus(base, { surfaceErrors: false });
            setMessage(payload.message || (deleteFiles ? `${targetModel} 모델을 삭제했습니다.` : `${targetModel} 모델을 목록에서 제거했습니다.`));
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '모델 목록 변경 중 오류가 발생했습니다.');
        } finally {
            finishUpdateActivity();
            setDeletingOllamaModels(previous => ({ ...previous, [targetModel]: false }));
            window.requestAnimationFrame(() => {
                // A confirmed removal can unmount the focused row. Keep focus in
                // Settings without taking it from another control used meanwhile.
                if (mountedRef.current && document.activeElement === document.body && dialogRef.current?.isConnected) {
                    (summaryModelSearchRef.current ?? closeButtonRef.current)?.focus({ preventScroll: true });
                }
            });
        }
    }, [apiBase, loadModelsStatus]);

    const openModelDeleteConfirmation = (modelName: string, deleteFiles: boolean) => {
        const model = normalizeSummaryModelName(modelName);
        if (!model || modelDeleteConfirmationRef.current) return;
        const confirmation = { model, deleteFiles };
        modelDeleteConfirmationRef.current = confirmation;
        setOpenSummaryModelMenu('');
        setMessage('');
        setModelDeleteConfirmation(confirmation);
    };

    const finishModelDeleteConfirmation = useCallback((confirmed: boolean) => {
        const confirmation = modelDeleteConfirmationRef.current;
        if (!confirmation) return;
        // Consume the request synchronously. Only this explicit confirmation path
        // may call DELETE; cancellation and unmount never create a request.
        modelDeleteConfirmationRef.current = null;
        setModelDeleteConfirmation(null);
        setModelDeleteReturnModel(confirmation.model);
        if (confirmed) void handleDeleteOllamaModel(confirmation.model, confirmation.deleteFiles);
    }, [handleDeleteOllamaModel]);

    useEffect(() => {
        if (modelDeleteConfirmation) modelDeleteCancelRef.current?.focus({ preventScroll: true });
    }, [modelDeleteConfirmation]);

    useEffect(() => {
        if (modelDeleteConfirmation || !modelDeleteReturnModel) return;
        const frame = window.requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active === document.body || active === dialogRef.current || active === closeButtonRef.current) {
                const row = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('[data-model-name]') ?? [])
                    .find(element => element.dataset.modelName === modelDeleteReturnModel);
                const target = row?.querySelector<HTMLElement>('button[aria-haspopup="menu"]:not(:disabled)')
                    ?? row ?? summaryModelSearchRef.current ?? closeButtonRef.current;
                target?.focus({ preventScroll: true });
            }
            setModelDeleteReturnModel('');
        });
        return () => window.cancelAnimationFrame(frame);
    }, [modelDeleteConfirmation, modelDeleteReturnModel]);

    // A restart can start a new load while an earlier one is still waiting; only the newest may update the form.
    const settingsLoadSeqRef = useRef(0);
    // Failed automatic retries so far; each one waits longer before the next.
    const [settingsRetryRound, setSettingsRetryRound] = useState(0);
    // The warning popup the user closed; rows keep their one-line failure state and retries continue.
    const [dismissedWarning, setDismissedWarning] = useState('');
    // A quiet load is an automatic retry: the rows keep their failure state instead of flipping back to 불러오는 중.
    const loadSettings = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> => {
        const loadSeq = settingsLoadSeqRef.current + 1;
        settingsLoadSeqRef.current = loadSeq;
        const superseded = () => loadSeq !== settingsLoadSeqRef.current;
        if (!quiet) setIsLoading(true);
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        try {
            const base = await getApiBase();
            if (superseded()) return false;
            setApiBase(base);
            const settingsResponse = await fetchWithTimeout(`${base}/api/settings`);

            if (!settingsResponse.ok) {
                throw new Error(`settings=${settingsResponse.status}`);
            }

            const nextSettings = await settingsResponse.json() as SettingsPayload;
            if (superseded()) return false;
            setSettings(nextSettings);
            setSettingsRetryRound(0);
            setErrorMessage(previous => previous.includes('설정을 불러오') ? '' : previous);
            applySettingsToForm(nextSettings);
            lastSavedGeneralKeyRef.current = generalSettingsKey({
                diarizationDuringAnalysis: nextSettings.diarization?.generate_during_analysis ?? false,
                sttDevice: nextSettings.stt?.device === 'cuda' ? 'cuda' : 'cpu',
                preserveExtractedAudio: nextSettings.privacy?.preserve_extracted_audio ?? true,
                autoSaveHwpxCopy: nextSettings.privacy?.auto_save_hwpx_copy ?? false,
                autoSaveAudioCopy: nextSettings.privacy?.auto_save_audio_copy ?? false,
            });
            const nextModels = await loadModelsStatus(base);
            return Boolean(nextModels);
        } catch {
            if (superseded()) return false;
            setSettings(null);
            setModels(null);
            setModelStatusErrorMessage('');
            setErrorMessage(getSettingsFailureMessage());
            setSettingsRetryRound(round => round + 1);
            return false;
        } finally {
            if (!superseded()) setIsLoading(false);
        }
    }, [applySettingsToForm, generalSettingsKey, loadModelsStatus]);

    useEffect(() => {
        setDownloadFormat(getDownloadFormatPreference());
        void loadSettings();
    }, [loadSettings]);

    useEffect(() => {
        if (settings || isLoading || isRestartingBackend || settingsRetryRound === 0 || !errorMessage.includes('잠시 후 자동으로 다시 확인합니다')) return;
        const delay = Math.min(SETTINGS_RETRY_MAX_MS, SETTINGS_RETRY_BASE_MS * 2 ** (settingsRetryRound - 1));
        const retry = () => { void loadSettings({ quiet: true }); };
        // A hidden window waits for the user to come back instead of polling a stopped engine.
        const retryWhenVisible = () => {
            if (document.visibilityState === 'hidden') return;
            document.removeEventListener('visibilitychange', retryWhenVisible);
            retry();
        };
        const timeoutId = window.setTimeout(() => {
            if (document.visibilityState === 'hidden') document.addEventListener('visibilitychange', retryWhenVisible);
            else retry();
        }, delay);
        return () => {
            window.clearTimeout(timeoutId);
            document.removeEventListener('visibilitychange', retryWhenVisible);
        };
    }, [errorMessage, isLoading, isRestartingBackend, loadSettings, settings, settingsRetryRound]);

    useEffect(() => {
        if (!apiBase || analysisModels.length === 0) return;
        analysisModels.forEach(model => {
            if (!model.downloadable || model.installed || modelDownloads[model.key]?.active) return;
            void (async () => {
                const response = await fetchWithTimeout(`${apiBase}/api/models/download-status?key=${encodeURIComponent(model.key)}`);
                if (!response.ok) return;
                const status = await response.json() as ModelDownloadStatus;
                if (!mountedRef.current || !status.active) return;
                const requestId = (modelDownloadRequestIdsRef.current[model.key] || 0) + 1;
                modelDownloadRequestIdsRef.current[model.key] = requestId;
                updateModelDownloadStatus(status);
                setMessage('');
                void pollModelDownloadStatus(apiBase, model.key, requestId).catch(error => {
                    if (!isCurrentModelDownloadRequest(model.key, requestId)) return;
                    setMessage('');
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            })().catch(() => {
                // Status refresh is best-effort; the normal model status refresh still runs.
            });
        });
    }, [
        analysisModels,
        apiBase,
        isCurrentModelDownloadRequest,
        modelDownloads,
        pollModelDownloadStatus,
        updateModelDownloadStatus,
    ]);

    useEffect(() => {
        if (!apiBase || !engineAnswered) return;
        void (async () => {
            const response = await fetchWithTimeout(`${apiBase}/api/models/ollama/runtime-status`);
            if (!response.ok) return;
            const status = await response.json() as OllamaRuntimeDownloadStatus;
            if (!mountedRef.current) return;
            updateOllamaRuntimeDownloadStatus(status);
            if (!status.active) return;
            const requestId = ollamaRuntimeRequestIdRef.current + 1;
            ollamaRuntimeRequestIdRef.current = requestId;
            setMessage('');
            beginOllamaRuntimePolling(apiBase, requestId);
        })().catch(() => {
            // Status refresh is best-effort; the normal model status refresh still runs.
        });
    }, [
        apiBase,
        beginOllamaRuntimePolling,
        engineAnswered,
        ollamaRuntimeDownload?.active,
        updateOllamaRuntimeDownloadStatus,
    ]);

    useEffect(() => {
        // Before the engine answers, a failed check would still mark the model as restored and never be retried.
        if (!apiBase || !engineAnswered) return;
        const candidateModels = Array.from(new Set([
            normalizeSummaryModelName(settings?.summary?.model),
            ...summaryModelOptions.map(option => normalizeSummaryModelName(option.model)),
        ].filter(Boolean)));
        candidateModels.forEach(modelName => {
            if (!isOllamaSummaryModel(modelName) || ollamaPulls[modelName]?.active || restoredOllamaPullsRef.current[modelName]) return;
            restoredOllamaPullsRef.current[modelName] = Date.now();
            void (async () => {
                const response = await fetchWithTimeout(`${apiBase}/api/models/ollama/pull-status?model=${encodeURIComponent(modelName)}`);
                if (!response.ok) return;
                const status = await response.json() as OllamaPullStatus;
                if (!mountedRef.current || !status.active) return;
                const requestId = (pullRequestIdsRef.current[modelName] || 0) + 1;
                pullRequestIdsRef.current[modelName] = requestId;
                updateOllamaPullStatus(status);
                setMessage('');
                void pollOllamaPullStatus(apiBase, modelName, requestId).catch(error => {
                    if (!isCurrentPullRequest(modelName, requestId)) return;
                    setMessage('');
                    setErrorMessage(error instanceof Error ? error.message : '모델 받기 상태를 확인하지 못했습니다.');
                });
            })().catch(() => {
                // Status refresh is best-effort; the normal model status refresh still runs.
            });
        });
    }, [
        apiBase,
        engineAnswered,
        isCurrentPullRequest,
        ollamaPulls,
        pollOllamaPullStatus,
        settings?.summary?.model,
        summaryModelOptions,
        updateOllamaPullStatus,
    ]);

    useEffect(() => {
        if (isRestartingBackend || !modelStatusErrorMessage || !apiBase || !isModelStatusCheckFailure(modelStatusErrorMessage)) return;
        const delay = Math.min(SETTINGS_RETRY_MAX_MS, SETTINGS_RETRY_BASE_MS * 2 ** Math.max(0, modelStatusRetryRound - 1));
        const timeoutId = window.setTimeout(() => {
            void loadModelsStatus(apiBase, { surfaceErrors: false });
        }, delay);
        return () => window.clearTimeout(timeoutId);
    }, [apiBase, isRestartingBackend, loadModelsStatus, modelStatusErrorMessage, modelStatusRetryRound]);

    useEffect(() => {
        if (isRestartingBackend || !restartFocusPendingRef.current) return;
        restartFocusPendingRef.current = false;
        const active = document.activeElement;
        if (!active || active === document.body) restartButtonRef.current?.focus();
    }, [isRestartingBackend]);

    useEffect(() => {
        if (!message) return;
        const timeoutId = window.setTimeout(() => {
            if (mountedRef.current) setMessage('');
        }, SETTINGS_NOTICE_AUTO_DISMISS_MS);
        return () => window.clearTimeout(timeoutId);
    }, [message]);

    useEffect(() => {
        if (!ollamaInstallPrompted) return;
        const timeoutId = window.setTimeout(() => {
            if (!mountedRef.current) return;
            setOllamaInstallPrompted(false);
            setOllamaInstallNoticeMessage('');
        }, SETTINGS_NOTICE_AUTO_DISMISS_MS);
        return () => window.clearTimeout(timeoutId);
    }, [ollamaInstallPrompted]);

    useEffect(() => {
        if (!openSummaryModelMenu) return;
        const focusFrame = window.requestAnimationFrame(() => {
            const menuId = summaryModelMenuTriggerRef.current?.getAttribute('aria-controls');
            const menu = menuId ? document.getElementById(menuId) : null;
            if (!menu) return;
            const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
            const item = summaryModelMenuFocusEdgeRef.current === 'last' ? items.at(-1) : items[0];
            (item ?? menu).focus();
        });
        const closeMenu = () => { setOpenSummaryModelMenu(''); summaryModelMenuTriggerRef.current?.focus({ preventScroll: true }); };
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('resize', closeMenu);
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Element | null;
            if (!target?.closest('[data-summary-model-menu-root]')) {
                setOpenSummaryModelMenu('');
            }
        };
        window.addEventListener('mousedown', handlePointerDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('scroll', closeMenu, true);
            window.removeEventListener('resize', closeMenu);
        };
    }, [openSummaryModelMenu]);

    const handleSummaryModelMenuToggle = (event: React.MouseEvent<HTMLButtonElement>, menuKey: string) => {
        summaryModelMenuTriggerRef.current = event.currentTarget;
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenuPosition({ left: Math.max(8, Math.min(bounds.right - 208, window.innerWidth - 216)), top: bounds.bottom + 92 > window.innerHeight - 8 ? Math.max(8, bounds.top - 92) : bounds.bottom + 4 });
        summaryModelMenuFocusEdgeRef.current = 'first';
        setOpenSummaryModelMenu(previous => previous === menuKey ? '' : menuKey);
    };

    const handleSummaryModelMenuTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, menuKey: string) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        summaryModelMenuTriggerRef.current = event.currentTarget;
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenuPosition({ left: Math.max(8, Math.min(bounds.right - 208, window.innerWidth - 216)), top: bounds.bottom + 92 > window.innerHeight - 8 ? Math.max(8, bounds.top - 92) : bounds.bottom + 4 });
        summaryModelMenuFocusEdgeRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpenSummaryModelMenu(menuKey);
    };

    const handleSummaryModelMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const menu = event.currentTarget;
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const currentIndex = items.findIndex(item => item === document.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowUp' ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
                    : (currentIndex + 1) % items.length;
            items[index]?.focus();
        } else if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            const trigger = summaryModelMenuTriggerRef.current;
            const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? []).filter(element => !menu.contains(element) && element.tabIndex >= 0
                && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
            const triggerIndex = controls.findIndex(element => element === trigger);
            const nextControl = event.key === 'Tab' && !event.shiftKey
                ? controls[triggerIndex + 1] ?? controls[0] : trigger;
            setOpenSummaryModelMenu('');
            nextControl?.focus();
        }
    };

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Tab') {
                const dialog = dialogRef.current;
                if (!dialog) return;
                const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(
                    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                )).filter(element => (
                    element.getAttribute('aria-hidden') !== 'true'
                    && element.getClientRects().length > 0
                ));
                if (focusableElements.length === 0) {
                    event.preventDefault();
                    dialog.focus();
                    return;
                }
                const firstElement = focusableElements[0];
                const lastElement = focusableElements[focusableElements.length - 1];
                const activeElement = document.activeElement;
                if (event.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
                    event.preventDefault();
                    lastElement.focus();
                } else if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
                    event.preventDefault();
                    firstElement.focus();
                }
                return;
            }

            if (event.key !== 'Escape') return;
            if (modelDeleteConfirmationRef.current) {
                event.preventDefault();
                finishModelDeleteConfirmation(false);
                return;
            }
            if (supportContactVisible) {
                closeSupportContact();
                return;
            }
            if (openSummaryModelMenu) {
                setOpenSummaryModelMenu('');
                summaryModelMenuTriggerRef.current?.focus();
                return;
            }
            if (searchView) {
                customSearchRequestRef.current += 1;
                setCustomSummarySearching(false);
                setSearchView(false);
                return;
            }
            onClose();
        };
        const previousOverflow = document.body.style.overflow;

        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [closeSupportContact, finishModelDeleteConfirmation, onClose, openSummaryModelMenu, searchView, supportContactVisible]);

    const saveGeneralSettings = useCallback(async () => {
        if (!settings) {
            setErrorMessage('설정을 아직 불러오지 못했습니다. 잠시 후 다시 저장해 주세요.');
            return;
        }

        const requestValues = {
            diarizationDuringAnalysis,
            sttDevice,
            preserveExtractedAudio,
            autoSaveHwpxCopy,
            autoSaveAudioCopy: preserveExtractedAudio ? autoSaveAudioCopy : false,
        };
        const requestKey = generalSettingsKey(requestValues);

        const finishUpdateActivity = beginSettingsUpdateActivity();
        setIsSaving(true);
        setSaveState('saving');
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
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
                    privacy: {
                        preserve_extracted_audio: requestValues.preserveExtractedAudio,
                        auto_save_hwpx_copy: requestValues.autoSaveHwpxCopy,
                        auto_save_audio_copy: requestValues.autoSaveAudioCopy,
                    },
                }),
            });

            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response, '설정을 저장하지 못했습니다. 다시 시도해 주세요.'));
            }

            const nextSettings = await response.json() as SettingsPayload;
            setSettings(current => current ? { ...nextSettings, summary: current.summary } : nextSettings);
            window.dispatchEvent(new Event('analysis:settings-updated'));
            await loadModelsStatus(base, { surfaceErrors: false });
            if (currentGeneralKeyRef.current === requestKey) {
                applyGeneralSettingsToForm(nextSettings);
            }
            lastSavedGeneralKeyRef.current = requestKey;
            setSaveState('saved');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
            setSaveState('idle');
        } finally {
            finishUpdateActivity();
            setIsSaving(false);
        }
    }, [
        apiBase,
        applyGeneralSettingsToForm,
        autoSaveAudioCopy,
        autoSaveHwpxCopy,
        diarizationDuringAnalysis,
        generalSettingsKey,
        loadModelsStatus,
        preserveExtractedAudio,
        settings,
        sttDevice,
    ]);

    const handleSaveSummaryModel = useCallback(async (modelOverride?: string) => {
        const focusOrigin = document.activeElement;
        if (!settings) {
            setErrorMessage('설정을 아직 불러오지 못했습니다. 잠시 후 다시 저장해 주세요.');
            return;
        }

        const finishUpdateActivity = beginSettingsUpdateActivity();
        setIsSaving(true);
        setSaveState('saving');
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        try {
            const summaryModel = normalizeSummaryModelName(modelOverride ?? summaryModelInput);
            if (!summaryModel) {
                throw new Error('요약 모델명을 입력하거나 권장 모델을 선택해 주세요.');
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
                throw new Error(await readApiErrorMessage(response, '사용할 요약 모델을 저장하지 못했습니다. 다시 시도해 주세요.'));
            }

            const nextSettings = await response.json() as SettingsPayload;
            // Selecting a model owns the choice, not a catalog registration that completed meanwhile.
            setSettings(current => current ? { ...current, summary: { ...current.summary,
                provider: nextSettings.summary?.provider, model: nextSettings.summary?.model } } : current);
            setSummaryModelInput(normalizeSummaryModelName(nextSettings.summary?.model));
            await loadModelsStatus(base, { surfaceErrors: false });
            if (!mountedRef.current) return;
            const active = document.activeElement;
            if (!dialogRef.current?.querySelector('.settings-search-results')
                && (active === document.body || active === focusOrigin || active === dialogRef.current)) {
                selectionFocusOriginRef.current = focusOrigin;
                setSelectionFocusModel(normalizeSummaryModelName(nextSettings.summary?.model));
            }
            setSaveState('saved');
        } catch (error) {
            setSummaryModelInput(normalizeSummaryModelName(settings.summary?.model));
            setErrorMessage(error instanceof Error ? error.message : '요약 모델 저장 중 오류가 발생했습니다.');
            setSaveState('idle');
        } finally {
            finishUpdateActivity();
            setIsSaving(false);
        }
    }, [apiBase, loadModelsStatus, settings, summaryModelInput]);

    useEffect(() => {
        const nextKey = generalSettingsKey({
            diarizationDuringAnalysis,
            sttDevice,
            preserveExtractedAudio,
            autoSaveHwpxCopy,
            autoSaveAudioCopy: preserveExtractedAudio ? autoSaveAudioCopy : false,
        });
        currentGeneralKeyRef.current = nextKey;
        if (!settings || isLoading || isSaving || isRestartingBackend) return;
        if (nextKey === lastSavedGeneralKeyRef.current) return;
        const timeoutId = window.setTimeout(() => {
            void saveGeneralSettings();
        }, 600);
        return () => window.clearTimeout(timeoutId);
    }, [
        autoSaveAudioCopy,
        autoSaveHwpxCopy,
        diarizationDuringAnalysis,
        generalSettingsKey,
        isLoading,
        isRestartingBackend,
        isSaving,
        preserveExtractedAudio,
        saveGeneralSettings,
        settings,
        sttDevice,
    ]);

    // Closing within the save delay (or while an earlier save is in flight) must not drop the change:
    // send the latest values on unmount. Only after settings loaded, so StrictMode's trial unmount stays quiet.
    const saveGeneralSettingsRef = useRef(saveGeneralSettings);
    useEffect(() => {
        saveGeneralSettingsRef.current = saveGeneralSettings;
    }, [saveGeneralSettings]);
    const generalSettingsLoadedRef = useRef(false);
    useEffect(() => {
        generalSettingsLoadedRef.current = Boolean(settings);
    }, [settings]);
    useEffect(() => () => {
        if (generalSettingsLoadedRef.current && currentGeneralKeyRef.current !== lastSavedGeneralKeyRef.current) {
            void saveGeneralSettingsRef.current();
        }
    }, []);

    const handleDownloadFormatChange = (nextFormat: DownloadFormat) => {
        setDownloadFormat(nextFormat);
        try {
            setDownloadFormatPreference(nextFormat);
        } catch {
            setErrorMessage('다운로드 형식을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
            return;
        }
        // Keep an engine save's 저장 중 visible until it finishes.
        if (!isSaving) setSaveState('saved');
    };

    const handleRestartBackend = async () => {
        if (analysisActive) {
            setErrorMessage('진행 중인 분석이 끝난 뒤 재시작할 수 있습니다.');
            return;
        }

        restartFocusPendingRef.current = document.activeElement === restartButtonRef.current;
        // A change still inside the save delay would be overwritten by the reload after the restart.
        if (settings && currentGeneralKeyRef.current !== lastSavedGeneralKeyRef.current) {
            await saveGeneralSettings();
        }
        const finishUpdateActivity = beginSettingsUpdateActivity();
        setIsRestartingBackend(true);
        settingsLoadSeqRef.current += 1;
        modelStatusRequestIdRef.current += 1;
        setModelStatusErrorMessage('');
        setErrorMessage('');
        setMessage('');
        setOllamaInstallPrompted(false);
        setOllamaInstallNoticeMessage('');
        try {
            const base = await restartDesktopBackend();
            setApiBase(base);
            const ready = await loadSettings();
            setMessage(
                ready
                    ? '분석 기능을 다시 시작했습니다.'
                    : '재시작했습니다. 모델 상태는 잠시 후 자동으로 다시 확인합니다.',
            );
        } catch {
            // The restart invalidated the load in flight, so read settings again: a slow engine may be up by now,
            // and if it is not, the settings failure message keeps the automatic retry going.
            const recovered = await loadSettings();
            if (recovered) setMessage('재시작은 확인하지 못했지만 분석 기능에 다시 연결했습니다.');
        } finally {
            finishUpdateActivity();
            setIsRestartingBackend(false);
        }
    };

    // Not gated on isLoading: when the engine does not answer, each load waits up to 20s before the 5s retry,
    // and 재시작 is exactly what the user needs then.
    const canRestartBackend = isTauriRuntime() && !analysisActive && !isSaving && !isRestartingBackend;
    const gpuUsable = Boolean(models?.stt_device_status?.gpu_usable);
    const gpuReason = models?.stt_device_status?.gpu_reason || 'CPU를 기본으로 사용합니다.';
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
    const ollamaRuntimeStatus = ollamaRuntimeDownload || models?.ollama_runtime_status || null;
    const ollamaConnection = models?.ollama_connection || null;
    const ollamaRuntimeAvailable = Boolean(ollamaRuntimeStatus?.available);
    const ollamaRuntimeActive = Boolean(ollamaRuntimeStatus?.active);
    const ollamaRuntimeNeedsUpdate = Boolean(ollamaRuntimeStatus?.update_required
        || Object.values(ollamaPulls).some(pull => pull.status === 'failed' && pull.error_code === 'runtime_update_required'));
    const ollamaRuntimeStopping = ollamaRuntimeStatus?.status === 'cancelling';
    const ollamaRuntimeProgressText = getOllamaRuntimeProgressText(ollamaRuntimeStatus);
    const ollamaRuntimeProgressPercent = getOllamaRuntimeProgressPercent(ollamaRuntimeStatus);
    const ollamaExecutableAvailable = Boolean(
        ollamaConnection?.executable_available
        ?? summaryModelStatus?.ollama_available
        ?? ollamaRuntimeAvailable,
    );
    const ollamaUsingManagedRuntime = Boolean(ollamaConnection?.source === 'managed' || ollamaRuntimeAvailable);
    const ollamaServerReady = Boolean(
        ollamaConnection ? ollamaConnection.server_ready : installedSummaryModels.size > 0,
    );
    const ollamaCanAutoStart = Boolean(ollamaConnection?.can_auto_start || ollamaRuntimeAvailable);
    const ollamaSystemStopped = ollamaConnection?.status === 'system_stopped';
    const ollamaRuntimePreparing = ollamaConnection?.status === 'managed_starting' || models?.summary_reason === 'runtime_preparing';
    // Without a status payload nothing is known yet: never conclude a model or the summary program is missing.
    const summaryModelInventoryUnknown = !inventoryConfirmed || ollamaRuntimePreparing;
    const ollamaMissing = Boolean(models) && (ollamaConnection?.status === 'missing' || (!ollamaExecutableAvailable && !ollamaRuntimeAvailable));
    const ollamaModelActionsReady = !ollamaRuntimeActive && (!ollamaRuntimeNeedsUpdate || !ollamaUsingManagedRuntime) && Boolean(ollamaServerReady || ollamaCanAutoStart);
    const showOllamaRuntimeAction = !ollamaRuntimeNeedsUpdate && Boolean(ollamaRuntimeActive || (!ollamaUsingManagedRuntime && ollamaMissing));
    const configuredSummaryModel = normalizeSummaryModelName(settings?.summary?.model);
    const isSummaryOptionInstalled = (modelName?: string) => Boolean(modelName && installedSummaryModels.has(modelName));
    const gpuStatusText = gpuUsable ? '음성 인식에 GPU 가속을 사용할 수 있습니다.' : gpuReason;
    const modelStatusCanAutoRetry = Boolean(modelStatusErrorMessage && isModelStatusCheckFailure(modelStatusErrorMessage));
    const summaryModelOllamaHelp = ollamaRuntimePreparing ? '요약 프로그램을 준비하고 있습니다.'
        : inventoryConfirmed ? '' : summaryConnectionError || (!models ? ''
            : ollamaSystemStopped ? 'Windows 시작 메뉴에서 Ollama를 실행해 주세요.'
                : ollamaRuntimeStatus?.status === 'failed' ? '요약 프로그램을 받지 못했습니다. 다시 받아 주세요.'
                    : ollamaMissing ? '회의 요약을 사용하려면 요약 프로그램을 받아 주세요.'
                    : ollamaCanAutoStart && !ollamaServerReady ? '요약 프로그램이 꺼져 있습니다.'
                        : summaryModelInventoryUnknown && !ollamaMissing ? '받은 모델 목록을 확인하지 못했습니다.' : '');
    const showSummaryConnectionNotice = Boolean(models && summaryModelInventoryUnknown && !ollamaMissing && !ollamaRuntimeActive);
    const showSummaryConnectAction = showSummaryConnectionNotice && !ollamaRuntimePreparing;
    const summaryConnectActionLabel = !summaryConnectionError && ollamaCanAutoStart && !ollamaServerReady && !ollamaSystemStopped
        ? '요약 프로그램 실행' : '연결 다시 확인';
    useEffect(() => {
        // Preparation is already in progress: read its status without starting or downloading anything.
        if (!apiBase || !models || !ollamaRuntimePreparing || isRestartingBackend || isModelStatusCheckFailure(modelStatusErrorMessage)) return;
        const timeout = window.setTimeout(() => {
            void loadModelsStatus(apiBase, { surfaceErrors: false });
        }, 5000);
        return () => window.clearTimeout(timeout);
    }, [apiBase, isRestartingBackend, loadModelsStatus, modelStatusErrorMessage, models, ollamaRuntimePreparing]);
    const ollamaInstallNotice = ollamaInstallPrompted
        ? (ollamaInstallNoticeMessage || OLLAMA_INSTALL_OPENED_NOTICE)
        : '';
    const ollamaInstallNoticeTone: 'info' | 'warning' = ollamaInstallNotice.includes('열지 못했습니다') ? 'warning' : 'info';
    const errorHeading = errorMessage.includes('Ollama') ? '요약 프로그램 설치 필요' : '설정 확인 실패';
    const connectionRecoveryActive = !isTauriRuntime() && initialSection === 'troubleshooting';
    const settingsReadError = !settings && errorMessage.includes('설정을 불러오') ? errorMessage : '';
    // Connection failures are warnings: a popup explains them once, and each row shows a one-line state.
    const showGlobalErrorMessage = Boolean(errorMessage && !ollamaInstallNotice && !settingsReadError);
    const modelStatusWarning = modelStatusCanAutoRetry && !isLoading
        ? `${modelStatusErrorMessage} 자동으로 다시 확인합니다. ${getEngineRecoveryStep()}` : '';
    // The troubleshooting page already explains these failures inline.
    const warningText = connectionRecoveryActive ? '' : settingsReadError || modelStatusWarning;
    const showWarningPopup = Boolean(warningText && warningText !== dismissedWarning && !ollamaInstallNotice);
    useEffect(() => {
        // A warning that cleared and comes back later is new to the user.
        if (!warningText) setDismissedWarning('');
    }, [warningText]);
    const missingAnalysisModels = models?.models.filter(model => model.required && !model.installed
        && !(model.key === 'diarization' && settings?.diarization?.generate_during_analysis === false)) || [];
    const hasDownloadableAnalysisModel = missingAnalysisModels.some(model => model.downloadable);
    const canSkipMissingDiarization = missingAnalysisModels.length > 0 && missingAnalysisModels.every(model => model.key === 'diarization')
        && settings?.diarization?.generate_during_analysis === true;
    const remainingPreparationIssue = hasDownloadableAnalysisModel
        ? { title: '분석 모델을 준비해 주세요', description: '필요한 모델을 받으면 분석할 수 있습니다.', actionLabel: '모델 설정 열기', onAction: openModelSettings }
        : canSkipMissingDiarization
            ? { title: '참석자 구분 설정을 변경해 주세요', description: '이어서 실행을 끄면 대화록부터 만들 수 있습니다.', actionLabel: '참석자 구분 설정', onAction: () => focusAnalysisSetting('diarization') }
            : requiresModelRepair ? undefined
                : models?.selected_stt_device === 'cuda' && models.stt_device_status?.gpu_usable === false
                    ? { title: '분석 장치를 변경해 주세요', description: '이 PC에서는 CPU로 분석할 수 있습니다.', actionLabel: '분석 장치 설정', onAction: () => focusAnalysisSetting('device') }
                    : models && !models.ready
                        ? { title: '분석 준비를 확인해 주세요', description: '연결은 확인됐지만 분석에 필요한 준비가 남아 있습니다.', actionLabel: '모델 설정 열기', onAction: openModelSettings }
                        : undefined;
    // Engine-backed switches show no guessed default before the engine answers, and cannot be changed then.
    // Settings arrive before the slower model status, so only the settings payload gates them.
    // A restart reloads them, so changes made meanwhile would be overwritten.
    const generalSettingsReady = Boolean(settings) && !isRestartingBackend;
    // Only the first read shows 불러오는 중; after a failure, retries keep the failure line so rows do not flicker.
    const engineSettingsPending = isRestartingBackend || (isLoading && !settingsReadError);
    const renderEngineSetting = (control: React.ReactNode) => (generalSettingsReady ? control : engineSettingsPending ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">불러오는 중</span>
    ) : (
        <span className="shrink-0 whitespace-nowrap text-xs text-[var(--status-error-fg)]">불러오지 못함</span>
    ));
    const renderDismissButton = (label: string, onClick: () => void) => (
        <button
            type="button"
            className="icon-button btn-ghost h-6 w-6 text-current opacity-70 transition-opacity hover:opacity-100"
            aria-label={label}
            onClick={onClick}
        >
            <X size={14} aria-hidden="true" />
        </button>
    );
    const returnFromSearch = () => {
        customSearchRequestRef.current += 1;
        setCustomSummarySearching(false);
        setSearchView(false);
    };
    const searchSummaryModels = async () => {
        const query = customSummaryModelInput.trim();
        if (!query) return;
        const requestId = ++customSearchRequestRef.current;
        setSearchView(true);
        setCustomSummarySearching(true);
        setSearchResults([]);
        setSearchPage(0);
        setSearchError('');
        setSearchHasMore(false);
        setOpenSummaryModelMenu('');
        try {
            const base = apiBase || await getApiBase();
            const response = await fetchWithTimeout(`${base}/api/models/ollama/search?q=${encodeURIComponent(query)}`);
            if (response.status === 404) throw new Error('모델 검색을 사용하려면 LMO 회의록 연결 프로그램을 업데이트해 주세요.');
            if (!response.ok) throw new Error(await readApiErrorMessage(response, '모델 검색을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 검색해 주세요.'));
            const result = await response.json() as { models: SummaryModelOption[]; has_more?: boolean };
            if (!Array.isArray(result.models)) throw new Error('검색 결과를 읽지 못했습니다. 다시 검색해 주세요.');
            if (!mountedRef.current || customSearchRequestRef.current !== requestId) return;
            setSearchResults(result.models);
            setSearchHasMore(Boolean(result.has_more));
        } catch (error) {
            if (mountedRef.current && customSearchRequestRef.current === requestId) setSearchError(error instanceof Error ? error.message : '모델 검색에 실패했습니다. 다시 검색해 주세요.');
        } finally {
            if (mountedRef.current && customSearchRequestRef.current === requestId) setCustomSummarySearching(false);
        }
    };
    const addSummaryModel = async (model: string) => {
        if (addingModel) return;
        setAddingModel(model);
        setSearchError('');
        try {
            const base = apiBase || await getApiBase();
            const response = await fetchWithTimeout(`${base}/api/models/ollama/model`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
            });
            if (response.status === 404) throw new Error('모델을 추가하려면 LMO 회의록 연결 프로그램을 업데이트해 주세요.');
            if (!response.ok) throw new Error(await readApiErrorMessage(response, '목록에 추가하지 못했습니다. 다시 시도해 주세요.'));
            const result = await response.json() as { summary: SettingsPayload['summary'] };
            if (!result.summary) throw new Error('추가 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
            if (!mountedRef.current) return;
            // Registration owns this entry only, so a delayed response cannot restore
            // another model deleted while verification was still running.
            const registered = result.summary.user_models?.find(option => normalizeSummaryModelName(option.model) === normalizeSummaryModelName(model));
            if (!registered) throw new Error('추가한 모델을 확인하지 못했습니다. 다시 시도해 주세요.');
            lastAddedModelRef.current = model;
            setSettings(current => current ? { ...current, summary: { ...current.summary,
                user_models: [...(current.summary?.user_models || []).filter(option => normalizeSummaryModelName(option.model) !== normalizeSummaryModelName(model)), registered] } } : current);
        } catch (error) {
            if (mountedRef.current) setSearchError(error instanceof Error ? error.message : '모델 추가에 실패했습니다.');
        } finally {
            if (mountedRef.current) setAddingModel('');
        }
    };
    const modelSearch = <OllamaModelSearch value={customSummaryModelInput} inputRef={summaryModelSearchRef}
        searching={customSummarySearching} onSearch={() => void searchSummaryModels()}
        onChange={value => { customSearchRequestRef.current += 1; setCustomSummaryModelInput(value); setCustomSummarySearching(false); }} />;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[var(--bg-overlay)] p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-dialog-title"
                aria-describedby={modelDeleteConfirmation ? 'settings-model-delete-description' : undefined}
                className="settings-dialog relative flex w-full max-w-4xl flex-col overflow-hidden border border-border bg-background"
                ref={dialogRef}
                tabIndex={-1}
            >
                <div className="settings-dialog-header flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="flex items-center gap-3">
                        <h2 id="settings-dialog-title" className="text-lg font-semibold text-foreground">설정</h2>
                        <span className="settings-save-state min-w-10" role="status" aria-live="polite">
                            {saveState === 'saving' ? '저장 중' : ''}
                        </span>
                    </div>
                    <div className="relative flex items-center gap-2">
                        <div className="relative">
                            <button
                                type="button"
                                onClick={event => {
                                    if (supportContactVisible) closeSupportContact();
                                    else {
                                        supportReturnFocusRef.current = event.currentTarget;
                                        setSupportContactVisible(true);
                                    }
                                }}
                                className="btn btn-outline h-8 px-3 text-xs"
                                aria-label="문의 연락처 보기"
                                aria-expanded={supportContactVisible}
                                title="문의"
                            >
                                <Mail size={13} aria-hidden="true" />
                                문의
                            </button>
                            {supportContactVisible && (
                                <div
                                    role="status"
                                    className="floating-panel absolute right-0 top-[calc(100%+0.5rem)] z-30 w-60 px-3 py-2 text-xs"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="text-muted-foreground">문의사항은 아래 이메일로 연락주세요.</p>
                                            <div className="mt-2 flex items-center gap-2 font-semibold text-foreground">
                                                <Mail size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                                                <a className="truncate underline" href={`mailto:${getSupportContactEmail()}`}>{getSupportContactEmail()}</a>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="icon-button btn-ghost h-5 w-5 shrink-0"
                                            aria-label="문의 연락처 닫기"
                                            ref={supportCloseRef}
                                            onClick={closeSupportContact}
                                        >
                                            <X size={12} aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                if (modelDeleteConfirmationRef.current) finishModelDeleteConfirmation(false);
                                onClose();
                            }}
                            className="icon-button btn-outline h-8 w-8"
                            aria-label="설정 닫기"
                            title="닫기"
                            ref={closeButtonRef}
                        >
                            <X size={16} aria-hidden="true" />
                        </button>
                    </div>
                </div>

                {showWarningPopup && (
                    <div className="settings-toast-slot">
                        <AppToast
                            message={warningText}
                            tone="warning"
                            actionLabel="다시 확인"
                            onAction={() => {
                                if (settingsReadError) void loadSettings();
                                else void handleRefreshModelsStatus();
                            }}
                            closeLabel="연결 경고 닫기"
                            onClose={() => setDismissedWarning(warningText)}
                        />
                    </div>
                )}

                {message && (
                    <div className="absolute right-5 top-20 z-20 w-[calc(100%-2.5rem)] max-w-md">
                        <StatusBanner
                            tone="neutral"
                            action={renderDismissButton('설정 안내 닫기', () => setMessage(''))}
                        >
                            {message}
                        </StatusBanner>
                    </div>
                )}

                <div className="settings-content custom-scrollbar">
                    {modelDeleteConfirmation ? <section className="settings-page" aria-labelledby="settings-model-delete-title">
                        <h3 id="settings-model-delete-title" className="text-sm font-semibold text-foreground">
                            {modelDeleteConfirmation.deleteFiles ? 'PC에서 모델 삭제' : '모델 목록에서 제거'}
                        </h3>
                        <div id="settings-model-delete-description" className="space-y-3 text-sm text-foreground">
                            <p className="break-all font-semibold">{modelDeleteConfirmation.model}</p>
                            <p>{modelDeleteConfirmation.deleteFiles
                                ? '이 PC에 받은 모델 파일을 삭제합니다. 다른 앱에서도 같은 모델을 사용한다면 다시 받아야 합니다.'
                                : '이 앱의 추가한 모델 목록에서만 제거합니다. PC에 받은 모델 파일은 유지합니다.'}</p>
                        </div>
                        <div className="flex justify-end gap-2">
                            <Button ref={modelDeleteCancelRef} variant="outline" className="h-8 px-3 text-xs"
                                aria-describedby="settings-model-delete-description" onClick={() => finishModelDeleteConfirmation(false)}>취소</Button>
                            <Button variant="outline" className="h-8 px-3 text-xs"
                                style={{ color: 'var(--status-error-fg)', borderColor: 'var(--status-error-fg)' }}
                                aria-label={`${modelDeleteConfirmation.model} ${modelDeleteConfirmation.deleteFiles ? 'PC에서 삭제 확인' : '목록에서 제거 확인'}`}
                                onClick={() => finishModelDeleteConfirmation(true)}>
                                <Trash2 size={14} aria-hidden="true" />{modelDeleteConfirmation.deleteFiles ? 'PC에서 삭제' : '목록에서 제거'}
                            </Button>
                        </div>
                    </section> : searchView ? <section className="settings-page settings-search-results" aria-label="요약 모델 검색 결과">
                        <div className="flex items-center gap-3">
                            <button type="button" className="btn btn-ghost h-8 px-2 text-xs" aria-label="설정으로 돌아가기" onClick={returnFromSearch}><ArrowLeft size={16} aria-hidden="true" />설정으로</button>
                            <h3 className="text-sm font-semibold">요약 모델 검색</h3>
                            <SettingsHint label="검색 결과" text="Ollama 공식 라이브러리의 로컬 요약 모델을 검색합니다. 목록에 추가한 뒤 설정에서 받기를 눌러야 다운로드됩니다." />
                        </div>
                        {modelSearch}
                        {searchError && <StatusBanner tone="error">{searchError}</StatusBanner>}
                        <div className="settings-catalog-list" aria-busy={customSummarySearching}>
                            {customSummarySearching ? <p role="status" className="settings-model-note"><Loader2 size={16} className="animate-spin" />검색 중</p>
                                : searchResults.length ? searchResults.slice(searchPage * 4, searchPage * 4 + 4).map(result => {
                                    const name = result.model || '';
                                    const added = summaryModelOptions.some(item => normalizeSummaryModelName(item.model) === normalizeSummaryModelName(name));
                                    return <div key={name} className="settings-catalog-row">
                                        <div className="min-w-0">
                                            <div className="settings-catalog-title"><h4 className="truncate text-sm font-medium" title={name}>{name}</h4></div>
                                            {result.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{result.description}</p>}
                                        </div>
                                        {added ? <Button variant="outline" className="h-8 w-28 shrink-0 px-3 text-xs" aria-label={`${name} 목록에서 보기`} disabled={Boolean(addingModel)} onClick={() => {
                                            lastAddedModelRef.current = normalizeSummaryModelName(name);
                                            returnFromSearch();
                                        }}>목록에서 보기</Button> : <Button variant="outline" className="h-8 w-28 shrink-0 px-3 text-xs" aria-label={`${name} 목록에 추가`} disabled={Boolean(addingModel)} onClick={() => void addSummaryModel(name)}>{addingModel === name ? '추가 중' : '목록에 추가'}</Button>}
                                    </div>;
                                }) : !searchError && <p role="status" className="settings-model-note">검색 결과가 없습니다. 다른 모델명으로 검색해 주세요.</p>}
                        </div>
                        {searchResults.length > 4 && <div className="settings-model-pagination">
                            <button type="button" className="icon-button h-6 w-6" aria-label="이전 검색 결과" disabled={searchPage === 0} onClick={() => setSearchPage(page => page - 1)}><ChevronLeft size={14} /></button>
                            <span>{searchPage + 1}/{Math.ceil(searchResults.length / 4)}</span>
                            <button type="button" className="icon-button h-6 w-6" aria-label="다음 검색 결과" disabled={(searchPage + 1) * 4 >= searchResults.length} onClick={() => setSearchPage(page => page + 1)}><ChevronRight size={14} /></button>
                        </div>}
                        {searchHasMore && <p className="text-xs text-muted-foreground">더 정확한 모델명으로 검색하면 다른 결과도 찾을 수 있습니다.</p>}
                    </section> : <>

                    {showGlobalErrorMessage && (
                        <div className="settings-page sticky top-0 z-10 mb-4">
                            <StatusBanner
                                tone="error"
                                heading={errorHeading}
                                action={renderDismissButton('설정 오류 알림 닫기', () => setErrorMessage(''))}
                            >
                                {errorMessage}
                            </StatusBanner>
                        </div>
                    )}
                    <section id="settings-general-panel" aria-label="설정 항목" className="settings-page">
                        {connectionRecoveryActive && <div className="settings-page-heading">
                            <h3>연결 문제 해결</h3>
                        </div>}

                        {!isTauriRuntime() && initialSection === 'troubleshooting' && <div className="settings-group" id="settings-troubleshooting" ref={connectionHelpRef} tabIndex={-1} data-settings-highlighted={highlightedSetting === 'settings-troubleshooting'}>
                            <LocalEngineConnectionHelp
                                onReturnToWriter={onClose}
                                onRequestSupport={() => {
                                    supportReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                                    setSupportContactVisible(true);
                                }}
                                preparationReady={models?.ready === true}
                                remainingIssue={remainingPreparationIssue}
                                requiresReinstall={requiresModelRepair && !hasDownloadableAnalysisModel && !canSkipMissingDiarization}
                                loadError={settingsReadError || (modelStatusCanAutoRetry ? modelStatusErrorMessage : '')}
                                onRetrySettings={() => { void loadSettings(); }}
                                checkingSettings={isLoading}
                            />
                        </div>}
                        <section className="settings-group" aria-labelledby="settings-analysis-title">
                            <h4 id="settings-analysis-title">분석</h4>
                            <div className="settings-list settings-analysis-list">
                                <div className="settings-paired-row">
                                <label id="settings-analysis-device" className="settings-row" data-settings-highlighted={highlightedSetting === 'settings-analysis-device'}>
                                    <span className="settings-row-copy">
                                        <span className="settings-row-title settings-title-with-hint">분석 장치<SettingsHint label="분석 장치" text={gpuStatusText} /></span>
                                    </span>
                                    {renderEngineSetting(
                                        <select
                                            ref={deviceSelectRef}
                                            value={sttDevice}
                                            onChange={event => setSttDevice(event.target.value as typeof sttDevice)}
                                            className="select-field settings-row-select"
                                        >
                                            <option value="cpu">CPU 기본 사용</option>
                                            <option value="cuda" disabled={!gpuUsable}>GPU 가속 사용</option>
                                        </select>
                                    )}
                                </label>
                                <div className="settings-inline-models settings-analysis-model-cell" id="settings-analysis-models" tabIndex={-1} data-settings-highlighted={highlightedSetting === 'settings-analysis-models'}>
                                    <div className="settings-analysis-model-status">
                                        <div className="settings-row-title">음성 인식 모델</div>
                                        {(engineSettingsPending && !models) || isCheckingModels ? (
                                            <span role="status" className="settings-analysis-readiness text-muted-foreground">
                                                <Loader2 size={14} className="animate-spin" aria-hidden="true" />확인 중
                                            </span>
                                        ) : modelStatusWarning || (!models && settingsReadError) ? (
                                            <span className="settings-analysis-readiness text-[var(--status-error-fg)]">
                                                {/* The popup explains the failure; the row keeps one line and its own retry. */}
                                                <span>확인하지 못함</span>
                                                {modelStatusWarning && (
                                                    <Button
                                                        variant="outline"
                                                        className="h-7 shrink-0 px-2 text-xs"
                                                        onClick={() => void handleRefreshModelsStatus()}
                                                        disabled={isCheckingModels}
                                                    >
                                                        다시 확인
                                                    </Button>
                                                )}
                                            </span>
                                        ) : analysisModels.length === 1 && analysisModels[0].installed ? (
                                            <span role="status" aria-label={`${getUserModelLabel(analysisModels[0])} 있음`} className="settings-analysis-readiness text-[var(--status-success-fg)]">
                                                <Check size={14} aria-hidden="true" />준비됨
                                            </span>
                                        ) : null}
                                    </div>
                                    {modelStatusErrorMessage && !modelStatusCanAutoRetry && !isLoading && (
                                        <StatusBanner
                                            tone="info"
                                            className="mt-3 py-2 text-xs shadow-none"
                                            action={(
                                                <Button
                                                    variant="outline"
                                                    className="h-8 shrink-0 px-3 text-xs"
                                                    onClick={() => void handleRefreshModelsStatus()}
                                                    disabled={isCheckingModels}
                                                >
                                                    다시 확인
                                                </Button>
                                            )}
                                        >
                                            {modelStatusErrorMessage}
                                            {' '}
                                            필요한 설정을 조정한 뒤 다시 확인해 주세요.
                                        </StatusBanner>
                                    )}

                                    {isLoading && !models ? null : analysisModels.length === 1 && analysisModels[0].installed ? null : analysisModels.length > 0 ? (
                                        <div className="settings-model-list mt-2">
                                            {analysisModels.map(model => {
                                                const modelUrl = model.install_url || model.license_url || '';
                                                const modelName = model.repo_id || model.label;
                                                const modelDownloadStatus = modelDownloads[model.key];
                                                const modelDownloadActive = Boolean(modelDownloadStatus?.active);
                                                const modelDownloadStopping = modelDownloadStatus?.status === 'cancelling';
                                                const progressText = getModelDownloadProgressText(modelDownloadStatus);
                                                const progressPercent = getModelDownloadProgressPercent(modelDownloadStatus);
                                                const manualNote = model.manual_note || '관리자가 준비한 모델 파일을 실행 폴더의 models 폴더에 넣어 주세요.';
                                                return (
                                                    <div key={model.key} className="settings-model-row">
                                                        <div className="flex items-center justify-between gap-3">
                                                            <div className="min-w-0">
                                                                {analysisModels.length > 1 && <div className="text-sm font-semibold text-foreground">{getUserModelLabel(model)}</div>}
                                                                {!model.installed && (
                                                                    <span className="mt-1 block text-xs text-muted-foreground">
                                                                        {getModelDownloadStatusMessage(modelDownloadStatus) || (model.downloadable
                                                                            ? '앱에서 바로 받을 수 있습니다. 용량이 커서 시간이 오래 걸릴 수 있습니다.'
                                                                            : manualNote)}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {model.installed ? (
                                                                <span
                                                                    role="status"
                                                                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--status-success-bg)] text-[var(--status-success-fg)]"
                                                                    aria-label={`${getUserModelLabel(model)} 있음`}
                                                                    title="모델 있음"
                                                                >
                                                                    <Check size={16} aria-hidden="true" />
                                                                </span>
                                                            ) : model.downloadable ? (
                                                                <Button
                                                                    variant="outline"
                                                                    className="h-8 shrink-0 px-3 text-xs"
                                                                    aria-label={`${getUserModelLabel(model)} ${modelDownloadActive ? '중지' : '받기'}`}
                                                                    onClick={() => {
                                                                        if (modelDownloadActive) {
                                                                            void handleStopModelDownload(model.key);
                                                                            return;
                                                                        }
                                                                        void handleDownloadModel(model);
                                                                    }}
                                                                    disabled={modelDownloadStopping}
                                                                >
                                                                    {modelDownloadActive
                                                                        ? (
                                                                            <>
                                                                                {modelDownloadStopping ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                                                                {modelDownloadStopping ? '중지 중' : '중지'}
                                                                            </>
                                                                        )
                                                                        : '받기'}
                                                                </Button>
                                                            ) : modelUrl ? (
                                                                <button
                                                                    type="button"
                                                                    className="btn btn-outline h-8 shrink-0 px-3 text-xs"
                                                                    aria-label={`${getUserModelLabel(model)} 준비 안내 열기`}
                                                                    title={`${modelName} 준비 안내`}
                                                                    onClick={() => {
                                                                        void openExternalUrl(modelUrl).catch(() => {
                                                                            setErrorMessage('모델 페이지를 열지 못했습니다. 잠시 후 다시 시도해 주세요.');
                                                                        });
                                                                    }}
                                                                >
                                                                    안내
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                        {modelDownloadActive && (
                                                            <div className="mt-3 space-y-1.5">
                                                                <ProgressBar
                                                                    value={progressPercent}
                                                                    size="sm"
                                                                    label={`${getUserModelLabel(model)} 받기 진행률`}
                                                                />
                                                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                                    {progressText && (
                                                                        <>
                                                                            <Loader2 size={12} className="animate-spin text-primary" aria-hidden="true" />
                                                                            <span>{progressText}</span>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : modelStatusWarning || settingsReadError ? null : (
                                        <div className="settings-model-note mt-3">
                                            {modelStatusErrorMessage || errorMessage
                                                ? '음성 인식 모델 상태 확인이 지연되고 있습니다. 모델을 다시 받을 필요는 없으며, 잠시 후 다시 확인해 주세요.'
                                                : '음성 인식 모델 상태를 아직 확인하지 못했습니다.'}
                                        </div>
                                    )}
                                </div>

                                </div>
                                <div className="settings-paired-row">
                                <div className="settings-row">
                                    <span className="settings-row-copy">
                                        <span className="settings-row-title settings-title-with-hint">음량 자동 보정<SettingsHint label="음량 자동 보정" text="음성 인식 전에 작은 소리의 음량을 보정합니다. 앱 내부 설정에 따라 적용하며 기존 설정은 유지합니다." /></span>
                                    </span>
                                    <span className={`text-xs ${!settings && !engineSettingsPending ? 'text-[var(--status-error-fg)]' : 'text-muted-foreground'}`} role="status" aria-label="음량 자동 보정 상태">
                                        {!settings ? (engineSettingsPending ? '확인 중' : '불러오지 못함') : settings.preprocessing?.enabled !== false && settings.preprocessing?.normalize_audio ? '자동' : '꺼짐'}
                                    </span>
                                </div>
                                <label
                                    id="settings-analysis-diarization"
                                    data-settings-highlighted={highlightedSetting === 'settings-analysis-diarization'}
                                    className="settings-row"
                                    title="켜면 대화록 생성 후 참석자 구분까지 이어서 실행하고, 끄면 대화록을 먼저 저장한 뒤 결과 화면에서 따로 실행합니다."
                                >
                                    <span className="settings-row-copy">
                                        <span className="settings-row-title settings-title-with-hint">참석자 구분까지 이어서 실행<SettingsHint label="참석자 구분까지 이어서 실행" text="끄면 음성 파일이 보관된 경우 결과 화면에서 따로 실행할 수 있습니다." /></span>
                                    </span>
                                    {renderEngineSetting(
                                        <input aria-label="참석자 구분까지 이어서 실행"
                                            type="checkbox"
                                            ref={diarizationToggleRef}
                                            className="settings-switch"
                                            checked={diarizationDuringAnalysis}
                                            onChange={event => setDiarizationDuringAnalysis(event.target.checked)}
                                        />
                                    )}
                                </label>
                                </div>
                            </div>
                        </section>

                        <section className="settings-group" id="settings-summary-models" aria-labelledby="settings-summary-title">
                            <div className="settings-model-heading">
                                <h4 id="settings-summary-title">요약 모델</h4>
                            </div>
                            <div className="settings-panel settings-summary-panel">
                                <div id="settings-model-search">{modelSearch}</div>
                                {!showSummaryConnectionNotice && (summaryModelOllamaHelp || showOllamaRuntimeAction) && <div className="settings-summary-recovery">
                                    <div className="min-w-0">
                                        {summaryModelOllamaHelp && <p className="text-xs text-muted-foreground">
                                            {summaryModelOllamaHelp}
                                        </p>}
                                    </div>
                                    {showOllamaRuntimeAction && (
                                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                                            <Button
                                                variant={ollamaRuntimeActive ? 'outline' : 'primary'}
                                                className="h-8 px-3 text-xs"
                                                aria-label={`요약 프로그램 ${ollamaRuntimeActive ? '중지' : '받기'}`}
                                                onClick={() => {
                                                    if (ollamaRuntimeActive) {
                                                        void handleStopOllamaRuntimeDownload();
                                                        return;
                                                    }
                                                    void handleDownloadOllamaRuntime();
                                                }}
                                                disabled={ollamaRuntimeStopping}
                                            >
                                                {ollamaRuntimeActive
                                                    ? (
                                                        <>
                                                            {ollamaRuntimeStopping ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                                            {ollamaRuntimeStopping ? '중지 중' : '중지'}
                                                        </>
                                                    )
                                                    : '요약 프로그램 받기'}
                                            </Button>
                                        </div>
                                    )}
                                </div>}
                                {!ollamaRuntimeActive && ollamaMissing && (
                                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        <span>앱에서 받기(권장) 또는 직접 설치 중 하나만 선택하세요. 기존 Ollama가 있으면 그대로 사용합니다.</span>
                                        <button
                                            type="button"
                                            className="btn btn-ghost h-8 px-2 text-xs underline"
                                            aria-label="요약 프로그램 설치 페이지 열기"
                                            onClick={() => {
                                                setErrorMessage('');
                                                setMessage('');
                                                setOllamaInstallPrompted(false);
                                                setOllamaInstallNoticeMessage('');
                                                void openExternalUrl(OLLAMA_INSTALL_URL)
                                                    .then(() => {
                                                        if (!mountedRef.current) return;
                                                        setOllamaInstallPrompted(true);
                                                        setOllamaInstallNoticeMessage(OLLAMA_INSTALL_OPENED_NOTICE);
                                                    })
                                                    .catch(() => {
                                                        setOllamaInstallPrompted(true);
                                                        setOllamaInstallNoticeMessage(getOllamaInstallFailedNotice());
                                                    });
                                            }}
                                        >
                                            직접 설치(Ollama)
                                        </button>
                                    </div>
                                )}
                                {ollamaInstallNotice && (
                                    <StatusBanner
                                        tone={ollamaInstallNoticeTone}
                                        className="mt-3 py-2 text-xs shadow-none"
                                        action={renderDismissButton('요약 프로그램 설치 안내 닫기', () => {
                                            setOllamaInstallPrompted(false);
                                            setOllamaInstallNoticeMessage('');
                                        })}
                                    >
                                        {ollamaInstallNotice}
                                    </StatusBanner>
                                )}
                                {ollamaRuntimeActive && !ollamaRuntimeNeedsUpdate && (
                                    <div className="mt-3 space-y-1.5">
                                        <ProgressBar
                                            value={ollamaRuntimeProgressPercent}
                                            size="sm"
                                            label="요약 프로그램 받기 진행률"
                                        />
                                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                            {ollamaRuntimeProgressText && (
                                                <>
                                                    <Loader2 size={12} className="animate-spin text-primary" aria-hidden="true" />
                                                    <span>{ollamaRuntimeProgressText}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {!models && engineSettingsPending && (
                                    <div className="settings-model-note mt-3">
                                        <RefreshCw size={16} className="animate-spin text-primary" aria-hidden="true" />
                                        모델 상태를 불러오는 중입니다.
                                    </div>
                                )}
                                {!models && !engineSettingsPending && (settingsReadError || modelStatusWarning) && (
                                    <div className="settings-model-note mt-3 text-[var(--status-error-fg)]">
                                        모델 상태를 불러오지 못했습니다.
                                    </div>
                                )}
                                <div id="settings-additional-models">
                                    {models && summaryModelOptions.length > 0 && <div className="settings-model-list settings-summary-model-list" data-model-capacity={summaryModelOptions.length > 2 ? 4 : 2} role="radiogroup" aria-label="요약 모델 선택">
                                        {visibleSummaryModels.map((option, index) => {
                                            const optionModel = normalizeSummaryModelName(option.model);
                                            const pullStatus = ollamaPulls[optionModel];
                                            const pullActive = Boolean(pullStatus?.active);
                                            const pullStopping = pullStatus?.status === 'cancelling';
                                            const installed = isSummaryOptionInstalled(optionModel);
                                            const selected = optionModel === configuredSummaryModel;
                                            const deleting = Boolean(deletingOllamaModels[optionModel]);
                                            const canPull = isOllamaSummaryModel(optionModel) && ollamaModelActionsReady;
                                            const canRemove = option.source === 'user' && !selected;
                                            const canDeleteFiles = installed && canPull && !summaryModelInventoryUnknown;
                                            const deleteDisabled = ollamaRuntimeActive || selected || pullActive || deleting || isSaving || (!canRemove && !canDeleteFiles);
                                            const deleteReason = selected ? '사용 중인 모델입니다. 다른 모델을 선택한 뒤 삭제할 수 있습니다.'
                                                : pullActive ? '받기를 중지한 뒤 삭제할 수 있습니다.' : deleteDisabled ? '현재 삭제할 수 없는 모델입니다.' : '삭제 옵션';
                                            const menuId = `summary-model-menu-${index}`;
                                            return <div key={optionModel} className="settings-model-row" tabIndex={-1} data-model-name={optionModel} data-model-selected={selected}>
                                                <div className="settings-model-controls">
                                                    <div className="settings-model-label"><span className="settings-model-name" title={optionModel}>{optionModel}</span></div>
                                                    <div className="settings-model-actions">
                                                        {pullActive ? <button type="button" className="settings-model-icon" aria-label={`${optionModel} 중지`} title="받기 중지" disabled={pullStopping}
                                                            onClick={() => void handleStopOllamaModelDownload(optionModel)}>{pullStopping ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} />}</button>
                                                            : (summaryModelInventoryUnknown || installed) ? <label className="settings-model-choice" title={summaryModelInventoryUnknown ? (selected ? '선택한 요약 모델 · 준비 확인 필요' : '준비 상태를 확인한 뒤 선택할 수 있습니다.') : selected ? '현재 사용 중인 요약 모델' : '요약 모델로 선택'}>
                                                                    <input type="radio" name="settings-summary-model" aria-label={`${optionModel} 요약 모델로 선택`} checked={selected}
                                                                        aria-description={summaryModelInventoryUnknown ? '저장된 선택을 표시합니다. 준비 상태는 아직 확인하지 못했습니다.' : undefined}
                                                                        disabled={ollamaRuntimeActive || summaryModelInventoryUnknown || isSaving || deleting} onChange={() => { if (!selected) void handleSaveSummaryModel(optionModel); }} />
                                                                    <Check size={16} strokeWidth={selected ? 2.5 : 2} aria-hidden="true" />
                                                                </label>
                                                                    : <button type="button" className="settings-model-icon" aria-label={`${optionModel} 받기`} title="받기" disabled={!canPull || deleting}
                                                                        onClick={() => void handleDownloadOllamaModel(optionModel)}><Download size={16} aria-hidden="true" /></button>}
                                                        <div data-summary-model-menu-root>
                                                            <button type="button" className="settings-model-icon settings-model-delete" aria-label={`${optionModel} 삭제 옵션`} aria-haspopup="menu"
                                                                aria-expanded={openSummaryModelMenu === optionModel} aria-controls={menuId} disabled={deleteDisabled} title={deleteReason}
                                                                onClick={event => handleSummaryModelMenuToggle(event, optionModel)} onKeyDown={event => handleSummaryModelMenuTriggerKeyDown(event, optionModel)}><Trash2 size={16} aria-hidden="true" /></button>
                                                            {openSummaryModelMenu === optionModel && <div id={menuId} role="menu" aria-label={`${optionModel} 삭제 옵션`} tabIndex={-1}
                                                                onKeyDown={handleSummaryModelMenuKeyDown} className="menu-panel settings-model-delete-menu" style={menuPosition}>
                                                                <button type="button" role="menuitem" tabIndex={-1} className="menu-item" aria-label={`${optionModel} 목록에서 제거`} disabled={!canRemove || deleting}
                                                                    onClick={() => openModelDeleteConfirmation(optionModel, false)}>목록에서 제거<span className="text-xs text-muted-foreground">PC 파일 유지</span></button>
                                                                <button type="button" role="menuitem" tabIndex={-1} className="menu-item menu-item-danger" aria-label={`${optionModel} PC에서 삭제`} disabled={!canDeleteFiles || deleting}
                                                                    onClick={() => openModelDeleteConfirmation(optionModel, true)}><Trash2 size={14} aria-hidden="true" />PC에서 삭제</button>
                                                            </div>}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="settings-model-progress" aria-live="polite">
                                                    {pullActive ? <><ProgressBar value={getOllamaPullProgressPercent(pullStatus)} size="sm" tone="info" label={`${optionModel} 모델 받기 진행률`} /><span>{getOllamaPullProgressText(pullStatus)}</span></>
                                                        : pullStatus?.error_code !== 'runtime_update_required' && (pullStatus?.status === 'failed' || pullStatus?.status === 'cancelled') ? <span>{pullStatus?.message || (pullStatus?.status === 'cancelled' ? '받기를 중지했습니다.' : '받지 못했습니다. 다시 받아 주세요.')}</span> : null}
                                                </div>
                                            </div>;
                                        })}
                                    </div>}
                                    <div className="settings-model-footer">
                                        {ollamaRuntimeNeedsUpdate ? <div className="w-full">
                                            <div className="settings-summary-recovery">
                                                <p role="status" className="text-xs text-muted-foreground">
                                                    {ollamaRuntimeActive ? ollamaRuntimeStatus?.message || '요약 프로그램을 업데이트하고 있습니다.'
                                                        : ollamaRuntimeStatus?.status === 'failed' ? ollamaRuntimeStatus.message
                                                            : ollamaUsingManagedRuntime ? '이 모델을 받으려면 요약 프로그램을 업데이트해 주세요.'
                                                                : 'Ollama를 업데이트한 뒤 모델 받기를 다시 눌러 주세요.'}
                                                </p>
                                                <Button variant="outline" className="h-8 shrink-0 px-3 text-xs"
                                                    aria-label={ollamaRuntimeActive ? '요약 프로그램 업데이트 중지' : '요약 프로그램 업데이트'}
                                                    title={!ollamaUsingManagedRuntime ? 'Ollama 공식 업데이트 설치 화면을 엽니다.' : undefined}
                                                    disabled={ollamaRuntimeStopping || ollamaRuntimeStatus?.status === 'installing'}
                                                    onClick={() => {
                                                        if (ollamaRuntimeActive) void handleStopOllamaRuntimeDownload();
                                                        else if (ollamaUsingManagedRuntime) void handleDownloadOllamaRuntime(true);
                                                        else void openExternalUrl(OLLAMA_INSTALL_URL).catch(() => setErrorMessage('Ollama 업데이트 화면을 열지 못했습니다. 공식 사이트에서 설치 파일을 받아 주세요.'));
                                                    }}>
                                                    {ollamaRuntimeActive ? <><Loader2 size={13} className="animate-spin" aria-hidden="true" />{ollamaRuntimeStatus?.status === 'installing' ? '적용 중' : ollamaRuntimeStopping ? '중지 중' : '중지'}</> : <><RefreshCw size={13} aria-hidden="true" />요약 프로그램 업데이트</>}
                                                </Button>
                                            </div>
                                            {ollamaRuntimeActive && <ProgressBar value={ollamaRuntimeProgressPercent} size="sm" label="요약 프로그램 업데이트 진행률" />}
                                        </div> : showSummaryConnectionNotice && <div className="settings-summary-recovery">
                                            <p role="status" className="text-xs text-muted-foreground">{summaryModelOllamaHelp}</p>
                                            {showSummaryConnectAction && <Button variant="outline" className="h-8 shrink-0 px-3 text-xs"
                                                aria-label={summaryConnectActionLabel} disabled={isConnectingSummary}
                                                onClick={() => void handleConnectSummaryModels()}>
                                                {isConnectingSummary && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                                                {isConnectingSummary ? '연결 중' : summaryConnectActionLabel}
                                            </Button>}
                                        </div>}
                                    {modelPageCount > 1 && <div className="settings-model-pagination">
                                        {modelPageCount > 1 && <><button type="button" className="icon-button h-6 w-6" aria-label="이전 모델" disabled={visibleModelPage === 0} onClick={() => { setOpenSummaryModelMenu(''); setModelPage(visibleModelPage - 1); }}><ChevronLeft size={14} /></button>
                                            <span>{visibleModelPage + 1}/{modelPageCount}</span><button type="button" className="icon-button h-6 w-6" aria-label="다음 모델" disabled={visibleModelPage + 1 >= modelPageCount} onClick={() => { setOpenSummaryModelMenu(''); setModelPage(visibleModelPage + 1); }}><ChevronRight size={14} /></button></>}
                                    </div>}
                                    </div>
                                </div>

                            </div>
                        </section>
                        <section className="settings-group settings-storage" aria-labelledby="settings-storage-title">
                            <h4 id="settings-storage-title">저장</h4>
                            <div className="settings-list">
                                <div className="settings-paired-row">
                                    <label className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title settings-title-with-hint">다운로드 형식<SettingsHint label="다운로드 형식" text="회의록을 저장할 때 기본으로 사용할 형식입니다." /></span>
                                        </span>
                                        <select aria-label="다운로드 형식"
                                            value={downloadFormat}
                                            onChange={event => handleDownloadFormatChange(event.target.value as DownloadFormat)}
                                            className="select-field settings-row-select"
                                        >
                                            <option value="hwpx">HWPX</option>
                                            <option value="docx">DOCX</option>
                                            <option value="txt">TXT</option>
                                            <option value="md">MD</option>
                                        </select>
                                    </label>
                                    <label className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title settings-title-with-hint">회의 요약 HWPX 자동 저장<SettingsHint label="회의 요약 HWPX 자동 저장" text="요약이 만들어지면 다운로드 폴더에도 저장합니다." /></span>
                                        </span>
                                        {renderEngineSetting(
                                            <input aria-label="회의 요약 HWPX 자동 저장"
                                                type="checkbox"
                                                className="settings-switch"
                                                checked={autoSaveHwpxCopy}
                                                onChange={event => setAutoSaveHwpxCopy(event.target.checked)}
                                            />
                                        )}
                                    </label>
                                </div>
                                <div className="settings-paired-row">
                                    <label className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title settings-title-with-hint">음성 재생 파일 보관<SettingsHint label="음성 재생 파일 보관" text="다시 듣기와 나중에 참석자 구분에 사용합니다." /></span>
                                        </span>
                                        {renderEngineSetting(
                                            <input aria-label="음성 재생 파일 보관"
                                                type="checkbox"
                                                className="settings-switch"
                                                checked={preserveExtractedAudio}
                                                onChange={event => setPreserveExtractedAudio(event.target.checked)}
                                            />
                                        )}
                                    </label>
                                    <label className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title settings-title-with-hint">음성 파일 자동 저장<SettingsHint label="음성 파일 자동 저장" text={preserveExtractedAudio ? '보관한 음성을 다운로드 폴더에도 저장합니다.' : '음성 재생 파일 보관을 켜면 사용할 수 있습니다.'} /></span>
                                        </span>
                                        {renderEngineSetting(
                                            <input aria-label="음성 파일 자동 저장"
                                                type="checkbox"
                                                className="settings-switch"
                                                checked={preserveExtractedAudio && autoSaveAudioCopy}
                                                onChange={event => setAutoSaveAudioCopy(event.target.checked)}
                                                disabled={!preserveExtractedAudio}
                                            />
                                        )}
                                    </label>
                                </div>
                            </div>
                        </section>
                        {isTauriRuntime() && (initialSection === 'troubleshooting' || isRestartingBackend || requiresModelRepair
                            || Boolean(modelStatusErrorMessage || settingsReadError) || (!isLoading && !settings)) && (
                            <div className="settings-group" id="settings-troubleshooting" data-settings-highlighted={highlightedSetting === 'settings-troubleshooting'}>
                                <h4>문제 해결</h4>
                                <div className="settings-list">
                                    {requiresModelRepair && <div className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title">필수 모델 파일 복구</span>
                                            <span className="settings-row-description">앱 설치 파일로 다시 설치해 주세요. 재시작만으로는 없는 파일이 설치되지 않습니다.</span>
                                        </span>
                                    </div>}
                                    <div className="settings-row">
                                        <span className="settings-row-copy">
                                            <span className="settings-row-title">분석 기능 재시작</span>
                                            <span id="settings-restart-description" className="settings-row-description">
                                                모델 상태가 계속 갱신되지 않을 때만 사용합니다.
                                                {analysisActive ? ' 진행 중인 분석이 끝난 뒤 다시 시작할 수 있습니다.' : ''}
                                            </span>
                                        </span>
                                        <Button
                                            ref={restartButtonRef}
                                            variant="outline"
                                            className="shrink-0"
                                            aria-describedby="settings-restart-description"
                                            onClick={() => void handleRestartBackend()}
                                            disabled={!canRestartBackend}
                                            title={analysisActive ? '진행 중인 분석이 끝난 뒤 다시 시작할 수 있습니다.' : '분석 기능을 다시 시작합니다.'}
                                        >
                                            <RefreshCw size={16} className={isRestartingBackend ? 'animate-spin' : ''} />
                                            {isRestartingBackend ? '재시작 중' : '재시작'}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>

                    </>}
                </div>
            </div>
        </div>
    );
};
