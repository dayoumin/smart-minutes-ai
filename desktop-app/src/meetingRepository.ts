export interface MeetingSegment {
    start: string;
    end: string;
    speaker: string;
    displaySpeaker?: string;
    text: string;
    timingApproximate?: boolean;
    speakerNeedsReview?: boolean;
    speaker_needs_review?: boolean;
    speakerSplitCoverageGap?: boolean;
    speaker_split_coverage_gap?: boolean;
    speakerSplitCoverageOverlap?: boolean;
    speaker_split_coverage_overlap?: boolean;
    shortSpeakerOverlap?: boolean;
    short_speaker_overlap?: boolean;
    mixedSpeakerSplit?: boolean;
    mixed_speaker_split?: boolean;
    displayOnly?: boolean;
}

export interface TranscriptEditMeta {
    edited?: boolean;
    editedAt?: string;
    summaryOutdated?: boolean;
    topicSectionsOutdated?: boolean;
    speakerContextOutdated?: boolean;
}

export interface MeetingReportTemplate {
    id: string;
    name: string;
    purpose?: string;
    sections?: string[];
    tone?: string;
    detailLevel?: string;
}

export interface MeetingContextTemplate {
    id: string;
    name: string;
    purpose?: string;
    prompt?: string;
    termGlossaryIds?: string[];
    focus?: string[];
    updatedAt?: string;
}

export interface MeetingTermGlossary {
    id: string;
    name: string;
    category: string;
    description?: string;
    entries?: Array<{
        id: string;
        canonical: string;
        variants?: string[];
        description?: string;
        use?: 'summary' | 'correction' | 'both';
        active?: boolean;
    }>;
}

export interface MeetingRecord {
    id: string;
    date: string;
    title: string;
    summary: string;
    participants: string;
    meetingPurpose?: string;
    selectedReportTemplateId?: string;
    reportTemplate?: MeetingReportTemplate;
    selectedContextTemplateId?: string;
    contextTemplate?: MeetingContextTemplate;
    selectedMinutesTemplateId?: string;
    minutesTemplate?: MeetingReportTemplate;
    selectedTermGlossaryIds?: string[];
    termGlossaries?: MeetingTermGlossary[];
    confirmedMinutes?: {
        updatedAt: string;
        segments: MeetingSegment[];
    };
    meetingReport?: {
        templateId: string;
        generatedAt: string;
        content: string;
        sections?: Array<{ title: string; content: string }>;
    };
    segments?: MeetingSegment[];
    displaySegments?: MeetingSegment[];
    editedDisplaySegments?: MeetingSegment[];
    transcriptEditMeta?: TranscriptEditMeta;
    speakerLabels?: Record<string, string>;
    sourceFile?: string;
    jobId?: string;
    pinned?: boolean;
    topics?: string[];
    topicSections?: MeetingTopicSection[];
    participantSummaries?: MeetingParticipantSummary[];
    speakerContextSummaries?: MeetingSpeakerContextSummary[];
    generationStatus?: MeetingGenerationStatus;
    actions?: string[];
    decisions?: string[];
    needsCheck?: string[];
    diarizationSkipped?: boolean;
    diarizationSkipMessage?: string;
    diarizationApplied?: boolean;
    diarizationRequested?: boolean;
    diarizationSkipReason?: string;
    diarizationDeferred?: boolean;
    diarizationDeferMessage?: string;
    outputFiles?: {
        json?: string | null;
        txt?: string | null;
        md?: string | null;
        docx?: string | null;
        hwpx?: string | null;
        audio?: string | null;
    };
}

type StoredMeetingRecord = Partial<MeetingRecord> & {
    topic_sections?: MeetingTopicSection[];
    display_segments?: MeetingSegment[];
    edited_display_segments?: MeetingSegment[];
    speaker_labels?: Record<string, string>;
    participant_summaries?: MeetingParticipantSummary[];
    speaker_context_summaries?: MeetingSpeakerContextSummary[];
    generation_status?: MeetingGenerationStatus;
    needs_check?: string[];
    diarization_skipped?: boolean;
    diarization_skip_message?: string;
    diarization_applied?: boolean;
    diarization_requested?: boolean;
    diarization_skip_reason?: string;
    diarization_deferred?: boolean;
    diarization_defer_message?: string;
    transcript_edit_meta?: TranscriptEditMeta;
    meeting_purpose?: string;
    selected_report_template_id?: string;
    report_template?: MeetingReportTemplate;
    selected_context_template_id?: string;
    context_template?: MeetingContextTemplate;
    selected_minutes_template_id?: string;
    minutes_template?: MeetingReportTemplate;
    selected_term_glossary_ids?: string[];
    term_glossaries?: MeetingTermGlossary[];
    confirmed_minutes?: MeetingRecord['confirmedMinutes'];
    meeting_report?: MeetingRecord['meetingReport'];
};

const normalizeMeetingRecord = (record: StoredMeetingRecord): MeetingRecord => ({
    ...(record as MeetingRecord),
    topicSections: record.topicSections ?? record.topic_sections ?? [],
    displaySegments: record.displaySegments ?? record.display_segments ?? [],
    editedDisplaySegments: record.editedDisplaySegments ?? record.edited_display_segments ?? [],
    speakerLabels: record.speakerLabels ?? record.speaker_labels ?? {},
    participantSummaries: record.participantSummaries ?? record.participant_summaries ?? [],
    speakerContextSummaries: record.speakerContextSummaries ?? record.speaker_context_summaries ?? [],
    generationStatus: record.generationStatus ?? record.generation_status ?? {},
    needsCheck: record.needsCheck ?? record.needs_check ?? [],
    diarizationSkipped: record.diarizationSkipped ?? record.diarization_skipped ?? false,
    diarizationSkipMessage: record.diarizationSkipMessage ?? record.diarization_skip_message ?? '',
    diarizationApplied: record.diarizationApplied ?? record.diarization_applied,
    diarizationRequested: record.diarizationRequested ?? record.diarization_requested,
    diarizationSkipReason: record.diarizationSkipReason ?? record.diarization_skip_reason ?? '',
    diarizationDeferred: record.diarizationDeferred ?? record.diarization_deferred ?? false,
    diarizationDeferMessage: record.diarizationDeferMessage ?? record.diarization_defer_message ?? '',
    transcriptEditMeta: record.transcriptEditMeta ?? record.transcript_edit_meta ?? {},
    meetingPurpose: record.meetingPurpose ?? record.meeting_purpose ?? '',
    selectedReportTemplateId: record.selectedReportTemplateId ?? record.selected_report_template_id ?? 'standard-minutes',
    reportTemplate: record.reportTemplate ?? record.report_template,
    selectedContextTemplateId: record.selectedContextTemplateId ?? record.selected_context_template_id ?? 'general',
    contextTemplate: record.contextTemplate ?? record.context_template,
    selectedMinutesTemplateId: record.selectedMinutesTemplateId ?? record.selected_minutes_template_id ?? 'archive-minutes',
    minutesTemplate: record.minutesTemplate ?? record.minutes_template,
    selectedTermGlossaryIds: record.selectedTermGlossaryIds ?? record.selected_term_glossary_ids ?? [],
    termGlossaries: record.termGlossaries ?? record.term_glossaries ?? [],
    confirmedMinutes: record.confirmedMinutes ?? record.confirmed_minutes,
    meetingReport: record.meetingReport ?? record.meeting_report,
});

export interface MeetingTopicSection {
    topic: string;
    summary: string;
    evidence?: string[];
    actions?: string[];
}

export interface MeetingParticipantSummary {
    participant: string;
    summary: string;
    key_points?: string[];
    actions?: string[];
}

export interface MeetingSpeakerContextSummary {
    speaker: string;
    display_name?: string;
    role_in_meeting?: string;
    summary: string;
    key_points?: string[];
    actions?: string[];
    needs_check?: string[];
}

export interface MeetingGenerationStatus {
    summary?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    topicSections?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    topic_sections?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    speakerContextSummaries?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    speaker_context_summaries?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    meetingReport?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
    meeting_report?: 'not_started' | 'generating' | 'completed' | 'failed' | 'skipped';
}

const DB_NAME = 'MeetingHistoryDB';
const STORE_NAME = 'meetings';
const DB_VERSION = 1;

const initDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
};

export const getAllMeetings = async (): Promise<MeetingRecord[]> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        let result: MeetingRecord[] = [];
        request.onsuccess = () => {
            result = (request.result as StoredMeetingRecord[]).map(normalizeMeetingRecord);
        };
        transaction.oncomplete = () => {
            db.close();
            resolve(result);
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
    });
};

export const addMeeting = async (meeting: MeetingRecord): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(meeting);
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
    });
};

export const getMeetingById = async (id: string): Promise<MeetingRecord | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);
        let result: MeetingRecord | undefined;
        request.onsuccess = () => {
            result = request.result ? normalizeMeetingRecord(request.result as StoredMeetingRecord) : undefined;
        };
        transaction.oncomplete = () => {
            db.close();
            resolve(result);
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
    });
};

export const updateMeeting = async (meeting: MeetingRecord): Promise<void> => {
    const existing = await getMeetingById(meeting.id);
    if (!existing) {
        throw new Error('수정할 회의록을 찾을 수 없습니다.');
    }

    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(meeting);
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
    });
};

export const deleteMeeting = async (id: string): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
    });
};
