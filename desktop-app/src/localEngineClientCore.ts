export interface LocalEngineClientDependencies {
    resolveBaseUrl: (signal?: AbortSignal) => Promise<string>;
    resolveRequestHeaders: (signal?: AbortSignal) => Promise<Record<string, string>>;
    fetch: typeof fetch;
}

export interface LocalEngineRequestInit extends RequestInit {
    timeoutMs?: number;
}

export interface LocalEngineClient {
    probe: (init?: LocalEngineRequestInit) => Promise<Response>;
    pair: (path: '/api/pair/start' | '/api/pair/complete', init?: LocalEngineRequestInit) => Promise<Response>;
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

export const createLocalEngineClient = (
    dependencies: LocalEngineClientDependencies,
): LocalEngineClient => {
    const execute = async (
        path: string,
        init: LocalEngineRequestInit,
        includeRuntimeHeaders: boolean,
    ): Promise<Response> => {
        const { timeoutMs, signal: callerSignal, ...requestInit } = init;
        const controller = new AbortController();
        const handleCallerAbort = () => controller.abort();
        const timeout = timeoutMs
            ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
            : null;

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
            return await dependencies.fetch(target, {
                ...requestInit,
                headers: includeRuntimeHeaders ? headers : withoutCredentials(headers),
                signal: controller.signal,
            });
        } finally {
            if (timeout !== null) globalThis.clearTimeout(timeout);
            callerSignal?.removeEventListener('abort', handleCallerAbort);
        }
    };

    const request = (path: string, init: LocalEngineRequestInit = {}) => (
        execute(path, init, true)
    );

    return {
        probe: (init = {}) => execute('/api/probe', init, false),
        pair: (path, init = {}) => execute(path, init, false),
        request,
        stream: request,
        download: request,
    };
};
