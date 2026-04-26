import React, { useEffect, useState } from 'react';
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
}

interface ModelsPayload {
    ready: boolean;
    models: ModelStatus[];
}

export const Settings: React.FC = () => {
    const [settings, setSettings] = useState<SettingsPayload | null>(null);
    const [models, setModels] = useState<ModelsPayload | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isDownloading, setIsDownloading] = useState(false);
    const [message, setMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

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

            setSettings(await settingsResponse.json());
            setModels(await modelsResponse.json());
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
    }, []);

    const handleDownloadModels = async () => {
        const needsToken = models?.models.some(model => model.requires_token && !model.installed && model.downloadable);
        const confirmed = window.confirm(
            needsToken
                ? '누락 모델 다운로드를 시작합니다. Pyannote 계열은 Hugging Face 라이선스 동의와 HF_TOKEN 환경변수가 필요할 수 있습니다. 계속할까요?'
                : '누락 모델 다운로드를 시작할까요?'
        );
        if (!confirmed) return;

        setIsDownloading(true);
        setMessage('모델 다운로드 요청을 시작했습니다.');
        setErrorMessage('');

        try {
            const response = await fetch(`${API_BASE}/api/models/download`, {
                method: 'POST',
                headers: { Accept: 'text/event-stream' },
            });

            if (!response.ok) throw new Error(`모델 다운로드 요청 실패: ${response.status}`);
            const reader = response.body?.getReader();
            if (!reader) throw new Error('다운로드 스트림을 읽을 수 없습니다.');

            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split('\n\n');
                buffer = blocks.pop() || '';

                for (const block of blocks) {
                    const data = block
                        .split('\n')
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trim())
                        .join('\n');
                    if (!data || data === '[DONE]') continue;

                    const parsed = JSON.parse(data);
                    if (parsed.message) setMessage(parsed.message);
                    if (parsed.type === 'error') throw new Error(parsed.message);
                    if (parsed.models) setModels({ ready: parsed.models.every((model: ModelStatus) => !model.required || model.installed), models: parsed.models });
                }
            }

            await loadSettings();
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '모델 다운로드 중 오류가 발생했습니다.');
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
            <div>
                <h2 className="text-h3 font-semibold text-primary">시스템 설정</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                    로컬 분석 서버, 모델 준비 상태, 대용량 파일 처리 정책을 확인합니다.
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
                    <Button variant="outline" onClick={loadSettings} disabled={isLoading || isDownloading}>
                        새로고침
                    </Button>
                </div>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">API 주소</div>
                        <div className="font-medium text-foreground">{API_BASE}</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">현재 모드</div>
                        <div className="font-medium text-foreground">{settings?.analysis_mode || 'mock'}</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">오프라인 모드</div>
                        <div className="font-medium text-foreground">{settings?.offline_mode ? '사용' : '미사용'}</div>
                    </div>
                </div>
            </section>

            <section className="bg-background border border-border rounded-lg p-6">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-semibold text-foreground">모델 준비 상태</h3>
                        <p className="text-sm text-muted-foreground">
                            기본 음성 인식은 Cohere Transcribe를 사용합니다. 로컬에 없으면 실제 분석 시작 시 자동 다운로드를 시도하고, Pyannote 계열은 라이선스 동의와 `HF_TOKEN` 환경변수가 필요할 수 있습니다.
                        </p>
                    </div>
                    <Button onClick={handleDownloadModels} disabled={isLoading || isDownloading}>
                        {isDownloading ? '다운로드 중...' : '누락 모델 다운로드 활성화'}
                    </Button>
                </div>

                <div className="mt-5 overflow-hidden rounded-md border border-border">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-muted text-foreground">
                            <tr>
                                <th className="p-3">모델</th>
                                <th className="p-3">상태</th>
                                <th className="p-3">요구 사항</th>
                                <th className="p-3">비고</th>
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
                                                HF_TOKEN {model.token_available ? '확인됨' : '필요'}
                                            </div>
                                        )}
                                        {model.license_name && <div>{model.license_name}</div>}
                                    </td>
                                    <td className="p-3 text-muted-foreground">
                                        <div>{model.gated ? '라이선스/조건 수락 필요 가능' : model.downloadable ? '자동 다운로드 가능' : '수동 배치 필요'}</div>
                                        {model.manual_note && <div className="mt-1 text-xs">{model.manual_note}</div>}
                                        {model.license_url && (
                                            <a className="mt-1 inline-block text-primary underline" href={model.license_url} target="_blank" rel="noreferrer">
                                                모델 페이지
                                            </a>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {!models?.models.length && (
                                <tr>
                                    <td colSpan={3} className="p-6 text-center text-muted-foreground">
                                        모델 상태를 불러오는 중입니다.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-background border border-border rounded-lg p-6">
                <h3 className="text-lg font-semibold text-foreground">대용량 파일 처리</h3>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">긴 음성 청크 분할</div>
                        <div className="font-medium text-foreground">{settings?.processing?.enable_long_audio_chunking ? '사용' : '미사용'}</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">청크 길이</div>
                        <div className="font-medium text-foreground">{settings?.processing?.long_audio_chunk_seconds || 900}초</div>
                    </div>
                    <div className="rounded-md bg-muted/30 p-3">
                        <div className="text-muted-foreground">요약 엔진</div>
                        <div className="font-medium text-foreground">{settings?.summary?.provider || 'ollama'} · {settings?.summary?.model || 'gemma4:e2b'}</div>
                    </div>
                </div>
            </section>
        </div>
    );
};
