import React, { useEffect, useMemo, useState } from 'react';
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
    app_name?: string;
    offline_mode?: boolean;
    analysis_mode?: string;
    paths?: {
        stt_model?: string;
        diarization_model?: string;
        output_dir?: string;
        temp_dir?: string;
    };
    processing?: {
        long_audio_chunk_seconds?: number;
        enable_long_audio_chunking?: boolean;
    };
    privacy?: {
        auto_delete_temp_audio?: boolean;
        save_original_audio_copy?: boolean;
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

const modelPageUrl = (model: ModelStatus): string | null => {
    if (model.license_url) return model.license_url;
    if (model.repo_id) return `https://huggingface.co/${model.repo_id}`;
    return null;
};

export const Settings: React.FC = () => {
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
        [models]
    );

    const loadSettings = async () => {
        setIsLoading(true);
        setErrorMessage('');
        try {
            const [settingsResponse, modelsResponse] = await Promise.all([
                fetch(`${API_BASE}/api/settings`),
                fetch(`${API_BASE}/api/models/status`),
            ]);

            if (!settingsResponse.ok || !modelsResponse.ok) {
                throw new Error('설정 정보를 불러오지 못했습니다.');
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

    const handleOpenDownloadPages = () => {
        const targets = missingModels.length ? missingModels : (models?.models || []).filter(model => model.downloadable || model.license_url);
        if (!targets.length) {
            setMessage('필수 모델이 모두 준비되어 있습니다.');
            return;
        }

        window.alert('모델 파일은 자동으로 내려받지 않습니다. 열리는 모델 페이지에서 약관을 확인하고 필요한 파일을 받은 뒤 표시된 경로에 배치해 주세요.');
        targets.slice(0, 3).forEach(model => {
            const url = modelPageUrl(model);
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
        setMessage('모델 다운로드 페이지를 열었습니다. 다운로드 후 새로고침을 눌러 상태를 확인하세요.');
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
            setMessage('설정을 저장했습니다. 다음 분석부터 적용됩니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '설정 저장 중 오류가 발생했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
            <div>
                <h2 className="text-h3 font-semibold text-primary">시스템 설정</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                    로컬 분석 서버, 모델 준비 상태, 파일 분할 방식과 실행 장치를 관리합니다.
                </p>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {errorMessage}
                </div>
            )}
            {message && (
                <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                    {message}
                </div>
            )}

            <section className="bg-background border border-border rounded-lg p-6">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-semibold text-foreground">분석 서버</h3>
                        <p className="text-sm text-muted-foreground">FastAPI 서버와 프론트엔드가 사용하는 기본 API 주소입니다.</p>
                    </div>
                    <Button variant="outline" onClick={loadSettings} disabled={isLoading || isSaving}>
                        새로고침
                    </Button>
                </div>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">API 주소</div>
                        <div className="font-medium text-foreground break-all">{API_BASE}</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">분석 모드</div>
                        <div className="font-medium text-foreground">{settings?.analysis_mode || 'mock'}</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">저장 위치</div>
                        <div className="font-medium text-foreground break-all">{settings?.paths?.output_dir || './outputs'}</div>
                    </div>
                </div>
            </section>

            <section className="bg-background border border-border rounded-lg p-6">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-semibold text-foreground">모델 준비 상태</h3>
                        <p className="text-sm text-muted-foreground">
                            Cohere Transcribe는 음성 인식, Pyannote Community-1은 화자 분리를 담당합니다.
                        </p>
                    </div>
                    <Button onClick={handleOpenDownloadPages} disabled={isLoading}>
                        다운로드 페이지 열기
                    </Button>
                </div>

                <div className="mt-5 overflow-hidden rounded-md border border-border">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-muted text-foreground">
                            <tr>
                                <th className="p-3">모델</th>
                                <th className="p-3">상태</th>
                                <th className="p-3">요구 사항</th>
                                <th className="p-3">받는 곳</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(models?.models || []).map(model => (
                                <tr key={model.key} className="border-t border-border">
                                    <td className="p-3">
                                        <div className="font-medium text-foreground">{model.label}</div>
                                        <div className="text-xs text-muted-foreground truncate max-w-xl">{model.path}</div>
                                    </td>
                                    <td className="p-3">
                                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${model.installed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                            {model.installed ? '준비됨' : '누락'}
                                        </span>
                                    </td>
                                    <td className="p-3 text-muted-foreground">
                                        <div>{model.required ? '필수' : '선택'}</div>
                                        {model.requires_token && (
                                            <div className={model.token_available ? 'text-green-700' : 'text-amber-700'}>
                                                HF 토큰 {model.token_available ? '확인됨' : '필요'}
                                            </div>
                                        )}
                                        {model.license_name && <div>{model.license_name}</div>}
                                    </td>
                                    <td className="p-3 text-muted-foreground">
                                        <div>{model.gated ? '약관 수락 후 수동 배치' : model.downloadable ? '모델 페이지에서 다운로드' : '수동 배치 필요'}</div>
                                        {model.manual_note && <div className="mt-1 text-xs">{model.manual_note}</div>}
                                        {modelPageUrl(model) && (
                                            <a className="mt-1 inline-block text-primary underline" href={modelPageUrl(model) || ''} target="_blank" rel="noreferrer">
                                                모델 페이지
                                            </a>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {!models?.models.length && (
                                <tr>
                                    <td colSpan={4} className="p-6 text-center text-muted-foreground">
                                        모델 상태를 불러오는 중입니다.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-background border border-border rounded-lg p-6">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-semibold text-foreground">분석 옵션</h3>
                        <p className="text-sm text-muted-foreground">긴 파일은 음성으로 변환한 뒤 청크 단위로 나누어 처리합니다.</p>
                    </div>
                    <Button onClick={handleSaveSettings} disabled={isLoading || isSaving}>
                        {isSaving ? '저장 중...' : '설정 저장'}
                    </Button>
                </div>

                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <label className="flex items-center gap-3 rounded-md bg-muted/30 p-3">
                        <input
                            type="checkbox"
                            checked={chunkingEnabled}
                            onChange={event => setChunkingEnabled(event.target.checked)}
                        />
                        <span>
                            <span className="block font-medium text-foreground">긴 파일 청크 분할</span>
                            <span className="text-muted-foreground">큰 음성/영상 파일을 작은 구간으로 나누어 분석합니다.</span>
                        </span>
                    </label>

                    <label className="rounded-md bg-muted/30 p-3">
                        <span className="block text-muted-foreground">청크 길이</span>
                        <div className="mt-2 flex items-center gap-3">
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
                            <span>초</span>
                        </div>
                    </label>

                    <label className="flex items-center gap-3 rounded-md bg-muted/30 p-3">
                        <input
                            type="checkbox"
                            checked={diarizationEnabled}
                            onChange={event => setDiarizationEnabled(event.target.checked)}
                        />
                        <span>
                            <span className="block font-medium text-foreground">화자 분리 사용</span>
                            <span className="text-muted-foreground">누가 언제 말했는지 Pyannote로 정렬합니다.</span>
                        </span>
                    </label>

                    <label className="rounded-md bg-muted/30 p-3">
                        <span className="block text-muted-foreground">STT 실행 장치</span>
                        <select
                            value={sttDevice}
                            onChange={event => setSttDevice(event.target.value as 'auto' | 'cpu' | 'cuda')}
                            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2"
                        >
                            <option value="auto">Auto</option>
                            <option value="cpu">CPU</option>
                            <option value="cuda">CUDA</option>
                        </select>
                    </label>

                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">요약 엔진</div>
                        <div className="font-medium text-foreground">{settings?.summary?.provider || 'ollama'} · {settings?.summary?.model || 'gemma4:e2b'}</div>
                    </div>

                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">임시 파일 정책</div>
                        <div className="font-medium text-foreground">
                            {settings?.privacy?.auto_delete_temp_audio ? '분석 후 임시 음성 삭제' : '임시 음성 보관'}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};
