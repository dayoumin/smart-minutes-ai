import React, { useEffect, useMemo, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { StatusBanner } from './StatusBanner';
import { toApiUrl } from './apiBase';

interface BenchmarkListItem {
    id: string;
    name: string;
    path: string;
    created_at?: string | null;
    modified_at?: string | null;
    size_bytes: number;
    sample_count?: number | null;
    engine_count?: number | null;
    kind: 'asr_benchmark' | 'single_result';
}

interface BenchmarkDetail {
    id: string;
    name: string;
    path: string;
    payload: unknown;
}

interface NormalizedResult {
    id: string;
    label: string;
    ok: boolean;
    seconds?: number;
    chars?: number;
    hangulRatio?: number;
    preview: string;
    error?: string;
}

const formatBytes = (value: number): string => {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const getNumber = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const scoreFromText = (text: string): { chars: number; hangulRatio: number } => {
    let hangul = 0;
    let latin = 0;
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code >= 0xac00 && code <= 0xd7a3) hangul += 1;
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin += 1;
    }
    return {
        chars: text.length,
        hangulRatio: hangul / Math.max(1, hangul + latin),
    };
};

const textFromSegments = (segments: unknown): string => {
    if (!Array.isArray(segments)) return '';
    return segments
        .map(segment => isRecord(segment) ? String(segment.text || '').trim() : '')
        .filter(Boolean)
        .join(' ');
};

const normalizeBenchmarkResults = (payload: unknown): NormalizedResult[] => {
    if (Array.isArray(payload)) {
        return payload.map((item, index) => {
            const record = isRecord(item) ? item : {};
            const preview = String(record.preview || '');
            const score = scoreFromText(preview);
            return {
                id: `direct-${index}`,
                label: `${record.variant || 'direct'}${record.punctuation !== undefined ? ` / punctuation ${String(record.punctuation)}` : ''}`,
                ok: true,
                seconds: getNumber(record.seconds),
                chars: getNumber(record.chars) ?? score.chars,
                hangulRatio: getNumber(record.hangul_ratio) ?? score.hangulRatio,
                preview,
            };
        });
    }

    if (!isRecord(payload)) return [];

    const samples = payload.samples;
    if (Array.isArray(samples)) {
        return samples.flatMap((sample, sampleIndex) => {
            if (!isRecord(sample)) return [];
            const sampleId = String(sample.sample_id || `sample-${sampleIndex + 1}`);
            const results = Array.isArray(sample.results) ? sample.results : [];
            return results.map((result, resultIndex) => {
                const record = isRecord(result) ? result : {};
                const score = isRecord(record.score) ? record.score : {};
                return {
                    id: `${sampleId}-${record.engine_id || resultIndex}`,
                    label: `${sampleId} / ${record.label || record.engine_id || record.engine || 'engine'}`,
                    ok: Boolean(record.ok),
                    seconds: getNumber(record.seconds),
                    chars: getNumber(score.chars),
                    hangulRatio: getNumber(score.hangul_ratio),
                    preview: String(record.preview || ''),
                    error: record.error ? String(record.error) : undefined,
                };
            });
        });
    }

    const preview = String(payload.preview || textFromSegments(payload.segments));
    if (preview) {
        const score = scoreFromText(preview);
        return [{
            id: 'single',
            label: String(payload.engine || payload.config || payload.mode || 'result'),
            ok: true,
            seconds: getNumber(payload.seconds),
            chars: getNumber(payload.chars) ?? score.chars,
            hangulRatio: getNumber(payload.hangul_ratio) ?? score.hangulRatio,
            preview,
        }];
    }

    return [];
};

export const AsrBenchmark: React.FC = () => {
    const [items, setItems] = useState<BenchmarkListItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<BenchmarkDetail | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadItems = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch(await toApiUrl('/api/dev/asr-benchmarks'), { cache: 'no-store' });
            if (!response.ok) throw new Error(`결과 목록을 불러오지 못했습니다. (${response.status})`);
            const payload = await response.json() as { results?: BenchmarkListItem[] };
            const nextItems = payload.results || [];
            setItems(nextItems);
            if (!selectedId && nextItems[0]) setSelectedId(nextItems[0].id);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : '결과 목록을 불러오지 못했습니다.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadItems();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const loadDetail = async () => {
            if (!selectedId) {
                setDetail(null);
                return;
            }
            setError(null);
            try {
                const response = await fetch(await toApiUrl(`/api/dev/asr-benchmarks/${encodeURIComponent(selectedId)}`), { cache: 'no-store' });
                if (!response.ok) throw new Error(`결과를 불러오지 못했습니다. (${response.status})`);
                setDetail(await response.json() as BenchmarkDetail);
            } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : '결과를 불러오지 못했습니다.');
            }
        };
        void loadDetail();
    }, [selectedId]);

    const normalizedResults = useMemo(() => normalizeBenchmarkResults(detail?.payload), [detail]);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-foreground">ASR 테스트 결과</h2>
                    <div className="mt-1 text-sm text-muted-foreground">같은 샘플로 모델별 음성 인식 결과를 비교합니다.</div>
                </div>
                <Button variant="outline" className="gap-2" onClick={() => void loadItems()} disabled={isLoading}>
                    <RefreshCw size={15} />
                    새로고침
                </Button>
            </div>

            {error && (
                <StatusBanner tone="warning">
                    {error}
                </StatusBanner>
            )}

            <div className="grid min-h-[560px] grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="app-panel overflow-hidden">
                    <div className="app-panel-header">
                        <div className="font-semibold text-foreground">결과 파일</div>
                    </div>
                    <div className="flex max-h-[520px] flex-col overflow-auto p-2 custom-scrollbar">
                        {items.length ? items.map(item => {
                            const isSelected = selectedId === item.id;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={`flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/40'}`}
                                    onClick={() => setSelectedId(item.id)}
                                >
                                    <FileText size={15} className={isSelected ? 'mt-0.5 shrink-0 text-primary' : 'mt-0.5 shrink-0 text-muted-foreground'} />
                                    <span className="min-w-0 flex-1">
                                        <span className={isSelected ? 'block truncate text-sm font-semibold text-primary' : 'block truncate text-sm font-semibold text-foreground'}>
                                            {item.name}
                                        </span>
                                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                            {item.modified_at || item.created_at || '날짜 없음'} · {formatBytes(item.size_bytes)}
                                        </span>
                                    </span>
                                </button>
                            );
                        }) : (
                            <div className="px-3 py-4 text-sm text-muted-foreground">
                                아직 표시할 테스트 결과가 없습니다.
                            </div>
                        )}
                    </div>
                </section>

                <section className="app-panel overflow-hidden">
                    <div className="app-panel-header">
                        <div>
                            <div className="font-semibold text-foreground">{detail?.name || '결과 선택'}</div>
                            {detail?.path && <div className="mt-1 truncate text-xs text-muted-foreground">{detail.path}</div>}
                        </div>
                    </div>

                    <div className="flex max-h-[520px] flex-col gap-3 overflow-auto p-4 custom-scrollbar">
                        {normalizedResults.length ? normalizedResults.map(result => (
                            <article key={result.id} className="summary-block">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-semibold text-foreground">{result.label}</div>
                                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                            <span>{result.ok ? '완료' : '실패'}</span>
                                            {result.seconds !== undefined && <span>{result.seconds}초</span>}
                                            {result.chars !== undefined && <span>{result.chars}자</span>}
                                            {result.hangulRatio !== undefined && <span>한글 비율 {(result.hangulRatio * 100).toFixed(1)}%</span>}
                                        </div>
                                    </div>
                                </div>
                                {result.error ? (
                                    <div className="mt-3 text-sm text-muted-foreground">{result.error}</div>
                                ) : (
                                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground">{result.preview || '미리보기 없음'}</p>
                                )}
                            </article>
                        )) : (
                            <div className="py-12 text-center text-sm text-muted-foreground">
                                결과 파일을 선택하면 모델별 전사 미리보기가 표시됩니다.
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
};
