let cachedApiBase: Promise<string> | null = null;

declare global {
    interface Window {
        __TAURI__?: {
            core?: {
                invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
            };
        };
    }
}

const fallbackApiBase = (): string => {
    if (typeof window === 'undefined') return 'http://127.0.0.1:17863';
    return 'http://127.0.0.1:17863';
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

const getTauriApiBase = async (): Promise<string | null> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const invoke = window.__TAURI__?.core?.invoke;
        if (invoke) {
            return invoke<string>('get_backend_base_url');
        }
        await sleep(100);
    }
    return null;
};

export const getApiBase = async (): Promise<string> => {
    if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL;

    if (!cachedApiBase) {
        cachedApiBase = getTauriApiBase().then(value => value || fallbackApiBase());
    }

    const apiBase = await cachedApiBase;
    if (apiBase !== fallbackApiBase()) return apiBase;

    const retryApiBase = await getTauriApiBase();
    if (retryApiBase) {
        cachedApiBase = Promise.resolve(retryApiBase);
        return retryApiBase;
    }

    return apiBase;
};

export const toApiUrl = async (url: string): Promise<string> => {
    const currentBase = new URL(await getApiBase());
    const target = new URL(url, currentBase);

    if (target.hostname === 'localhost' || target.hostname === '127.0.0.1') {
        target.hostname = currentBase.hostname;
    }
    target.port = currentBase.port;
    target.protocol = currentBase.protocol;

    return target.toString();
};
