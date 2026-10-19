const KEY = 'barorok.localEngineBrowserApproval.v1';
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export const createBrowserApprovalToken = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Persistent browser approval is separate from the short lived in-memory API session. */
export class LocalEngineBrowserCredentialStore {
    private readonly storage: () => BrowserStorage | null;
    private fallback: string | null | undefined;

    constructor(storage: () => BrowserStorage | null = () => (
        typeof window === 'undefined' ? null : window.localStorage
    )) { this.storage = storage; }

    current(): string | null {
        if (this.fallback !== undefined) return this.fallback;
        try {
            const value = this.storage()?.getItem(KEY);
            return isToken(value) ? value : null;
        } catch { return null; }
    }

    replace(token: string): void {
        if (!isToken(token)) return;
        this.fallback = token;
        try {
            const storage = this.storage();
            if (storage) { storage.setItem(KEY, token); this.fallback = undefined; }
        } catch { /* Keep this visit revocable even when persistent storage is blocked. */ }
    }

    clear(): void {
        this.fallback = null;
        try {
            const storage = this.storage();
            if (storage) { storage.removeItem(KEY); this.fallback = undefined; }
        } catch { /* Server revocation remains authoritative. */ }
    }
}
