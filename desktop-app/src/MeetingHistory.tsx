import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Edit3, Loader2, PlusCircle, Save, Search, X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { getAllMeetings, MeetingRecord, MeetingSpeakerContextSummary, MeetingTopicSection, updateMeeting } from './meetingRepository';
import { toApiUrl } from './apiBase';
import { Input } from './Input';
import { StatusBanner } from './StatusBanner';
import { MeetingDownloadControl } from './MeetingDownloadControl';
import {
    canGenerateSpeakerContext as canGenerateSpeakerContextFromState,
    getSpeakerGenerationStatus,
    getTopicGenerationStatus,
    normalizeGenerationStatus,
} from './meetingGeneration';

interface MeetingHistoryProps {
    selectedMeetingId?: string | null;
    onCreateMeeting?: () => void;
}

type DetailTab = 'summary' | 'script';
type GenerationKind = 'topicSections' | 'speakerContextSummaries';

interface GenerateTopicSectionsResponse {
    topics?: string[];
    topic_sections?: MeetingTopicSection[];
    topicSections?: MeetingTopicSection[];
    generation_status?: MeetingRecord['generationStatus'];
    generationStatus?: MeetingRecord['generationStatus'];
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

interface GenerateSpeakerContextResponse {
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    participant_summaries?: MeetingRecord['participantSummaries'];
    participantSummaries?: MeetingRecord['participantSummaries'];
    generation_status?: MeetingRecord['generationStatus'];
    generationStatus?: MeetingRecord['generationStatus'];
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

const generationStatusLabel = {
    not_started: '생성 전',
    generating: '생성 중',
    completed: '완료',
    failed: '다시 필요',
};

const speakerToneCount = 6;

const getGenerationErrorMessage = async (response: Response, fallback: string): Promise<string> => {
    const body = await response.text().catch(() => '');
    if (!body) return fallback;

    try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail === 'Output result not found') {
            return '저장된 분석 원본을 찾지 못했습니다. 대화록이 있는 회의록이면 다시 정리를 생성합니다.';
        }
        if (parsed.detail === 'Transcript segments are required') {
            return '대화록이 없어 AI 정리를 만들 수 없습니다. 원본 음성 파일로 다시 분석해 주세요.';
        }
        return parsed.detail || fallback;
    } catch {
        return body || fallback;
    }
};

const getSpeakerTone = (speaker: string, index: number): string => {
    const match = speaker.match(/(\d+)/);
    const speakerIndex = match ? Number.parseInt(match[1], 10) : index;
    return `speaker-tone-${speakerIndex % speakerToneCount}`;
};

const looksLikeKoreanMisrecognition = (text: string): boolean => {
    const compact = text.replace(/\s/g, '');
    if (compact.length < 20) return false;

    const hangulCount = (compact.match(/[\uac00-\ud7a3]/g) || []).length;
    const latinCount = (compact.match(/[A-Za-z]/g) || []).length;
    return latinCount > hangulCount * 2 && latinCount > 24;
};

export const MeetingHistory: React.FC<MeetingHistoryProps> = ({ selectedMeetingId, onCreateMeeting }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [detailTab, setDetailTab] = useState<DetailTab>('summary');
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDate, setEditDate] = useState('');
    const [editParticipants, setEditParticipants] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [generatingKind, setGeneratingKind] = useState<GenerationKind | null>(null);
    const currentSelectedMeetingIdRef = useRef<string | null>(null);

    const loadRecords = React.useCallback(async (event?: Event) => {
        try {
            setIsLoading(true);
            setErrorMessage('');
            const data = await getAllMeetings();
            const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            const nextSelectedId = (event as CustomEvent<{ id?: string }> | undefined)?.detail?.id;
            setRecords(sorted);
            setSelectedMeeting(prev => {
                if (nextSelectedId) return sorted.find(record => record.id === nextSelectedId) ?? prev;
                if (selectedMeetingId) return sorted.find(record => record.id === selectedMeetingId) ?? prev;
                if (prev && sorted.some(record => record.id === prev.id)) return sorted.find(record => record.id === prev.id) ?? prev;
                return sorted[0] ?? null;
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '회의 기록을 불러오지 못했습니다.');
        } finally {
            setIsLoading(false);
        }
    }, [selectedMeetingId]);

    useEffect(() => {
        void loadRecords();
        window.addEventListener('meetings:updated', loadRecords);
        return () => window.removeEventListener('meetings:updated', loadRecords);
    }, [loadRecords]);

    useEffect(() => {
        if (!selectedMeetingId) return;
        const nextMeeting = records.find(record => record.id === selectedMeetingId);
        if (nextMeeting) setSelectedMeeting(nextMeeting);
    }, [records, selectedMeetingId]);

    useEffect(() => {
        currentSelectedMeetingIdRef.current = selectedMeeting?.id ?? null;
        setDetailTab('summary');
        setIsEditing(false);
        setSearchQuery('');
    }, [selectedMeeting?.id]);

    useEffect(() => {
        if (!selectedMeeting) return;
        setEditTitle(selectedMeeting.title);
        setEditDate(selectedMeeting.date);
        setEditParticipants(selectedMeeting.participants);
    }, [selectedMeeting]);

    const updateSelectedMeeting = async (patch: Partial<MeetingRecord>, target = selectedMeeting) => {
        if (!target) return;
        const nextMeeting = { ...target, ...patch };
        await updateMeeting(nextMeeting);
        setSelectedMeeting(nextMeeting);
        setRecords(prev => prev.map(record => (record.id === nextMeeting.id ? nextMeeting : record)));
        window.dispatchEvent(new Event('meetings:updated'));
    };

    const setLocalGenerationStatus = (meetingId: string, kind: GenerationKind, state: 'generating' | 'completed' | 'failed') => {
        setSelectedMeeting(prev => {
            if (!prev || prev.id !== meetingId) return prev;
            return {
                ...prev,
                generationStatus: normalizeGenerationStatus(prev.generationStatus, { [kind]: state }),
            };
        });
    };

    const handleSaveEdit = async () => {
        if (!selectedMeeting) return;
        const title = editTitle.trim();
        const date = editDate.trim();
        const participants = editParticipants.trim();
        if (!title || !date) {
            setErrorMessage('회의 제목과 일시는 비워둘 수 없습니다.');
            return;
        }

        try {
            setErrorMessage('');
            await updateSelectedMeeting({ title, date, participants });
            setIsEditing(false);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '회의록 정보를 저장하지 못했습니다.');
        }
    };

    const topicGenerationStatus = getTopicGenerationStatus(selectedMeeting?.generationStatus, selectedMeeting?.topicSections);
    const canUseAiOrganization = Boolean(selectedMeeting?.jobId && selectedMeeting?.segments?.length);
    const speakerGenerationStatus = getSpeakerGenerationStatus(
        selectedMeeting?.generationStatus,
        selectedMeeting?.speakerContextSummaries,
    );
    const canCreateSpeakerContext = canGenerateSpeakerContextFromState(
        selectedMeeting?.generationStatus,
        selectedMeeting?.topicSections,
    );
    const speakerGenerationStatusText = canCreateSpeakerContext && speakerGenerationStatus === 'not_started'
        ? '생성 가능'
        : generationStatusLabel[speakerGenerationStatus];

    const handleGenerateTopicSections = async () => {
        if (generatingKind !== null || topicGenerationStatus === 'generating') return;
        if (!selectedMeeting?.jobId) {
            setErrorMessage('분석 결과 파일이 있는 회의록에서만 주제별 정리를 만들 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        try {
            setErrorMessage('');
            setGeneratingKind('topicSections');
            setLocalGenerationStatus(targetMeeting.id, 'topicSections', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-topic-sections`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '주제별 정리를 만들지 못했습니다.'));

            const data = await response.json() as GenerateTopicSectionsResponse;
            await updateSelectedMeeting({
                topics: data.topics ?? targetMeeting.topics ?? [],
                topicSections: data.topicSections ?? data.topic_sections ?? [],
                generationStatus: data.generationStatus ?? data.generation_status ?? { topicSections: 'completed' },
                outputFiles: data.outputs ?? targetMeeting.outputFiles,
            }, targetMeeting);
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            setLocalGenerationStatus(targetMeeting.id, 'topicSections', 'failed');
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(error instanceof Error ? error.message : '주제별 정리 생성 중 오류가 발생했습니다.');
            }
        } finally {
            setGeneratingKind(null);
        }
    };

    const handleGenerateSpeakerContext = async () => {
        if (generatingKind !== null || speakerGenerationStatus === 'generating') return;
        if (!selectedMeeting?.jobId) {
            setErrorMessage('분석 결과 파일이 있는 회의록에서만 참석자별 정리를 만들 수 있습니다.');
            return;
        }
        if (!canCreateSpeakerContext) {
            setErrorMessage('참석자별 정리는 주제별 정리를 먼저 만든 뒤 사용할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        try {
            setErrorMessage('');
            setGeneratingKind('speakerContextSummaries');
            setLocalGenerationStatus(targetMeeting.id, 'speakerContextSummaries', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-speaker-context`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '참석자별 정리를 만들지 못했습니다.'));

            const data = await response.json() as GenerateSpeakerContextResponse;
            await updateSelectedMeeting({
                speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? [],
                participantSummaries: data.participantSummaries ?? data.participant_summaries ?? targetMeeting.participantSummaries ?? [],
                generationStatus: data.generationStatus ?? data.generation_status ?? { speakerContextSummaries: 'completed' },
                outputFiles: data.outputs ?? targetMeeting.outputFiles,
            }, targetMeeting);
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            setLocalGenerationStatus(targetMeeting.id, 'speakerContextSummaries', 'failed');
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(error instanceof Error ? error.message : '참석자별 정리 생성 중 오류가 발생했습니다.');
            }
        } finally {
            setGeneratingKind(null);
        }
    };

    const contentQuery = searchQuery.trim().toLowerCase();
    const summaryMatches = !contentQuery || Boolean(selectedMeeting?.summary.toLowerCase().includes(contentQuery));
    const allTopics = useMemo(() => {
        const topics = selectedMeeting?.topics ?? [];
        const sectionTopics = selectedMeeting?.topicSections?.map(section => section.topic) ?? [];
        return Array.from(new Set([...topics, ...sectionTopics].filter(Boolean)));
    }, [selectedMeeting]);
    const visibleTopics = useMemo(
        () => allTopics.filter(topic => !contentQuery || topic.toLowerCase().includes(contentQuery)),
        [allTopics, contentQuery],
    );
    const visibleTopicSections = useMemo(
        () => selectedMeeting?.topicSections?.filter(section => !contentQuery || [
            section.topic,
            section.summary,
            ...(section.evidence ?? []),
            ...(section.actions ?? []),
        ].join(' ').toLowerCase().includes(contentQuery)) ?? [],
        [contentQuery, selectedMeeting],
    );
    const speakerSummariesForDisplay = useMemo(() => {
        if (selectedMeeting?.speakerContextSummaries?.length) {
            return selectedMeeting.speakerContextSummaries.map(item => ({
                name: item.display_name || item.speaker,
                role: item.role_in_meeting,
                summary: item.summary,
                keyPoints: item.key_points ?? [],
                actions: item.actions ?? [],
                needsCheck: item.needs_check ?? [],
            }));
        }

        return selectedMeeting?.participantSummaries?.map(item => ({
            name: item.participant,
            role: '',
            summary: item.summary,
            keyPoints: item.key_points ?? [],
            actions: item.actions ?? [],
            needsCheck: [],
        })) ?? [];
    }, [selectedMeeting]);
    const visibleSpeakerSummaries = useMemo(
        () => speakerSummariesForDisplay.filter(item => !contentQuery || [
            item.name,
            item.role ?? '',
            item.summary,
            ...item.keyPoints,
            ...item.actions,
            ...item.needsCheck,
        ].join(' ').toLowerCase().includes(contentQuery)),
        [contentQuery, speakerSummariesForDisplay],
    );
    const filteredSegments = useMemo(
        () => selectedMeeting?.segments?.filter(segment => !contentQuery || [
            segment.speaker,
            segment.text,
            segment.start,
            segment.end,
        ].join(' ').toLowerCase().includes(contentQuery)) ?? [],
        [contentQuery, selectedMeeting],
    );
    const hasCompletedEmptyTopicSections = topicGenerationStatus === 'completed' && !visibleTopicSections.length && Boolean(selectedMeeting?.topicSections);
    const hasCompletedEmptySpeakerContext = speakerGenerationStatus === 'completed' && !visibleSpeakerSummaries.length && Boolean(selectedMeeting?.speakerContextSummaries);
    const hasDecisionContent = Boolean(selectedMeeting?.decisions?.length || selectedMeeting?.needsCheck?.length);

    if (isLoading) {
        return (
            <div className="mx-auto max-w-5xl">
                <div className="app-panel flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
                    회의 기록을 불러오는 중입니다.
                </div>
            </div>
        );
    }

    if (!selectedMeeting) {
        return (
            <div className="mx-auto max-w-5xl">
                <div className="app-panel flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
                    <h2 className="text-lg font-semibold text-foreground">선택된 회의록이 없습니다</h2>
                    <p className="text-sm text-muted-foreground">왼쪽 회의 기록에서 회의록을 선택하거나 새 회의록을 작성하세요.</p>
                    {onCreateMeeting && (
                        <Button onClick={onCreateMeeting}>
                            <PlusCircle size={16} />
                            새 회의록 작성
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-5xl">
            {errorMessage && (
                <StatusBanner tone="error" className="mb-4">
                    {errorMessage}
                </StatusBanner>
            )}

            <article className="app-panel overflow-hidden">
                <div className="app-panel-header flex flex-col gap-4 border-b border-border p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        {isEditing ? (
                            <div className="grid flex-1 gap-3">
                                <Input value={editTitle} onChange={event => setEditTitle(event.target.value)} aria-label="회의 제목" />
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <Input value={editDate} onChange={event => setEditDate(event.target.value)} aria-label="회의 일시" />
                                    <Input value={editParticipants} onChange={event => setEditParticipants(event.target.value)} aria-label="참석자" />
                                </div>
                            </div>
                        ) : (
                            <div className="min-w-0 flex-1">
                                <h2 className="break-words text-xl font-semibold text-foreground">{selectedMeeting.title}</h2>
                                <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                                    <div><span className="font-medium text-foreground">일시:</span> {selectedMeeting.date}</div>
                                    <div><span className="font-medium text-foreground">참석자:</span> {selectedMeeting.participants || '-'}</div>
                                </div>
                                {selectedMeeting.sourceFile && (
                                    <div className="mt-2 break-words text-sm text-muted-foreground">
                                        <span className="font-medium text-foreground">원본 파일:</span> {selectedMeeting.sourceFile}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="flex shrink-0 items-center gap-2">
                            {isEditing ? (
                                <>
                                    <Button onClick={handleSaveEdit}>
                                        <Save size={16} />
                                        저장
                                    </Button>
                                    <IconButton
                                        aria-label="수정 취소"
                                        title="수정 취소"
                                        icon={<X size={18} />}
                                        onClick={() => setIsEditing(false)}
                                    />
                                </>
                            ) : (
                                <>
                                    <MeetingDownloadControl
                                        meeting={selectedMeeting}
                                        onMessage={setErrorMessage}
                                        onDownloadingChange={setIsDownloading}
                                    />
                                    <IconButton
                                        aria-label="회의 정보 수정"
                                        title="회의 정보 수정"
                                        icon={<Edit3 size={18} />}
                                        onClick={() => setIsEditing(true)}
                                        disabled={isDownloading}
                                    />
                                </>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                        <div className="tab-list" role="tablist" aria-label="회의록 상세">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={detailTab === 'summary'}
                                className={`tab-button ${detailTab === 'summary' ? 'tab-button-active' : ''}`}
                                onClick={() => setDetailTab('summary')}
                            >
                                회의 요약
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={detailTab === 'script'}
                                className={`tab-button ${detailTab === 'script' ? 'tab-button-active' : ''}`}
                                onClick={() => setDetailTab('script')}
                            >
                                대화록
                            </button>
                        </div>
                        <label className="relative w-full lg:max-w-xs">
                            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={searchQuery}
                                onChange={event => setSearchQuery(event.target.value)}
                                placeholder="현재 회의에서 검색"
                                className="pl-9"
                                aria-label="현재 회의에서 검색"
                            />
                        </label>
                    </div>
                </div>

                <div className="space-y-6 p-5">
                    {detailTab === 'summary' && (
                        <>
                            {summaryMatches && (
                                <section>
                                    <h3 className="section-title mb-2">핵심 요약</h3>
                                    <div className="detail-callout">{selectedMeeting.summary || '요약 내용이 없습니다.'}</div>
                                </section>
                            )}

                            {canUseAiOrganization && (
                                <section className="detail-action-row">
                                    <h3 className="section-title mb-3">AI 정리</h3>
                                    <div className="grid gap-2 lg:grid-cols-2">
                                        <div className="ai-action-item">
                                            <div className="min-w-0">
                                                <div className="ai-action-title">주제별 정리</div>
                                                <div className="ai-action-meta">{generationStatusLabel[topicGenerationStatus]}</div>
                                            </div>
                                            <Button
                                                variant="outline"
                                                className="detail-action-button"
                                                disabled={generatingKind !== null || topicGenerationStatus === 'generating'}
                                                onClick={handleGenerateTopicSections}
                                            >
                                                {generatingKind === 'topicSections' && <Loader2 size={15} className="animate-spin" />}
                                                주제별 정리
                                            </Button>
                                        </div>
                                        <div className={`ai-action-item ${!canCreateSpeakerContext ? 'ai-action-item-disabled' : ''}`}>
                                            <div className="min-w-0">
                                                <div className="ai-action-title">참석자별 정리</div>
                                                <div className="ai-action-meta">
                                                    {canCreateSpeakerContext || speakerGenerationStatus !== 'not_started'
                                                        ? speakerGenerationStatusText
                                                        : '주제별 정리 후 사용'}
                                                </div>
                                            </div>
                                            <Button
                                                variant="outline"
                                                className="detail-action-button"
                                                disabled={generatingKind !== null || speakerGenerationStatus === 'generating' || !canCreateSpeakerContext}
                                                onClick={handleGenerateSpeakerContext}
                                                title={canCreateSpeakerContext ? '참석자별 정리' : '주제별 정리를 먼저 만들어 주세요.'}
                                            >
                                                {generatingKind === 'speakerContextSummaries' && <Loader2 size={15} className="animate-spin" />}
                                                참석자별 정리
                                            </Button>
                                        </div>
                                    </div>
                                </section>
                            )}

                            {hasDecisionContent && (
                                <section>
                                    <h3 className="section-title mb-2">주요 내용 및 결정사항</h3>
                                    <div className="grid gap-3">
                                        {!!selectedMeeting.decisions?.length && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">결정사항</div>
                                                <ul className="detail-list">
                                                    {selectedMeeting.decisions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                        {!!selectedMeeting.needsCheck?.length && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">확인 필요</div>
                                                <ul className="detail-list">
                                                    {selectedMeeting.needsCheck.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                </section>
                            )}

                            {!!visibleTopics.length && (
                                <section>
                                    <h3 className="section-title mb-2">논의 내용</h3>
                                    <div className="flex flex-wrap gap-2">
                                        {visibleTopics.map(topic => (
                                            <span key={topic} className="topic-chip">{topic}</span>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {(!!visibleTopicSections.length || hasCompletedEmptyTopicSections) && (
                                <section>
                                    <h3 className="section-title mb-2">주제별 정리</h3>
                                    {visibleTopicSections.length ? (
                                        <div className="grid gap-3">
                                            {visibleTopicSections.map((section, index) => (
                                                <article key={`${section.topic}-${index}`} className="detail-subtle-card">
                                                    <h4 className="font-semibold text-foreground">{section.topic}</h4>
                                                    <p className="mt-2 text-sm leading-relaxed text-foreground">{section.summary}</p>
                                                    {!!section.evidence?.length && (
                                                        <ul className="detail-list mt-3">
                                                            {section.evidence.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{item}</li>)}
                                                        </ul>
                                                    )}
                                                    {!!section.actions?.length && (
                                                        <div className="mt-3">
                                                            <div className="mb-1 text-xs font-semibold text-muted-foreground">할 일</div>
                                                            <ul className="detail-list">
                                                                {section.actions.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{item}</li>)}
                                                            </ul>
                                                        </div>
                                                    )}
                                                </article>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="detail-inline-note">
                                            주제별 정리는 완료됐지만 표시할 내용이 없습니다. 대화록 내용을 확인해 주세요.
                                        </div>
                                    )}
                                </section>
                            )}

                            {(!!visibleSpeakerSummaries.length || hasCompletedEmptySpeakerContext) && (
                                <section>
                                    <h3 className="section-title mb-2">참석자별 정리</h3>
                                    {visibleSpeakerSummaries.length ? (
                                        <>
                                            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                                                화자 구분과 회의 맥락을 바탕으로 만든 AI 초안입니다. 실제 이름과 역할은 확인이 필요할 수 있습니다.
                                            </p>
                                            <div className="grid gap-3 md:grid-cols-2">
                                                {visibleSpeakerSummaries.map((item, index) => (
                                                    <article key={`${item.name}-${index}`} className="detail-subtle-card">
                                                        <h4 className="font-semibold text-foreground">{item.name}</h4>
                                                        {item.role && <div className="mt-1 text-xs text-muted-foreground">{item.role}</div>}
                                                        <p className="mt-2 text-sm leading-relaxed text-foreground">{item.summary}</p>
                                                        {!!item.keyPoints.length && (
                                                            <ul className="detail-list mt-3">
                                                                {item.keyPoints.map((point, pointIndex) => <li key={`${point}-${pointIndex}`}>{point}</li>)}
                                                            </ul>
                                                        )}
                                                    </article>
                                                ))}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="detail-inline-note">
                                            참석자별 정리는 완료됐지만 표시할 내용이 없습니다. 대화록의 화자 구분을 확인해 주세요.
                                        </div>
                                    )}
                                </section>
                            )}

                            {!!selectedMeeting.actions?.length && (
                                <section>
                                    <h3 className="section-title mb-2">할 일</h3>
                                    <ul className="detail-list">
                                        {selectedMeeting.actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
                                    </ul>
                                </section>
                            )}
                        </>
                    )}

                    {detailTab === 'script' && (
                        <section>
                            <h3 className="section-title mb-3">대화록</h3>
                            {filteredSegments.length ? (
                                <div className="space-y-2">
                                    {filteredSegments.map((segment, index) => {
                                        const warning = looksLikeKoreanMisrecognition(segment.text);
                                        return (
                                            <article key={`${segment.start}-${index}`} className={`script-row ${warning ? 'script-row-warning' : ''}`}>
                                                <div className="script-meta">
                                                    <span className={`speaker-dot ${getSpeakerTone(segment.speaker, index)}`} />
                                                    <span className="font-semibold text-foreground">{segment.speaker || '화자'}</span>
                                                    <span>{segment.start} - {segment.end}</span>
                                                    {segment.timingApproximate && <span className="script-badge">시간 추정</span>}
                                                </div>
                                                <p className="script-text">{segment.text}</p>
                                            </article>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="detail-inline-note">대화록 내용이 없습니다.</div>
                            )}
                        </section>
                    )}
                </div>
            </article>
        </div>
    );
};
