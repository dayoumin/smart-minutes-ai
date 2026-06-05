import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CircleHelp, Copy, Edit3, FileAudio, Loader2, Pause, Play, Save, Search, Square, X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { getAllMeetings, getMeetingById, MeetingRecord, MeetingSegment, MeetingSpeakerContextSummary, MeetingTopicSection, updateMeeting } from './meetingRepository';
import { isTauriRuntime, openSavedFileLocation, toApiUrl } from './apiBase';
import { Input } from './Input';
import { StatusBanner } from './StatusBanner';
import { MeetingDownloadControl } from './MeetingDownloadControl';
import { ProgressBar } from './ProgressBar';
import { formatAnalysisDuration } from './analysisTimeEstimate';
import {
    canGenerateSpeakerContext as canGenerateSpeakerContextFromState,
    getSpeakerGenerationStatus,
    getSummaryGenerationStatus,
    getTopicGenerationStatus,
    normalizeGenerationStatus,
} from './meetingGeneration';
import { getTopicGenerationUiState, TopicGenerationIntent } from './topicGenerationUi';

interface MeetingHistoryProps {
    selectedMeetingId?: string | null;
    onCreateMeeting?: () => void;
    onSelectMeetingId?: (id: string | null) => void;
    onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
    onOpenSettings?: () => void;
}

type DetailTab = 'summary' | 'script';
type OrganizeTab = 'summary' | 'topics' | 'speakers';
type GenerationKind = 'diarization' | 'summary' | 'topicSections' | 'speakerContextSummaries';
type AudioAvailability = 'idle' | 'checking' | 'available' | 'missing';
type DiarizationStopAction = 'cancel' | 'defer';

const getCurrentTimeMs = (): number => Date.now();

interface SpeakerContributionStats {
    turnCount: number;
    charCount: number;
    sharePercent: number;
}

interface TopicGenerationRequestIntent {
    meetingId: string;
    intent: TopicGenerationIntent;
}

interface SavedFileToast {
    id: number;
    path: string | null;
}

interface OperationToast {
    id: number;
    message: string;
    tone: 'warning' | 'neutral' | 'error';
}

interface ModelsStatusResponse {
    summary_ready?: boolean;
    summary_message?: string;
}

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
    topic_section?: MeetingTopicSection;
    topicSection?: MeetingTopicSection;
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

interface GenerateDiarizationResponse {
    segments?: MeetingSegment[];
    display_segments?: MeetingSegment[];
    displaySegments?: MeetingSegment[];
    diarization_applied?: boolean;
    diarizationApplied?: boolean;
    diarization_requested?: boolean;
    diarizationRequested?: boolean;
    diarization_skipped?: boolean;
    diarizationSkipped?: boolean;
    diarization_deferred?: boolean;
    diarizationDeferred?: boolean;
    generation_status?: MeetingRecord['generationStatus'];
    generationStatus?: MeetingRecord['generationStatus'];
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    participant_summaries?: MeetingRecord['participantSummaries'];
    participantSummaries?: MeetingRecord['participantSummaries'];
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

interface GenerationProgressResponse {
    active?: boolean;
    progress?: number;
    message?: string;
    status?: 'idle' | 'processing' | 'completed' | 'failed' | string;
    action?: DiarizationStopAction;
    started_at?: string;
    updated_at?: string;
}

interface StopDiarizationResponse {
    accepted?: boolean;
    active?: boolean;
    running?: boolean;
    status?: string;
    action?: DiarizationStopAction;
    message?: string;
}

interface SyncOutputRecordResponse {
    outputs?: MeetingRecord['outputFiles'];
    export_error?: string | null;
}

const isStaleGenerationMessage = (message: string): boolean => (
    message.includes('이번 결과는 저장하지 않았습니다')
    || message.includes('주제별 정리를 저장하지 않았습니다')
    || message.includes('참석자별 정리를 저장하지 않았습니다')
);

const isGuidanceNeedsCheckItem = (message: string): boolean => (
    message.includes('정리는 회의 기록에서 별도로 실행')
    || message.includes('필요한 정리를 선택해서 실행')
);

const defaultParticipantLabel = (value: string): string => {
    const label = String(value || '').trim();
    const speakerNumber = label.match(/^SPEAKER[_\s-]?(\d+)$/i);
    if (speakerNumber) return `참석자${String(Number(speakerNumber[1]) + 1).padStart(2, '0')}`;
    const legacyKoreanNumber = label.match(/^화자(\d+)$/);
    if (legacyKoreanNumber) {
        const [, digits] = legacyKoreanNumber;
        const parsed = Number(digits);
        const participantNumber = digits.length >= 2 ? parsed + 1 : Math.max(1, parsed);
        return `참석자${String(participantNumber).padStart(2, '0')}`;
    }
    return label || '참석자';
};

const toParticipantCopy = (value: string): string => value
    .replaceAll('발화자 구분', '참석자 구분')
    .replaceAll('화자 분리', '참석자 구분')
    .replaceAll('화자 구분', '참석자 구분')
    .replaceAll('화자별', '참석자별')
    .replaceAll('화자 라벨', '자동 참석자 라벨')
    .replaceAll('발화자', '참석자')
    .replaceAll('발언자', '참석자')
    .replace(/화자\d+/g, match => defaultParticipantLabel(match))
    .replaceAll('회의 기록에서', '기록 정리에서');

const getFallbackDiarizationProgressPercent = (elapsedMs: number): number => {
    if (elapsedMs <= 0) return 3;
    const elapsedMinutes = elapsedMs / 60_000;
    const easedProgress = 1 - Math.exp(-elapsedMinutes / 3);
    return Math.min(92, Math.max(3, Math.round(8 + easedProgress * 84)));
};

const formatDiarizationRemainingEstimate = (
    elapsedMs: number,
    progressPercent: number,
    status?: string,
): string => {
    if (status === 'stopping') return '중지 중';
    if (progressPercent >= 99) return '곧 완료';
    if (elapsedMs < 5_000 || progressPercent < 10) return '측정 중';

    const estimatedTotalMs = elapsedMs / (Math.max(1, progressPercent) / 100);
    const remainingMs = Math.max(0, estimatedTotalMs - elapsedMs);
    if (remainingMs < 15_000) return '곧 완료';
    return `약 ${formatAnalysisDuration(remainingMs)}`;
};

const formatDiarizationProgressMessage = (message: string): string => {
    const normalized = toParticipantCopy(message.trim());
    const statusMap: Record<string, string> = {
        '준비 중': '참석자 구분 준비 중',
        diarization_resource_limit: '음성 파일이 너무 길거나 커서 참석자 구분을 실행하지 않았습니다.',
        diarization_model_not_ready: '참석자 구분 모델이 준비되지 않았습니다.',
        audio_required_for_diarization: '참석자 구분에 필요한 원본 음성을 찾지 못했습니다.',
        diarization_runtime_error: '참석자 구분 실행 중 오류가 발생했습니다.',
    };
    return statusMap[normalized] || normalized || '참석자 구분 중';
};

const parseGenerationStartedAt = (value?: string): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
};

const speakerToneCount = 6;

interface GenerationErrorInfo {
    message: string;
    detail?: string;
}

interface GenerationRequestError extends Error {
    detail?: string;
}

const getGenerationErrorInfo = async (response: Response, fallback: string): Promise<GenerationErrorInfo> => {
    const body = await response.text().catch(() => '');
    if (!body) return { message: fallback };

    try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail === 'Output result not found') {
            return { message: '분석 원본을 찾지 못했습니다. 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'Transcript segments are required') {
            return { message: '대화록이 없어 정리할 수 없습니다. 다시 분석해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'summary_input_changed') {
            return { message: '대화록이 바뀌어 이번 정리는 저장하지 않았습니다. 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'summary_model_not_ready') {
            return { message: '요약 AI가 준비되지 않았습니다. 대화록은 사용할 수 있고, 요약은 Ollama 모델을 준비한 뒤 다시 실행해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'topic_input_changed') {
            return { message: '대화록이나 요약이 바뀌어 주제별 정리를 저장하지 않았습니다. 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'speaker_input_changed') {
            return { message: '대화록이나 주제별 정리가 바뀌어 참석자별 정리를 저장하지 않았습니다. 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'topic_generation_empty') {
            return { message: '주제별 정리 결과가 비어 있습니다. 요약 내용을 확인한 뒤 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'speaker_context_generation_empty') {
            return { message: '참석자별 정리 결과가 비어 있습니다. 주제별 정리와 대화록을 확인한 뒤 다시 정리해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'audio_required_for_diarization') {
            return { message: '참석자 구분에 필요한 원본 음성을 찾지 못했습니다. 다시 분석해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'diarization_model_not_ready') {
            return { message: '참석자 구분 모델이 준비되지 않았습니다. models 폴더를 확인해 주세요.', detail: parsed.detail };
        }
        if (parsed.detail === 'diarization_resource_limit') {
            return { message: '음성 파일이 너무 길거나 커서 참석자 구분을 실행하지 않았습니다. 대화록은 그대로 사용할 수 있습니다.', detail: parsed.detail };
        }
        if (parsed.detail === 'diarization_already_completed') {
            return { message: '이미 참석자 구분이 완료된 대화록입니다.', detail: parsed.detail };
        }
        if (parsed.detail === 'diarization generation is already running') {
            return { message: '참석자 구분이 이미 진행 중입니다.', detail: parsed.detail };
        }
        if (parsed.detail === 'diarization_runtime_error') {
            return { message: '참석자 구분 실행 중 오류가 발생했습니다. 원본 음성과 참석자 구분 모델 상태를 확인한 뒤 다시 실행해 주세요.', detail: parsed.detail };
        }
        return { message: parsed.detail || fallback, detail: parsed.detail };
    } catch {
        return { message: body || fallback };
    }
};

const getGenerationErrorMessage = async (response: Response, fallback: string): Promise<string> => {
    const errorInfo = await getGenerationErrorInfo(response, fallback);
    return errorInfo.message;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlightSearchText = (text: string, query: string): React.ReactNode => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return text;

    const queryPattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'gi');
    const lowerQuery = trimmedQuery.toLowerCase();
    return text.split(queryPattern).map((part, index) => (
        part.toLowerCase() === lowerQuery
            ? <mark key={`${part}-${index}`} className="search-highlight">{part}</mark>
            : part
    ));
};

interface InlineStateNoteProps {
    children: React.ReactNode;
    className?: string;
}

const InlineStateNote = ({ children, className = '' }: InlineStateNoteProps) => (
    <div className={`detail-inline-note ${className}`}>{children}</div>
);

interface DetailHelpButtonProps {
    title: string;
    ariaLabel: string;
}

const DetailHelpButton = ({ title, ariaLabel }: DetailHelpButtonProps) => (
    <span
        className="detail-help-button"
        title={title}
        aria-label={`${ariaLabel}: ${title}`}
        role="img"
    >
        <CircleHelp size={16} />
    </span>
);

interface DetailTabButtonProps {
    active: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
    children: React.ReactNode;
}

const DetailTabButton = ({ active, disabled = false, title, onClick, children }: DetailTabButtonProps) => (
    <button
        type="button"
        aria-pressed={active}
        aria-disabled={disabled || undefined}
        className={`tab-button ${active ? 'tab-button-active' : ''}`}
        disabled={disabled}
        onClick={onClick}
        title={title}
    >
        {children}
    </button>
);

interface OrganizeRunButtonProps {
    ariaLabel: string;
    title: string;
    disabled: boolean;
    icon: React.ReactNode;
    label: string;
    className?: string;
    onClick: () => void | Promise<void>;
}

const OrganizeRunButton = ({
    ariaLabel,
    title,
    disabled,
    icon,
    label,
    className = '',
    onClick,
}: OrganizeRunButtonProps) => (
    <Button
        variant="outline"
        className={`detail-action-button ${className}`}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => { void onClick(); }}
        title={title}
    >
        {icon}
        {label}
    </Button>
);

interface SpeakerLabelPanelProps {
    panelRef: React.RefObject<HTMLDivElement | null>;
    speakers: string[];
    drafts: Record<string, string>;
    hasChanges: boolean;
    getTone: (speaker: string, index: number) => string;
    getName: (speaker: string) => string;
    onChange: (speaker: string, value: string) => void;
    onSave: () => void | Promise<void>;
    onClear: (speaker: string) => void;
}

const SpeakerLabelPanel = ({
    panelRef,
    speakers,
    drafts,
    hasChanges,
    getTone,
    getName,
    onChange,
    onSave,
    onClear,
}: SpeakerLabelPanelProps) => (
    <div ref={panelRef} className="speaker-label-panel">
        {hasChanges && (
            <div className="speaker-label-panel-header">
                <span className="font-medium text-foreground">저장되지 않은 변경</span>
            </div>
        )}
        {speakers.map((speaker, index) => {
            const speakerDraft = drafts[speaker] ?? '';
            const hasSpeakerLabelInput = Boolean(speakerDraft.trim());
            const speakerName = getName(speaker);
            return (
                <label key={speaker} className="speaker-label-field">
                    <span className="speaker-label-field-title">
                        <span className={`speaker-dot ${getTone(speaker, index)}`} />
                        {speakerName}
                    </span>
                    <div className="relative">
                        <Input
                            value={speakerDraft}
                            aria-label={`${speakerName} 이름`}
                            className={hasSpeakerLabelInput ? 'speaker-label-input' : ''}
                            onChange={event => onChange(speaker, event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void onSave();
                                }
                            }}
                        />
                        {hasSpeakerLabelInput && (
                            <div className="absolute inset-y-1 right-1 flex items-center gap-1">
                                <button
                                    type="button"
                                    className="speaker-label-input-action"
                                    title="이름 저장"
                                    aria-label={`${speakerName} 이름 저장`}
                                    onClick={() => { void onSave(); }}
                                    disabled={!hasChanges}
                                >
                                    ↵
                                </button>
                                <button
                                    type="button"
                                    className="speaker-label-input-action"
                                    title="입력 지우기"
                                    aria-label={`${speakerName} 이름 입력 지우기`}
                                    onClick={() => onClear(speaker)}
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        )}
                    </div>
                </label>
            );
        })}
    </div>
);

const getSpeakerTone = (speaker: string, index: number): string => {
    const match = speaker.match(/(\d+)/);
    const speakerIndex = match
        ? Number.parseInt(match[1], 10)
        : speaker.trim()
            ? Array.from(speaker).reduce((sum, char) => sum + char.charCodeAt(0), 0)
            : index;
    return `speaker-tone-${speakerIndex % speakerToneCount}`;
};

const getSegmentSpeakerTone = (segment: MeetingSegment, index: number): string => (
    getSpeakerTone(segment.displaySpeaker || segment.speaker || '', index)
);

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

const formatEditableTranscript = (segments: MeetingSegment[]): string => (
    normalizeTranscriptDrafts(segments)
        .map(segment => {
            const speaker = String(segment.displaySpeaker || segment.speaker || '참석자').trim() || '참석자';
            return `${speaker}: ${segment.text}`;
        })
        .join('\n')
);

const copyTextToClipboard = async (text: string): Promise<void> => {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // Fall back below for desktop runtimes that block Clipboard API access.
        }
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (!copied) throw new Error('Clipboard copy failed');
};

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

export const MeetingHistory: React.FC<MeetingHistoryProps> = ({ selectedMeetingId, onCreateMeeting, onSelectMeetingId, onRegisterLeaveGuard, onOpenSettings }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [noticeMessage, setNoticeMessage] = useState('');
    const [savedFileToast, setSavedFileToast] = useState<SavedFileToast | null>(null);
    const [operationToast, setOperationToast] = useState<OperationToast | null>(null);
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [detailTab, setDetailTab] = useState<DetailTab>('script');
    const [organizeTab, setOrganizeTab] = useState<OrganizeTab>('summary');
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
    const [topicGenerationIntent, setTopicGenerationIntent] = useState<TopicGenerationRequestIntent | null>(null);
    const [diarizationStartedAt, setDiarizationStartedAt] = useState<number | null>(null);
    const [diarizationNow, setDiarizationNow] = useState(getCurrentTimeMs);
    const [diarizationProgress, setDiarizationProgress] = useState<GenerationProgressResponse | null>(null);
    const [diarizationProgressJobId, setDiarizationProgressJobId] = useState<string | null>(null);
    const [isDiarizationStopConfirmOpen, setIsDiarizationStopConfirmOpen] = useState(false);
    const [isStoppingDiarization, setIsStoppingDiarization] = useState(false);
    const [stoppingDiarizationAction, setStoppingDiarizationAction] = useState<DiarizationStopAction | null>(null);
    const [customTopicTitle, setCustomTopicTitle] = useState('');
    const [selectedTopicKey, setSelectedTopicKey] = useState<string | null>(null);
    const [selectedSpeakerSummaryKey, setSelectedSpeakerSummaryKey] = useState<string>('all');
    const [collapsedSpeakerSummaryKeys, setCollapsedSpeakerSummaryKeys] = useState<Record<string, boolean>>({});
    const [summaryModelReady, setSummaryModelReady] = useState<boolean | null>(null);
    const [summaryModelMessage, setSummaryModelMessage] = useState('');
    const [isSpeakerLabelPanelOpen, setIsSpeakerLabelPanelOpen] = useState(false);
    const currentSelectedMeetingIdRef = useRef<string | null>(null);
    const selectedMeetingRef = useRef<MeetingRecord | null>(null);
    const recordsRef = useRef<MeetingRecord[]>([]);
    const meetingUpdateQueuesRef = useRef<Record<string, Promise<void>>>({});
    const hydratedMeetingIdRef = useRef<string | null>(null);
    const canLeaveMeetingRef = useRef<(nextMeetingId: string | null) => boolean>(() => true);
    const diarizationProgressJobIdRef = useRef<string | null>(null);
    const diarizationAbortControllerRef = useRef<AbortController | null>(null);
    const diarizationStopActionRef = useRef<DiarizationStopAction | null>(null);
    const diarizationFailureToastKeyRef = useRef<string | null>(null);
    const topicSectionRefs = useRef<Record<string, HTMLElement | null>>({});
    const topicSectionsSectionRef = useRef<HTMLDivElement | null>(null);
    const speakerSummarySectionRef = useRef<HTMLDivElement | null>(null);
    const speakerLabelsPanelRef = useRef<HTMLDivElement | null>(null);

    const normalizeTopicKey = React.useCallback((value: string) => value.trim().toLocaleLowerCase(), []);

    const showSavedFileToast = React.useCallback((path: string | null) => {
        setSavedFileToast({
            id: getCurrentTimeMs(),
            path,
        });
    }, []);

    const showOperationToast = React.useCallback((message: string, tone: OperationToast['tone'] = 'neutral') => {
        setOperationToast({
            id: getCurrentTimeMs(),
            message,
            tone,
        });
    }, []);

    const handleOpenSavedFileLocation = async () => {
        if (!savedFileToast?.path) return;
        try {
            await openSavedFileLocation(savedFileToast.path);
            setSavedFileToast(null);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : '저장 폴더를 열지 못했습니다.');
        }
    };

    useEffect(() => {
        if (!savedFileToast) return undefined;
        const timeoutId = window.setTimeout(() => setSavedFileToast(null), 3500);
        return () => window.clearTimeout(timeoutId);
    }, [savedFileToast]);

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
        setDetailTab('script');
        setIsEditing(false);
        setIsTranscriptEditing(false);
        setTranscriptSegmentDrafts([]);
        setNoticeMessage('');
        setSearchQuery('');
        setSelectedTopicKey(null);
        setSelectedSpeakerSummaryKey('all');
        setCollapsedSpeakerSummaryKeys({});
        setIsSpeakerLabelPanelOpen(false);
        setIsDiarizationStopConfirmOpen(false);
    }, [selectedMeeting?.id]);

    useEffect(() => {
        let cancelled = false;
        const loadSummaryModelStatus = async () => {
            try {
                const response = await fetch(await toApiUrl('/api/models/status'));
                if (!response.ok) throw new Error(`models=${response.status}`);
                const payload = await response.json() as ModelsStatusResponse;
                if (cancelled) return;
                setSummaryModelReady(Boolean(payload.summary_ready));
                setSummaryModelMessage(payload.summary_message || '');
            } catch {
                if (cancelled) return;
                setSummaryModelReady(null);
                setSummaryModelMessage('');
            }
        };
        const syncSummaryModelStatus = () => {
            void loadSummaryModelStatus();
        };

        syncSummaryModelStatus();
        window.addEventListener('focus', syncSummaryModelStatus);
        window.addEventListener('analysis:settings-updated', syncSummaryModelStatus);
        return () => {
            cancelled = true;
            window.removeEventListener('focus', syncSummaryModelStatus);
            window.removeEventListener('analysis:settings-updated', syncSummaryModelStatus);
        };
    }, []);

    useEffect(() => {
        selectedMeetingRef.current = selectedMeeting;
    }, [selectedMeeting]);

    useEffect(() => {
        diarizationProgressJobIdRef.current = diarizationProgressJobId;
    }, [diarizationProgressJobId]);

    useEffect(() => {
        if (generatingKind !== 'diarization' && !diarizationProgress?.active) return undefined;
        setDiarizationNow(getCurrentTimeMs());
        const timerId = window.setInterval(() => setDiarizationNow(getCurrentTimeMs()), 1000);
        return () => window.clearInterval(timerId);
    }, [diarizationProgress?.active, generatingKind]);

    useEffect(() => {
        if (!selectedMeeting?.jobId || selectedMeeting.diarizationApplied) return undefined;

        let cancelled = false;
        const jobId = selectedMeeting.jobId;
        const loadDiarizationProgress = async () => {
            try {
                const progressUrl = await toApiUrl(`/api/outputs/${encodeURIComponent(jobId)}/generation-progress/diarization`);
                const response = await fetch(progressUrl);
                if (!response.ok) return;
                const payload = await response.json() as GenerationProgressResponse;
                if (!cancelled && payload.active) {
                    setDiarizationProgressJobId(jobId);
                    setDiarizationProgress(payload);
                    setDiarizationStartedAt(parseGenerationStartedAt(payload.started_at) ?? getCurrentTimeMs());
                }
            } catch {
                // Older backends will simply keep the local elapsed-time fallback visible.
            }
        };

        void loadDiarizationProgress();
        return () => {
            cancelled = true;
        };
    }, [selectedMeeting?.diarizationApplied, selectedMeeting?.jobId]);

    useEffect(() => {
        const jobId = diarizationProgressJobId;
        const shouldPoll = Boolean(jobId && (generatingKind === 'diarization' || diarizationProgress?.active));
        if (!jobId || !shouldPoll) return undefined;

        let cancelled = false;
        let inFlight = false;
        const loadDiarizationProgress = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const progressUrl = await toApiUrl(`/api/outputs/${encodeURIComponent(jobId)}/generation-progress/diarization`);
                const response = await fetch(progressUrl);
                if (!response.ok) return;
                const payload = await response.json() as GenerationProgressResponse;
                if (cancelled) return;
                const startedAt = parseGenerationStartedAt(payload.started_at);
                if (startedAt) {
                    setDiarizationStartedAt(current => current ?? startedAt);
                }
                setDiarizationProgress(current => {
                    const currentProgress = typeof current?.progress === 'number' ? current.progress : 0;
                    const nextProgress = typeof payload.progress === 'number' ? payload.progress : currentProgress;
                    if (payload.active && nextProgress < currentProgress) {
                        return current;
                    }
                    return {
                        ...payload,
                        progress: nextProgress,
                        action: payload.action ?? current?.action,
                    };
                });
                if (payload.status === 'failed') {
                    const failureKey = `${jobId}:${payload.updated_at ?? payload.message ?? 'failed'}`;
                    if (diarizationFailureToastKeyRef.current !== failureKey) {
                        diarizationFailureToastKeyRef.current = failureKey;
                        const message = payload.message || '참석자 구분 중 오류가 발생했습니다. 다시 실행해 주세요.';
                        showOperationToast(message, 'error');
                        setErrorMessage(message);
                    }
                }
            } catch {
                // Older backends will simply keep the local elapsed-time fallback visible.
            } finally {
                inFlight = false;
            }
        };

        void loadDiarizationProgress();
        const timerId = window.setInterval(() => {
            void loadDiarizationProgress();
        }, 1500);
        return () => {
            cancelled = true;
            window.clearInterval(timerId);
        };
    }, [diarizationProgress?.active, diarizationProgressJobId, generatingKind, showOperationToast]);

    useEffect(() => {
        if (noticeMessage === '참석자 이름을 저장했습니다.') {
            setNoticeMessage('');
        }
    }, [noticeMessage]);

    useEffect(() => {
        if (!operationToast) return undefined;
        const timerId = window.setTimeout(() => {
            setOperationToast(current => (current?.id === operationToast.id ? null : current));
        }, 5000);
        return () => window.clearTimeout(timerId);
    }, [operationToast]);

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
            const data = await response.json().catch(() => null) as { saved_path?: string | null } | null;
            showSavedFileToast(data?.saved_path ?? null);
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
            const syncMessage = await syncMeetingOutputRecordSafely(targetMeetingId, targetJobId);
            if (syncMessage && currentSelectedMeetingIdRef.current === targetMeetingId) {
                setErrorMessage(syncMessage);
            }
        } catch (error) {
            setNoticeMessage('');
            setErrorMessage(error instanceof Error ? error.message : '참석자 이름을 저장하지 못했습니다.');
        }
    };

    const handleClearSpeakerLabel = (speaker: string) => {
        setSpeakerLabelDrafts(prev => ({
            ...prev,
            [speaker]: '',
        }));
    };

    const handleCancelSpeakerLabelEdit = () => {
        setSpeakerLabelDrafts(selectedMeeting?.speakerLabels ?? {});
        setIsSpeakerLabelPanelOpen(false);
    };

    const handleGenerateDiarization = async () => {
        if (generatingKind !== null) return;
        if (!ensureNoUnsavedDraftChanges('참석자 구분 실행')) return;
        if (!canGenerateDiarization || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(hasTranscriptData ? '분석 원본이 있어야 참석자 구분을 실행할 수 있습니다.' : '대화록이 있어야 참석자 구분을 실행할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const abortController = new AbortController();
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setOperationToast(null);
            setIsDiarizationStopConfirmOpen(false);
            diarizationStopActionRef.current = null;
            diarizationFailureToastKeyRef.current = null;
            diarizationAbortControllerRef.current = abortController;
            const startedAt = getCurrentTimeMs();
            setDiarizationStartedAt(startedAt);
            setDiarizationNow(startedAt);
            diarizationProgressJobIdRef.current = targetJobId;
            setDiarizationProgressJobId(targetJobId);
            setDiarizationProgress({
                active: true,
                progress: 0,
                message: '참석자 구분 준비 중',
                status: 'processing',
            });
            setGeneratingKind('diarization');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-diarization`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(targetMeeting),
                signal: abortController.signal,
            });
            if (!response.ok) {
                const errorInfo = await getGenerationErrorInfo(response, '참석자 구분을 실행하지 못했습니다.');
                const requestError = new Error(errorInfo.message) as GenerationRequestError;
                requestError.detail = errorInfo.detail;
                throw requestError;
            }

            const data = await response.json() as GenerateDiarizationResponse;
            if (diarizationProgressJobIdRef.current === targetJobId) {
                setDiarizationNow(getCurrentTimeMs());
                setDiarizationProgress({
                    active: false,
                    progress: 100,
                    message: '참석자 구분 완료',
                    status: 'completed',
                });
            }
            await updateSelectedMeeting(currentMeeting => ({
                segments: data.segments ?? currentMeeting.segments,
                displaySegments: data.displaySegments ?? data.display_segments ?? currentMeeting.displaySegments,
                diarizationApplied: data.diarizationApplied ?? data.diarization_applied ?? true,
                diarizationRequested: data.diarizationRequested ?? data.diarization_requested ?? true,
                diarizationSkipped: data.diarizationSkipped ?? data.diarization_skipped ?? false,
                diarizationDeferred: data.diarizationDeferred ?? data.diarization_deferred ?? false,
                diarizationSkipMessage: '',
                diarizationSkipReason: '',
                diarizationDeferMessage: '',
                speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? currentMeeting.speakerContextSummaries,
                participantSummaries: data.participantSummaries ?? data.participant_summaries ?? currentMeeting.participantSummaries,
                generationStatus: data.generationStatus ?? data.generation_status ?? currentMeeting.generationStatus,
                transcriptEditMeta: {
                    ...(currentMeeting.transcriptEditMeta ?? {}),
                    speakerContextOutdated: Boolean(currentMeeting.speakerContextSummaries?.length || currentMeeting.participantSummaries?.length),
                },
                outputFiles: data.outputs ?? currentMeeting.outputFiles,
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setDetailTab('script');
                setNoticeMessage(data.export_error || '참석자 구분을 완료했습니다.');
            }
        } catch (error) {
            const isAbortError = error instanceof DOMException
                ? error.name === 'AbortError'
                : error instanceof Error && error.name === 'AbortError';
            if (isAbortError && diarizationStopActionRef.current) {
                return;
            }
            if (diarizationProgressJobIdRef.current === targetJobId) {
                setDiarizationNow(getCurrentTimeMs());
                const message = error instanceof Error ? error.message : '참석자 구분 실행 중 오류가 발생했습니다.';
                const detail = error instanceof Error ? (error as GenerationRequestError).detail : undefined;
                if (detail === 'audio_required_for_diarization') {
                    setAudioSourceUrl('');
                    setAudioAvailability('missing');
                }
                setDiarizationProgress(current => ({
                    ...(current ?? {}),
                    active: false,
                    message,
                    status: 'failed',
                }));
                showOperationToast(message, 'error');
            }
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
                setErrorMessage(error instanceof Error ? error.message : '참석자 구분을 실행하지 못했습니다.');
            }
        } finally {
            if (diarizationAbortControllerRef.current === abortController) {
                diarizationAbortControllerRef.current = null;
            }
            diarizationStopActionRef.current = null;
            setGeneratingKind(null);
        }
    };

    const handleOpenDiarizationStopConfirm = () => {
        setIsDiarizationStopConfirmOpen(true);
        setNoticeMessage('');
        setErrorMessage('');
    };

    const handleStopDiarization = async (action: DiarizationStopAction) => {
        const targetMeeting = selectedMeetingRef.current;
        const targetJobId = diarizationProgressJobIdRef.current ?? targetMeeting?.jobId;
        if (!targetMeeting || !targetJobId) return;

        const finalMessage = action === 'defer'
            ? '참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.'
            : '참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다.';

        try {
            setIsStoppingDiarization(true);
            setStoppingDiarizationAction(action);
            setErrorMessage('');
            diarizationStopActionRef.current = action;
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generation-stop/diarization`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '참석자 구분을 중지하지 못했습니다.'));
            const data = await response.json() as StopDiarizationResponse;

            if (data.accepted === false) {
                setIsDiarizationStopConfirmOpen(false);
                setDiarizationNow(getCurrentTimeMs());
                setDiarizationProgress(current => ({
                    ...(current ?? {}),
                    active: false,
                    progress: current?.progress ?? 0,
                    message: data.message || '진행 중인 참석자 구분이 없습니다.',
                    status: data.status || 'idle',
                }));
                if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                    setNoticeMessage(data.message || '진행 중인 참석자 구분이 없습니다.');
                }
                return;
            }

            diarizationAbortControllerRef.current?.abort();
            setIsDiarizationStopConfirmOpen(false);
            setDiarizationNow(getCurrentTimeMs());
            setDiarizationProgress(current => ({
                ...(current ?? {}),
                active: data.active ?? true,
                progress: current?.progress ?? 0,
                action: data.action ?? action,
                message: data.message || finalMessage,
                status: data.status || 'stopping',
            }));
            await updateSelectedMeeting(currentMeeting => ({
                diarizationApplied: false,
                diarizationRequested: true,
                diarizationSkipped: false,
                diarizationDeferred: action === 'defer',
                diarizationSkipMessage: '',
                diarizationSkipReason: '',
                diarizationDeferMessage: action === 'defer' ? '원본 음성이 남아 있으면 참석자 구분은 나중에 이 회의록에서 다시 실행할 수 있습니다.' : '',
                speakerContextSummaries: [],
                participantSummaries: [],
                generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, { speakerContextSummaries: 'not_started' }),
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                showOperationToast(data.message || finalMessage, 'warning');
            }
        } catch (error) {
            diarizationStopActionRef.current = null;
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
                const message = error instanceof Error ? error.message : '참석자 구분을 중지하지 못했습니다.';
                setErrorMessage(message);
                showOperationToast(message, 'error');
            }
        } finally {
            setIsStoppingDiarization(false);
            setStoppingDiarizationAction(null);
            setGeneratingKind(current => current === 'diarization' ? null : current);
        }
    };

    const handleGenerateSummary = async () => {
        if (generatingKind !== null || summaryGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canRunSummaryGeneration || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(summaryModelUnavailable ? organizeModelGuidanceMessage : hasTranscriptData ? '분석 원본이 있어야 전체 요약을 정리할 수 있습니다.' : '대화록이 있어야 전체 요약을 정리할 수 있습니다.');
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
            setOrganizeTab('summary');
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
    const effectiveStoredDisplaySegments = useMemo(
        () => resolveEffectiveTranscriptSegments(selectedMeeting),
        [selectedMeeting],
    );
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
    const transcriptSpeakerCount = new Set(
        effectiveStoredDisplaySegments
            .map(segment => String(segment.speaker || segment.displaySpeaker || '').trim())
            .filter(Boolean),
    ).size;
    const transcriptLooksSingleSpeaker = hasTranscriptData && transcriptSpeakerCount === 1;
    const summarySkippedForDeferredAnalysis = summaryGenerationStatus === 'skipped'
        && Boolean(selectedMeeting?.summary?.includes('정리는 회의 기록에서 별도로 실행'));
    const diarizationProgressMatchesSelected = Boolean(
        selectedMeeting?.jobId
        && diarizationProgressJobId === selectedMeeting.jobId,
    );
    const diarizationIsRunning = Boolean(
        diarizationProgressMatchesSelected
        && (generatingKind === 'diarization' || diarizationProgress?.active),
    );
    const diarizationStopRequested = Boolean(diarizationIsRunning && diarizationProgress?.status === 'stopping');
    const diarizationStopAction = stoppingDiarizationAction ?? diarizationProgress?.action;
    const diarizationStopLabel = diarizationStopAction === 'cancel' ? '취소 중' : '중지 중';
    const diarizationApplied = selectedMeeting?.diarizationApplied;
    const diarizationNeedsSourceAudio = Boolean(
        selectedMeeting?.jobId
        && hasTranscriptData
        && !diarizationApplied
        && !selectedMeeting?.diarizationSkipped
        && audioAvailability === 'missing',
    );
    const diarizationStatus = (() => {
        if (!hasTranscriptData) return { label: '대기', tone: 'neutral' };
        if (diarizationStopRequested) return { label: diarizationStopLabel, tone: 'warning' };
        if (diarizationIsRunning) return { label: '진행 중', tone: 'info' };
        if (selectedMeeting?.diarizationSkipped) return { label: '제외됨', tone: 'warning' };
        if (diarizationApplied === true) return { label: '완료', tone: 'success' };
        if (diarizationNeedsSourceAudio && transcriptLooksSingleSpeaker) return { label: '표식 1명', tone: 'neutral' };
        if (diarizationNeedsSourceAudio) return { label: '재실행 불가', tone: 'neutral' };
        if (audioAvailability === 'checking') return { label: '확인 중', tone: 'info' };
        if (selectedMeeting?.jobId) return { label: '대기', tone: 'neutral' };
        return { label: '대기', tone: 'neutral' };
    })();
    const diarizationStatusTitle = (() => {
        if (selectedMeeting?.diarizationSkipped) {
            return toParticipantCopy(selectedMeeting.diarizationSkipMessage || '참석자 구분은 제외하고 대화록을 먼저 저장했습니다.');
        }
        if (diarizationNeedsSourceAudio && transcriptLooksSingleSpeaker) {
            return '대화록의 참석자 표식이 1명입니다. 추가 구분이 필요하면 원본 음성을 보관한 상태로 다시 분석해 주세요.';
        }
        if (diarizationNeedsSourceAudio) {
            return '저장된 음성 파일이 없어 참석자 구분을 다시 실행할 수 없습니다.';
        }
        if (selectedMeeting?.diarizationDeferred && !selectedMeeting.diarizationApplied) {
            return toParticipantCopy(selectedMeeting.diarizationDeferMessage || '대화록은 저장되었습니다. 필요할 때 참석자 구분을 실행하세요.');
        }
        return undefined;
    })();
    const canGenerateSummary = Boolean(selectedMeeting?.jobId && hasTranscriptData);
    const canGenerateDiarization = Boolean(
        selectedMeeting?.jobId
        && hasTranscriptData
        && !selectedMeeting?.diarizationApplied
        && !selectedMeeting?.diarizationSkipped
        && audioAvailability === 'available'
    );
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
    const summaryModelUnavailable = summaryModelReady === false
        || (summaryModelReady !== true && summaryGenerationStatus === 'skipped');
    const canOpenOrganizeTab = hasTranscriptData;
    const organizeTabDisabledMessage = !hasTranscriptData
        ? '대화록이 있어야 기록 정리를 사용할 수 있습니다.'
        : '';
    const organizeModelGuidanceMessage = summaryModelMessage || '정리 모델이 준비되면 전체 요약과 주제별 정리를 실행할 수 있습니다.';
    const canRunSummaryGeneration = canGenerateSummary && !summaryModelUnavailable;
    const canRunTopicGeneration = canGenerateTopicSections && !summaryModelUnavailable;
    const canRunSpeakerContextGeneration = canRunTopicGeneration && canCreateSpeakerContext;
    const summaryRegenerationWillResetDerived = Boolean(selectedMeeting?.topicSections?.length || selectedMeeting?.speakerContextSummaries?.length || selectedMeeting?.participantSummaries?.length);

    useEffect(() => {
        if (detailTab !== 'summary' || canOpenOrganizeTab) return;
        setDetailTab('script');
    }, [canOpenOrganizeTab, detailTab]);

    const handleGenerateTopicSections = async () => {
        if (generatingKind !== null || topicGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canRunTopicGeneration || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(summaryModelUnavailable ? organizeModelGuidanceMessage : hasTranscriptData ? '분석 원본이 있어야 주제별 정리를 할 수 있습니다.' : '대화록이 있어야 주제별 정리를 할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const inputFingerprint = buildGenerationInputFingerprint(targetMeeting);
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setTopicGenerationIntent({ meetingId: targetMeeting.id, intent: 'all' });
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
                    speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? [],
                    participantSummaries: data.participantSummaries ?? data.participant_summaries ?? [],
                    generationStatus: data.generationStatus ?? data.generation_status ?? { topicSections: 'completed' },
                    transcriptEditMeta: {
                        ...(currentMeeting.transcriptEditMeta ?? {}),
                        topicSectionsOutdated: false,
                        speakerContextOutdated: false,
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
            setOrganizeTab('topics');
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
            setTopicGenerationIntent(null);
            setGeneratingKind(null);
        }
    };

    const handleGenerateCustomTopicSection = async () => {
        const topicTitle = customTopicTitle.trim();
        if (generatingKind !== null || topicGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!topicTitle) {
            setNoticeMessage('');
            setErrorMessage('추가로 정리할 주제 제목을 입력해 주세요.');
            return;
        }
        if (!canRunTopicGeneration || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(summaryModelUnavailable ? organizeModelGuidanceMessage : hasTranscriptData ? '분석 원본이 있어야 주제별 정리를 할 수 있습니다.' : '대화록이 있어야 주제별 정리를 할 수 있습니다.');
            return;
        }

        const targetMeeting = selectedMeeting;
        const targetJobId = selectedMeeting.jobId;
        const inputFingerprint = buildGenerationInputFingerprint(targetMeeting);
        const hadCompletedTopicSectionsBeforeRequest = getTopicGenerationStatus(targetMeeting.generationStatus, targetMeeting.topicSections) === 'completed'
            && (targetMeeting.topicSections?.filter(section => section.topic?.trim()).length ?? 0) >= 1;
        try {
            setErrorMessage('');
            setNoticeMessage('');
            setTopicGenerationIntent({ meetingId: targetMeeting.id, intent: 'custom' });
            setGeneratingKind('topicSections');
            setLocalGenerationStatus(targetMeeting.id, 'topicSections', 'generating');
            const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(targetJobId)}/generate-topic-section`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...targetMeeting,
                    topicTitle,
                }),
            });
            if (!response.ok) throw new Error(await getGenerationErrorMessage(response, '추가 주제 정리를 만들지 못했습니다.'));

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
                    topicSections: data.topicSections ?? data.topic_sections ?? currentMeeting.topicSections ?? [],
                    speakerContextSummaries: data.speakerContextSummaries ?? data.speaker_context_summaries ?? [],
                    participantSummaries: data.participantSummaries ?? data.participant_summaries ?? [],
                    generationStatus: data.generationStatus ?? data.generation_status ?? { topicSections: 'completed' },
                    transcriptEditMeta: {
                        ...(currentMeeting.transcriptEditMeta ?? {}),
                        topicSectionsOutdated: false,
                        speakerContextOutdated: false,
                    },
                    outputFiles: data.outputs ?? currentMeeting.outputFiles,
                };
            }, targetMeeting.id);
            if (inputChangedBeforeSave) {
                setNoticeMessage('');
                setErrorMessage('회의 정보나 대화록이 바뀌어 이번 추가 주제 정리는 저장하지 않았습니다. 다시 정리해 주세요.');
                return;
            }
            if (searchQuery.trim()) {
                setSearchQuery('');
            }
            setCustomTopicTitle('');
            setSelectedTopicKey(normalizeTopicKey(topicTitle));
            setOrganizeTab('topics');
            setNoticeMessage(`"${topicTitle}" 주제를 추가로 정리했습니다.`);
            if (data.export_error && currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setErrorMessage(data.export_error);
            }
        } catch (error) {
            const nextState = error instanceof Error && isStaleGenerationMessage(error.message) ? 'not_started' : 'failed';
            await updateSelectedMeeting(currentMeeting => ({
                generationStatus: normalizeGenerationStatus(currentMeeting.generationStatus, {
                    topicSections: hadCompletedTopicSectionsBeforeRequest ? 'completed' : nextState,
                }),
            }), targetMeeting.id);
            if (currentSelectedMeetingIdRef.current === targetMeeting.id) {
                setNoticeMessage('');
                setErrorMessage(error instanceof Error ? error.message : '추가 주제 정리 생성 중 오류가 발생했습니다.');
            }
        } finally {
            setTopicGenerationIntent(null);
            setGeneratingKind(null);
        }
    };

    const handleGenerateSpeakerContext = async () => {
        if (generatingKind !== null || speakerGenerationStatus === 'generating') return;
        if (!ensureNoUnsavedDraftChanges('정리 실행')) return;
        if (!canRunTopicGeneration || !selectedMeeting?.jobId) {
            setNoticeMessage('');
            setErrorMessage(summaryModelUnavailable ? organizeModelGuidanceMessage : hasTranscriptData ? '분석 원본이 있어야 참석자별 정리를 할 수 있습니다.' : '대화록이 있어야 참석자별 정리를 할 수 있습니다.');
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
            setOrganizeTab('speakers');
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

    const contentQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
    const renderSearchText = React.useCallback((text: string | null | undefined) => (
        highlightSearchText(String(text ?? ''), searchQuery)
    ), [searchQuery]);
    const hasGeneratedSummary = summaryGenerationStatus === 'completed'
        && Boolean(selectedMeeting?.summary?.trim())
        && !summarySkippedForDeferredAnalysis;
    const summaryMatches = hasGeneratedSummary
        && (!contentQuery || Boolean(selectedMeeting?.summary.toLowerCase().includes(contentQuery)));
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
    const visibleTopicSectionTopics = useMemo(
        () => visibleTopicSections
            .map(section => section.topic ?? '')
            .filter(topic => Boolean(normalizeTopicKey(topic))),
        [normalizeTopicKey, visibleTopicSections],
    );
    const displayedTopicSections = useMemo(
        () => selectedTopicKey
            ? visibleTopicSections.filter(section => normalizeTopicKey(section.topic ?? '') === selectedTopicKey)
            : visibleTopicSections,
        [normalizeTopicKey, selectedTopicKey, visibleTopicSections],
    );
    const speakersInTranscript = useMemo(() => {
        const speakerSet = new Set<string>();
        [...(selectedMeeting?.segments ?? []), ...(selectedMeeting?.displaySegments ?? []), ...(selectedMeeting?.editedDisplaySegments ?? [])].forEach(segment => {
            if (segment.speaker) speakerSet.add(segment.speaker);
        });
        return Array.from(speakerSet).sort((a, b) => a.localeCompare(b, 'ko'));
    }, [selectedMeeting]);
    const defaultSpeakerNameMap = useMemo(
        () => Object.fromEntries(speakersInTranscript.map((speaker, index) => [speaker, `참석자${String(index + 1).padStart(2, '0')}`])),
        [speakersInTranscript],
    );
    const defaultSpeakerName = React.useCallback((speaker: string, fallback?: string) => {
        const speakerNumber = String(speaker || '').match(/^SPEAKER[_\s-]?(\d+)$/i);
        if (speakerNumber) return defaultParticipantLabel(speaker);
        const koreanSpeakerNumber = String(speaker || fallback || '').match(/^화자(\d+)$/);
        if (koreanSpeakerNumber) return defaultParticipantLabel(String(speaker || fallback || ''));
        const normalizedFallback = String(fallback || '').trim();
        const fallbackNumber = normalizedFallback.match(/^SPEAKER[_\s-]?(\d+)$/i);
        if (fallbackNumber) return defaultParticipantLabel(normalizedFallback);
        const fallbackKoreanNumber = normalizedFallback.match(/^화자(\d+)$/);
        if (fallbackKoreanNumber) return defaultParticipantLabel(normalizedFallback);
        if (speaker && defaultSpeakerNameMap[speaker]) return defaultSpeakerNameMap[speaker];
        return normalizedFallback || speaker || '참석자';
    }, [defaultSpeakerNameMap]);
    const resolveSpeakerName = React.useCallback((speaker: string, fallback?: string) => {
        return selectedMeeting?.speakerLabels?.[speaker] || defaultSpeakerName(speaker, fallback);
    }, [defaultSpeakerName, selectedMeeting?.speakerLabels]);
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
    const speakerContributionLookup = useMemo(() => {
        const statsBySpeaker = new Map<string, Omit<SpeakerContributionStats, 'sharePercent'>>();
        const aliasToSpeakers = new Map<string, Set<string>>();
        let totalChars = 0;

        const addAlias = (alias: string | undefined, speakerKey: string) => {
            const normalizedAlias = String(alias || '').trim();
            if (!normalizedAlias) return;

            const speakers = aliasToSpeakers.get(normalizedAlias) ?? new Set<string>();
            speakers.add(speakerKey);
            aliasToSpeakers.set(normalizedAlias, speakers);
        };

        for (const segment of effectiveStoredDisplaySegments) {
            const text = String(segment.text || '').trim();
            if (!text) continue;

            const charCount = text.length;
            const speaker = String(segment.speaker || '').trim();
            const displaySpeaker = String(segment.displaySpeaker || '').trim();
            const defaultName = defaultSpeakerName(speaker, displaySpeaker);
            const resolvedSpeaker = resolveSpeakerName(speaker, displaySpeaker);
            const speakerKey = speaker || displaySpeaker || resolvedSpeaker;
            if (!speakerKey) continue;
            const aliases = new Set<string | undefined>([
                speaker,
                displaySpeaker,
                defaultName,
                resolvedSpeaker,
                selectedMeeting?.speakerLabels?.[speaker],
                selectedMeeting?.speakerLabels?.[displaySpeaker],
            ]);

            totalChars += charCount;
            const current = statsBySpeaker.get(speakerKey) ?? { turnCount: 0, charCount: 0 };
            statsBySpeaker.set(speakerKey, {
                turnCount: current.turnCount + 1,
                charCount: current.charCount + charCount,
            });
            aliases.forEach(alias => addAlias(alias, speakerKey));
        }

        const statsWithShare = new Map<string, SpeakerContributionStats>();
        statsBySpeaker.forEach((stats, speakerKey) => {
            statsWithShare.set(speakerKey, {
                ...stats,
                sharePercent: totalChars > 0 ? Math.round((stats.charCount / totalChars) * 100) : 0,
            });
        });
        const uniqueAliasToSpeaker = new Map<string, string>();
        aliasToSpeakers.forEach((speakers, alias) => {
            if (speakers.size === 1) {
                const [speakerKey] = Array.from(speakers);
                uniqueAliasToSpeaker.set(alias, speakerKey);
            }
        });

        return { statsBySpeaker: statsWithShare, uniqueAliasToSpeaker };
    }, [defaultSpeakerName, effectiveStoredDisplaySegments, resolveSpeakerName, selectedMeeting?.speakerLabels]);
    const findSpeakerContribution = React.useCallback((aliases: Array<string | undefined>) => {
        for (const alias of aliases) {
            const normalizedAlias = String(alias || '').trim();
            if (!normalizedAlias) continue;
            const directStats = speakerContributionLookup.statsBySpeaker.get(normalizedAlias);
            if (directStats) return directStats;
            const speakerKey = speakerContributionLookup.uniqueAliasToSpeaker.get(normalizedAlias);
            const stats = speakerKey ? speakerContributionLookup.statsBySpeaker.get(speakerKey) : undefined;
            if (stats) return stats;
        }
        return undefined;
    }, [speakerContributionLookup]);
    const formatSpeakerContribution = React.useCallback((stats?: SpeakerContributionStats) => {
        if (!stats || stats.turnCount <= 0) return '';
        const shareLabel = stats.sharePercent <= 0 && stats.charCount > 0 ? '<1%' : `${stats.sharePercent}%`;
        return `발언 ${stats.turnCount}회 · 텍스트 비중 ${shareLabel}`;
    }, []);
    const speakerSummariesForDisplay = useMemo(() => {
        if (selectedMeeting?.speakerContextSummaries?.length) {
            return selectedMeeting.speakerContextSummaries.map((item, index) => {
                const resolvedName = resolveSpeakerName(item.speaker, item.display_name);
                const contribution = findSpeakerContribution([
                    item.speaker,
                    item.display_name,
                    resolvedName,
                    selectedMeeting.speakerLabels?.[item.speaker],
                    item.display_name ? selectedMeeting.speakerLabels?.[item.display_name] : undefined,
                ]);
                return {
                    key: `${item.speaker}-${item.display_name ?? ''}`,
                    name: toParticipantCopy(resolvedName),
                    role: toParticipantCopy(item.role_in_meeting ?? ''),
                    summary: toParticipantCopy(item.summary),
                    keyPoints: (item.key_points ?? []).map(toParticipantCopy),
                    actions: (item.actions ?? []).map(toParticipantCopy),
                    needsCheck: (item.needs_check ?? []).map(toParticipantCopy),
                    sourceSpeaker: item.speaker,
                    contribution,
                    contributionLabel: formatSpeakerContribution(contribution),
                    originalIndex: index,
                };
            }).sort((left, right) => (
                (right.contribution?.charCount ?? 0) - (left.contribution?.charCount ?? 0)
                || left.originalIndex - right.originalIndex
            ));
        }

        return selectedMeeting?.participantSummaries?.map((item, index) => {
            const contribution = findSpeakerContribution([item.participant]);
            const participantName = defaultSpeakerName(item.participant);
            return {
                key: `${item.participant}`,
                name: toParticipantCopy(participantName),
                role: '',
                summary: toParticipantCopy(item.summary),
                keyPoints: (item.key_points ?? []).map(toParticipantCopy),
                actions: (item.actions ?? []).map(toParticipantCopy),
                needsCheck: [],
                sourceSpeaker: item.participant,
                contribution,
                contributionLabel: formatSpeakerContribution(contribution),
                originalIndex: index,
            };
        }).sort((left, right) => (
            (right.contribution?.charCount ?? 0) - (left.contribution?.charCount ?? 0)
            || left.originalIndex - right.originalIndex
        )) ?? [];
    }, [defaultSpeakerName, findSpeakerContribution, formatSpeakerContribution, resolveSpeakerName, selectedMeeting]);
    const filteredSpeakerSummaries = useMemo(
        () => speakerSummariesForDisplay.filter(item => !contentQuery || [
            item.name,
            item.role,
            item.contributionLabel,
            item.summary,
            ...item.keyPoints,
            ...item.needsCheck,
        ].join(' ').toLowerCase().includes(contentQuery)),
        [contentQuery, speakerSummariesForDisplay],
    );
    const speakerSummaryNameCounts = useMemo(() => {
        const counts = new Map<string, number>();
        filteredSpeakerSummaries.forEach(item => {
            counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
        });
        return counts;
    }, [filteredSpeakerSummaries]);
    const getSpeakerSummaryChipLabel = React.useCallback((item: typeof filteredSpeakerSummaries[number]) => (
        (speakerSummaryNameCounts.get(item.name) ?? 0) > 1 && item.sourceSpeaker && item.sourceSpeaker !== item.name
            ? `${item.name} (${item.sourceSpeaker})`
            : item.name
    ), [speakerSummaryNameCounts]);
    const displayActions = useMemo(
        () => selectedMeeting?.actions?.map(action => normalizeActionText(action)) ?? [],
        [normalizeActionText, selectedMeeting?.actions],
    );
    const visibleDecisions = useMemo(
        () => selectedMeeting?.decisions?.filter(item => !contentQuery || item.toLowerCase().includes(contentQuery)) ?? [],
        [contentQuery, selectedMeeting?.decisions],
    );
    const visibleActions = useMemo(
        () => displayActions.filter(action => !contentQuery || action.toLowerCase().includes(contentQuery)),
        [contentQuery, displayActions],
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
    const hasResultHighlights = Boolean(visibleTopics.length || visibleDecisions.length || visibleActions.length);
    const visibleNeedsCheck = useMemo(
        () => (selectedMeeting?.needsCheck ?? []).filter(item => (
            !isGuidanceNeedsCheckItem(item)
            && (!contentQuery || item.toLowerCase().includes(contentQuery))
        )),
        [contentQuery, selectedMeeting?.needsCheck],
    );
    const hasNeedsCheckContent = Boolean(visibleNeedsCheck.length);
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
        window.dispatchEvent(new CustomEvent('close-guard:state', {
            detail: { source: 'meeting-history', active: hasUnsavedDraftChanges },
        }));
        return () => {
            window.dispatchEvent(new CustomEvent('close-guard:state', {
                detail: { source: 'meeting-history', active: false },
            }));
        };
    }, [hasUnsavedDraftChanges]);

    useEffect(() => {
        const active = Boolean(generatingKind || diarizationProgress?.active);
        window.dispatchEvent(new CustomEvent('backend-task:state', {
            detail: { source: 'meeting-history-generation', active },
        }));
        return () => {
            window.dispatchEvent(new CustomEvent('backend-task:state', {
                detail: { source: 'meeting-history-generation', active: false },
            }));
        };
    }, [diarizationProgress?.active, generatingKind]);

    useEffect(() => {
        if (isTauriRuntime()) return;
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

    const handleCopyEditableTranscript = async () => {
        const transcriptText = formatEditableTranscript(displaySegments);
        if (!transcriptText) {
            setNoticeMessage('');
            setErrorMessage('복사할 대화록이 없습니다.');
            return;
        }

        try {
            setErrorMessage('');
            setNoticeMessage('');
            await copyTextToClipboard(transcriptText);
            setNoticeMessage('편집용 대화록을 복사했습니다.');
        } catch {
            setNoticeMessage('');
            setErrorMessage('대화록을 복사하지 못했습니다. 다시 시도해 주세요.');
        }
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
        setIsSpeakerLabelPanelOpen(true);
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
    const shouldOfferTopicRegeneration = topicGenerationStatus === 'completed'
        && !topicSectionsOutdated
        && (selectedMeeting?.topicSections?.filter(section => section.topic?.trim()).length ?? 0) <= 1;
    const shouldShowTopicAction = topicGenerationStatus !== 'completed' || topicSectionsOutdated || shouldOfferTopicRegeneration;
    const shouldShowSpeakerAction = speakerGenerationStatus !== 'completed' || speakerContextOutdated || topicSectionsOutdated;
    const hasTopicSectionResults = Boolean(
        selectedMeeting?.topicSections?.some(section => section.topic?.trim() || section.summary?.trim()),
    );
    const canShowCompletedCustomTopicInput = topicGenerationStatus === 'completed' && !topicSectionsOutdated && hasTopicSectionResults;
    const speakerActionBlockedMessage = !summaryModelUnavailable && shouldShowSpeakerAction && !canRunSpeakerContextGeneration
        ? topicSectionsOutdated
            ? '주제별 정리를 다시 한 뒤 참석자별 정리를 실행할 수 있습니다.'
            : '주제별 정리를 먼저 하면 참석자별 정리를 실행할 수 있습니다.'
        : '';
    const isCurrentTopicGenerationRequest = Boolean(
        topicGenerationIntent?.meetingId
        && selectedMeeting?.id
        && topicGenerationIntent.meetingId === selectedMeeting.id,
    );
    const selectedTopicGenerationIntent = isCurrentTopicGenerationRequest ? topicGenerationIntent?.intent ?? null : null;
    const selectedGeneratingKind = isCurrentTopicGenerationRequest ? generatingKind : null;
    const isOtherMeetingGenerating = generatingKind !== null && !isCurrentTopicGenerationRequest;
    const {
        isTopicGenerationRunning,
        isMainTopicGenerationRunning,
        isCustomTopicGenerationRunning,
    } = getTopicGenerationUiState({
        generatingKind: selectedGeneratingKind,
        topicGenerationStatus,
        topicGenerationIntent: selectedTopicGenerationIntent,
    });
    const shouldShowCustomTopicInput = canShowCompletedCustomTopicInput || isCustomTopicGenerationRunning;
    const customTopicButtonLabel = isCustomTopicGenerationRunning ? '정리 중' : '추가 정리';
    const customTopicButtonTitle = isCustomTopicGenerationRunning
        ? '추가 주제를 정리 중입니다.'
        : isTopicGenerationRunning || isOtherMeetingGenerating
            ? '다른 정리가 진행 중입니다.'
            : summaryModelUnavailable
                ? organizeModelGuidanceMessage
                : canRunTopicGeneration
                    ? '입력한 주제로 추가 정리'
                    : '전체 요약을 먼저 정리해 주세요.';
    const customTopicButtonAriaLabel = isCustomTopicGenerationRunning ? '추가 주제 정리 중' : '주제 추가 정리';
    const topicActionButtonLabel = isMainTopicGenerationRunning
        ? '정리 중'
        : shouldOfferTopicRegeneration
            ? '다시 정리'
            : getActionLabel(topicGenerationStatus);
    const topicActionButtonTitle = isMainTopicGenerationRunning
        ? '주제별 정리 중입니다.'
        : isTopicGenerationRunning || isOtherMeetingGenerating
            ? '다른 정리가 진행 중입니다.'
            : summaryModelUnavailable
                ? organizeModelGuidanceMessage
            : canRunTopicGeneration
                ? (shouldOfferTopicRegeneration ? '주제별 다시 정리' : '주제별 정리')
                : '전체 요약을 먼저 정리해 주세요.';
    const topicActionButtonAriaLabel = isMainTopicGenerationRunning ? '주제별 정리 중' : '주제별 정리';

    const renderRunIcon = (
        kind: GenerationKind,
        status: string,
        isRunning = generatingKind === kind || status === 'generating',
    ) => (
        isRunning
            ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            : <Play size={14} aria-hidden="true" />
    );

    const showDiarizationProgress = diarizationIsRunning;
    const diarizationElapsedMs = showDiarizationProgress && diarizationStartedAt
        ? Math.max(0, diarizationNow - diarizationStartedAt)
        : 0;
    const reportedDiarizationProgress = typeof diarizationProgress?.progress === 'number'
        ? diarizationProgress.progress
        : null;
    const diarizationProgressPercent = showDiarizationProgress
        ? Math.min(100, Math.max(
            0,
            reportedDiarizationProgress && reportedDiarizationProgress > 0
                ? reportedDiarizationProgress
                : getFallbackDiarizationProgressPercent(diarizationElapsedMs),
        ))
        : 0;
    const diarizationProgressMessage = formatDiarizationProgressMessage(
        diarizationProgress?.message || (diarizationStopRequested ? '참석자 구분 중지 중' : '참석자 구분 중'),
    );
    const diarizationRemainingEstimate = formatDiarizationRemainingEstimate(
        diarizationElapsedMs,
        diarizationProgressPercent,
        diarizationProgress?.status,
    );
    const effectiveDiarizationRemainingEstimate = diarizationStopRequested
        ? diarizationStopLabel
        : diarizationRemainingEstimate;
    const diarizationProgressPanel = showDiarizationProgress ? (
        <div className="mt-3 border-t border-border/70 pt-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-1 gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3 text-sm font-semibold text-foreground" role="status" aria-live="polite">
                            <span className="min-w-0 truncate">{diarizationProgressMessage}</span>
                            <span className="shrink-0 text-primary">{Math.round(diarizationProgressPercent)}%</span>
                        </div>
                        <ProgressBar
                            value={diarizationProgressPercent}
                            size="sm"
                            tone={diarizationProgress?.status === 'failed' ? 'error' : 'primary'}
                            className="mt-3"
                            label="참석자 구분 진행률"
                        />
                    </div>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                    <div className="text-xs text-muted-foreground">경과 시간</div>
                    <div className="mt-1 text-sm font-semibold text-primary">
                        {formatAnalysisDuration(diarizationElapsedMs)}
                    </div>
                    <div className="mt-3 text-xs text-muted-foreground">예상 남은 시간</div>
                    <div className="mt-1 text-sm font-semibold text-primary">
                        {effectiveDiarizationRemainingEstimate}
                    </div>
                    {!isDiarizationStopConfirmOpen && !diarizationStopRequested && (
                        <Button
                            variant="outline"
                            className="mt-3 h-8 px-3 text-xs"
                            onClick={handleOpenDiarizationStopConfirm}
                            disabled={isStoppingDiarization}
                            title="참석자 구분을 중지하거나 취소합니다."
                        >
                            <Square size={13} aria-hidden="true" />
                            중지/취소
                        </Button>
                    )}
                    {diarizationStopRequested && (
                        <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                            {diarizationStopLabel}
                        </div>
                    )}
                </div>
            </div>
            {isDiarizationStopConfirmOpen && (
                <div className="diarization-stop-panel" role="group" aria-label="참석자 구분 중지 또는 취소 방식 선택">
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground">참석자 구분을 어떻게 처리할까요?</div>
                        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            중지하면 원본 음성이 남아 있을 때 다시 실행할 수 있고, 취소하면 이번 실행만 멈춥니다.
                        </div>
                    </div>
                    <div className="diarization-stop-actions">
                        <Button
                            variant="outline"
                            className="h-8 px-3 text-xs"
                            onClick={() => handleStopDiarization('defer')}
                            disabled={isStoppingDiarization}
                            title="원본 음성이 남아 있으면 다시 실행할 수 있게 중지"
                        >
                            {isStoppingDiarization && stoppingDiarizationAction === 'defer' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                            중지
                        </Button>
                        <Button
                            variant="outline"
                            className="h-8 px-3 text-xs"
                            onClick={() => handleStopDiarization('cancel')}
                            disabled={isStoppingDiarization}
                            title="이번 참석자 구분 실행만 취소"
                        >
                            {isStoppingDiarization && stoppingDiarizationAction === 'cancel' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                            취소
                        </Button>
                        <Button
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            onClick={() => setIsDiarizationStopConfirmOpen(false)}
                            disabled={isStoppingDiarization}
                        >
                            계속
                        </Button>
                    </div>
                </div>
            )}
        </div>
    ) : null;

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
            {savedFileToast && (
                <div className="save-toast" role="status" aria-live="polite">
                    <span className="font-semibold text-foreground">저장됨</span>
                    {savedFileToast.path && isTauriRuntime() && (
                        <button
                            type="button"
                            className="save-toast-action"
                            onClick={handleOpenSavedFileLocation}
                        >
                            폴더 열기
                        </button>
                    )}
                    <button
                        type="button"
                        className="save-toast-close"
                        aria-label="저장 알림 닫기"
                        onClick={() => setSavedFileToast(null)}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}
            {operationToast && (
                <div className={`operation-toast status-${operationToast.tone}`} role="status" aria-live="polite">
                    <span className="font-semibold">{operationToast.message}</span>
                    <button
                        type="button"
                        className="operation-toast-close"
                        aria-label="알림 닫기"
                        onClick={() => setOperationToast(null)}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

            <article className="app-panel overflow-hidden">
                <div className="app-panel-header flex flex-col gap-4 border-b border-border p-5">
                    <div className="grid gap-4">
                        <div className="flex items-start justify-between gap-4">
                            {isEditing ? (
                                <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-foreground">
                                    회의 제목
                                    <Input value={editTitle} onChange={event => setEditTitle(event.target.value)} aria-label="회의 제목" placeholder="회의 제목" />
                                </label>
                            ) : (
                                <h2 className="meeting-detail-title min-w-0 flex-1">{selectedMeeting.title}</h2>
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
                                            onSaved={showSavedFileToast}
                                            onDownloadingChange={setIsDownloading}
                                            beforeDownload={() => ensureNoUnsavedDraftChanges('파일 저장')}
                                            disabled={isDownloading}
                                        />
                                        {selectedMeeting.jobId && audioSourceUrl && (
                                            <IconButton
                                                aria-label="음성 파일을 다운로드 폴더에 저장"
                                                title="음성 파일을 다운로드 폴더에 저장"
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

                        {isEditing ? (
                            <div className="grid gap-3">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="grid gap-1 text-xs font-semibold text-foreground">
                                        회의 일시
                                        <Input value={editDate} onChange={event => setEditDate(event.target.value)} aria-label="회의 일시" placeholder="회의 일시" />
                                    </label>
                                    <label className="grid gap-1 text-xs font-semibold text-foreground">
                                        회의 목적/정리 맥락
                                        <Input value={editMeetingPurpose} onChange={event => setEditMeetingPurpose(event.target.value)} aria-label="회의 목적 또는 정리 맥락" placeholder="정리할 때 강조할 맥락" />
                                    </label>
                                </div>
                                {!selectedMeeting.meetingPurpose && selectedMeeting.participants && (
                                    <div className="text-xs text-muted-foreground">
                                        기존 참석자: {selectedMeeting.participants}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <>
                                <div className="meeting-detail-heading">
                                    <div className="meeting-meta-grid">
                                        <div className="meeting-meta-item">
                                            <span className="meeting-meta-label">일시</span>
                                            <span className="meeting-meta-value">{selectedMeeting.date}</span>
                                        </div>
                                        <div className="meeting-meta-item">
                                            <span className="meeting-meta-label">{selectedMeeting.meetingPurpose ? '회의 목적/정리 맥락' : '참석자'}</span>
                                            <span className="meeting-meta-value">{selectedMeeting.meetingPurpose || selectedMeeting.participants || '-'}</span>
                                        </div>
                                        {selectedMeeting.sourceFile && (
                                            <div className="meeting-meta-item sm:col-span-2">
                                                <span className="meeting-meta-label">원본 파일</span>
                                                <span className="meeting-meta-value">{selectedMeeting.sourceFile}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="meeting-status-grid">
                                    <div className="meeting-status-item">
                                        <span className="meeting-status-title">대화록</span>
                                        <span className={`status-pill status-${hasTranscriptData ? 'success' : 'neutral'}`}>
                                            {hasTranscriptData ? '완료' : '대기'}
                                        </span>
                                    </div>
                                    <div className="meeting-status-item" title={diarizationStatusTitle}>
                                        <span className="meeting-status-title">참석자 구분</span>
                                        <span className="meeting-status-actions">
                                            <span className={`status-pill status-${diarizationStatus.tone}`}>
                                                {diarizationStatus.label}
                                            </span>
                                            {(canGenerateDiarization || diarizationIsRunning) && (
                                                <Button
                                                    variant="outline"
                                                    className="meeting-status-run-button"
                                                    aria-label={diarizationStopRequested ? `참석자 구분 ${diarizationStopLabel}` : diarizationIsRunning ? '참석자 구분 중지/취소' : '참석자 구분 실행'}
                                                    title={diarizationStopRequested ? `참석자 구분 ${diarizationStopLabel}` : diarizationIsRunning ? '참석자 구분 중지/취소' : '참석자 구분 실행'}
                                                    disabled={diarizationIsRunning ? (isStoppingDiarization || diarizationStopRequested) : generatingKind !== null}
                                                    onClick={diarizationIsRunning ? handleOpenDiarizationStopConfirm : handleGenerateDiarization}
                                                >
                                                    {diarizationStopRequested ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : diarizationIsRunning ? <Square size={13} aria-hidden="true" /> : renderRunIcon('diarization', 'not_started')}
                                                    {diarizationStopRequested ? diarizationStopLabel : diarizationIsRunning ? '중지/취소' : '실행'}
                                                </Button>
                                            )}
                                        </span>
                                    </div>
                                </div>
                                {selectedMeeting.diarizationSkipped && (
                                    <div className="status-note mt-3">
                                        {toParticipantCopy(selectedMeeting.diarizationSkipMessage || '참석자 구분은 제외하고 대화록을 먼저 저장했습니다.')}
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
                                {diarizationStatusTitle && !selectedMeeting.diarizationSkipped && (
                                    <div className="status-note mt-3">
                                        {diarizationStatusTitle}
                                    </div>
                                )}
                                {selectedMeeting.jobId && audioAvailability === 'missing' && !diarizationStatusTitle && (
                                    <div className="status-note mt-3">
                                        참석자 구분을 다시 실행하려면 분석 당시 보관한 음성 파일이 필요합니다.
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    <div className="flex flex-col gap-3 pt-4 lg:flex-row lg:items-end lg:justify-between">
                        <div className="tab-list" aria-label="회의록 상세">
                            <DetailTabButton
                                active={detailTab === 'script'}
                                onClick={() => setDetailTab('script')}
                            >
                                대화록
                            </DetailTabButton>
                            <DetailTabButton
                                active={detailTab === 'summary'}
                                disabled={!canOpenOrganizeTab}
                                onClick={() => setDetailTab('summary')}
                                title={canOpenOrganizeTab ? '기록 정리' : organizeTabDisabledMessage}
                            >
                                기록 정리
                            </DetailTabButton>
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

                <div className="meeting-detail-body space-y-6">
                    {detailTab === 'summary' && (
                        <>
                            {summaryModelUnavailable && (
                                <StatusBanner
                                    tone="warning"
                                    heading="모델 필요"
                                    className="mb-4"
                                    action={onOpenSettings ? (
                                        <Button variant="outline" onClick={onOpenSettings}>
                                            모델
                                        </Button>
                                    ) : undefined}
                                >
                                    {organizeModelGuidanceMessage}
                                </StatusBanner>
                            )}
                            {showDiarizationProgress && (
                                <section className="detail-action-row">
                                    <h3 className="section-title mb-3">대화록</h3>
                                    {diarizationProgressPanel}
                                </section>
                            )}

                            <section className="detail-action-row">
                                <div className="mb-3 flex items-center gap-2">
                                    <h3 className="section-title">정리</h3>
                                    <DetailHelpButton
                                        title="필요한 정리 탭을 열어 정리합니다. 전체 요약을 먼저 만들면 주제별 정리와 참석자별 정리를 이어서 만들 수 있습니다."
                                        ariaLabel="정리 도움말"
                                    />
                                </div>
                                <div className="mb-4 flex flex-wrap items-end gap-2">
                                    <div className="tab-list flex-1" aria-label="정리 종류">
                                        <DetailTabButton
                                            active={organizeTab === 'summary'}
                                            onClick={() => setOrganizeTab('summary')}
                                        >
                                            전체 요약
                                        </DetailTabButton>
                                        <DetailTabButton
                                            active={organizeTab === 'topics'}
                                            onClick={() => setOrganizeTab('topics')}
                                        >
                                            주제별 정리
                                        </DetailTabButton>
                                        <DetailTabButton
                                            active={organizeTab === 'speakers'}
                                            onClick={() => setOrganizeTab('speakers')}
                                        >
                                            참석자별 정리
                                        </DetailTabButton>
                                    </div>
                                    {organizeTab === 'speakers' && (
                                        <div className="flex items-center gap-2 pb-1">
                                            <DetailHelpButton
                                                title="AI가 참석자별로 정리한 초안입니다. 텍스트 비중은 대화록 글자 수 기준입니다."
                                                ariaLabel="참석자별 정리 도움말"
                                            />
                                            {(!!visibleSpeakerSummaries.length || hasCompletedEmptySpeakerContext) && (
                                                <IconButton
                                                    variant="outline"
                                                    icon={<Edit3 size={16} />}
                                                    className="h-8 w-8"
                                                    onClick={openSpeakerLabelEditor}
                                                    aria-label="이름 변경"
                                                    title="이름 변경"
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>

                                {organizeTab === 'summary' && (
                                    <div className="space-y-3" data-summary-section="overview">
                                        {hasGeneratedSummary ? (
                                            summaryMatches ? (
                                                <div className="detail-callout">{renderSearchText(toParticipantCopy(selectedMeeting.summary))}</div>
                                            ) : (
                                                <InlineStateNote>검색과 일치하는 전체 요약이 없습니다.</InlineStateNote>
                                            )
                                        ) : (
                                            <InlineStateNote>
                                                전체 요약을 정리하면 주요 내용, 결정사항, 할 일을 여기에서 확인할 수 있습니다.
                                            </InlineStateNote>
                                        )}
                                        {summaryOutdated && hasGeneratedSummary && (
                                            <InlineStateNote>
                                                회의 정보나 대화록이 바뀌어 현재 전체 요약은 이전 기준일 수 있습니다.
                                            </InlineStateNote>
                                        )}
                                        {hasResultHighlights && (
                                            <div className="grid gap-3">
                                                {!!visibleTopics.length && (
                                                    <div className="detail-subtle-card">
                                                        <div className="mb-2 text-xs font-semibold text-muted-foreground">주요 내용</div>
                                                        <ul className="detail-list">
                                                            {visibleTopics.map((topic, index) => <li key={`${topic}-${index}`}>{renderSearchText(toParticipantCopy(topic))}</li>)}
                                                        </ul>
                                                    </div>
                                                )}
                                                {!!visibleDecisions.length && (
                                                    <div className="detail-subtle-card">
                                                        <div className="mb-2 text-xs font-semibold text-muted-foreground">결정사항</div>
                                                        <ul className="detail-list">
                                                            {visibleDecisions.map((item, index) => <li key={`${item}-${index}`}>{renderSearchText(toParticipantCopy(item))}</li>)}
                                                        </ul>
                                                    </div>
                                                )}
                                                {!!visibleActions.length && (
                                                    <div className="detail-subtle-card">
                                                        <div className="mb-2 text-xs font-semibold text-muted-foreground">할 일</div>
                                                        <ul className="detail-list">
                                                            {visibleActions.map((action, index) => <li key={`${action}-${index}`}>{renderSearchText(toParticipantCopy(action))}</li>)}
                                                        </ul>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {hasNeedsCheckContent && (
                                            <div className="detail-subtle-card">
                                                <div className="mb-2 text-xs font-semibold text-muted-foreground">추가 확인</div>
                                                <ul className="detail-list">
                                                    {visibleNeedsCheck.map((item, index) => <li key={`${item}-${index}`}>{renderSearchText(toParticipantCopy(item))}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                        {shouldShowSummaryAction && (
                                            <div className="flex justify-end">
                                                <OrganizeRunButton
                                                    ariaLabel="전체 요약 정리"
                                                    disabled={!canRunSummaryGeneration || generatingKind !== null || summaryGenerationStatus === 'generating'}
                                                    onClick={handleGenerateSummary}
                                                    title={summaryModelUnavailable ? organizeModelGuidanceMessage : '전체 요약 정리'}
                                                    icon={renderRunIcon('summary', summaryGenerationStatus)}
                                                    label={getActionLabel(summaryGenerationStatus)}
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}

                                {organizeTab === 'topics' && (
                                    <div className="space-y-3" ref={topicSectionsSectionRef}>
                                        {topicSectionsOutdated && (
                                            <InlineStateNote>
                                                회의 정보나 대화록이 바뀌어 현재 주제별 정리는 이전 기준일 수 있습니다.
                                            </InlineStateNote>
                                        )}
                                        {visibleTopicSections.length ? (
                                            <>
                                                {!!visibleTopicSectionTopics.length && (
                                                    <div className="flex flex-wrap gap-2">
                                                        <button
                                                            type="button"
                                                            className={`topic-chip ${selectedTopicKey === null ? 'topic-chip-active' : ''}`}
                                                            onClick={() => setSelectedTopicKey(null)}
                                                            title="전체 주제 보기"
                                                            aria-pressed={selectedTopicKey === null}
                                                        >
                                                            {renderSearchText('전체')}
                                                        </button>
                                                        {visibleTopicSectionTopics.map(topic => (
                                                            <button
                                                                key={topic}
                                                                type="button"
                                                                className={`topic-chip ${selectedTopicKey === normalizeTopicKey(topic) ? 'topic-chip-active' : ''}`}
                                                                onClick={() => handleSelectTopic(topic)}
                                                                title="해당 주제 위치로 이동"
                                                                aria-pressed={selectedTopicKey === normalizeTopicKey(topic)}
                                                            >
                                                                {renderSearchText(topic)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="grid gap-3">
                                                    {displayedTopicSections.map((section, index) => (
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
                                                            <h4 className="font-semibold text-foreground">{renderSearchText(toParticipantCopy(section.topic))}</h4>
                                                            <p className="mt-2 text-sm leading-relaxed text-foreground">{renderSearchText(toParticipantCopy(section.summary))}</p>
                                                            {!!section.evidence?.length && (
                                                                <ul className="detail-list mt-3">
                                                                    {section.evidence.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{renderSearchText(toParticipantCopy(item))}</li>)}
                                                                </ul>
                                                            )}
                                                        </article>
                                                    ))}
                                                </div>
                                            </>
                                        ) : (
                                            <InlineStateNote>
                                                {isFiltering
                                                    ? '검색과 일치하는 주제별 정리가 없습니다.'
                                                    : hasCompletedEmptyTopicSections
                                                        ? '주제별 정리 내용이 없습니다. 대화록을 확인해 주세요.'
                                                        : '주제별 정리를 하면 각 주제의 논의 내용이 여기에 표시됩니다.'}
                                            </InlineStateNote>
                                        )}
                                        {shouldShowCustomTopicInput && (
                                            <div className="detail-control-card">
                                                <Input
                                                    value={customTopicTitle}
                                                    onChange={event => setCustomTopicTitle(event.target.value)}
                                                    onKeyDown={event => {
                                                        if (event.key === 'Enter') {
                                                            event.preventDefault();
                                                            void handleGenerateCustomTopicSection();
                                                        }
                                                    }}
                                                    placeholder="추가로 정리할 주제 제목"
                                                    aria-label="추가로 정리할 주제 제목"
                                                    disabled={generatingKind !== null}
                                                />
                                                <OrganizeRunButton
                                                    className="h-10 sm:w-24"
                                                    ariaLabel={customTopicButtonAriaLabel}
                                                    disabled={!customTopicTitle.trim() || !canRunTopicGeneration || generatingKind !== null || topicGenerationStatus === 'generating'}
                                                    onClick={handleGenerateCustomTopicSection}
                                                    title={customTopicButtonTitle}
                                                    icon={renderRunIcon('topicSections', topicGenerationStatus, isCustomTopicGenerationRunning)}
                                                    label={customTopicButtonLabel}
                                                />
                                            </div>
                                        )}
                                        {shouldShowTopicAction && (
                                            <div className="flex justify-end">
                                                <OrganizeRunButton
                                                    ariaLabel={topicActionButtonAriaLabel}
                                                    disabled={!canRunTopicGeneration || generatingKind !== null || topicGenerationStatus === 'generating'}
                                                    onClick={handleGenerateTopicSections}
                                                    title={topicActionButtonTitle}
                                                    icon={renderRunIcon('topicSections', topicGenerationStatus, isMainTopicGenerationRunning)}
                                                    label={topicActionButtonLabel}
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}

                                {organizeTab === 'speakers' && (
                                    <div className="space-y-3" ref={speakerSummarySectionRef}>
                                        <InlineStateNote>
                                            AI가 참석자별로 정리한 초안입니다. 이름은 필요하면 수정해 주세요.
                                        </InlineStateNote>
                                        {speakerContextOutdated && (
                                            <InlineStateNote>
                                                회의 정보나 대화록이 바뀌어 현재 참석자별 정리는 이전 기준일 수 있습니다.
                                            </InlineStateNote>
                                        )}
                                        {speakerActionBlockedMessage && filteredSpeakerSummaries.length > 0 && (
                                            <InlineStateNote>
                                                {speakerActionBlockedMessage}
                                            </InlineStateNote>
                                        )}
                                        {filteredSpeakerSummaries.length ? (
                                            <>
                                                {filteredSpeakerSummaries.length > 1 && (
                                                    <div className="flex flex-wrap gap-2">
                                                        <button
                                                            type="button"
                                                            className={`topic-chip ${selectedSpeakerSummaryKey === 'all' ? 'topic-chip-active' : ''}`}
                                                            onClick={() => setSelectedSpeakerSummaryKey('all')}
                                                            aria-pressed={selectedSpeakerSummaryKey === 'all'}
                                                        >
                                                            {renderSearchText('전체')}
                                                        </button>
                                                        {filteredSpeakerSummaries.map(item => {
                                                            const chipLabel = getSpeakerSummaryChipLabel(item);
                                                            return (
                                                            <button
                                                                key={item.key}
                                                                type="button"
                                                                className={`topic-chip ${selectedSpeakerSummaryKey === item.key ? 'topic-chip-active' : ''}`}
                                                                onClick={() => setSelectedSpeakerSummaryKey(item.key)}
                                                                aria-pressed={selectedSpeakerSummaryKey === item.key}
                                                                aria-label={chipLabel}
                                                            >
                                                                {renderSearchText(chipLabel)}
                                                            </button>
                                                        );
                                                        })}
                                                    </div>
                                                )}
                                                <div className="grid gap-3">
                                                    {visibleSpeakerSummaries.map(item => (
                                                        <article key={item.key} className="detail-subtle-card">
                                                            <button
                                                                type="button"
                                                                className="speaker-summary-toggle"
                                                                onClick={() => setCollapsedSpeakerSummaryKeys(current => ({
                                                                    ...current,
                                                                    [item.key]: !current[item.key],
                                                                }))}
                                                                aria-expanded={!collapsedSpeakerSummaryKeys[item.key]}
                                                            >
                                                                <div className="min-w-0">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <h4 className="font-semibold text-foreground">{renderSearchText(item.name)}</h4>
                                                                        {item.role && (
                                                                            <span className="speaker-summary-role">
                                                                                {renderSearchText(item.role)}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {item.contributionLabel && (
                                                                        <div
                                                                            className="speaker-summary-contribution"
                                                                            title="대화록 글자 수 기준입니다. 발언 시간이나 중요도 비율은 아닙니다."
                                                                        >
                                                                            {renderSearchText(item.contributionLabel)}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true">
                                                                    {collapsedSpeakerSummaryKeys[item.key] ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                                                                </span>
                                                            </button>
                                                            {!collapsedSpeakerSummaryKeys[item.key] && (
                                                                <>
                                                                    <p className="mt-2 text-sm leading-relaxed text-foreground">{renderSearchText(item.summary)}</p>
                                                                    {!!item.keyPoints.length && (
                                                                        <div className="mt-3">
                                                                            <div className="mb-2 text-xs font-semibold text-muted-foreground">핵심 발언</div>
                                                                            <ul className="detail-list">
                                                                                {item.keyPoints.map((point, pointIndex) => <li key={`${point}-${pointIndex}`}>{renderSearchText(point)}</li>)}
                                                                            </ul>
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}
                                                        </article>
                                                    ))}
                                                </div>
                                            </>
                                        ) : (
                                            <InlineStateNote>
                                                {isFiltering
                                                    ? '검색과 일치하는 참석자별 정리가 없습니다.'
                                                    : hasCompletedEmptySpeakerContext
                                                        ? '참석자별 정리 내용이 없습니다. 참석자 구분을 확인해 주세요.'
                                                        : speakerActionBlockedMessage
                                                            ? speakerActionBlockedMessage
                                                            : '참석자별 정리를 하면 참석자별 요약과 핵심 발언이 여기에 표시됩니다.'}
                                            </InlineStateNote>
                                        )}
                                        {shouldShowSpeakerAction && (
                                            <div className="flex justify-end">
                                                <OrganizeRunButton
                                                    ariaLabel="참석자별 정리"
                                                    disabled={!canRunSpeakerContextGeneration || generatingKind !== null || speakerGenerationStatus === 'generating'}
                                                    onClick={handleGenerateSpeakerContext}
                                                    title={summaryModelUnavailable ? organizeModelGuidanceMessage : canCreateSpeakerContext ? '참석자별 정리' : '주제별 정리를 먼저 만들어 주세요.'}
                                                    icon={renderRunIcon('speakerContextSummaries', speakerGenerationStatus)}
                                                    label={getActionLabel(speakerGenerationStatus)}
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>

                        </>
                    )}

                    {detailTab === 'script' && (
                        <section>
                            <div className="mb-4 flex flex-col gap-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <h3 className="section-title">대화록</h3>
                                    <div className="flex flex-wrap gap-2">
                                        {!!selectedMeeting.editedDisplaySegments?.length && !isTranscriptEditing && !isSpeakerLabelPanelOpen && !hasSpeakerLabelChanges && (
                                            <Button variant="outline" onClick={handleRevertTranscript}>
                                                원본 복원
                                            </Button>
                                        )}
                                        {isTranscriptEditing ? (
                                            <>
                                                <Button onClick={handleSaveTranscriptEdit}>
                                                    <Save size={15} />
                                                    저장
                                                </Button>
                                                <Button variant="outline" onClick={handleCancelTranscriptEdit}>
                                                    취소
                                                </Button>
                                            </>
                                        ) : !isSpeakerLabelPanelOpen && !hasSpeakerLabelChanges && (
                                            <>
                                                <Button variant="outline" onClick={() => void handleCopyEditableTranscript()} disabled={!displaySegments.length}>
                                                    <Copy size={15} />
                                                    편집용 복사
                                                </Button>
                                                <Button variant="outline" onClick={handleStartTranscriptEdit} disabled={!displaySegments.length}>
                                                    <Edit3 size={15} />
                                                    대화록 편집
                                                </Button>
                                            </>
                                        )}
                                        {!!speakersInTranscript.length && !isTranscriptEditing && (
                                            isSpeakerLabelPanelOpen || hasSpeakerLabelChanges ? (
                                                <>
                                                    <Button variant="outline" onClick={handleSaveSpeakerLabels} disabled={!hasSpeakerLabelChanges}>
                                                        <Save size={15} />
                                                        이름 저장
                                                    </Button>
                                                    <Button variant="outline" onClick={handleCancelSpeakerLabelEdit}>
                                                        취소
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button variant="outline" onClick={() => setIsSpeakerLabelPanelOpen(true)}>
                                                    <Edit3 size={15} />
                                                    이름 변경
                                                </Button>
                                            )
                                        )}
                                    </div>
                                </div>
                                {!!selectedMeeting.editedDisplaySegments?.length && !isTranscriptEditing && (
                                    <InlineStateNote>
                                        현재 화면은 수정본 대화록입니다. 원본은 별도로 보존됩니다.
                                    </InlineStateNote>
                                )}
                                {!!speakersInTranscript.length && (isSpeakerLabelPanelOpen || hasSpeakerLabelChanges) && (
                                    <SpeakerLabelPanel
                                        panelRef={speakerLabelsPanelRef}
                                        speakers={speakersInTranscript}
                                        drafts={speakerLabelDrafts}
                                        hasChanges={hasSpeakerLabelChanges}
                                        getTone={getSpeakerTone}
                                        getName={defaultSpeakerName}
                                        onChange={(speaker, value) => setSpeakerLabelDrafts(prev => ({
                                            ...prev,
                                            [speaker]: value,
                                        }))}
                                        onSave={handleSaveSpeakerLabels}
                                        onClear={handleClearSpeakerLabel}
                                    />
                                )}
                            </div>
                            {(isTranscriptEditing ? transcriptSegmentDrafts.length : visibleSegments.length) ? (
                                <div className="space-y-2">
                                    {(isTranscriptEditing ? transcriptSegmentDrafts : visibleSegments).map((segment, index) => {
                                        const warning = looksLikeKoreanMisrecognition(segment.text);
                                        return (
                                            <article key={`${segment.start}-${index}`} className={`script-row ${warning ? 'script-row-warning' : ''}`}>
                                                <div className="script-meta flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                                    <span className={`speaker-dot ${getSegmentSpeakerTone(segment, index)}`} />
                                                    <span className="font-semibold text-foreground">{renderSearchText(segment.displaySpeaker || segment.speaker || '참석자')}</span>
                                                    <span>{segment.start} - {segment.end}</span>
                                                    {segment.timingApproximate && <span className="script-badge">시간 추정</span>}
                                                </div>
                                                {isTranscriptEditing ? (
                                                    <textarea
                                                        value={segment.text}
                                                        onChange={event => handleTranscriptDraftChange(index, event.target.value)}
                                                        className="script-edit-textarea"
                                                        aria-label={`${segment.displaySpeaker || segment.speaker || '참석자'} 대화록 수정`}
                                                    />
                                                ) : (
                                                    <p className="script-text">{renderSearchText(segment.text)}</p>
                                                )}
                                            </article>
                                        );
                                    })}
                                </div>
                            ) : (
                                <InlineStateNote>대화록 내용이 없습니다.</InlineStateNote>
                            )}
                        </section>
                    )}
                </div>
            </article>
        </div>
    );
};
