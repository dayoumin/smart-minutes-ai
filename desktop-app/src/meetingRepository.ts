export interface MeetingSegment {
    start: string;
    end: string;
    speaker: string;
    text: string;
    timingApproximate?: boolean;
}

export interface MeetingRecord {
    id: string;
    date: string;
    title: string;
    summary: string;
    participants: string;
    segments?: MeetingSegment[];
    sourceFile?: string;
    jobId?: string;
    topics?: string[];
    actions?: string[];
    outputFiles?: {
        json?: string | null;
        txt?: string | null;
        md?: string | null;
        docx?: string | null;
    };
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
            result = request.result as MeetingRecord[];
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
