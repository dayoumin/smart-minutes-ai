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
    instructions?: string;
    sections?: string[];
    requiredSections?: string[];
    optionalSections?: string[];
    tone?: string;
    detailLevel?: string;
    updatedAt?: string;
    builtIn?: boolean;
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
    folderId?: string;
    createdAt?: string;
    updatedAt?: string;
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
        templateName?: string;
        templateSnapshot?: MeetingReportTemplate;
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
    analysisStatus?: 'diarization_in_progress' | 'diarization_failed' | 'diarization_stopped' | 'completed';
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
    folder_id?: string;
    created_at?: string;
    updated_at?: string;
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
    folderId: record.folderId ?? record.folder_id,
    createdAt: record.createdAt ?? record.created_at ?? record.date,
    updatedAt: record.updatedAt ?? record.updated_at ?? record.createdAt ?? record.created_at ?? record.date,
});

export interface MeetingFolder {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    pinned?: boolean;
    sortOrder?: number;
}

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
const FOLDER_STORE_NAME = 'folders';
const DB_VERSION = 2;
const normalizeFolderName = (name: string): string => name.trim().toLocaleLowerCase('ko-KR');

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
            if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) {
                db.createObjectStore(FOLDER_STORE_NAME, { keyPath: 'id' });
            }
        };
    });
};

export const getAllMeetings = async (): Promise<MeetingRecord[]> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME, FOLDER_STORE_NAME], 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        const folderRequest = transaction.objectStore(FOLDER_STORE_NAME).getAll();
        let result: MeetingRecord[] = [];
        let folderIds = new Set<string>();
        request.onsuccess = () => {
            result = (request.result as StoredMeetingRecord[]).map(normalizeMeetingRecord);
        };
        folderRequest.onsuccess = () => {
            folderIds = new Set((folderRequest.result as MeetingFolder[]).map(folder => folder.id));
        };
        transaction.oncomplete = () => {
            db.close();
            resolve(result.map(record => record.folderId && !folderIds.has(record.folderId)
                ? { ...record, folderId: undefined }
                : record));
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error ?? folderRequest.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error ?? folderRequest.error);
        };
    });
};

export const addMeeting = async (meeting: MeetingRecord): Promise<void> => {
    const now = new Date().toISOString();
    const storedMeeting: MeetingRecord = {
        ...meeting,
        createdAt: meeting.createdAt ?? now,
        updatedAt: meeting.updatedAt ?? now,
    };
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(storedMeeting);
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
        const request = store.put({
            ...meeting,
            createdAt: meeting.createdAt ?? existing.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
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

export const updateMeetingPinned = async (meetingId: string, pinned: boolean): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(meetingId);
        let updated = false;
        request.onsuccess = () => {
            const meeting = request.result as StoredMeetingRecord | undefined;
            if (!meeting) {
                transaction.abort();
                return;
            }
            updated = true;
            store.put({
                ...meeting,
                pinned,
                updatedAt: new Date().toISOString(),
            }).onerror = () => transaction.abort();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            if (updated) resolve();
            else reject(new Error('수정할 회의록을 찾을 수 없습니다.'));
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error ?? new Error('회의록 고정 상태를 바꾸지 못했습니다.'));
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

export const getAllMeetingFolders = async (): Promise<MeetingFolder[]> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDER_STORE_NAME, 'readonly');
        const request = transaction.objectStore(FOLDER_STORE_NAME).getAll();
        let folders: MeetingFolder[] = [];
        request.onsuccess = () => {
            folders = request.result as MeetingFolder[];
        };
        transaction.oncomplete = () => {
            db.close();
            resolve(folders);
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

export const addMeetingFolder = async (name: string): Promise<MeetingFolder> => {
    const now = new Date().toISOString();
    const folder: MeetingFolder = {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: now,
        updatedAt: now,
    };
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDER_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(FOLDER_STORE_NAME);
        const request = store.getAll();
        let failure: Error | null = null;
        request.onsuccess = () => {
            const existingFolders = request.result as MeetingFolder[];
            const duplicate = existingFolders
                .some(existing => normalizeFolderName(existing.name) === normalizeFolderName(folder.name));
            if (duplicate) {
                failure = new Error('같은 이름의 폴더가 이미 있습니다.');
                transaction.abort();
                return;
            }
            const orderedFolders = existingFolders.slice().sort((a, b) => {
                if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
                const aOrder = Number.isFinite(a.sortOrder) ? a.sortOrder as number : Number.MAX_SAFE_INTEGER;
                const bOrder = Number.isFinite(b.sortOrder) ? b.sortOrder as number : Number.MAX_SAFE_INTEGER;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.name.localeCompare(b.name, 'ko');
            });
            orderedFolders.forEach((existing, index) => {
                if (existing.sortOrder === index) return;
                store.put({
                    ...existing,
                    sortOrder: index,
                    updatedAt: new Date().toISOString(),
                }).onerror = () => transaction.abort();
            });
            folder.sortOrder = orderedFolders.length;
            store.add(folder).onerror = () => transaction.abort();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve(folder);
        };
        transaction.onerror = () => {
            db.close();
            reject(failure ?? transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(failure ?? transaction.error ?? request.error);
        };
    });
};

export const renameMeetingFolder = async (folderId: string, name: string): Promise<MeetingFolder> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDER_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(FOLDER_STORE_NAME);
        const request = store.getAll();
        let updatedFolder: MeetingFolder | null = null;
        let failure: Error | null = null;
        request.onsuccess = () => {
            const folders = request.result as MeetingFolder[];
            const folder = folders.find(existing => existing.id === folderId);
            if (!folder) {
                failure = new Error('폴더를 찾을 수 없습니다.');
                transaction.abort();
                return;
            }
            const duplicate = folders.some(existing => (
                existing.id !== folderId
                && normalizeFolderName(existing.name) === normalizeFolderName(name)
            ));
            if (duplicate) {
                failure = new Error('같은 이름의 폴더가 이미 있습니다.');
                transaction.abort();
                return;
            }
            updatedFolder = {
                ...folder,
                name: name.trim(),
                updatedAt: new Date().toISOString(),
            };
            store.put(updatedFolder);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            if (updatedFolder) resolve(updatedFolder);
            else reject(new Error('폴더를 찾을 수 없습니다.'));
        };
        transaction.onerror = () => {
            db.close();
            reject(failure ?? transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(failure ?? transaction.error ?? request.error ?? new Error('폴더 이름을 바꾸지 못했습니다.'));
        };
    });
};

export const updateMeetingFolderPinned = async (folderId: string, pinned: boolean): Promise<MeetingFolder> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDER_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(FOLDER_STORE_NAME);
        const request = store.get(folderId);
        let updatedFolder: MeetingFolder | null = null;
        request.onsuccess = () => {
            const folder = request.result as MeetingFolder | undefined;
            if (!folder) {
                transaction.abort();
                return;
            }
            updatedFolder = {
                ...folder,
                pinned,
                updatedAt: new Date().toISOString(),
            };
            store.put(updatedFolder);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            if (updatedFolder) resolve(updatedFolder);
            else reject(new Error('폴더를 찾을 수 없습니다.'));
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? request.error ?? new Error('폴더 고정 상태를 바꾸지 못했습니다.'));
        };
    });
};

export const reorderMeetingFolders = async (folderIds: string[]): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDER_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(FOLDER_STORE_NAME);
        const request = store.getAll();
        const orderById = new Map(folderIds.map((id, index) => [id, index]));
        request.onsuccess = () => {
            (request.result as MeetingFolder[]).forEach(folder => {
                const sortOrder = orderById.get(folder.id);
                if (sortOrder === undefined) return;
                store.put({
                    ...folder,
                    sortOrder,
                    updatedAt: new Date().toISOString(),
                });
            });
        };
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
            reject(transaction.error ?? request.error ?? new Error('폴더 순서를 바꾸지 못했습니다.'));
        };
    });
};

export const moveMeetingToFolder = async (meetingId: string, folderId?: string): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME, FOLDER_STORE_NAME], 'readwrite');
        const meetingStore = transaction.objectStore(STORE_NAME);
        const folderStore = transaction.objectStore(FOLDER_STORE_NAME);
        const meetingRequest = meetingStore.get(meetingId);

        const move = () => {
            const record = meetingRequest.result as StoredMeetingRecord | undefined;
            if (!record) {
                transaction.abort();
                return;
            }
            meetingStore.put({
                ...record,
                folderId: folderId || undefined,
                folder_id: undefined,
                updatedAt: new Date().toISOString(),
            });
        };

        meetingRequest.onsuccess = () => {
            if (!folderId) {
                move();
                return;
            }
            const folderRequest = folderStore.get(folderId);
            folderRequest.onsuccess = () => {
                if (!folderRequest.result) {
                    transaction.abort();
                    return;
                }
                move();
            };
            folderRequest.onerror = () => transaction.abort();
        };
        meetingRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? new Error('회의록 폴더를 변경하지 못했습니다.'));
        };
    });
};

export const deleteMeetingFolder = async (folderId: string): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME, FOLDER_STORE_NAME], 'readwrite');
        const meetingStore = transaction.objectStore(STORE_NAME);
        const folderStore = transaction.objectStore(FOLDER_STORE_NAME);
        const meetingsRequest = meetingStore.getAll();
        meetingsRequest.onsuccess = () => {
            (meetingsRequest.result as StoredMeetingRecord[])
                .filter(record => (record.folderId ?? record.folder_id) === folderId)
                .forEach(record => meetingStore.put({
                    ...record,
                    folderId: undefined,
                    folder_id: undefined,
                    updatedAt: new Date().toISOString(),
                }));
            folderStore.delete(folderId);
        };
        meetingsRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? new Error('폴더를 삭제하지 못했습니다.'));
        };
    });
};
