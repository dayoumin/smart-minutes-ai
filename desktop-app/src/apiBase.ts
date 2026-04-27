const getLocalApiBase = (): string => {
    if (typeof window === 'undefined') return 'http://127.0.0.1:8000';
    return `http://${window.location.hostname || '127.0.0.1'}:8000`;
};

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? getLocalApiBase();

export const toApiUrl = (url: string): string => {
    const currentBase = new URL(API_BASE);
    const target = new URL(url, currentBase);

    if (target.hostname === 'localhost' || target.hostname === '127.0.0.1') {
        target.hostname = currentBase.hostname;
    }

    return target.toString();
};
