import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

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

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState<SettingsTab>('models');
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [chunkSeconds, setChunkSeconds] = useState(30);
    const [chunkingEnabled, setChunkingEnabled] = useState(true);
    const [diarizationEnabled, setDiarizationEnabled] = useState(true);
    const [sttDevice, setSttDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');

    const missingModels = useMemo(
        () => (models?.models || []).filter(model => model.required && !model.installed),
        [models],
    );

    const modelSummary = useMemo(() => {
        if (!models) return '확인 중';
        if (models.ready) return '필수 모델 준비됨';
        return `${missingModels.length}개 모델 필요`;
    }, [models, missingModels.length]);

    const loadSettings = async () => {
        setIsLoading(true);
        setErrorMessage('');
        try {
            const [settingsResponse, modelsResponse] = await Promise.all([
                fetch(`${API_BASE}/api/settings`),
                fetch(`${API_BASE}/api/models/status`),
            ]);

            if (!settingsResponse.ok || !modelsResponse.ok) {
                throw new Error('설정 정보를 불러오지 못했습니다. 백엔드 서버가 실행 중인지 확인해 주세요.');
            }

            const nextSettings = await settingsResponse.json() as SettingsPayload;
            setSettings(nextSettings);
            setModels(await modelsResponse.json());
            setChunkSeconds(nextSettings.processing?.long_audio_chunk_seconds ?? 30);
            setChunkingEnabled(nextSettings.processing?.enable_long_audio_chunking ?? true);
            setDiarizationEnabled(nextSettings.diarization?.enabled ?? true);
            setSttDevice(nextSettings.stt?.device ?? 'auto');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const handleOpenDownloadPages = () => {
        const candidates = missingModels.length
            ? missingModels
            : (models?.models || []).filter(model => model.downloadable || model.license_url || model.repo_id);

        if (!candidates.length) {
            setMessage('필수 모델이 모두 준비되어 있습니다.');
            return;
        }

        candidates.slice(0, 3).forEach(model => {
            const url = modelPageUrl(model);
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
        setMessage('모델 페이지를 열었습니다. 받은 파일을 지정된 models 폴더에 넣은 뒤 상태를 새로고침하세요.');
    };

    const handleSaveSettings = async () => {
        setIsSaving(true);
        setErrorMessage('');
        setMessage('');

        try {
            const response = await fetch(`${API_BASE}/api/settings`, {
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
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
                        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {errorMessage}
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
                                        사용자는 모델이 준비됐는지만 알면 됩니다. 부족한 모델은 다운로드 페이지에서 받아 넣으면 됩니다.
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <Button variant="outline" onClick={loadSettings} disabled={isLoading || isSaving}>
                                        상태 새로고침
                                    </Button>
                                    <Button onClick={handleOpenDownloadPages} disabled={isLoading}>
                                        다운로드
                                    </Button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-3">
                                {(models?.models || []).map(model => (
                                    <div key={model.key} className="rounded-md border border-border bg-muted/20 p-4">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <div className="font-medium text-foreground">{model.label}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {model.required ? '필수' : '선택'} · {model.gated ? '약관 확인 필요' : '공개 모델'}
                                                </div>
                                            </div>
                                            <span className={`w-fit rounded-md px-2.5 py-1 text-xs font-semibold ${model.installed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                                {model.installed ? '준비됨' : '필요함'}
                                            </span>
                                        </div>
                                        {!model.installed && (
                                            <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                                {model.manual_note || '모델 페이지에서 파일을 받은 뒤 앱의 models 폴더에 배치하세요.'}
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {!models?.models.length && (
                                    <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
                                        모델 상태를 불러오는 중입니다.
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
                                        대부분은 기본값으로 충분합니다. 문제가 있을 때만 조정하세요.
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

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">분할 길이</span>
                                <div className="mt-3 flex items-center gap-3">
                                    <input
                                        type="range"
                                        min={10}
                                        max={300}
                                        step={10}
                                        value={chunkSeconds}
                                        onChange={event => setChunkSeconds(Number(event.target.value))}
                                        className="w-full"
                                        disabled={!chunkingEnabled}
                                    />
                                    <input
                                        type="number"
                                        min={10}
                                        max={3600}
                                        value={chunkSeconds}
                                        onChange={event => setChunkSeconds(Number(event.target.value))}
                                        className="w-24 rounded-md border border-input bg-background px-3 py-2"
                                        disabled={!chunkingEnabled}
                                    />
                                    <span className="text-sm text-muted-foreground">초</span>
                                </div>
                            </label>

                            <label className="rounded-md border border-border bg-muted/20 p-4">
                                <span className="block font-medium text-foreground">실행 장치</span>
                                <select
                                    value={sttDevice}
                                    onChange={event => setSttDevice(event.target.value as 'auto' | 'cpu' | 'cuda')}
                                    className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2"
                                >
                                    <option value="auto">자동</option>
                                    <option value="cpu">CPU</option>
                                    <option value="cuda">CUDA</option>
                                </select>
                            </label>
                        </section>
                    )}

                    {activeTab === 'about' && (
                        <section className="flex flex-col gap-4 text-sm">
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">요약 엔진</div>
                                <div className="mt-1 text-muted-foreground">
                                    {settings?.summary?.provider || 'ollama'} · {settings?.summary?.model || 'gemma4:e2b'}
                                </div>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 p-4">
                                <div className="font-medium text-foreground">데스크톱 앱에서 숨긴 항목</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    API 주소, 내부 저장 경로, 임시 파일 정책, 모델 세부 경로는 일반 사용자가 매번 볼 필요가 없어 기본 화면에서 제외했습니다. 배포판에서는 앱이 정한 폴더와 백엔드 실행 환경을 사용하면 됩니다.
                                </p>
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
