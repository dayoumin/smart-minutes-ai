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
    if (typeof window === 'undefined') return 'http://127.0.0.1:8000';
    return 'http://127.0.0.1:8000';
};

export const getApiBase = async (): Promise<string> => {
    if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL;

    if (!cachedApiBase) {
        const invoke = window.__TAURI__?.core?.invoke;
        cachedApiBase = invoke
            ? invoke<string>('get_backend_base_url').catch(() => fallbackApiBase())
            : Promise.resolve(fallbackApiBase());
    }

    return cachedApiBase;
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
