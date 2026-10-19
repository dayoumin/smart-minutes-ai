import { localEngineClient } from './localEngineClient';
import { abortableAudioBody, AUDIO_PLAYBACK_PROTOCOL, audioPlaybackHeaders, parseAudioPlaybackRequest } from './audioPlaybackTransport';

export interface LocalAudioPlaybackSource { url: string; dispose: () => void; }
interface AudioLease { path: string; controllers: Set<AbortController>; }
const leases = new Map<string, AudioLease>();
const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
const scriptUrl = new URL('local-audio-worker.js', baseUrl).href;
let registrationPromise: Promise<void> | null = null;
let listening = false;
const cancellation = () => new DOMException('Audio playback was canceled.', 'AbortError');

const handleAudioRequest = (event: MessageEvent<unknown>) => {
    const port = event.ports[0];
    const source = event.source;
    const request = parseAudioPlaybackRequest(event.data);
    if (!port || !source || !('scriptURL' in source) || source.scriptURL !== scriptUrl
        || event.origin !== window.location.origin || !request) { port?.close(); return; }
    const lease = leases.get(request.leaseId);
    if (!lease) {
        port.postMessage({ protocol: AUDIO_PLAYBACK_PROTOCOL, status: 404, headers: {}, body: null });
        port.close();
        return;
    }
    const controller = new AbortController();
    lease.controllers.add(controller);
    port.onmessage = message => {
        if (message.data?.protocol === AUDIO_PLAYBACK_PROTOCOL && message.data.cancel === true) controller.abort();
    };
    port.start();
    const settle = () => lease.controllers.delete(controller);
    void (async () => {
        let body: ReadableStream<Uint8Array> | null = null;
        try {
            const response = await localEngineClient.download(lease.path, {
                method: request.method, cache: 'no-store', signal: controller.signal,
                headers: request.range ? { Range: request.range } : undefined, timeoutMs: 10000,
            });
            if (controller.signal.aborted || leases.get(request.leaseId) !== lease) {
                void response.body?.cancel().catch(() => {});
                throw cancellation();
            }
            if (request.method !== 'HEAD' && response.body) {
                body = abortableAudioBody(response.body, controller.signal, settle);
            }
            port.postMessage({
                protocol: AUDIO_PLAYBACK_PROTOCOL, status: response.status,
                headers: audioPlaybackHeaders(response.headers), body,
            }, body ? [body] : []);
            if (!body) settle();
        } catch {
            controller.abort();
            settle();
            try { port.postMessage({ protocol: AUDIO_PLAYBACK_PROTOCOL, status: 503, headers: {}, body: null }); }
            catch { /* The requesting media element may already be gone. */ }
        } finally { port.close(); }
    })();
};

const disposeAll = () => {
    for (const lease of leases.values()) for (const controller of lease.controllers) controller.abort();
    leases.clear();
};
const handlePageHide = (event: PageTransitionEvent) => {
    // BFCache retains the document and its audio elements, including their URLs.
    // Keep their leases alive until explicit disposal or permanent departure.
    if (!event.persisted) disposeAll();
};
const ensureWorker = async (): Promise<void> => {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('Audio playback is unavailable.');
    if (!registrationPromise) {
        registrationPromise = (async () => {
            const container = navigator.serviceWorker;
            const existing = await container.getRegistration(baseUrl.href);
            const workers = [existing?.active, existing?.waiting, existing?.installing, container.controller];
            if (workers.some(worker => worker && worker.scriptURL !== scriptUrl)) throw new Error('Audio transport ownership conflict.');
            await container.register(scriptUrl, { scope: baseUrl.pathname, updateViaCache: 'none' });
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => { clearTimeout(timeout); container.removeEventListener('controllerchange', check); };
                const check = () => {
                    if (container.controller?.scriptURL === scriptUrl) { cleanup(); resolve(); }
                };
                const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Audio transport timed out.')); }, 10000);
                container.addEventListener('controllerchange', check);
                check();
            });
            if (!listening) {
                navigator.serviceWorker.addEventListener('message', handleAudioRequest);
                window.addEventListener('pagehide', handlePageHide);
                listening = true;
            }
        })().catch(error => { registrationPromise = null; throw error; });
    }
    await registrationPromise;
};

export const createLocalAudioPlaybackSource = async (
    jobId: string, signal?: AbortSignal,
): Promise<LocalAudioPlaybackSource> => {
    if (signal?.aborted) throw cancellation();
    await ensureWorker();
    if (signal?.aborted) throw cancellation();
    const leaseId = crypto.randomUUID();
    const lease: AudioLease = { path: '/api/outputs/' + encodeURIComponent(jobId) + '/audio', controllers: new Set() };
    leases.set(leaseId, lease);
    const dispose = () => {
        signal?.removeEventListener('abort', dispose);
        if (leases.get(leaseId) !== lease) return;
        leases.delete(leaseId);
        for (const controller of lease.controllers) controller.abort();
        lease.controllers.clear();
    };
    signal?.addEventListener('abort', dispose, { once: true });
    return { url: new URL('__lmo_audio__/' + leaseId, baseUrl).href, dispose };
};

if (import.meta.hot) import.meta.hot.dispose(() => {
    disposeAll();
    if (listening) {
        navigator.serviceWorker.removeEventListener('message', handleAudioRequest);
        window.removeEventListener('pagehide', handlePageHide);
    }
});
