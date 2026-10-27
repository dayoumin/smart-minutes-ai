import { getRuntimeEnvironment, getTauriInvoke, type RuntimeKind } from './runtimeEnvironment';

interface ResolvedApiBase {
    base: string;
    // False only for the desktop fallback guess made before native code or discovery answered.
    final: boolean;
}

let cachedApiBase: { runtime: RuntimeKind; value: Promise<ResolvedApiBase> } | null = null;
let cachedDesktopActionToken: Promise<string> | null = null;

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
        const invoke = getTauriInvoke();
        if (!invoke) return;
        const timestamp = new Date().toISOString();
        await invoke('write_frontend_log', { message: `${timestamp} ${message}` });
    } catch {
        // Diagnostics must never break the user flow.
    }
};

export const setTauriCloseGuardActive = async (active: boolean): Promise<void> => {
    try {
        const invoke = getTauriInvoke();
        if (!invoke) return;
        await invoke('set_close_guard_active', { active });
    } catch {
        // Close protection is best-effort; failing here must not break editing or analysis.
    }
};

export const openSavedFileLocation = async (savedPath: string): Promise<void> => {
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('데스크탑 앱에서만 저장 폴더를 열 수 있습니다.');
    await invoke('open_saved_file_location', { savedPath });
};

export const openExternalUrl = async (url: string): Promise<void> => {
    const invoke = getTauriInvoke();
    if (invoke) {
        await invoke('open_external_url', { url });
        return;
    }

    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
        window.location.href = url;
    }
};

/** Native web link navigation preserves the editor even when noopener hides the new-window handle. */
export const openExternalUrlPreservingPage = async (url: string): Promise<void> => {
    if (getTauriInvoke()) return openExternalUrl(url);
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    document.body.append(link);
    try {
        link.click();
    } finally {
        link.remove();
    }
};

export const isTauriRuntime = (): boolean => {
    return getRuntimeEnvironment().kind === 'tauri-desktop';
};

const getDesktopActionToken = async (): Promise<string> => {
    const invoke = getTauriInvoke();
    if (!invoke) return '';
    try {
        return await invoke<string>('get_desktop_action_token');
    } catch {
        return '';
    }
};

export const getDesktopActionHeaders = async (): Promise<Record<string, string>> => {
    if (!isTauriRuntime()) return {};
    if (!cachedDesktopActionToken) {
        cachedDesktopActionToken = getDesktopActionToken();
    }
    const token = await cachedDesktopActionToken;
    return token ? { 'X-LMO-Desktop-Action-Token': token } : {};
};

const getTauriApiBase = async (attempts = 5): Promise<string | null> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const invoke = getTauriInvoke();
        if (invoke) {
            const value = await invoke<string>('get_backend_base_url');
            await writeFrontendLog(`apiBase tauri=${value}`);
            return value;
        }
        await sleep(100);
    }
    return null;
};

// Base discovery cannot use the common client: resolving its base would recurse.
// Only a native restart result is trusted for credentialed health polling; never send
// the desktop token to legacy port-discovery candidates.
const isHealthyApiBase = async (baseUrl: string, authenticatedRestart = false): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
        const response = await fetch(new URL('/api/health', baseUrl), {
            cache: 'no-store',
            signal: controller.signal,
            headers: authenticatedRestart ? await getDesktopActionHeaders() : undefined,
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
        if (await isHealthyApiBase(baseUrl, true)) return true;
        await sleep(500);
    }
    return false;
};

const resolveDesktopApiBase = async (nativeAttempts: number): Promise<ResolvedApiBase> => {
    const nativeBase = await getTauriApiBase(nativeAttempts);
    if (nativeBase) return { base: nativeBase, final: true };
    const discovered = await discoverLocalApiBase();
    return discovered ? { base: discovered, final: true } : { base: fallbackApiBase(), final: false };
};

// Every engine request resolves its base here, so an answered base is cached as final.
// The web build has no native bridge to wait for; only an unanswered desktop guess is retried.
export const getApiBase = async (): Promise<string> => {
    const runtime = getRuntimeEnvironment().kind;

    // A base resolved before a late native bridge appeared belongs to the other runtime.
    if (cachedApiBase?.runtime !== runtime) {
        cachedApiBase = {
            runtime,
            value: runtime === 'tauri-desktop'
                ? resolveDesktopApiBase(80)
                : Promise.resolve({ base: import.meta.env.VITE_API_BASE_URL || fallbackApiBase(), final: true }),
        };
    }

    const cached = cachedApiBase;
    const resolved = await cached.value;
    if (resolved.final) return resolved.base;

    const retried = await resolveDesktopApiBase(20);
    if (retried.final && cachedApiBase === cached) {
        cachedApiBase = { runtime, value: Promise.resolve(retried) };
    }
    return retried.base;
};

export const restartDesktopBackend = async (): Promise<string> => {
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('데스크탑 앱에서만 분석 서버를 다시 시작할 수 있습니다.');

    const baseUrl = await invoke<string>('restart_backend');
    if (!await waitForHealthyApiBase(baseUrl)) {
        throw new Error('분석 서버를 다시 시작했지만 아직 응답하지 않습니다. 잠시 후 상태 새로고침을 눌러 주세요.');
    }
    cachedApiBase = { runtime: 'tauri-desktop', value: Promise.resolve({ base: baseUrl, final: true }) };
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
