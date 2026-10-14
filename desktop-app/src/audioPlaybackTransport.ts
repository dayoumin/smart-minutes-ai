export const AUDIO_PLAYBACK_PROTOCOL = 'lmo-audio-v1';

export interface AudioPlaybackRequest {
    protocol: typeof AUDIO_PLAYBACK_PROTOCOL;
    leaseId: string;
    method: 'GET' | 'HEAD';
    range: string | null;
}

export const parseAudioPlaybackRequest = (value: unknown): AudioPlaybackRequest | null => {
    if (!value || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    if (data.protocol !== AUDIO_PLAYBACK_PROTOCOL || typeof data.leaseId !== 'string'
        || !/^[a-f0-9-]{36}$/.test(data.leaseId) || (data.method !== 'GET' && data.method !== 'HEAD')) return null;
    if (data.range !== null && (typeof data.range !== 'string' || data.range.length > 100
        || !/^bytes=(?:\d+-\d*|-\d+)$/.test(data.range))) return null;
    return { protocol: AUDIO_PLAYBACK_PROTOCOL, leaseId: data.leaseId, method: data.method, range: data.range };
};

export const audioPlaybackHeaders = (headers: Headers): Record<string, string> => {
    const result: Record<string, string> = { 'Cache-Control': 'no-store' };
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = headers.get(name);
        if (value !== null) result[name] = value;
    }
    return result;
};

// Keep cancellation connected after the shared client has returned response headers.
export const abortableAudioBody = (
    body: ReadableStream<Uint8Array>, signal: AbortSignal, onSettled: () => void,
): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    let ended = false;
    let abort = () => {};
    const settle = () => {
        if (ended) return;
        ended = true;
        signal.removeEventListener('abort', abort);
        onSettled();
    };
    const cancelReader = async (reason?: unknown) => {
        try { await reader.cancel(reason); } catch { /* The source may already have failed. */ }
        finally { reader.releaseLock(); }
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            abort = () => {
                if (ended) return;
                settle();
                const error = new DOMException('Audio playback was canceled.', 'AbortError');
                controller.error(error);
                void cancelReader(error);
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        },
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (ended) return;
                if (chunk.done) { settle(); reader.releaseLock(); controller.close(); }
                else controller.enqueue(chunk.value);
            } catch (error) {
                if (ended) return;
                settle();
                reader.releaseLock();
                controller.error(error);
            }
        },
        async cancel(reason) { settle(); await cancelReader(reason); },
    });
};
