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
const HEALTH_CHECK_TIMEOUT_MS = 350;
const LOCAL_BACKEND_PORT_START = 17863;
const LOCAL_BACKEND_PORT_ATTEMPTS = 100;

export const writeFrontendLog = async (message: string): Promise<void> => {
    try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return;
        const timestamp = new Date().toISOString();
        await invoke('write_frontend_log', { message: `${timestamp} ${message}` });
    } catch {
        // Diagnostics must never break the user flow.
    }
};

export const setTauriCloseGuardActive = async (active: boolean): Promise<void> => {
    try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return;
        await invoke('set_close_guard_active', { active });
    } catch {
        // Close protection is best-effort; failing here must not break editing or analysis.
    }
};

export const openSavedFileLocation = async (savedPath: string): Promise<void> => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error('데스크탑 앱에서만 저장 폴더를 열 수 있습니다.');
    await invoke('open_saved_file_location', { savedPath });
};

export const openExternalUrl = async (url: string): Promise<void> => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
        await invoke('open_external_url', { url });
        return;
    }

    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
        window.location.href = url;
    }
};

export const isTauriRuntime = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (window.__TAURI__?.core?.invoke) return true;
    return window.location.hostname === 'tauri.localhost' || window.location.protocol === 'tauri:';
};

const getTauriApiBase = async (attempts = 5): Promise<string | null> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const invoke = window.__TAURI__?.core?.invoke;
        if (invoke) {
            const value = await invoke<string>('get_backend_base_url');
            await writeFrontendLog(`apiBase tauri=${value}`);
            return value;
        }
        await sleep(100);
    }
    return null;
};

const isHealthyApiBase = async (baseUrl: string): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
        const response = await fetch(new URL('/api/health', baseUrl), {
            cache: 'no-store',
            signal: controller.signal,
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        window.clearTimeout(timeout);
    }
};

const discoverLocalApiBase = async (): Promise<string | null> => {
    for (let offset = 0; offset < LOCAL_BACKEND_PORT_ATTEMPTS; offset += 1) {
        const candidate = `http://127.0.0.1:${LOCAL_BACKEND_PORT_START + offset}`;
        if (await isHealthyApiBase(candidate)) return candidate;
    }
    return null;
};

const waitForHealthyApiBase = async (baseUrl: string, attempts = 30): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await isHealthyApiBase(baseUrl)) return true;
        await sleep(500);
    }
    return false;
};

export const getApiBase = async (): Promise<string> => {
    const runningInTauri = isTauriRuntime();

    if (!cachedApiBase) {
        cachedApiBase = getTauriApiBase(runningInTauri ? 80 : 5).then(value => {
            if (value) return value;
            if (!runningInTauri && import.meta.env.VITE_API_BASE_URL) {
                return import.meta.env.VITE_API_BASE_URL;
            }
            if (runningInTauri) return discoverLocalApiBase().then(discovered => discovered ?? fallbackApiBase());
            return fallbackApiBase();
        });
    }

    const apiBase = await cachedApiBase;
    if (apiBase !== fallbackApiBase()) return apiBase;

    const retryApiBase = await getTauriApiBase(runningInTauri ? 20 : 5);
    if (retryApiBase) {
        cachedApiBase = Promise.resolve(retryApiBase);
        return retryApiBase;
    }

    if (runningInTauri) {
        const discoveredApiBase = await discoverLocalApiBase();
        if (discoveredApiBase) {
            cachedApiBase = Promise.resolve(discoveredApiBase);
            return discoveredApiBase;
        }
    }

    return apiBase;
};

export const restartDesktopBackend = async (): Promise<string> => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error('데스크탑 앱에서만 분석 서버를 다시 시작할 수 있습니다.');

    const baseUrl = await invoke<string>('restart_backend');
    if (!await waitForHealthyApiBase(baseUrl)) {
        throw new Error('분석 서버를 다시 시작했지만 아직 응답하지 않습니다. 잠시 후 상태 새로고침을 눌러 주세요.');
    }
    cachedApiBase = Promise.resolve(baseUrl);
    await writeFrontendLog(`apiBase restarted=${baseUrl}`);
    return baseUrl;
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
