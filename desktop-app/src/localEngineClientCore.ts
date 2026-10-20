export interface LocalEngineClientDependencies {
    resolveBaseUrl: (signal?: AbortSignal) => Promise<string>;
    resolveRequestHeaders: (signal?: AbortSignal) => Promise<Record<string, string>>;
    fetch: typeof fetch;
    captureAuthorizationRecovery?: (authorization: string) => (() => Promise<LocalEngineAuthorizationRecovery | null>) | null;
    beginProtectedActivity?: (authorization: string, signal?: AbortSignal) => () => void;
}

export interface LocalEngineAuthorizationRecovery {
    authorization: string;
    isCurrent: () => boolean;
    expire: () => void;
}

export interface LocalEngineRequestInit extends RequestInit {
    timeoutMs?: number;
}

export interface LocalEngineClient {
    probe: (init?: LocalEngineRequestInit) => Promise<Response>;
    /** Resolves when the engine answered at all, without reading the (opaque) response. */
    reach: (init?: LocalEngineRequestInit) => Promise<Response>;
    pair: (path: '/api/pair/start' | '/api/pair/complete' | '/api/pair/restore' | '/api/pair/forget', init?: LocalEngineRequestInit) => Promise<Response>;
    session: (
        path: '/api/session/renew' | '/api/session/revoke',
        sessionToken: string,
        init?: LocalEngineRequestInit,
    ) => Promise<Response>;
    request: (path: string, init?: LocalEngineRequestInit) => Promise<Response>;
    stream: (path: string, init?: LocalEngineRequestInit) => Promise<Response>;
    download: (path: string, init?: LocalEngineRequestInit) => Promise<Response>;
}

const mergeHeaders = (
    runtimeHeaders: Record<string, string>,
    requestHeaders?: HeadersInit,
): Headers => {
    const headers = new Headers(requestHeaders);
    new Headers(runtimeHeaders).forEach((value, key) => headers.set(key, value));
    return headers;
};

const withoutCredentials = (headers: Headers): Headers => {
    headers.delete('Authorization');
    headers.delete('X-LMO-Desktop-Action-Token');
    return headers;
};

const awaitWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    return await new Promise<T>((resolve, reject) => {
        const handleAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        signal.addEventListener('abort', handleAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', handleAbort));
    });
};

const resolveEngineApiUrl = (path: string, baseUrl: string): URL => {
    if (!/^\/api(?:\/|$)/.test(path)) {
        throw new TypeError('Local engine requests require a relative /api path.');
    }
    const base = new URL(baseUrl);
    const target = new URL(path, base);
    if (target.origin !== base.origin || !/^\/api(?:\/|$)/.test(target.pathname)) {
        throw new TypeError('Local engine requests cannot leave the configured API boundary.');
    }
    return target;
};

const snapshotRequestBody = (body: BodyInit | null | undefined) => {
    if (body instanceof FormData) {
        const copy = new FormData();
        body.forEach((value, name) => copy.append(name, value));
        return { body: copy, replayable: true };
    }
    if (body instanceof URLSearchParams) return { body: new URLSearchParams(body), replayable: true };
    if (body instanceof ArrayBuffer) return { body: body.slice(0), replayable: true };
    if (ArrayBuffer.isView(body)) {
        return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice(), replayable: true };
    }
    return { body, replayable: body == null || typeof body === 'string' || body instanceof Blob };
};

const isAuthorizationRejection = (response: Response): boolean => (
    response.status === 401 && response.headers.get('WWW-Authenticate')?.trim().toLowerCase() === 'bearer'
);

const isProtectedWork = (path: string, method: string): boolean => method.toUpperCase() === 'POST' && (
    path === '/api/analyze'
    || /^\/api\/outputs\/[^/]+\/generate-(?:summary|diarization|topic-sections|topic-section|speaker-context|report)$/.test(path)
);

const ownResponseActivity = (response: Response, source: ReadableStream<Uint8Array>, finish: () => void): Response => {
    const reader = source.getReader();
    let settled = false;
    const settle = () => { if (!settled) { settled = true; finish(); } };
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const part = await reader.read();
                if (settled) return;
                if (part.done) { controller.close(); settle(); reader.releaseLock(); }
                else controller.enqueue(part.value);
            } catch (error) {
                if (!settled) controller.error(error);
                settle();
                reader.releaseLock();
            }
        },
        async cancel(reason) {
            settle();
            try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(wrapped, {
        url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    return wrapped;
};

export const createLocalEngineClient = (
    dependencies: LocalEngineClientDependencies,
): LocalEngineClient => {
    const execute = async (
        path: string,
        init: LocalEngineRequestInit,
        includeRuntimeHeaders: boolean,
        explicitSessionToken = '',
    ): Promise<Response> => {
        const { timeoutMs, signal: callerSignal, ...requestInit } = init;
        const controller = new AbortController();
        const handleCallerAbort = () => controller.abort();
        const timeout = timeoutMs
            ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
            : null;
        let finishActivity: (() => void) | undefined;
        let responseOwnsActivity = false;
        const finishResponse = (response: Response): Response => {
            if (!finishActivity || !response.ok || !response.body) return response;
            const wrapped = ownResponseActivity(response, response.body, finishActivity);
            responseOwnsActivity = true;
            return wrapped;
        };

        if (callerSignal) {
            if (callerSignal.aborted) controller.abort();
            else callerSignal.addEventListener('abort', handleCallerAbort, { once: true });
        }

        try {
            const baseUrl = await awaitWithAbort(
                dependencies.resolveBaseUrl(controller.signal),
                controller.signal,
            );
            const target = resolveEngineApiUrl(path, baseUrl);
            const runtimeHeaders = includeRuntimeHeaders
                ? await awaitWithAbort(
                    dependencies.resolveRequestHeaders(controller.signal),
                    controller.signal,
                )
                : {};
            const headers = mergeHeaders(runtimeHeaders, requestInit.headers);
            const outgoingHeaders = includeRuntimeHeaders ? headers : withoutCredentials(headers);
            if (explicitSessionToken) outgoingHeaders.set('Authorization', `Bearer ${explicitSessionToken}`);
            const snapshot = snapshotRequestBody(requestInit.body);
            const runtimeAuthorization = new Headers(runtimeHeaders).get('Authorization');
            const recoverAuthorization = includeRuntimeHeaders && runtimeAuthorization?.startsWith('Bearer ')
                && !outgoingHeaders.has('X-LMO-Desktop-Action-Token')
                ? dependencies.captureAuthorizationRecovery?.(runtimeAuthorization)
                : null;
            if (includeRuntimeHeaders && runtimeAuthorization?.startsWith('Bearer ')
                && !outgoingHeaders.has('X-LMO-Desktop-Action-Token')
                && isProtectedWork(target.pathname, requestInit.method ?? 'GET')) {
                // Observe caller abort for the activity without changing fetch's existing abort lifetime.
                finishActivity = dependencies.beginProtectedActivity?.(runtimeAuthorization, callerSignal ?? controller.signal);
            }
            const fetchRequest = (requestHeaders: Headers) => awaitWithAbort(dependencies.fetch(target, {
                ...requestInit,
                body: snapshot.body,
                headers: requestHeaders,
                signal: controller.signal,
            }), controller.signal);
            const response = await fetchRequest(outgoingHeaders);
            if (
                !recoverAuthorization || !isAuthorizationRejection(response)
            ) return finishResponse(response);

            let recovery: LocalEngineAuthorizationRecovery | null;
            try {
                recovery = await awaitWithAbort(
                    recoverAuthorization(), controller.signal,
                );
            } catch {
                if (controller.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
                return response;
            }
            if (!recovery || !snapshot.replayable || !recovery.isCurrent()) return response;
            const currentBase = await awaitWithAbort(dependencies.resolveBaseUrl(controller.signal), controller.signal);
            const currentHeaders = await awaitWithAbort(dependencies.resolveRequestHeaders(controller.signal), controller.signal);
            if (
                new URL(currentBase).origin !== target.origin || !recovery.isCurrent()
                || new Headers(currentHeaders).get('Authorization') !== recovery.authorization
                || new Headers(currentHeaders).has('X-LMO-Desktop-Action-Token')
            ) return response;
            // Only the auth gate's rejection is replayed, never a started stream/network failure.
            void response.body?.cancel().catch(() => {});
            const retried = await fetchRequest(mergeHeaders(currentHeaders, outgoingHeaders));
            if (isAuthorizationRejection(retried)) recovery.expire();
            return finishResponse(retried);
        } finally {
            if (!responseOwnsActivity) finishActivity?.();
            if (timeout !== null) globalThis.clearTimeout(timeout);
            callerSignal?.removeEventListener('abort', handleCallerAbort);
        }
    };

    const request = (path: string, init: LocalEngineRequestInit = {}) => (
        execute(path, init, true)
    );

    return {
        probe: (init = {}) => execute('/api/probe', init, false),
        reach: (init = {}) => execute('/api/probe', { ...init, mode: 'no-cors', credentials: 'omit' }, false),
        pair: (path, init = {}) => execute(path, init, false),
        session: (path, sessionToken, init = {}) => execute(path, init, false, sessionToken),
        request,
        stream: request,
        download: request,
    };
};
