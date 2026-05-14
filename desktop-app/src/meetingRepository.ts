export interface MeetingSegment {
    start: string;
    end: string;
    speaker: string;
    displaySpeaker?: string;
    text: string;
    timingApproximate?: boolean;
    displayOnly?: boolean;
}

export interface TranscriptEditMeta {
    edited?: boolean;
    editedAt?: string;
    summaryOutdated?: boolean;
    topicSectionsOutdated?: boolean;
    speakerContextOutdated?: boolean;
}

export interface MeetingRecord {
    id: string;
    date: string;
    title: string;
    summary: string;
    participants: string;
    meetingPurpose?: string;
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
    transcript_edit_meta?: TranscriptEditMeta;
    meeting_purpose?: string;
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
    transcriptEditMeta: record.transcriptEditMeta ?? record.transcript_edit_meta ?? {},
    meetingPurpose: record.meetingPurpose ?? record.meeting_purpose ?? '',
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
    summary?: 'not_started' | 'generating' | 'completed' | 'failed';
    topicSections?: 'not_started' | 'generating' | 'completed' | 'failed';
    topic_sections?: 'not_started' | 'generating' | 'completed' | 'failed';
    speakerContextSummaries?: 'not_started' | 'generating' | 'completed' | 'failed';
    speaker_context_summaries?: 'not_started' | 'generating' | 'completed' | 'failed';
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
