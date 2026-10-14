import type { AnalysisResumeDraft } from './analysisResumeDrafts';
import {
    addMeeting,
    deleteMeeting,
    getAllMeetings,
    MeetingGenerationStatus,
    MeetingParticipantSummary,
    MeetingRecord,
    MeetingSegment,
    MeetingSpeakerContextSummary,
    MeetingTopicSection,
    updateMeeting,
} from './meetingRepository';
import {
    DEFAULT_CONTEXT_TEMPLATE_ID,
    DEFAULT_REPORT_TEMPLATE_ID,
    getContextTemplateById,
    getReportTemplateById,
} from './meetingKnowledge';
import type { ContextTemplate, ReportTemplate, TermGlossary } from './meetingKnowledge';

export interface AnalyzeResult {
    job_id?: string;
    source_file?: string;
    partial?: boolean;
    status?: string;
    heartbeat?: boolean;
    progress?: number;
    eta_seconds?: number | null;
    etaSeconds?: number | null;
    total_audio_seconds?: number;
    totalAudioSeconds?: number;
    completed_audio_seconds?: number;
    completedAudioSeconds?: number;
    transcript_ready?: boolean;
    transcriptReady?: boolean;
    summary?: string;
    segments?: MeetingSegment[];
    display_segments?: MeetingSegment[];
    displaySegments?: MeetingSegment[];
    topics?: string[];
    topic_sections?: MeetingTopicSection[];
    topicSections?: MeetingTopicSection[];
    participant_summaries?: MeetingParticipantSummary[];
    participantSummaries?: MeetingParticipantSummary[];
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    generation_status?: MeetingGenerationStatus;
    generationStatus?: MeetingGenerationStatus;
    actions?: string[];
    decisions?: string[];
    needs_check?: string[];
    needsCheck?: string[];
    diarization_skipped?: boolean;
    diarizationSkipped?: boolean;
    diarization_applied?: boolean;
    diarizationApplied?: boolean;
    diarization_requested?: boolean;
    diarizationRequested?: boolean;
    diarization_skip_message?: string;
    diarizationSkipMessage?: string;
    diarization_skip_reason?: string;
    diarizationSkipReason?: string;
    diarization_deferred?: boolean;
    diarizationDeferred?: boolean;
    diarization_defer_message?: string;
    diarizationDeferMessage?: string;
    selected_report_template_id?: string;
    selectedReportTemplateId?: string;
    report_template?: ReportTemplate;
    reportTemplate?: ReportTemplate;
    selected_context_template_id?: string;
    selectedContextTemplateId?: string;
    context_template?: ContextTemplate;
    contextTemplate?: ContextTemplate;
    selected_term_glossary_ids?: string[];
    selectedTermGlossaryIds?: string[];
    term_glossaries?: TermGlossary[];
    termGlossaries?: TermGlossary[];
    meeting?: {
        source_file?: string;
        job_id?: string;
        meeting_purpose?: string;
        selected_report_template_id?: string;
        report_template?: ReportTemplate;
        selected_context_template_id?: string;
        context_template?: ContextTemplate;
        selected_term_glossary_ids?: string[];
        term_glossaries?: TermGlossary[];
    };
    outputs?: {
        job_id?: string;
        json?: string | null;
        txt?: string | null;
        md?: string | null;
        docx?: string | null;
        hwpx?: string | null;
        audio?: string | null;
    };
    auto_saved_files?: Partial<Record<'hwpx' | 'audio', string>>;
    auto_save_errors?: Partial<Record<'hwpx' | 'audio', string>>;
    action?: string;
    resume?: {
        requested?: boolean;
        mode?: string;
        message?: string;
        fallback_reason?: string | null;
        reused_chunk_count?: number;
    };
}

const meetingHasTranscript = (meeting: MeetingRecord): boolean => (
    Boolean(meeting.displaySegments?.length) || Boolean(meeting.segments?.length)
);

const isLegacySavedMeeting = (meeting: MeetingRecord): boolean => (
    meeting.analysisStatus == null
    && (meetingHasTranscript(meeting) || Boolean(meeting.confirmedMinutes) || Boolean(meeting.meetingReport))
);

const isKeptAnalysisMeeting = (meeting: MeetingRecord): boolean => (
    meeting.analysisStatus === 'completed'
    || meeting.analysisStatus === 'diarization_stopped'
    || meeting.analysisStatus === 'diarization_failed'
    || isLegacySavedMeeting(meeting)
    || Boolean(meeting.jobId && meeting.id !== meeting.jobId)
    || meetingHasUserResult(meeting)
);

const isSettledAnalysisMeeting = (meeting: MeetingRecord): boolean => (
    meeting.analysisStatus === 'diarization_stopped'
    || meeting.analysisStatus === 'diarization_failed'
);

const hasItems = <T,>(items: T[] | undefined): items is T[] => Boolean(items?.length);

const meetingHasUserResult = (meeting: MeetingRecord): boolean => {
    const summaryState = meeting.generationStatus?.summary;
    return Boolean(
        (meeting.summary?.trim() && (summaryState === 'completed' || summaryState === 'skipped'))
        || hasItems(meeting.topicSections)
        || hasItems(meeting.participantSummaries)
        || hasItems(meeting.speakerContextSummaries)
        || meeting.confirmedMinutes
        || meeting.meetingReport
        || meeting.transcriptEditMeta?.edited
    );
};

const segmentSignature = (segments: MeetingSegment[] | undefined): string => JSON.stringify(
    (segments ?? []).map(segment => [segment.start, segment.end, segment.speaker, segment.text]),
);

const shownTranscriptSignature = (
    meeting: Pick<MeetingRecord, 'editedDisplaySegments' | 'displaySegments' | 'segments'>,
): string => (
    hasItems(meeting.editedDisplaySegments)
        ? segmentSignature(meeting.editedDisplaySegments)
        : segmentSignature(meeting.displaySegments?.length ? meeting.displaySegments : meeting.segments)
);

const preferKeptList = <T,>(
    preserve: boolean,
    kept: T[] | undefined,
    incoming: T[] | undefined,
): T[] | undefined => (
    preserve && hasItems(kept) ? kept : incoming
);

export const upsertMeetingRecord = async (record: MeetingRecord): Promise<string> => {
    const meetings = await getAllMeetings();
    const matches = meetings.filter(meeting => (
        meeting.id === record.id
        || Boolean(record.jobId && meeting.jobId === record.jobId)
    ));
    const byMostRecentlyUpdated = (latest: MeetingRecord | undefined, meeting: MeetingRecord): MeetingRecord => {
        if (!latest) return meeting;
        const latestUpdatedAt = Date.parse(latest.updatedAt || latest.createdAt || latest.date) || 0;
        const meetingUpdatedAt = Date.parse(meeting.updatedAt || meeting.createdAt || meeting.date) || 0;
        return meetingUpdatedAt > latestUpdatedAt ? meeting : latest;
    };
    const latestExisting = matches.reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined);
    if (latestExisting) {
        const completedExisting = matches
            .filter(meeting => meeting.analysisStatus === 'completed' || isLegacySavedMeeting(meeting))
            .reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined);
        const incomingRecord = completedExisting && record.analysisStatus !== 'completed'
            ? completedExisting
            : record;
        const userEditedMatches = matches.filter(meeting => (
            meeting.id !== meeting.jobId
            || Boolean(meeting.folderId)
            || meeting.pinned !== undefined
            || Boolean(meeting.editedDisplaySegments?.length)
            || Boolean(meeting.transcriptEditMeta?.edited)
            || Boolean(meeting.transcriptEditMeta?.editedAt)
            || Boolean(meeting.confirmedMinutes)
            || Boolean(meeting.meetingReport)
            || Boolean(Object.keys(meeting.speakerLabels || {}).length)
        ));
        const userEdited = userEditedMatches.reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined)
            || latestExisting;
        const existing = userEdited || latestExisting;
        const settledExisting = matches
            .filter(isSettledAnalysisMeeting)
            .reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined);
        const userResultExisting = matches
            .filter(meetingHasUserResult)
            .reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined);
        const contentSource = [settledExisting, userResultExisting]
            .filter((meeting): meeting is MeetingRecord => Boolean(meeting))
            .reduce<MeetingRecord | undefined>(byMostRecentlyUpdated, undefined);
        const preserveSettledContent = Boolean(
            contentSource && incomingRecord.analysisStatus !== 'completed',
        );
        const keptTopicSections = preferKeptList(
            preserveSettledContent,
            contentSource?.topicSections,
            incomingRecord.topicSections,
        );
        const keptParticipantSummaries = preferKeptList(
            preserveSettledContent,
            contentSource?.participantSummaries,
            incomingRecord.participantSummaries,
        );
        const keptSpeakerContextSummaries = preferKeptList(
            preserveSettledContent,
            contentSource?.speakerContextSummaries,
            incomingRecord.speakerContextSummaries,
        );
        const summaryState = contentSource?.generationStatus?.summary;
        const keepSummary = Boolean(
            preserveSettledContent
            && contentSource?.summary?.trim()
            && (summaryState === 'completed' || summaryState === 'skipped')
        );
        const keepTopics = keptTopicSections === contentSource?.topicSections && hasItems(contentSource?.topicSections);
        const keepSpeakerContext = keptSpeakerContextSummaries === contentSource?.speakerContextSummaries
            && hasItems(contentSource?.speakerContextSummaries);
        const keepParticipantContext = keptParticipantSummaries === contentSource?.participantSummaries
            && hasItems(contentSource?.participantSummaries);
        const settledGenerationStatus = contentSource?.generationStatus;
        const generationStatus = (() => {
            if (!preserveSettledContent) return incomingRecord.generationStatus;
            const next: MeetingGenerationStatus = { ...incomingRecord.generationStatus };
            if (keepSummary) next.summary = settledGenerationStatus?.summary ?? 'completed';
            if (keepTopics) {
                next.topicSections = settledGenerationStatus?.topicSections ?? settledGenerationStatus?.topic_sections ?? 'completed';
                delete next.topic_sections;
            }
            if (keepSpeakerContext) {
                next.speakerContextSummaries = settledGenerationStatus?.speakerContextSummaries
                    ?? settledGenerationStatus?.speaker_context_summaries
                    ?? 'completed';
                delete next.speaker_context_summaries;
            }
            return next;
        })();
        const keptActions = preferKeptList(preserveSettledContent, contentSource?.actions, incomingRecord.actions);
        const keptDecisions = preferKeptList(preserveSettledContent, contentSource?.decisions, incomingRecord.decisions);
        const keptNeedsCheck = preferKeptList(preserveSettledContent, contentSource?.needsCheck, incomingRecord.needsCheck);
        const keptTopics = preferKeptList(preserveSettledContent, contentSource?.topics, incomingRecord.topics);
        const keptEditedSegments = userEdited.editedDisplaySegments?.length
            ? userEdited.editedDisplaySegments
            : existing.editedDisplaySegments;
        const transcriptChanged = Boolean(
            preserveSettledContent
            && contentSource
            && shownTranscriptSignature(contentSource) !== shownTranscriptSignature({
                editedDisplaySegments: keptEditedSegments,
                displaySegments: incomingRecord.displaySegments,
                segments: incomingRecord.segments,
            }),
        );
        const baseTranscriptEditMeta = Object.keys(userEdited.transcriptEditMeta || {}).length > 0
            ? userEdited.transcriptEditMeta
            : existing.transcriptEditMeta;
        const completedReplacesShownTranscript = incomingRecord.analysisStatus === 'completed' && !hasItems(keptEditedSegments);
        const transcriptEditMeta = transcriptChanged
            ? {
                ...baseTranscriptEditMeta,
                summaryOutdated: keepSummary || Boolean(baseTranscriptEditMeta?.summaryOutdated),
                topicSectionsOutdated: keepTopics || Boolean(baseTranscriptEditMeta?.topicSectionsOutdated),
                speakerContextOutdated: keepParticipantContext || keepSpeakerContext || Boolean(baseTranscriptEditMeta?.speakerContextOutdated),
            }
            : completedReplacesShownTranscript
                ? {
                    ...baseTranscriptEditMeta,
                    summaryOutdated: false,
                    topicSectionsOutdated: false,
                    speakerContextOutdated: false,
                }
                : baseTranscriptEditMeta;
        await updateMeeting({
            ...incomingRecord,
            summary: keepSummary && contentSource ? contentSource.summary : incomingRecord.summary,
            topicSections: keptTopicSections,
            participantSummaries: keptParticipantSummaries,
            speakerContextSummaries: keptSpeakerContextSummaries,
            actions: keptActions,
            decisions: keptDecisions,
            needsCheck: keptNeedsCheck,
            topics: keptTopics,
            generationStatus,
            id: existing.id,
            date: userEdited.date || existing.date || incomingRecord.date,
            title: userEdited.title || existing.title || incomingRecord.title,
            meetingPurpose: userEdited.meetingPurpose ?? existing.meetingPurpose ?? incomingRecord.meetingPurpose,
            createdAt: existing.createdAt,
            folderId: userEdited.folderId ?? existing.folderId,
            pinned: userEdited.pinned ?? existing.pinned,
            sourceFile: userEdited.sourceFile || existing.sourceFile || incomingRecord.sourceFile,
            speakerLabels: Object.keys(userEdited.speakerLabels || {}).length > 0
                ? userEdited.speakerLabels
                : existing.speakerLabels ?? incomingRecord.speakerLabels,
            editedDisplaySegments: keptEditedSegments,
            transcriptEditMeta,
            confirmedMinutes: userEdited.confirmedMinutes ?? existing.confirmedMinutes,
            meetingReport: userEdited.meetingReport ?? existing.meetingReport,
        });
        await Promise.all(
            matches
                .filter(meeting => meeting.id !== existing.id)
                .map(meeting => deleteMeeting(meeting.id)),
        );
        return existing.id;
    }
    await addMeeting(record);
    return record.id;
};

export const deleteMeetingRecordForJob = async (jobId: string): Promise<void> => {
    const meetings = await getAllMeetings();
    const matches = meetings.filter(meeting => meeting.id === jobId || meeting.jobId === jobId);
    const deletions = matches.filter(meeting => !isKeptAnalysisMeeting(meeting));
    const inProgressKept = matches.filter(meeting => (
        isKeptAnalysisMeeting(meeting)
        && meeting.analysisStatus === 'diarization_in_progress'
    ));
    await Promise.all(deletions.map(meeting => deleteMeeting(meeting.id)));
    await Promise.all(inProgressKept.map(meeting => updateMeeting({
        ...meeting,
        analysisStatus: 'diarization_stopped',
    })));
};

export const updateMeetingAnalysisStatus = async (
    jobId: string,
    analysisStatus: NonNullable<MeetingRecord['analysisStatus']>,
): Promise<void> => {
    const meeting = (await getAllMeetings()).find(item => item.id === jobId || item.jobId === jobId);
    if (!meeting) return;
    const meetingId = await upsertMeetingRecord({ ...meeting, analysisStatus });
    window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: meetingId, openHistory: false },
    }));
};

export const meetingRecordFromSavedAnalysis = (
    data: AnalyzeResult,
    draft: AnalysisResumeDraft,
): MeetingRecord => ({
    id: draft.jobId,
    date: draft.date.replace('T', ' '),
    title: draft.title.trim(),
    participants: draft.participants || '',
    meetingPurpose: draft.meetingPurpose?.trim() || '',
    selectedReportTemplateId: data.selectedReportTemplateId
        || data.selected_report_template_id
        || draft.selectedReportTemplateId
        || DEFAULT_REPORT_TEMPLATE_ID,
    reportTemplate: data.reportTemplate
        || data.report_template
        || draft.reportTemplate
        || getReportTemplateById(DEFAULT_REPORT_TEMPLATE_ID),
    selectedContextTemplateId: data.selectedContextTemplateId
        || data.selected_context_template_id
        || DEFAULT_CONTEXT_TEMPLATE_ID,
    contextTemplate: data.contextTemplate
        || data.context_template
        || getContextTemplateById(DEFAULT_CONTEXT_TEMPLATE_ID),
    selectedTermGlossaryIds: data.selectedTermGlossaryIds
        || data.selected_term_glossary_ids
        || draft.selectedTermGlossaryIds
        || [],
    termGlossaries: data.termGlossaries
        || data.term_glossaries
        || draft.termGlossaries
        || [],
    summary: data.summary || '대화록을 저장했습니다.',
    segments: data.segments || [],
    displaySegments: data.displaySegments || data.display_segments || [],
    speakerLabels: {},
    sourceFile: data.source_file || draft.sourceFilename,
    jobId: data.job_id || draft.jobId,
    topics: data.topics || [],
    topicSections: data.topicSections || data.topic_sections || [],
    participantSummaries: data.participantSummaries || data.participant_summaries || [],
    speakerContextSummaries: data.speakerContextSummaries || data.speaker_context_summaries || [],
    generationStatus: data.generationStatus || data.generation_status || {},
    actions: data.actions || [],
    decisions: data.decisions || [],
    needsCheck: data.needsCheck || data.needs_check || [],
    analysisStatus: data.partial
        ? draft.status === 'failed'
            ? 'diarization_failed'
            : draft.status === 'stopped' || draft.status === 'cancelled'
                ? 'diarization_stopped'
                : 'diarization_in_progress'
        : 'completed',
    diarizationSkipped: data.diarizationSkipped ?? data.diarization_skipped ?? false,
    diarizationApplied: data.diarizationApplied ?? data.diarization_applied ?? false,
    diarizationRequested: data.diarizationRequested ?? data.diarization_requested ?? true,
    diarizationSkipMessage: data.diarizationSkipMessage || data.diarization_skip_message || '',
    diarizationSkipReason: data.diarizationSkipReason || data.diarization_skip_reason || '',
    diarizationDeferred: data.diarizationDeferred ?? data.diarization_deferred ?? false,
    diarizationDeferMessage: data.diarizationDeferMessage || data.diarization_defer_message || '',
    outputFiles: data.outputs,
});

export interface DraftStatusPayload {
    drafts?: Array<{
        job_id: string;
        status: 'active' | 'cancelled' | 'failed' | 'completed' | 'stopped' | 'missing';
        stage?: string;
        updated_at?: string;
        resume_supported?: boolean;
        completed_chunk_count?: number;
        last_progress?: {
            message?: string;
            progress?: number;
            status?: string;
            transcript_ready?: boolean;
            transcriptReady?: boolean;
            eta_seconds?: number | null;
            etaSeconds?: number | null;
        };
        last_error?: string;
    }>;
}
