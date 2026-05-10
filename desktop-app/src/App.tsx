import React, { useEffect, useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';
import { Settings } from './Settings';
import { AsrBenchmark } from './AsrBenchmark';
import { addMeeting, getAllMeetings, MeetingRecord, MeetingSegment } from './meetingRepository';
import { getApiBase } from './apiBase';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
    rawMessage?: string;
    startedAt?: number | null;
    stalled?: boolean;
}

interface BenchmarkScore {
    hangul_ratio?: number;
}

interface BenchmarkResult {
    seconds?: number;
    score?: BenchmarkScore;
    segments?: Array<Record<string, unknown>>;
    display_segments?: Array<Record<string, unknown>>;
    aligned_segments?: Array<Record<string, unknown>>;
}

interface BenchmarkPayload extends BenchmarkResult {
    qwen_seconds?: number;
    qwen_score?: BenchmarkScore;
    qwen_segments?: number;
    fast_seconds?: number;
    fast_score?: BenchmarkScore;
    fast_segments?: number;
    speakers?: unknown[];
    aligned_segments?: Array<Record<string, unknown>>;
    qwen?: BenchmarkResult;
    faster_whisper?: BenchmarkResult;
    samples?: Array<{ results?: BenchmarkResult[] }>;
}

const formatSegmentTime = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remain = total % 60;
    return [hours, minutes, remain].map(value => String(value).padStart(2, '0')).join(':');
};

const toMeetingSegments = (segments: Array<Record<string, unknown>> = []): MeetingSegment[] => segments.map(segment => ({
    start: formatSegmentTime(Number(segment.start ?? 0)),
    end: formatSegmentTime(Number(segment.end ?? 0)),
    speaker: String(segment.speaker_name || segment.speaker || '화자'),
    text: String(segment.text || ''),
    timingApproximate: Boolean(segment.timing_approximate),
}));

const splitSentences = (text: string): string[] => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    return normalized.split(/(?<=[.!?。？！])\s+/).map(item => item.trim()).filter(Boolean);
};

const normalizeForRepeatCheck = (text: string): string => text.toLowerCase().replace(/[\W_]+/gu, '');

const removeRepeatedSentences = (text: string): string => {
    const sentences = splitSentences(text);
    if (sentences.length < 2) return text.replace(/\s+/g, ' ').trim();
    const cleaned: string[] = [];
    const seen: string[] = [];
    sentences.forEach((sentence, index) => {
        const normalized = normalizeForRepeatCheck(sentence);
        const previous = seen.at(-1) ?? '';
        const isAdjacentRepeat = previous === normalized;
        const isTrailingLoop = index === sentences.length - 1 && normalized.length >= 8 && seen.slice(0, -1).includes(normalized);
        if (isAdjacentRepeat || isTrailingLoop) return;
        cleaned.push(sentence);
        seen.push(normalized);
    });
    return cleaned.join(' ');
};

const removeRepeatedMeetingSegments = (segments: MeetingSegment[]): MeetingSegment[] => {
    const cleaned = segments
        .map(segment => ({ ...segment, text: removeRepeatedSentences(segment.text) }))
        .filter(segment => segment.text);
    if (cleaned.length < 2) return cleaned;
    return cleaned.filter((segment, index) => {
        const normalized = normalizeForRepeatCheck(segment.text);
        const previous = index > 0 ? normalizeForRepeatCheck(cleaned[index - 1].text) : '';
        const earlier = cleaned.slice(0, index - 1).map(item => normalizeForRepeatCheck(item.text));
        return previous !== normalized && !(index === cleaned.length - 1 && normalized.length >= 8 && earlier.includes(normalized));
    });
};

const fetchBenchmarkPayload = async (apiBase: string, id: string): Promise<BenchmarkPayload> => {
    const response = await fetch(new URL(`/api/dev/asr-benchmarks/${id}`, apiBase), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load benchmark: ${id}`);
    const data = await response.json();
    return data.payload;
};

const firstBenchmarkResult = (payload: BenchmarkPayload): BenchmarkResult => (
    payload?.samples?.[0]?.results?.[0] ?? payload
);

const benchmarkSegments = (result: BenchmarkResult): MeetingSegment[] => (
    toMeetingSegments(result.display_segments || result.segments || [])
);

const buildComparisonSummary = (label: string, model: string, seconds: number, hangulRatio?: number, segmentCount?: number, speakerCount?: number): string => (
    `${label} ${model} 테스트 결과입니다. 처리 시간은 ${seconds.toFixed(2)}초, 한글 비율은 ${hangulRatio !== undefined ? `${(hangulRatio * 100).toFixed(1)}%` : '확인 필요'}, ` +
    `발화 segment는 ${segmentCount ?? 0}개, 화자 수는 ${speakerCount ?? 0}명으로 확인했습니다.`
);

const seedAsrComparisonMeetings = async (): Promise<string | null> => {
    if (!import.meta.env.DEV) return null;

    const existing = await getAllMeetings();
    const existingIds = new Set(existing.map(record => record.id));
    const apiBase = await getApiBase();
    const [test4QwenAlign, test4FastAlign, test1Combined] = await Promise.all([
        fetchBenchmarkPayload(apiBase, 'asr_benchmark/qwen3_test4_90s_speaker_alignment_compare.json'),
        fetchBenchmarkPayload(apiBase, 'asr_benchmark/faster_whisper_test4_90s_speaker_alignment_compare.json'),
        fetchBenchmarkPayload(apiBase, 'asr_benchmark/test1_90s_qwen_faster_speaker_alignment_compare.json'),
    ]);

    const records: MeetingRecord[] = [
        {
            id: 'asr-compare-test4-qwen',
            title: 'ASR 비교 test(4) - Qwen',
            date: '2026-05-07 22:28',
            participants: 'Qwen3-ASR, ForcedAligner, pyannote',
            sourceFile: 'test (4).mp4',
            summary: buildComparisonSummary(
                'test (4) 90초',
                'Qwen+ForcedAligner',
                Number(test4QwenAlign.qwen_seconds ?? 0),
                Number(test4QwenAlign.qwen_score?.hangul_ratio ?? 0),
                Number(test4QwenAlign.qwen_segments ?? 0),
                Array.isArray(test4QwenAlign.speakers) ? test4QwenAlign.speakers.length : 0,
            ),
            topics: ['Qwen 전사 품질', '화자 정렬', '표시용 문장'],
            actions: ['실제 회의 샘플에서 추가 검증'],
            decisions: ['현재 CPU 환경에서는 faster-whisper 우선 검토'],
            needsCheck: ['Qwen 내부 segment가 길게 묶이는 경우 확인'],
            segments: removeRepeatedMeetingSegments(toMeetingSegments(test4QwenAlign.aligned_segments)),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
        {
            id: 'asr-compare-test4-faster-whisper',
            title: 'ASR 비교 test(4) - faster-whisper',
            date: '2026-05-07 22:30',
            participants: 'faster-whisper-large-v3, pyannote',
            sourceFile: 'test (4).mp4',
            summary: buildComparisonSummary(
                'test (4) 90초',
                'faster-whisper',
                Number(test4FastAlign.fast_seconds ?? 0),
                Number(test4FastAlign.fast_score?.hangul_ratio ?? 0),
                Number(test4FastAlign.fast_segments ?? 0),
                Array.isArray(test4FastAlign.speakers) ? test4FastAlign.speakers.length : 0,
            ),
            topics: ['faster-whisper 전사 품질', '발화 경계', '화자 정렬'],
            actions: ['다른 실제 대화 샘플에서 반복 확인'],
            decisions: ['test (4)에서는 faster-whisper가 더 빠르고 발화 경계가 자연스러움'],
            needsCheck: ['긴 파일에서 처리 시간과 반복 문장 여부 확인'],
            segments: toMeetingSegments(test4FastAlign.aligned_segments),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
        {
            id: 'asr-compare-test1-qwen',
            title: 'ASR 비교 test(1) - Qwen',
            date: '2026-05-07 22:40',
            participants: 'Qwen3-ASR, ForcedAligner, pyannote',
            sourceFile: 'test (1).mp4',
            summary: buildComparisonSummary(
                'test (1) 90초',
                'Qwen+ForcedAligner',
                Number(test1Combined.qwen?.seconds ?? 0),
                Number(test1Combined.qwen?.score?.hangul_ratio ?? 0),
                Number(test1Combined.qwen?.segments ?? 0),
                Array.isArray(test1Combined.speakers) ? test1Combined.speakers.length : 0,
            ),
            topics: ['Qwen 실제 대화 샘플', '화자 4명', '내부 segment'],
            actions: ['speaker boundary 기반 문장 분배는 후순위 검토'],
            decisions: ['Qwen은 품질 후보로 유지하되 기본 후보는 보류'],
            needsCheck: ['짧은 대사가 빠르게 오가는 상황에서 segment 뭉침 확인'],
            segments: removeRepeatedMeetingSegments(toMeetingSegments(test1Combined.qwen?.aligned_segments)),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
        {
            id: 'asr-compare-test1-faster-whisper',
            title: 'ASR 비교 test(1) - faster-whisper',
            date: '2026-05-07 22:42',
            participants: 'faster-whisper-large-v3, pyannote',
            sourceFile: 'test (1).mp4',
            summary: buildComparisonSummary(
                'test (1) 90초',
                'faster-whisper',
                Number(test1Combined.faster_whisper?.seconds ?? 0),
                Number(test1Combined.faster_whisper?.score?.hangul_ratio ?? 0),
                Number(test1Combined.faster_whisper?.segments ?? 0),
                Array.isArray(test1Combined.speakers) ? test1Combined.speakers.length : 0,
            ),
            topics: ['faster-whisper 실제 대화 샘플', '화자 4명', '발화 단위'],
            actions: ['포터블 앱 기본 후보 통합 검토'],
            decisions: ['test (1)에서도 faster-whisper가 더 실용적'],
            needsCheck: ['30분 이상 파일에서 속도와 안정성 확인'],
            segments: toMeetingSegments(test1Combined.faster_whisper?.aligned_segments),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
    ];

    for (const record of records) {
        await addMeeting(existingIds.has(record.id) ? { ...existing.find(item => item.id === record.id), ...record } : record);
    }
    window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: 'asr-compare-test4-faster-whisper', openHistory: true } }));
    return 'asr-compare-test4-faster-whisper';
};

const seedHermesComparisonMeetings = async (): Promise<string | null> => {
    if (!import.meta.env.DEV) return null;

    const existing = await getAllMeetings();
    const existingIds = new Set(existing.map(record => record.id));
    const apiBase = await getApiBase();
    const [fasterPayload, qwenPayload] = await Promise.all([
        fetchBenchmarkPayload(apiBase, 'asr_benchmark/hermes_faster_whisper_90s_compare.json'),
        fetchBenchmarkPayload(apiBase, 'asr_benchmark/hermes_qwen3_90s_compare.json'),
    ]);
    const faster = firstBenchmarkResult(fasterPayload);
    const qwen = firstBenchmarkResult(qwenPayload);

    const records: MeetingRecord[] = [
        {
            id: 'asr-compare-hermes-faster-whisper',
            title: 'ASR 비교 Hermes 90초 - faster-whisper',
            date: '2026-05-07 23:05',
            participants: 'faster-whisper-large-v3',
            sourceFile: '[Hermes Agent] 기억하고 진화하는 AI 헤르메스 에이전트.mp4',
            summary: `Hermes 파일 앞 90초 faster-whisper 테스트 결과입니다. 처리 시간은 ${Number(faster.seconds ?? 0).toFixed(2)}초, 한글 비율은 ${(Number(faster.score?.hangul_ratio ?? 0) * 100).toFixed(1)}%, 발화 segment는 ${(faster.segments || []).length}개입니다.`,
            topics: ['전사 품질', '처리 속도', '발화 경계'],
            actions: ['긴 구간에서도 반복 문장 여부 확인'],
            decisions: ['Hermes 90초 구간에서도 faster-whisper가 훨씬 빠름'],
            needsCheck: ['일부 고유명사와 제품명 오인식 확인'],
            segments: benchmarkSegments(faster),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
        {
            id: 'asr-compare-hermes-qwen',
            title: 'ASR 비교 Hermes 90초 - Qwen',
            date: '2026-05-07 23:10',
            participants: 'Qwen3-ASR, ForcedAligner',
            sourceFile: '[Hermes Agent] 기억하고 진화하는 AI 헤르메스 에이전트.mp4',
            summary: `Hermes 파일 앞 90초 Qwen+ForcedAligner 테스트 결과입니다. 처리 시간은 ${Number(qwen.seconds ?? 0).toFixed(2)}초, 한글 비율은 ${(Number(qwen.score?.hangul_ratio ?? 0) * 100).toFixed(1)}%, 표시 segment는 ${(qwen.display_segments || qwen.segments || []).length}개입니다.`,
            topics: ['전사 품질', 'ForcedAligner', '문장 표시'],
            actions: ['고유명사와 조사/띄어쓰기 오류를 faster-whisper와 비교'],
            decisions: ['Qwen은 한글 비율은 높지만 CPU 처리 시간이 큼'],
            needsCheck: ['짧은 맞장구와 고유명사 인식 확인'],
            segments: removeRepeatedMeetingSegments(benchmarkSegments(qwen)),
            generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
        },
    ];

    for (const record of records) {
        await addMeeting(existingIds.has(record.id) ? { ...existing.find(item => item.id === record.id), ...record } : record);
    }
    window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: 'asr-compare-hermes-faster-whisper', openHistory: true } }));
    return 'asr-compare-hermes-faster-whisper';
};

export const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState('minutes');
    const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({
        active: false,
        progress: 0,
        message: '',
    });
    const showAsrBenchmark = import.meta.env.DEV || import.meta.env.VITE_ENABLE_ASR_BENCHMARK === 'true';
    const handleCreateMeeting = () => {
        setSelectedMeetingId(null);
        setActiveTab('minutes');
    };
    const handleDeleteMeeting = (id: string) => {
        setSelectedMeetingId(current => current === id ? null : current);
    };

    useEffect(() => {
        const handleAnalysisStatus = (event: Event) => {
            const detail = (event as CustomEvent<AnalysisStatus>).detail;
            if (!detail) return;
            setAnalysisStatus({
                active: detail.active,
                progress: Math.min(100, Math.max(0, detail.progress || 0)),
                message: detail.message || '',
                rawMessage: detail.rawMessage || detail.message || '',
                startedAt: detail.startedAt || null,
                stalled: Boolean(detail.stalled),
            });
        };

        window.addEventListener('analysis:status', handleAnalysisStatus);
        return () => window.removeEventListener('analysis:status', handleAnalysisStatus);
    }, []);

    useEffect(() => {
        const handleMeetingsUpdated = (event: Event) => {
            const detail = (event as CustomEvent<{ id?: string; openHistory?: boolean }>).detail;
            if (!detail?.id || !detail.openHistory) return;
            setSelectedMeetingId(detail.id);
            setActiveTab('history');
        };

        window.addEventListener('meetings:updated', handleMeetingsUpdated);
        return () => window.removeEventListener('meetings:updated', handleMeetingsUpdated);
    }, []);

    useEffect(() => {
        if (!showAsrBenchmark) return;
        let cancelled = false;
        let completed = false;

        const runSeed = async () => {
            if (completed) return;
            try {
                const id = await Promise.all([
                    seedAsrComparisonMeetings(),
                    seedHermesComparisonMeetings(),
                ]);
                const selectedId = id[1] || id[0];
                if (cancelled || !selectedId) return;
                completed = true;
                setSelectedMeetingId(selectedId);
                setActiveTab('history');
            } catch (error) {
                console.warn('Failed to seed ASR comparison meetings', error);
            }
        };

        void runSeed();
        const retryTimer = window.setInterval(() => void runSeed(), 5000);
        return () => {
            cancelled = true;
            window.clearInterval(retryTimer);
        };
    }, [showAsrBenchmark]);

    return (
        <>
            <Layout
                activeTab={activeTab}
                selectedMeetingId={selectedMeetingId}
                onTabChange={setActiveTab}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onCreateMeeting={handleCreateMeeting}
                onDeleteMeeting={handleDeleteMeeting}
                analysisStatus={analysisStatus}
                showAsrBenchmark={showAsrBenchmark}
                onSelectMeeting={(id) => {
                    setSelectedMeetingId(id);
                    setActiveTab('history');
                }}
            >
                <div className={activeTab === 'minutes' ? 'contents' : 'hidden'}>
                    <MeetingWriter onOpenSettings={() => setIsSettingsOpen(true)} />
                </div>
                <div className={activeTab === 'history' ? 'contents' : 'hidden'}>
                    <MeetingHistory
                        selectedMeetingId={selectedMeetingId}
                        onCreateMeeting={handleCreateMeeting}
                    />
                </div>
                {showAsrBenchmark && (
                    <div className={activeTab === 'asr-benchmark' ? 'contents' : 'hidden'}>
                        <AsrBenchmark />
                    </div>
                )}
            </Layout>
            {isSettingsOpen && <Settings onClose={() => setIsSettingsOpen(false)} />}
        </>
    );
};

export default App;
