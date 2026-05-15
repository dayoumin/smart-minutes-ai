import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Edit3, FileAudio, Loader2, PlusCircle, Save, Search, X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { getAllMeetings, getMeetingById, MeetingRecord, MeetingSegment, MeetingSpeakerContextSummary, MeetingTopicSection, updateMeeting } from './meetingRepository';
import { toApiUrl } from './apiBase';
import { Input } from './Input';
import { StatusBanner } from './StatusBanner';
import { MeetingDownloadControl } from './MeetingDownloadControl';
import {
    canGenerateSpeakerContext as canGenerateSpeakerContextFromState,
    getSpeakerGenerationStatus,
    getSummaryGenerationStatus,
    getTopicGenerationStatus,
    normalizeGenerationStatus,
} from './meetingGeneration';

interface MeetingHistoryProps {
    selectedMeetingId?: string | null;
    onCreateMeeting?: () => void;
    onSelectMeetingId?: (id: string | null) => void;
    onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
}

type DetailTab = 'summary' | 'script';
type GenerationKind = 'summary' | 'topicSections' | 'speakerContextSummaries';
type AudioAvailability = 'idle' | 'checking' | 'available' | 'missing';

interface GenerateSummaryResponse {
    summary?: string;
    topics?: string[];
    actions?: string[];
    decisions?: string[];
    needs_check?: string[];
    needsCheck?: string[];
    topic_sections?: MeetingTopicSection[];
    topicSections?: MeetingTopicSection[];
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    participant_summaries?: MeetingRecord['participantSummaries'];
    participantSummaries?: MeetingRecord['participantSummaries'];
    generation_status?: MeetingRecord['generationStatus'];
    generationStatus?: MeetingRecord['generationStatus'];
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

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

interface SyncOutputRecordResponse {
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

const generationStatusLabel = {
    not_started: '정리 전',
    generating: '정리 중',
    completed: '완료',
    failed: '정리 필요',
    skipped: '요약 AI 준비 필요',
};

const isStaleGenerationMessage = (message: string): boolean => (
    message.includes('이번 결과는 저장하지 않았습니다')
    || message.includes('주제별 정리를 저장하지 않았습니다')
    || message.includes('참석자별 정리를 저장하지 않았습니다')
);

const speakerToneCount = 6;

const getGenerationErrorMessage = async (response: Response, fallback: string): Promise<string> => {
    const body = await response.text().catch(() => '');
    if (!body) return fallback;

    try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail === 'Output result not found') {
            return '분석 원본을 찾지 못했습니다. 다시 정리해 주세요.';
        }
        if (parsed.detail === 'Transcript segments are required') {
            return '대화록이 없어 정리할 수 없습니다. 다시 분석해 주세요.';
        }
        if (parsed.detail === 'summary_input_changed') {
            return '대화록이 바뀌어 이번 정리는 저장하지 않았습니다. 다시 정리해 주세요.';
        }
        if (parsed.detail === 'summary_model_not_ready') {
            return '요약 AI가 준비되지 않았습니다. 대화록은 사용할 수 있고, 요약은 Ollama 모델을 준비한 뒤 다시 실행해 주세요.';
        }
        if (parsed.detail === 'topic_input_changed') {
            return '대화록이나 요약이 바뀌어 주제별 정리를 저장하지 않았습니다. 다시 정리해 주세요.';
        }
        if (parsed.detail === 'speaker_input_changed') {
            return '대화록이나 주제별 정리가 바뀌어 참석자별 정리를 저장하지 않았습니다. 다시 정리해 주세요.';
        }
        return parsed.detail || fallback;
    } catch {
        return body || fallback;
    }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const timestampToSeconds = (timestamp: string): number | null => {
    const parts = timestamp.split(':').map(part => Number.parseInt(part, 10));
    if (parts.some(Number.isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
};

const looksSentenceComplete = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/[.!?。！？…]$/.test(trimmed)) return true;
    return /(다|요|죠|니다|습니다|습니까|까요|거든요|겁니다|됩니다|합니다|했습니다|해요|예요|이에요|네요|군요|잖아요)$/.test(trimmed);
};

const looksIncompleteSentenceEnd = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (looksSentenceComplete(trimmed)) return false;
    return /(은|는|이|가|을|를|에|에서|에게|께|으로|로|와|과|하고|랑|이나|거나|까지|부터|보다|처럼|만|도|의|좀|그런|어떤|왜냐면|때문에|위해서|하면서|하면|보니까|하는지를|하는지|가지고|들고)$/.test(trimmed);
};

const mergeDisplaySegments = (segments: MeetingSegment[]): MeetingSegment[] => {
    const targetMinimumSeconds = 25;
    const softMaximumSeconds = 60;
    const hardMaximumLength = 700;
    const merged: MeetingSegment[] = [];

    for (const segment of segments) {
        const previous = merged[merged.length - 1];
        const previousStart = previous ? timestampToSeconds(previous.start) : null;
        const previousEnd = previous ? timestampToSeconds(previous.end) : null;
        const currentStart = timestampToSeconds(segment.start);
        const currentEnd = timestampToSeconds(segment.end);
        const gapSeconds = previousEnd !== null && currentStart !== null ? currentStart - previousEnd : Number.POSITIVE_INFINITY;
        const combinedDurationSeconds = previousStart !== null && currentEnd !== null ? currentEnd - previousStart : Number.POSITIVE_INFINITY;
        const combinedText = previous ? `${previous.text} ${segment.text}`.trim() : segment.text;
        const previousDurationSeconds = previousStart !== null && previousEnd !== null ? previousEnd - previousStart : Number.POSITIVE_INFINITY;
        const previousNeedsContinuation = previous ? !looksSentenceComplete(previous.text) || looksIncompleteSentenceEnd(previous.text) : false;
        const currentIsShortTail = segment.text.trim().length <= 35;
        const previousParagraphIsShort = previousDurationSeconds < targetMinimumSeconds;
        const canMerge = Boolean(previous)
            && previous.speaker === segment.speaker
            && Boolean(previous.timingApproximate) === Boolean(segment.timingApproximate)
            && gapSeconds >= -3
            && gapSeconds <= 3
            && (previousNeedsContinuation || previousParagraphIsShort || currentIsShortTail)
            && combinedDurationSeconds <= softMaximumSeconds
            && combinedText.length <= hardMaximumLength;

        if (previous && canMerge) {
            previous.end = segment.end;
            previous.text = combinedText;
            continue;
        }

        merged.push({ ...segment });
    }

    return merged;
};

const normalizeTranscriptDrafts = (segments: MeetingSegment[]): MeetingSegment[] => (
    segments
        .map(segment => ({
            ...segment,
            text: segment.text.trim(),
        }))
        .filter(segment => Boolean(segment.text))
);

const resolveBaseDisplaySegments = (meeting: MeetingRecord | null): MeetingSegment[] => (
    meeting?.displaySegments?.length
        ? meeting.displaySegments
        : mergeDisplaySegments(meeting?.segments ?? [])
);

const resolveEffectiveTranscriptSegments = (meeting: MeetingRecord | null): MeetingSegment[] => (
    meeting?.editedDisplaySegments?.length
        ? meeting.editedDisplaySegments
        : resolveBaseDisplaySegments(meeting)
);

const transcriptSegmentsEqual = (left: MeetingSegment[], right: MeetingSegment[]): boolean => JSON.stringify(
    left.map(segment => ({
        start: segment.start,
        end: segment.end,
        speaker: segment.speaker,
        text: segment.text,
        timingApproximate: Boolean(segment.timingApproximate),
    })),
) === JSON.stringify(
    right.map(segment => ({
        start: segment.start,
        end: segment.end,
        speaker: segment.speaker,
        text: segment.text,
        timingApproximate: Boolean(segment.timingApproximate),
    })),
);

const buildTranscriptEditMeta = (meeting: MeetingRecord): NonNullable<MeetingRecord['transcriptEditMeta']> => ({
    edited: true,
    editedAt: new Date().toISOString(),
    summaryOutdated: Boolean(meeting.summary?.trim()),
    topicSectionsOutdated: Boolean(meeting.topicSections?.length),
    speakerContextOutdated: Boolean((meeting.speakerContextSummaries?.length ?? 0) || (meeting.participantSummaries?.length ?? 0)),
});

const buildTranscriptOutdatedMeta = (
    meeting: MeetingRecord,
    edited: boolean,
): NonNullable<MeetingRecord['transcriptEditMeta']> => ({
    edited,
    editedAt: new Date().toISOString(),
    summaryOutdated: Boolean(meeting.summary?.trim()),
    topicSectionsOutdated: Boolean(meeting.topicSections?.length),
    speakerContextOutdated: Boolean((meeting.speakerContextSummaries?.length ?? 0) || (meeting.participantSummaries?.length ?? 0)),
});

const buildTranscriptFingerprint = (segments: MeetingSegment[]): string => JSON.stringify(
    normalizeTranscriptDrafts(segments).map(segment => ({
        start: segment.start,
        end: segment.end,
        speaker: segment.speaker,
        text: segment.text,
        timingApproximate: Boolean(segment.timingApproximate),
    })),
);

const buildGenerationInputFingerprint = (meeting: MeetingRecord): string => JSON.stringify({
    transcript: buildTranscriptFingerprint(resolveEffectiveTranscriptSegments(meeting)),
    title: meeting.title || '',
    date: meeting.date || '',
    meetingPurpose: meeting.meetingPurpose || '',
});

export const MeetingHistory: React.FC<MeetingHistoryProps> = ({ selectedMeetingId, onCreateMeeting, onSelectMeetingId, onRegisterLeaveGuard }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [noticeMessage, setNoticeMessage] = useState('');
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [detailTab, setDetailTab] = useState<DetailTab>('summary');
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDate, setEditDate] = useState('');
    const [editMeetingPurpose, setEditMeetingPurpose] = useState('');
    const [speakerLabelDrafts, setSpeakerLabelDrafts] = useState<Record<string, string>>({});
    const [isTranscriptEditing, setIsTranscriptEditing] = useState(false);
    const [transcriptSegmentDrafts, setTranscriptSegmentDrafts] = useState<MeetingSegment[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [audioSourceUrl, setAudioSourceUrl] = useState('');
    const [audioAvailability, setAudioAvailability] = useState<AudioAvailability>('idle');
    const [generatingKind, setGeneratingKind] = useState<GenerationKind | null>(null);
    const [selectedTopicKey, setSelectedTopicKey] = useState<string | null>(null);
    const [selectedSpeakerSummaryKey, setSelectedSpeakerSummaryKey] = useState<string>('all');
    const [collapsedSpeakerSummaryKeys, setCollapsedSpeakerSummaryKeys] = useState<Record<string, boolean>>({});
    const currentSelectedMeetingIdRef = useRef<string | null>(null);
    const selectedMeetingRef = useRef<MeetingRecord | null>(null);
    const recordsRef = useRef<MeetingRecord[]>([]);
    const meetingUpdateQueuesRef = useRef<Record<string, Promise<void>>>({});
    const hydratedMeetingIdRef = useRef<string | null>(null);
    const canLeaveMeetingRef = useRef<(nextMeetingId: string | null) => boolean>(() => true);
    const topicSectionRefs = useRef<Record<string, HTMLElement | null>>({});
    const topicSectionsSectionRef = useRef<HTMLElement | null>(null);
    const speakerSummarySectionRef = useRef<HTMLElement | null>(null);
    const speakerLabelsPanelRef = useRef<HTMLDivElement | null>(null);

    const normalizeTopicKey = React.useCallback((value: string) => value.trim().toLocaleLowerCase(), []);

    const loadRecords = React.useCallback(async (event?: Event) => {
        try {
            setIsLoading(true);
            setErrorMessage('');
            const data = await getAllMeetings();
            const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            const nextSelectedId = (event as CustomEvent<{ id?: string }> | undefined)?.detail?.id;
            const currentMeeting = selectedMeetingRef.current;
            const nextMeeting = nextSelectedId
                ? sorted.find(record => record.id === nextSelectedId) ?? currentMeeting ?? null
                : selectedMeetingId
                    ? sorted.find(record => record.id === selectedMeetingId) ?? currentMeeting ?? null
                    : currentMeeting && sorted.some(record => record.id === currentMeeting.id)
                        ? sorted.find(record => record.id === currentMeeting.id) ?? currentMeeting
                        : sorted[0] ?? null;
            if (currentMeeting?.id !== (nextMeeting?.id ?? null) && !canLeaveMeetingRef.current(nextMeeting?.id ?? null)) {
                setRecords(sorted);
                return;
            }
            setRecords(sorted);
            setSelectedMeeting(nextMeeting);
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
        if (!nextMeeting) return;
        if (!canLeaveMeetingRef.current(nextMeeting.id)) return;
        setSelectedMeeting(nextMeeting);
    }, [records, selectedMeetingId]);

    useEffect(() => {
        currentSelectedMeetingIdRef.current = selectedMeeting?.id ?? null;
        setDetailTab('summary');
        setIsEditing(false);
        setIsTranscriptEditing(false);
        setTranscriptSegmentDrafts([]);
        setNoticeMessage('');
        setSearchQuery('');
        setSelectedTopicKey(null);
        setSelectedSpeakerSummaryKey('all');
        setCollapsedSpeakerSummaryKeys({});
    }, [selectedMeeting?.id]);

    useEffect(() => {
        selectedMeetingRef.current = selectedMeeting;
    }, [selectedMeeting]);

    useEffect(() => {
        let cancelled = false;
        const loadAudioUrl = async () => {
            if (!selectedMeeting?.jobId) {
                setAudioSourceUrl('');
                setAudioAvailability('idle');
                return;
            }
            setAudioAvailability('checking');
            const audioUrl = selectedMeeting.outputFiles?.audio
                || `/api/outputs/${encodeURIComponent(selectedMeeting.jobId)}/audio`;
            const resolved = await toApiUrl(audioUrl);
            try {
                const response = await fetch(resolved, { method: 'HEAD' });
                if (!cancelled) {
                    setAudioSourceUrl(response.ok ? resolved : '');
                    setAudioAvailability(response.ok ? 'available' : 'missing');
                }
            } catch {
                if (!cancelled) {
                    setAudioSourceUrl('');
                    setAudioAvailability('missing');
                }
            }
        };
        void loadAudioUrl();
        return () => {
            cancelled = true;
        };
    }, [selectedMeeting?.jobId, selectedMeeting?.outputFiles?.audio]);

    useEffect(() => {
        recordsRef.current = records;
    }, [records]);

    const updateSelectedMeeting = async (
        patch: Partial<MeetingRecord> | ((latestMeeting: MeetingRecord) => Partial<MeetingRecord>),
        targetId = selectedMeeting?.id ?? null,
    ) => {
        if (!targetId) return;
        const previousTask = meetingUpdateQueuesRef.current[targetId] ?? Promise.resolve();
        const nextTask = previousTask
            .catch(() => undefined)
            .then(async () => {
                const latestMeeting = (
                    (selectedMeetingRef.current?.id === targetId ? selectedMeetingRef.current : null)
                    ?? recordsRef.current.find(record => record.id === targetId)
                    ?? await getMeetingById(targetId)
                );
                if (!latestMeeting) return;

                const resolvedPatch = typeof patch === 'function' ? patch(latestMeeting) : patch;
                const nextMeeting = { ...latestMeeting, ...resolvedPatch };
                await updateMeeting(nextMeeting);

                if (currentSelectedMeetingIdRef.current === nextMeeting.id) {
                    selectedMeetingRef.current = nextMeeting;
                }

                setSelectedMeeting(prev => {
                    if (!prev || prev.id !== nextMeeting.id) return prev;
                    return nextMeeting;
                });
                setRecords(prev => {
                    const exists = prev.some(record => record.id === nextMeeting.id);
                    const nextRecords = exists
                        ? prev.map(record => (record.id === nextMeeting.id ? nextMeeting : record))
                        : [...prev, nextMeeting];
                    recordsRef.current = nextRecords;
                    return nextRecords;
                });
                window.dispatchEvent(new Event('meetings:updated'));
            });

        const queuedTask = nextTask.finally(() => {
            if (meetingUpdateQueuesRef.current[targetId] === queuedTask) {
                delete meetingUpdateQueuesRef.current[targetId];
            }
        });

        meetingUpdateQueuesRef.current[targetId] = queuedTask;
        await queuedTask;
    };

    const syncMeetingOutputRecord = async (meetingId: string, jobId?: string | null): Promise<SyncOutputRecordResponse | null> => {
        if (!jobId) return null;
        const latestMeeting = await getMeetingById(meetingId);
        if (!latestMeeting) return null;

        const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(jobId)}/sync-record`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(latestMeeting),
        });
        if (!response.ok) {
            throw new Error(await getGenerationErrorMessage(response, '저장한 내용을 분석 원본과 동기화하지 못했습니다.'));
        }
        return await response.json() as SyncOutputRecordResponse;
    };

    const syncMeetingOutputRecordSafely = async (meetingId: string, jobId?: string | null): Promise<string | null> => {
        try {
            const syncResponse = await syncMeetingOutputRecord(meetingId, jobId);
            if (syncResponse?.outputs) {
                await updateSelectedMeeting({ outputFiles: syncResponse.outputs }, meetingId);
            }
            return syncResponse?.export_error ?? null;
        } catch (error) {
            return error instanceof Error ? error.message : '저장 내용은 반영됐지만 분석 원본과 동기화하지 못했습니다.';
        }
    };

    const handleSaveAudioCopy = async () => {
        if (!selectedMeeting?.jobId || isDownloading) return;

        try {
            setIsDownloading(true);
            setErrorMessage('');
            setNoticeMessage('');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(selectedMeeting.jobId)}/audio/save-copy`), {
                method: 'POST',
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                if (response.status === 403) {
                    throw new Error('앱 화면에서만 음성 파일을 저장할 수 있습니다. 새 창이나 외부 페이지에서 실행 중이면 앱 화면으로 돌아와 다시 시도해 주세요.');
                }
                if (response.status === 404) {
                    throw new Error('저장된 음성 파일을 찾지 못했습니다.');
                }
                throw new Error(detail || '음성 파일을 저장하지 못했습니다.');
            }
            await response.json().catch(() => undefined);
            setNoticeMessage('음성 파일을 다운로드 폴더에 저장했습니다.');
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '음성 파일을 저장하지 못했습니다.');
        } finally {
            setIsDownloading(false);
        }
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
        const targetMeetingId = selectedMeeting.id;
        const targetJobId = selectedMeeting.jobId;
        const title = editTitle.trim();
        const date = editDate.trim();
        const meetingPurpose = editMeetingPurpose.trim();
        const inputMetadataChanged = title !== (selectedMeeting.title || '').trim()
            || date !== (selectedMeeting.date || '').trim()
            || meetingPurpose !== (selectedMeeting.meetingPurpose || '').trim();
        if (!title || !date) {
            setErrorMessage('회의 제목과 일시는 비워둘 수 없습니다.');
            return;
        }

        try {
            setErrorMessage('');
            setNoticeMessage('');
            await updateSelectedMeeting(currentMeeting => ({
                title,
                date,
                meetingPurpose,
                participants: currentMeeting.participants || '',
                transcriptEditMeta: inputMetadataChanged
                    ? buildTranscriptOutdatedMeta(currentMeeting, Boolean(currentMeeting.transcriptEditMeta?.edited || currentMeeting.editedDisplaySegments?.length))
                    : currentMeeting.transcriptEditMeta,
            }));
            setIsEditing(false);
            setNoticeMessage('회의 정보를 저장했습니다.');
            const syncMessage = await syncMeetingOutputRecordSafely(targetMeetingId, targetJobId);
            if (syncMessage && currentSelectedMeetingIdRef.current === targetMeetingId) {
                setErrorMessage(syncMessage);
            }
        } catch (error) {
            setNoticeMessage('');
            setErrorMessage(error instanceof Error ? error.message : '회의록 정보를 저장하지 못했습니다.');
        }
    };

    const handleSaveSpeakerLabels = async () => {
        if (!selectedMeeting || !hasSpeakerLabelChanges) return;
        const targetMeetingId = selectedMeeting.id;
        const targetJobId = selectedMeeting.jobId;
        const cleanedLabels = Object.fromEntries(
            Object.entries(speakerLabelDrafts)
                .map(([speaker, label]) => [speaker, label.trim()])
                .filter(([, label]) => Boolean(label)),
        );
        try {
            setErrorMessage('');
            setNoticeMessage('');
            await updateSelectedMeeting({ speakerLabels: cleanedLabels });
            setNoticeMessage('화자 이름을 저장했습니다.');
            const syncMessage = await syncMeetingOutputRecordSafely(targetMeetingId, targetJobId);
            if (syncMessage && currentSelectedMeetingIdRef.current === targetMeetingId) {
                setErrorMessage(syncMessage);
            }
        } catch (error) {
            setNoticeMessage('');
            setErrorMessage(error instanceof Error ? error.message : '화자 이름을 저장하지 못했습니다.');
        }
    };

    const handleGenerateSummary = async () => {
        if (generatingKind !== null || summaryGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canGenerateSummary || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(hasTranscriptData ? '분석 원본이 있어야 전체 요약을 정리할 수 있습니다.' : '대화록이 있어야 전체 요약을 정리할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const inputFingerprint = buildGenerationInputFingerprint(targetMeeting);
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setGeneratingKind('summary');
            setLocalGenerationStatus(targetMeeting.id, 'summary', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-summary`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '핵심 요약을 다시 만들지 못했습니다.'));

            const data = await response.json() as GenerateSummaryResponse;
            let inputChangedBeforeSave = false;
            await updateSelectedMeeting(currentMeeting => {
                const inputChangedSinceRequest = buildGenerationInputFingerprint(currentMeeting) !== inputFingerprint;
                if (inputChangedSinceRequest) {
                    inputChangedBeforeSave = true;
                    return {
                        generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { summary: 'not_started' }),
                        transcriptEditMeta: buildTranscriptOutdatedMeta(currentMeeting, Boolean(currentMeeting.transcriptEditMeta?.edited || currentMeeting.editedDisplaySegments?.length)),
                    };
                }
                return {
                    summary: data.summary ?? currentMeeting.summary,
                    topics: data.topics ?? [],
                    actions: data.actions ?? [],
                    decisions: data.decisions ?? [],
                    needsCheck: data.needsCheck ?? data.needs_check ?? [],
                    topicSections: data.topicSections ?? data.topic_sections ?? [],
                    speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? [],
                    participantSummaries: data.participantSummaries ?? data.participant_summaries ?? [],
                    generationStatus: data.generationStatus ?? data.generation_status ?? { summary: 'completed' },
                    transcriptEditMeta: {
                        ...(currentMeeting.transcriptEditMeta ?? {}),
                        summaryOutdated: false,
                        topicSectionsOutdated: false,
                        speakerContextOutdated: false,
                    },
                    outputFiles: data.outputs ?? currentMeeting.outputFiles,
                };
            }, targetMeeting.id);
            if (inputChangedBeforeSave) {
                setNoticeMessage('');
                setErrorMessage('회의 정보나 대화록이 바뀌어 이번 전체 요약은 저장하지 않았습니다. 다시 정리해 주세요.');
                return;
            }
            if (searchQuery.trim()) {
                setSearchQuery('');
            }
            window.requestAnimationFrame(() => {
                document.querySelector('[data-summary-section="overview"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            const nextSummaryStatus = data.generationStatus?.summary ?? data.generation_status?.summary;
            setNoticeMessage(nextSummaryStatus === 'skipped'
                ? '요약 AI가 준비되지 않아 대화록만 유지했습니다.'
                : summaryRegenerationWillResetDerived
                    ? '전체 요약을 정리했습니다. 아래 정리도 다시 해 주세요.'
                    : '전체 요약을 정리했습니다.');
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            const nextState = error instanceof Error && isStaleGenerationMessage(error.message) ? 'not_started' : 'failed';
            await updateSelectedMeeting(currentMeeting => ({
                generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { summary: nextState }),
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
                setErrorMessage(error instanceof Error ? error.message : '핵심 요약 생성 중 오류가 발생했습니다.');
            }
        } finally {
            setGeneratingKind(null);
        }
    };

    const originalDisplaySegments = useMemo(
        () => resolveBaseDisplaySegments(selectedMeeting),
        [selectedMeeting],
    );
    const effectiveStoredDisplaySegments = resolveEffectiveTranscriptSegments(selectedMeeting);
    const transcriptEditMeta = selectedMeeting?.transcriptEditMeta ?? {};
    const topicSectionsOutdated = Boolean(transcriptEditMeta.topicSectionsOutdated);
    const speakerContextOutdated = Boolean(transcriptEditMeta.speakerContextOutdated);
    const summaryOutdated = Boolean(transcriptEditMeta.summaryOutdated);
    const summaryGenerationStatus = getSummaryGenerationStatus(selectedMeeting?.generationStatus, selectedMeeting?.summary);
    const topicGenerationStatus = getTopicGenerationStatus(selectedMeeting?.generationStatus, selectedMeeting?.topicSections);
    const hasTranscriptData = Boolean(
        (selectedMeeting?.editedDisplaySegments?.length ?? 0)
        || (selectedMeeting?.displaySegments?.length ?? 0)
        || (selectedMeeting?.segments?.length ?? 0),
    );
    const canGenerateSummary = Boolean(selectedMeeting?.jobId && hasTranscriptData);
    const canGenerateTopicSections = Boolean(selectedMeeting?.jobId && hasTranscriptData && summaryGenerationStatus !== 'skipped');
    const speakerGenerationStatus = getSpeakerGenerationStatus(
        selectedMeeting?.generationStatus,
        selectedMeeting?.speakerContextSummaries,
    );
    const baseCanCreateSpeakerContext = canGenerateSpeakerContextFromState(
        selectedMeeting?.generationStatus,
        selectedMeeting?.topicSections,
    );
    const canCreateSpeakerContext = baseCanCreateSpeakerContext && !topicSectionsOutdated;
    const summaryActionMeta = canGenerateSummary
        ? (summaryOutdated ? '수정 필요' : generationStatusLabel[summaryGenerationStatus])
        : '';
    const speakerGenerationStatusText = canCreateSpeakerContext && speakerGenerationStatus === 'not_started'
        ? '정리 가능'
        : generationStatusLabel[speakerGenerationStatus];
    const topicActionMeta = canGenerateTopicSections
        ? (topicSectionsOutdated ? '수정 필요' : generationStatusLabel[topicGenerationStatus])
        : '';
    const speakerActionMeta = canGenerateTopicSections
        ? (topicSectionsOutdated
            ? '주제 정리 필요'
            : speakerContextOutdated
                ? '수정 필요'
                : (canCreateSpeakerContext || speakerGenerationStatus !== 'not_started'
            ? speakerGenerationStatusText
            : '주제별 정리 후 사용'))
        : '';
    const summaryRegenerationWillResetDerived = Boolean(selectedMeeting?.topicSections?.length || selectedMeeting?.speakerContextSummaries?.length || selectedMeeting?.participantSummaries?.length);
    const actionSectionNote = !hasTranscriptData
        ? '대화록이 있어야 정리할 수 있습니다.'
        : !selectedMeeting?.jobId
            ? '분석 원본이 있어야 정리할 수 있습니다.'
            : summaryGenerationStatus === 'skipped'
                ? '요약 AI가 준비되면 전체 요약과 추가 정리를 만들 수 있습니다.'
            : !baseCanCreateSpeakerContext
                ? '참석자별 정리 전에 주제별 정리를 먼저 해 주세요.'
                : summaryRegenerationWillResetDerived && summaryOutdated
                    ? '전체 요약을 다시 정리하면 아래 정리도 다시 해야 합니다.'
                    : null;

    const handleGenerateTopicSections = async () => {
        if (generatingKind !== null || topicGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canGenerateTopicSections || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(hasTranscriptData ? '분석 원본이 있어야 주제별 정리를 할 수 있습니다.' : '대화록이 있어야 주제별 정리를 할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const inputFingerprint = buildGenerationInputFingerprint(targetMeeting);
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setGeneratingKind('topicSections');
            setLocalGenerationStatus(targetMeeting.id, 'topicSections', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-topic-sections`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '주제별 정리를 만들지 못했습니다.'));

            const data = await response.json() as GenerateTopicSectionsResponse;
            let inputChangedBeforeSave = false;
            await updateSelectedMeeting(currentMeeting => {
                const inputChangedSinceRequest = buildGenerationInputFingerprint(currentMeeting) !== inputFingerprint;
                if (inputChangedSinceRequest) {
                    inputChangedBeforeSave = true;
                    return {
                        generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { topicSections: 'not_started' }),
                        transcriptEditMeta: buildTranscriptOutdatedMeta(currentMeeting, Boolean(currentMeeting.transcriptEditMeta?.edited || currentMeeting.editedDisplaySegments?.length)),
                    };
                }
                return {
                    topics: data.topics ?? currentMeeting.topics ?? [],
                    topicSections: data.topicSections ?? data.topic_sections ?? [],
                    generationStatus: data.generationStatus ?? data.generation_status ?? { topicSections: 'completed' },
                    transcriptEditMeta: {
                        ...(currentMeeting.transcriptEditMeta ?? {}),
                        topicSectionsOutdated: false,
                        speakerContextOutdated: Boolean(currentMeeting.speakerContextSummaries?.length || currentMeeting.participantSummaries?.length),
                    },
                    outputFiles: data.outputs ?? currentMeeting.outputFiles,
                };
            }, targetMeeting.id);
            if (inputChangedBeforeSave) {
                setNoticeMessage('');
                setErrorMessage('회의 정보나 대화록이 바뀌어 이번 주제별 정리는 저장하지 않았습니다. 다시 정리해 주세요.');
                return;
            }
            if (searchQuery.trim()) {
                setSearchQuery('');
            }
            const firstTopic = (data.topicSections ?? data.topic_sections ?? [])[0]?.topic;
            if (firstTopic) {
                setSelectedTopicKey(normalizeTopicKey(firstTopic));
            }
            window.requestAnimationFrame(() => {
                topicSectionsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            setNoticeMessage('주제별 정리를 완료했습니다.');
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            const nextState = error instanceof Error && isStaleGenerationMessage(error.message) ? 'not_started' : 'failed';
            await updateSelectedMeeting(currentMeeting => ({
                generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { topicSections: nextState }),
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
                setErrorMessage(error instanceof Error ? error.message : '주제별 정리 생성 중 오류가 발생했습니다.');
            }
        } finally {
            setGeneratingKind(null);
        }
    };

    const handleGenerateSpeakerContext = async () => {
        if (generatingKind !== null || speakerGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canGenerateTopicSections || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(hasTranscriptData ? '분석 원본이 있어야 참석자별 정리를 할 수 있습니다.' : '대화록이 있어야 참석자별 정리를 할 수 있습니다.');
            return;
        }
        if (!canCreateSpeakerContext) {
            setNoticeMessage('');
            setErrorMessage('참석자별 정리 전에 주제별 정리를 먼저 해 주세요.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const inputFingerprint = buildGenerationInputFingerprint(targetMeeting);
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setGeneratingKind('speakerContextSummaries');
            setLocalGenerationStatus(targetMeeting.id, 'speakerContextSummaries', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-speaker-context`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '참석자별 정리를 만들지 못했습니다.'));

            const data = await response.json() as GenerateSpeakerContextResponse;
            let inputChangedBeforeSave = false;
            await updateSelectedMeeting(currentMeeting => {
                const inputChangedSinceRequest = buildGenerationInputFingerprint(currentMeeting) !== inputFingerprint;
                if (inputChangedSinceRequest) {
                    inputChangedBeforeSave = true;
                    return {
                        generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { speakerContextSummaries: 'not_started' }),
                        transcriptEditMeta: buildTranscriptOutdatedMeta(currentMeeting, Boolean(currentMeeting.transcriptEditMeta?.edited || currentMeeting.editedDisplaySegments?.length)),
                    };
                }
                return {
                    speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? [],
                    participantSummaries: data.participantSummaries ?? data.participant_summaries ?? currentMeeting.participantSummaries ?? [],
                    generationStatus: data.generationStatus ?? data.generation_status ?? { speakerContextSummaries: 'completed' },
                    transcriptEditMeta: {
                        ...(currentMeeting.transcriptEditMeta ?? {}),
                        speakerContextOutdated: false,
                    },
                    outputFiles: data.outputs ?? currentMeeting.outputFiles,
                };
            }, targetMeeting.id);
            if (inputChangedBeforeSave) {
                setNoticeMessage('');
                setErrorMessage('회의 정보나 대화록이 바뀌어 이번 참석자별 정리는 저장하지 않았습니다. 다시 정리해 주세요.');
                return;
            }
            if (searchQuery.trim()) {
                setSearchQuery('');
            }
            window.requestAnimationFrame(() => {
                speakerSummarySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            setNoticeMessage('참석자별 정리를 완료했습니다.');
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            const nextState = error instanceof Error && isStaleGenerationMessage(error.message) ? 'not_started' : 'failed';
            await updateSelectedMeeting(currentMeeting => ({
                generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { speakerContextSummaries: nextState }),
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
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
    const topicSectionKeySet = useMemo(
        () => new Set((selectedMeeting?.topicSections ?? []).map(section => normalizeTopicKey(section.topic ?? '')).filter(Boolean)),
        [normalizeTopicKey, selectedMeeting?.topicSections],
    );
    const visibleTopicSections = useMemo(
        () => selectedMeeting?.topicSections?.filter(section => !contentQuery || [
            section.topic,
            section.summary,
            ...(section.evidence ?? []),
        ].join(' ').toLowerCase().includes(contentQuery)) ?? [],
        [contentQuery, selectedMeeting],
    );
    const resolveSpeakerName = React.useCallback((speaker: string, fallback?: string) => {
        return selectedMeeting?.speakerLabels?.[speaker] || fallback || speaker;
    }, [selectedMeeting?.speakerLabels]);
    const replaceSpeakerLabelsInText = React.useCallback((text: string) => {
        const labels = selectedMeeting?.speakerLabels;
        if (!labels) return text;

        return Object.entries(labels)
            .filter(([, label]) => Boolean(label?.trim()))
            .sort(([left], [right]) => right.length - left.length)
            .reduce((currentText, [speaker, label]) => currentText.replaceAll(speaker, label.trim()), text);
    }, [selectedMeeting?.speakerLabels]);
    const actionSpeakerPrefixes = useMemo(() => {
        const labels = selectedMeeting?.speakerLabels ?? {};
        return Array.from(
            new Set([
                ...Object.keys(labels),
                ...Object.values(labels)
                    .map(label => label.trim())
                    .filter(Boolean),
            ]),
        ).sort((left, right) => right.length - left.length);
    }, [selectedMeeting?.speakerLabels]);
    const normalizeActionText = React.useCallback((text: string) => {
        const replaced = replaceSpeakerLabelsInText(text).trim();
        const matchingPrefix = actionSpeakerPrefixes.find(prefix => (
            new RegExp(`^${escapeRegExp(prefix)}\\s*:`).test(replaced)
        ));
        if (matchingPrefix) {
            return replaced.replace(new RegExp(`^${escapeRegExp(matchingPrefix)}\\s*:\\s*`), '').trim();
        }
        return replaced.replace(/^화자\d+\s*:\s*/, '').trim();
    }, [actionSpeakerPrefixes, replaceSpeakerLabelsInText]);
    const speakerSummariesForDisplay = useMemo(() => {
        if (selectedMeeting?.speakerContextSummaries?.length) {
            return selectedMeeting.speakerContextSummaries.map(item => ({
                key: `${item.speaker}-${item.display_name ?? ''}`,
                name: resolveSpeakerName(item.speaker, item.display_name),
                role: item.role_in_meeting,
                summary: item.summary,
                keyPoints: item.key_points ?? [],
                actions: item.actions ?? [],
                needsCheck: item.needs_check ?? [],
            }));
        }

        return selectedMeeting?.participantSummaries?.map(item => ({
            key: `${item.participant}`,
            name: item.participant,
            role: '',
            summary: item.summary,
            keyPoints: item.key_points ?? [],
            actions: item.actions ?? [],
            needsCheck: [],
        })) ?? [];
    }, [resolveSpeakerName, selectedMeeting]);
    const filteredSpeakerSummaries = useMemo(
        () => speakerSummariesForDisplay.filter(item => !contentQuery || [
            item.name,
            item.summary,
            ...item.keyPoints,
            ...item.needsCheck,
        ].join(' ').toLowerCase().includes(contentQuery)),
        [contentQuery, speakerSummariesForDisplay],
    );
    const displayActions = useMemo(
        () => selectedMeeting?.actions?.map(action => normalizeActionText(action)) ?? [],
        [normalizeActionText, selectedMeeting?.actions],
    );
    const visibleSpeakerSummaries = useMemo(
        () => filteredSpeakerSummaries.filter(item => selectedSpeakerSummaryKey === 'all' || item.key === selectedSpeakerSummaryKey),
        [filteredSpeakerSummaries, selectedSpeakerSummaryKey],
    );
    const displaySegments = useMemo(() => {
        return effectiveStoredDisplaySegments.map(segment => ({
            ...segment,
            displaySpeaker: resolveSpeakerName(segment.speaker, segment.displaySpeaker),
        }));
    }, [effectiveStoredDisplaySegments, resolveSpeakerName]);
    const speakersInTranscript = useMemo(() => {
        const speakerSet = new Set<string>();
        [...(selectedMeeting?.segments ?? []), ...(selectedMeeting?.displaySegments ?? []), ...(selectedMeeting?.editedDisplaySegments ?? [])].forEach(segment => {
            if (segment.speaker) speakerSet.add(segment.speaker);
        });
        return Array.from(speakerSet).sort((a, b) => a.localeCompare(b, 'ko'));
    }, [selectedMeeting]);
    const visibleSegments = useMemo(
        () => displaySegments.filter(segment => !contentQuery || [
            segment.speaker,
            segment.displaySpeaker ?? '',
            segment.text,
            segment.start,
            segment.end,
        ].join(' ').toLowerCase().includes(contentQuery)) ?? [],
        [contentQuery, displaySegments],
    );
    const hasCompletedEmptyTopicSections = topicGenerationStatus === 'completed' && !visibleTopicSections.length && Boolean(selectedMeeting?.topicSections);
    const hasCompletedEmptySpeakerContext = speakerGenerationStatus === 'completed' && !visibleSpeakerSummaries.length && Boolean(selectedMeeting?.speakerContextSummaries);
    const hasResultHighlights = Boolean(visibleTopics.length || selectedMeeting?.decisions?.length || displayActions.length);
    const hasNeedsCheckContent = Boolean(selectedMeeting?.needsCheck?.length);
    const isFiltering = Boolean(contentQuery);
    const cleanedSpeakerLabels = useMemo(
        () => Object.fromEntries(
            Object.entries(selectedMeeting?.speakerLabels ?? {})
                .map(([speaker, label]) => [speaker, label.trim()])
                .filter(([, label]) => Boolean(label)),
        ),
        [selectedMeeting?.speakerLabels],
    );
    const cleanedSpeakerLabelDrafts = useMemo(
        () => Object.fromEntries(
            Object.entries(speakerLabelDrafts)
                .map(([speaker, label]) => [speaker, label.trim()])
                .filter(([, label]) => Boolean(label)),
        ),
        [speakerLabelDrafts],
    );
    const hasSpeakerLabelChanges = JSON.stringify(cleanedSpeakerLabels) !== JSON.stringify(cleanedSpeakerLabelDrafts);
    const normalizedTranscriptDrafts = useMemo(
        () => normalizeTranscriptDrafts(transcriptSegmentDrafts),
        [transcriptSegmentDrafts],
    );
    const normalizedVisibleSegments = useMemo(
        () => normalizeTranscriptDrafts(displaySegments),
        [displaySegments],
    );
    const hasTranscriptDraftChanges = isTranscriptEditing
        && !transcriptSegmentsEqual(normalizedTranscriptDrafts, normalizedVisibleSegments);
    const hasMeetingInfoChanges = isEditing && (
        editTitle.trim() !== (selectedMeeting?.title ?? '').trim()
        || editDate.trim() !== (selectedMeeting?.date ?? '').trim()
        || editMeetingPurpose.trim() !== (selectedMeeting?.meetingPurpose || '').trim()
    );
    const hasUnsavedDraftChanges = hasMeetingInfoChanges || hasSpeakerLabelChanges || hasTranscriptDraftChanges;

    useEffect(() => {
        if (!selectedMeeting) return;
        const meetingChanged = hydratedMeetingIdRef.current !== selectedMeeting.id;
        if (meetingChanged || !isEditing) {
            setEditTitle(selectedMeeting.title);
            setEditDate(selectedMeeting.date);
            setEditMeetingPurpose(selectedMeeting.meetingPurpose || '');
        }
        if (meetingChanged || !hasSpeakerLabelChanges) {
            setSpeakerLabelDrafts(selectedMeeting.speakerLabels ?? {});
        }
        hydratedMeetingIdRef.current = selectedMeeting.id;
    }, [hasSpeakerLabelChanges, isEditing, selectedMeeting]);

    const confirmDiscardUnsavedChanges = React.useCallback((nextMeetingId: string | null) => {
        const currentMeetingId = currentSelectedMeetingIdRef.current;
        if (!currentMeetingId || currentMeetingId === nextMeetingId || !hasUnsavedDraftChanges) return true;

        const shouldDiscard = window.confirm('저장되지 않은 변경이 있습니다. 이동하면 현재 편집 내용이 사라집니다. 계속하시겠습니까?');
        if (!shouldDiscard) {
            onSelectMeetingId?.(currentMeetingId);
        }
        return shouldDiscard;
    }, [hasUnsavedDraftChanges, onSelectMeetingId]);

    useEffect(() => {
        canLeaveMeetingRef.current = confirmDiscardUnsavedChanges;
    }, [confirmDiscardUnsavedChanges]);

    useEffect(() => {
        if (!onRegisterLeaveGuard) return;
        onRegisterLeaveGuard(() => confirmDiscardUnsavedChanges(null));
        return () => onRegisterLeaveGuard(null);
    }, [confirmDiscardUnsavedChanges, onRegisterLeaveGuard]);

    useEffect(() => {
        if (!hasUnsavedDraftChanges) return;

        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [hasUnsavedDraftChanges]);

    const ensureNoUnsavedDraftChanges = (actionLabel: string): boolean => {
        if (!hasUnsavedDraftChanges) return true;
        setNoticeMessage('');
        setErrorMessage(`저장되지 않은 변경이 있습니다. ${actionLabel} 전에 변경 내용을 저장하거나 취소해 주세요.`);
        return false;
    };

    const handleStartTranscriptEdit = () => {
        setErrorMessage('');
        setNoticeMessage('');
        setTranscriptSegmentDrafts(displaySegments.map(segment => ({ ...segment })));
        setIsTranscriptEditing(true);
    };

    const handleTranscriptDraftChange = (index: number, text: string) => {
        setTranscriptSegmentDrafts(current => current.map((segment, currentIndex) => (
            currentIndex === index ? { ...segment, text } : segment
        )));
    };

    const handleCancelTranscriptEdit = () => {
        setTranscriptSegmentDrafts([]);
        setIsTranscriptEditing(false);
        setNoticeMessage('');
    };

    const handleRevertTranscript = async () => {
        if (!selectedMeeting?.editedDisplaySegments?.length) return;
        const targetMeetingId = selectedMeeting.id;
        const targetJobId = selectedMeeting.jobId;
        try {
            setErrorMessage('');
            setNoticeMessage('');
            await updateSelectedMeeting(currentMeeting => ({
                editedDisplaySegments: [],
                transcriptEditMeta: buildTranscriptOutdatedMeta(currentMeeting, false),
            }));
            setTranscriptSegmentDrafts([]);
            setIsTranscriptEditing(false);
            setNoticeMessage('원본 대화록으로 되돌렸습니다. 기존 정리 내용은 다시 확인이 필요합니다.');
            const syncMessage = await syncMeetingOutputRecordSafely(targetMeetingId, targetJobId);
            if (syncMessage && currentSelectedMeetingIdRef.current === targetMeetingId) {
                setErrorMessage(syncMessage);
            }
        } catch (error) {
            setNoticeMessage('');
            setErrorMessage(error instanceof Error ? error.message : '대화록 수정본을 되돌리지 못했습니다.');
        }
    };

    const handleSaveTranscriptEdit = async () => {
        if (!selectedMeeting) return;
        const targetMeetingId = selectedMeeting.id;
        const targetJobId = selectedMeeting.jobId;
        const normalizedDrafts = normalizeTranscriptDrafts(transcriptSegmentDrafts);
        if (!normalizedDrafts.length) {
            setErrorMessage('대화록 수정본은 비워둘 수 없습니다.');
            return;
        }

        const normalizedOriginal = normalizeTranscriptDrafts(originalDisplaySegments);
        const hasChanges = !transcriptSegmentsEqual(normalizedDrafts, normalizedOriginal);
        try {
            setErrorMessage('');
            setNoticeMessage('');
            await updateSelectedMeeting(currentMeeting => (
                hasChanges
                    ? {
                        editedDisplaySegments: normalizedDrafts,
                        transcriptEditMeta: buildTranscriptEditMeta(currentMeeting),
                    }
                    : {
                        editedDisplaySegments: [],
                        transcriptEditMeta: buildTranscriptOutdatedMeta(currentMeeting, false),
                    }
            ));
            setTranscriptSegmentDrafts([]);
            setIsTranscriptEditing(false);
            setNoticeMessage(hasChanges ? '대화록 수정본을 저장했습니다.' : '수정 내용이 없어 원본 대화록으로 유지했습니다.');
            const syncMessage = await syncMeetingOutputRecordSafely(targetMeetingId, targetJobId);
            if (syncMessage && currentSelectedMeetingIdRef.current === targetMeetingId) {
                setErrorMessage(syncMessage);
            }
        } catch (error) {
            setNoticeMessage('');
            setErrorMessage(error instanceof Error ? error.message : '대화록 수정본을 저장하지 못했습니다.');
        }
    };

    useEffect(() => {
        if (!selectedTopicKey) return;
        if (topicSectionKeySet.has(selectedTopicKey)) return;
        setSelectedTopicKey(null);
    }, [selectedTopicKey, topicSectionKeySet]);

    useEffect(() => {
        if (selectedSpeakerSummaryKey === 'all') return;
        if (filteredSpeakerSummaries.some(item => item.key === selectedSpeakerSummaryKey)) return;
        setSelectedSpeakerSummaryKey('all');
    }, [filteredSpeakerSummaries, selectedSpeakerSummaryKey]);

    useEffect(() => {
        topicSectionRefs.current = {};
    }, [selectedMeeting?.id, visibleTopicSections]);

    const openSpeakerLabelEditor = () => {
        setDetailTab('script');
        window.requestAnimationFrame(() => {
            speakerLabelsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const input = speakerLabelsPanelRef.current?.querySelector('input');
            if (input instanceof HTMLInputElement) {
                input.focus();
            }
        });
    };

    const handleSelectTopic = (topic: string) => {
        const nextKey = normalizeTopicKey(topic);
        if (!topicSectionKeySet.has(nextKey)) return;
        const willSelect = selectedTopicKey !== nextKey;
        setSelectedTopicKey(current => current === nextKey ? null : nextKey);
        if (willSelect) {
            window.requestAnimationFrame(() => {
                topicSectionRefs.current[nextKey]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    };

    const getActionLabel = (status: string): string => (status === 'generating' ? '정리 중' : '정리');
    const shouldShowSummaryAction = summaryGenerationStatus !== 'completed' || summaryOutdated;
    const shouldShowTopicAction = topicGenerationStatus !== 'completed' || topicSectionsOutdated;
    const shouldShowSpeakerAction = speakerGenerationStatus !== 'completed' || speakerContextOutdated || topicSectionsOutdated;

    const renderActionMeta = (meta: string, status: string, isOutdated = false) => {
        if (!meta) return null;
        if (status === 'completed' && !isOutdated) return null;
        return <span>{meta}</span>;
    };

    const renderActionTitle = (title: string, status: string, isOutdated = false) => (
        <div className="inline-flex items-center gap-2">
            {status === 'completed' && !isOutdated && <CheckCircle2 size={16} className="text-emerald-600" aria-hidden="true" />}
            <span>{title}</span>
        </div>
    );

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
            {noticeMessage && (
                <StatusBanner tone="success" className="mb-4">
                    {noticeMessage}
                </StatusBanner>
            )}
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
                                    <Input value={editMeetingPurpose} onChange={event => setEditMeetingPurpose(event.target.value)} aria-label="회의 목적" />
                                </div>
                                {!selectedMeeting.meetingPurpose && selectedMeeting.participants && (
                                    <div className="text-xs text-muted-foreground">
                                        기존 참석자: {selectedMeeting.participants}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="min-w-0 flex-1">
                                <h2 className="break-words text-xl font-semibold text-foreground">{selectedMeeting.title}</h2>
                                <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                                    <div><span className="font-medium text-foreground">일시:</span> {selectedMeeting.date}</div>
                                    <div>
                                        <span className="font-medium text-foreground">
                                            {selectedMeeting.meetingPurpose ? '회의 목적:' : '참석자:'}
                                        </span> {selectedMeeting.meetingPurpose || selectedMeeting.participants || '-'}
                                    </div>
                                </div>
                                {selectedMeeting.sourceFile && (
                                    <div className="mt-2 break-words text-sm text-muted-foreground">
                                        <span className="font-medium text-foreground">원본 파일:</span> {selectedMeeting.sourceFile}
                                    </div>
                                )}
                                {selectedMeeting.diarizationSkipped && (
                                    <div className="status-note mt-3">
                                        {selectedMeeting.diarizationSkipMessage || '긴 음성 파일이라 발화자 구분을 건너뛰고 대화록과 요약을 먼저 만들었습니다.'}
                                    </div>
                                )}
                                {audioSourceUrl && (
                                    <audio
                                        className="mt-3 h-9 w-full max-w-xl"
                                        aria-label="추출 음성"
                                        controls
                                        crossOrigin="anonymous"
                                        preload="metadata"
                                        src={audioSourceUrl}
                                    />
                                )}
                                {selectedMeeting.jobId && audioAvailability === 'missing' && (
                                    <div className="mt-2 text-xs text-muted-foreground">
                                        저장된 음성 파일이 없습니다. 설정에서 음성 재생 파일 보관을 켜고 다시 분석하면 결과 화면에서 재생하거나 저장할 수 있습니다.
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
                                        onNotice={setNoticeMessage}
                                        onError={setErrorMessage}
                                        onDownloadingChange={setIsDownloading}
                                        beforeDownload={() => ensureNoUnsavedDraftChanges('파일 저장')}
                                        disabled={isDownloading}
                                    />
                                    {selectedMeeting.jobId && audioSourceUrl && (
                                        <IconButton
                                            aria-label="음성 파일 저장"
                                            title="음성 파일 저장"
                                            icon={<FileAudio size={18} />}
                                            onClick={handleSaveAudioCopy}
                                            disabled={isDownloading}
                                        />
                                    )}
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
                                <section data-summary-section="overview">
                                    <h3 className="section-title mb-2">핵심 요약</h3>
                                    {summaryOutdated && (
                                        <div className="detail-inline-note mb-3">
                                            회의 정보나 대화록이 바뀌어 현재 핵심 요약은 이전 기준일 수 있습니다.
                                        </div>
                                    )}
                                    <div className="detail-callout">{selectedMeeting.summary || '요약 내용이 없습니다.'}</div>
                                </section>
                            )}

                            <section className="detail-action-row">
                                <h3 className="section-title mb-3">정리</h3>
                                <div className="grid gap-2 lg:grid-cols-3">
                                    <div className="ai-action-item">
                                        <div className="min-w-0">
                                            <div className="ai-action-title">{renderActionTitle('전체 요약', summaryGenerationStatus, summaryOutdated)}</div>
                                            <div className="ai-action-meta">{renderActionMeta(summaryActionMeta, summaryGenerationStatus, summaryOutdated)}</div>
                                        </div>
                                        {shouldShowSummaryAction && (
                                            <Button
                                                variant="outline"
                                                className="detail-action-button"
                                                aria-label="전체 요약 정리"
                                                disabled={!canGenerateSummary || generatingKind !== null || summaryGenerationStatus === 'generating'}
                                                onClick={handleGenerateSummary}
                                            >
                                                {generatingKind === 'summary' && <Loader2 size={15} className="animate-spin" />}
                                                {getActionLabel(summaryGenerationStatus)}
                                            </Button>
                                        )}
                                    </div>
                                    <div className="ai-action-item">
                                        <div className="min-w-0">
                                            <div className="ai-action-title">{renderActionTitle('주제별 정리', topicGenerationStatus, topicSectionsOutdated)}</div>
                                            <div className="ai-action-meta">{renderActionMeta(topicActionMeta, topicGenerationStatus, topicSectionsOutdated)}</div>
                                        </div>
                                        {shouldShowTopicAction && (
                                            <Button
                                                variant="outline"
                                                className="detail-action-button"
                                                aria-label="주제별 정리"
                                                disabled={!canGenerateTopicSections || generatingKind !== null || topicGenerationStatus === 'generating'}
                                                onClick={handleGenerateTopicSections}
                                            >
                                                {generatingKind === 'topicSections' && <Loader2 size={15} className="animate-spin" />}
                                                {getActionLabel(topicGenerationStatus)}
                                            </Button>
                                        )}
                                    </div>
                                    <div className={`ai-action-item ${!canCreateSpeakerContext ? 'ai-action-item-disabled' : ''}`}>
                                        <div className="min-w-0">
                                            <div className="ai-action-title">{renderActionTitle('참석자별 정리', speakerGenerationStatus, speakerContextOutdated || topicSectionsOutdated)}</div>
                                            <div className="ai-action-meta">{renderActionMeta(speakerActionMeta, speakerGenerationStatus, speakerContextOutdated || topicSectionsOutdated)}</div>
                                        </div>
                                        {shouldShowSpeakerAction && (
                                            <Button
                                                variant="outline"
                                                className="detail-action-button"
                                                aria-label="참석자별 정리"
                                                disabled={!canGenerateTopicSections || generatingKind !== null || speakerGenerationStatus === 'generating' || !canCreateSpeakerContext}
                                                onClick={handleGenerateSpeakerContext}
                                                title={canCreateSpeakerContext ? '참석자별 정리' : '주제별 정리를 먼저 만들어 주세요.'}
                                            >
                                                {generatingKind === 'speakerContextSummaries' && <Loader2 size={15} className="animate-spin" />}
                                                {getActionLabel(speakerGenerationStatus)}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                {actionSectionNote && (
                                    <div className="detail-inline-note mt-3">
                                        {actionSectionNote}
                                    </div>
                                )}
                            </section>

                            {hasResultHighlights && (
                                <section>
                                    <h3 className="section-title mb-2">주요 내용 및 결정사항</h3>
                                    <div className="grid gap-3">
                                        {!!visibleTopics.length && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">주요 내용</div>
                                                <ul className="detail-list">
                                                    {visibleTopics.map((topic, index) => <li key={`${topic}-${index}`}>{topic}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                        {!!selectedMeeting.decisions?.length && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">결정사항</div>
                                                <ul className="detail-list">
                                                    {selectedMeeting.decisions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                        {!!displayActions.length && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">할 일</div>
                                                <ul className="detail-list">
                                                    {displayActions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                </section>
                            )}

                            {hasNeedsCheckContent && (
                                <section>
                                    <h3 className="section-title mb-2">추가 확인</h3>
                                    <div className="detail-subtle-card">
                                        <ul className="detail-list">
                                            {selectedMeeting!.needsCheck!.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                                        </ul>
                                    </div>
                                </section>
                            )}

                            {!!visibleTopics.length && !selectedMeeting?.topicSections?.length && (
                                <section>
                                    <h3 className="section-title mb-2">논의 주제</h3>
                                    <div className="flex flex-wrap gap-2">
                                        {visibleTopics.map(topic => (
                                            topicSectionKeySet.has(normalizeTopicKey(topic)) ? (
                                                <button
                                                    key={topic}
                                                    type="button"
                                                    className={`topic-chip ${selectedTopicKey === normalizeTopicKey(topic) ? 'topic-chip-active' : ''}`}
                                                    onClick={() => handleSelectTopic(topic)}
                                                    title="주제별 정리 위치로 이동"
                                                >
                                                    {topic}
                                                </button>
                                            ) : (
                                                <span key={topic} className="topic-chip">
                                                    {topic}
                                                </span>
                                            )
                                        ))}
                                    </div>
                                    {!selectedMeeting?.topicSections?.length && (
                                        <div className="detail-inline-note mt-3">
                                            주제별 정리를 하면 아래에 자세한 내용이 표시됩니다.
                                        </div>
                                    )}
                                </section>
                            )}

                            {(!!visibleTopicSections.length || hasCompletedEmptyTopicSections) && (
                                <section ref={topicSectionsSectionRef}>
                                    <h3 className="section-title mb-2">주제별 정리</h3>
                                    {!!visibleTopics.length && (
                                        <div className="mb-3 flex flex-wrap gap-2">
                                            {visibleTopics.map(topic => (
                                                <button
                                                    key={topic}
                                                    type="button"
                                                    className={`topic-chip ${selectedTopicKey === normalizeTopicKey(topic) ? 'topic-chip-active' : ''}`}
                                                    onClick={() => handleSelectTopic(topic)}
                                                    title="해당 주제 위치로 이동"
                                                >
                                                    {topic}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {visibleTopicSections.length ? (
                                        <div className="grid gap-3">
                                            {visibleTopicSections.map((section, index) => (
                                                <article
                                                    key={`${section.topic}-${index}`}
                                                    ref={node => {
                                                        const key = normalizeTopicKey(section.topic ?? '');
                                                        if (!key) return;
                                                        if (node && !topicSectionRefs.current[key]) {
                                                            topicSectionRefs.current[key] = node;
                                                        }
                                                    }}
                                                    className={`detail-subtle-card ${selectedTopicKey === normalizeTopicKey(section.topic ?? '') ? 'topic-chip-active' : ''}`}
                                                >
                                                    <h4 className="font-semibold text-foreground">{section.topic}</h4>
                                                    <p className="mt-2 text-sm leading-relaxed text-foreground">{section.summary}</p>
                                                    {!!section.evidence?.length && (
                                                        <ul className="detail-list mt-3">
                                                            {section.evidence.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{item}</li>)}
                                                        </ul>
                                                    )}
                                                </article>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="detail-inline-note">
                                            {isFiltering
                                                ? '검색과 일치하는 주제별 정리가 없습니다.'
                                                : '주제별 정리 내용이 없습니다. 대화록을 확인해 주세요.'}
                                        </div>
                                    )}
                                </section>
                            )}

                            {(!!visibleSpeakerSummaries.length || hasCompletedEmptySpeakerContext) && (
                                <section ref={speakerSummarySectionRef}>
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <h3 className="section-title">참석자별 정리</h3>
                                            <button
                                                type="button"
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                                                title="화자 구분을 기준으로 정리한 내용입니다. 이름과 역할은 확인해 주세요."
                                                aria-label="참석자별 정리 도움말"
                                            >
                                                <CircleHelp size={16} />
                                            </button>
                                        </div>
                                        <IconButton
                                            variant="outline"
                                            icon={<Edit3 size={16} />}
                                            onClick={openSpeakerLabelEditor}
                                            aria-label="이름 연결"
                                            title="이름 연결"
                                        />
                                    </div>
                                    {filteredSpeakerSummaries.length ? (
                                        <>
                                            {filteredSpeakerSummaries.length > 1 && (
                                                <div className="mb-3 flex flex-wrap gap-2">
                                                    <button
                                                        type="button"
                                                        className={`topic-chip ${selectedSpeakerSummaryKey === 'all' ? 'topic-chip-active' : ''}`}
                                                        onClick={() => setSelectedSpeakerSummaryKey('all')}
                                                    >
                                                        전체
                                                    </button>
                                                    {filteredSpeakerSummaries.map(item => (
                                                        <button
                                                            key={item.key}
                                                            type="button"
                                                            className={`topic-chip ${selectedSpeakerSummaryKey === item.key ? 'topic-chip-active' : ''}`}
                                                            onClick={() => setSelectedSpeakerSummaryKey(item.key)}
                                                        >
                                                            {item.name}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="grid gap-3">
                                                {visibleSpeakerSummaries.map(item => (
                                                    <article key={item.key} className="detail-subtle-card">
                                                        <button
                                                            type="button"
                                                            className="flex w-full items-start justify-between gap-3 text-left"
                                                            onClick={() => setCollapsedSpeakerSummaryKeys(current => ({
                                                                ...current,
                                                                [item.key]: !current[item.key],
                                                            }))}
                                                            aria-expanded={!collapsedSpeakerSummaryKeys[item.key]}
                                                        >
                                                            <div>
                                                                <h4 className="font-semibold text-foreground">{item.name}</h4>
                                                            </div>
                                                            <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true">
                                                                {collapsedSpeakerSummaryKeys[item.key] ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                                                            </span>
                                                        </button>
                                                        {!collapsedSpeakerSummaryKeys[item.key] && (
                                                            <>
                                                                <p className="mt-2 text-sm leading-relaxed text-foreground">{item.summary}</p>
                                                                {!!item.keyPoints.length && (
                                                                    <ul className="detail-list mt-3">
                                                                        {item.keyPoints.map((point, pointIndex) => <li key={`${point}-${pointIndex}`}>{point}</li>)}
                                                                    </ul>
                                                                )}
                                                            </>
                                                        )}
                                                    </article>
                                                ))}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="detail-inline-note">
                                            {isFiltering
                                                ? '검색과 일치하는 참석자별 정리가 없습니다.'
                                                : '참석자별 정리 내용이 없습니다. 화자 구분을 확인해 주세요.'}
                                        </div>
                                    )}
                                </section>
                            )}

                        </>
                    )}

                    {detailTab === 'script' && (
                        <section>
                            <div className="mb-4 flex flex-col gap-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <h3 className="section-title">대화록</h3>
                                    <div className="flex flex-wrap gap-2">
                                        {!!selectedMeeting.editedDisplaySegments?.length && !isTranscriptEditing && (
                                            <Button variant="outline" onClick={handleRevertTranscript}>
                                                원본 복원
                                            </Button>
                                        )}
                                        {isTranscriptEditing ? (
                                            <>
                                                <Button onClick={handleSaveTranscriptEdit}>
                                                    <Save size={15} />
                                                    수정본 저장
                                                </Button>
                                                <Button variant="outline" onClick={handleCancelTranscriptEdit}>
                                                    취소
                                                </Button>
                                            </>
                                        ) : (
                                            <Button variant="outline" onClick={handleStartTranscriptEdit} disabled={!displaySegments.length}>
                                                <Edit3 size={15} />
                                                대화록 편집
                                            </Button>
                                        )}
                                        {!!speakersInTranscript.length && (
                                            <Button variant="outline" onClick={handleSaveSpeakerLabels} disabled={!hasSpeakerLabelChanges}>
                                                <Save size={15} />
                                                이름 저장
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                {!!selectedMeeting.editedDisplaySegments?.length && !isTranscriptEditing && (
                                    <div className="detail-inline-note">
                                        현재 화면은 수정본 대화록입니다. 원본은 별도로 보존됩니다.
                                    </div>
                                )}
                                {!!speakersInTranscript.length && (
                                    <div ref={speakerLabelsPanelRef} className="grid gap-2 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-2">
                                        <div className="sm:col-span-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                                            <span>이름을 연결하면 대화록과 참석자별 정리에 반영됩니다.</span>
                                            {hasSpeakerLabelChanges && <span className="font-medium text-foreground">저장되지 않은 변경</span>}
                                        </div>
                                        {speakersInTranscript.map((speaker, index) => (
                                            <label key={speaker} className="grid gap-1 text-xs font-medium text-muted-foreground">
                                                <span className="flex items-center gap-2">
                                                    <span className={`speaker-dot ${getSpeakerTone(speaker, index)}`} />
                                                    {speaker}
                                                </span>
                                                <Input
                                                    value={speakerLabelDrafts[speaker] ?? ''}
                                                    placeholder="이름 입력"
                                                    aria-label={`${speaker} 이름`}
                                                    onChange={event => setSpeakerLabelDrafts(prev => ({
                                                        ...prev,
                                                        [speaker]: event.target.value,
                                                    }))}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {(isTranscriptEditing ? transcriptSegmentDrafts.length : visibleSegments.length) ? (
                                <div className="space-y-2">
                                    {(isTranscriptEditing ? transcriptSegmentDrafts : visibleSegments).map((segment, index) => {
                                        const warning = looksLikeKoreanMisrecognition(segment.text);
                                        return (
                                            <article key={`${segment.start}-${index}`} className={`script-row ${warning ? 'script-row-warning' : ''}`}>
                                                <div className="script-meta">
                                                    <span className={`speaker-dot ${getSpeakerTone(segment.speaker, index)}`} />
                                                    <span className="font-semibold text-foreground">{segment.displaySpeaker || segment.speaker || '화자'}</span>
                                                    <span>{segment.start} - {segment.end}</span>
                                                    {segment.timingApproximate && <span className="script-badge">시간 추정</span>}
                                                </div>
                                                {isTranscriptEditing ? (
                                                    <textarea
                                                        value={segment.text}
                                                        onChange={event => handleTranscriptDraftChange(index, event.target.value)}
                                                        className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition focus:ring-2 focus:ring-primary/30"
                                                        aria-label={`${segment.displaySpeaker || segment.speaker || '화자'} 대화록 수정`}
                                                    />
                                                ) : (
                                                    <p className="script-text">{segment.text}</p>
                                                )}
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
