export type SettingsScenario = 'ready' | 'missing' | 'downloading' | 'paused' | 'failed' | 'runtime-missing' | 'loading' | 'many-models';

type ApiHandler = (url: URL, init: RequestInit) => Promise<Response>;
let activeHandler: ApiHandler | undefined;
let fenceInstalled = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});

export const installStoryNetworkFence = () => {
    if (fenceInstalled) return;
    fenceInstalled = true;
    // Return a truthy handle so openExternalUrl does not navigate as a fallback.
    window.open = () => window;
    document.addEventListener('click', event => {
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (link instanceof HTMLAnchorElement && new URL(link.href).origin !== window.location.origin) {
            event.preventDefault();
        }
    }, true);
    const fetchAsset = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(request?.url ?? String(input), window.location.href);
        if (url.pathname.startsWith('/api/')) {
            return activeHandler?.(url, {
                ...init,
                method: init.method ?? request?.method,
                signal: init.signal ?? request?.signal,
                body: init.body ?? (request && request.method !== 'GET' ? await request.clone().text() : undefined),
            }) ?? json({ detail: 'Storybook: API fixture is not registered.' }, 501);
        }
        if (url.origin !== window.location.origin) {
            return json({ detail: 'Storybook: external requests are disabled.' }, 501);
        }
        return fetchAsset(input, init);
    };
};

export const configureSettingsScenario = (scenario?: SettingsScenario) => {
    if (!scenario) {
        activeHandler = undefined;
        return;
    }
    const settings = {
        processing: { enable_long_audio_chunking: true, long_audio_chunk_seconds: 600 },
        stt: { device: 'cpu', language: 'ko' },
        preprocessing: { enabled: true, normalize_audio: true, normalization_mode: 'auto', noise_gate: false, trim_silence: false, denoise: false },
        diarization: { enabled: true, generate_during_analysis: true },
        privacy: { preserve_extracted_audio: true, auto_save_hwpx_copy: false, auto_save_audio_copy: false },
        summary: {
            provider: 'ollama', model: 'gemma4:e2b',
            model_options: ['gemma4:e2b', 'gemma4:e4b'].map((model, index) => ({ model, label: index === 0 ? '2B' : '4B', source: 'recommended' })),
            user_models: [] as { model: string; source: string }[],
        },
    };
    if (scenario === 'many-models') settings.summary.user_models = ['example:one', 'example:two', 'example:three'].map(model => ({ model, source: 'user' }));
    let sttInstalled = scenario === 'ready' || scenario === 'runtime-missing' || scenario === 'many-models';
    const installed = new Set(scenario === 'ready' || scenario === 'many-models' ? ['gemma4:e2b'] : []);
    let runtimeAvailable = scenario !== 'runtime-missing';
    const initialStatus = scenario === 'downloading' ? 'running'
        : scenario === 'paused' ? 'cancelled' : scenario === 'failed' ? 'failed' : 'idle';
    const status = (key: string, state = initialStatus) => ({
        key, model: key, active: state === 'running', status: state, message: '',
        downloaded_bytes: state === 'idle' ? 0 : 9_000_000,
        completed: state === 'idle' ? 0 : 9_000_000, total: 3_000_000_000,
        expected_bytes: 3_000_000_000, progress_percent: state === 'idle' ? 0 : 0.3,
        eta_seconds: state === 'running' ? 3600 : null,
        can_resume: state === 'cancelled' || state === 'failed',
        error: state === 'failed' ? 'network connection interrupted' : '',
    });
    let stt = status('stt_faster_whisper');
    const pulls = new Map(['gemma4:e2b', 'gemma4:e4b'].map(model => [model, status(model)]));
    const observedJobs = new Set<string>();
    // Settings currently restores active jobs only. Show a real polling transition
    // into paused/failed, rather than pretending an inactive job was restored.
    const observe = (key: string, value: ReturnType<typeof status>) => {
        if ((scenario === 'paused' || scenario === 'failed') && !observedJobs.has(key)) {
            observedJobs.add(key);
            return status(key, 'running');
        }
        return value;
    };
    const runtime = () => ({
        key: 'ollama_runtime', available: runtimeAvailable, active: false,
        status: runtimeAvailable ? 'completed' : 'idle', message: '', can_resume: false,
    });
    const handler: ApiHandler = async (url, init) => {
        const path = url.pathname;
        const method = init.method ?? 'GET';
        const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {};
        if (path === '/api/health') return json({ ok: true });
        if (path === '/api/settings') {
            if (scenario === 'loading') {
                await new Promise((_, reject) => {
                    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
                    if (init.signal?.aborted) abort();
                    else init.signal?.addEventListener('abort', abort, { once: true });
                });
            }
            if (method === 'PATCH') {
                for (const key of Object.keys(body) as (keyof typeof settings)[]) {
                    Object.assign(settings[key], body[key]);
                }
            }
            return json(settings);
        }
        if (path === '/api/models/status') return json({
            ready: sttInstalled, summary_ready: installed.has(settings.summary.model), errors: [],
            ollama_connection: { status: runtimeAvailable ? 'managed_ready' : 'missing', source: runtimeAvailable ? 'managed' : 'none', executable_available: runtimeAvailable, server_ready: runtimeAvailable, can_auto_start: runtimeAvailable },
            ollama_runtime_status: runtime(),
            models: [
                { key: 'stt_faster_whisper', label: 'STT', installed: sttInstalled, required: true, downloadable: true },
                { key: 'diarization', label: 'Diarization', installed: true, required: true },
                { key: 'llm', installed: installed.size > 0, configured_model: settings.summary.model, installed_model: [...installed][0], installed_models: [...installed], inventory_checked: runtimeAvailable, ollama_available: runtimeAvailable, install_options: settings.summary.model_options },
            ],
            stt_device_status: { gpu_detected: false, gpu_usable: false },
        });
        if (path === '/api/models/download-status') return json(observe('stt_faster_whisper', stt));
        if (path === '/api/models/download') { stt = status('stt_faster_whisper', 'running'); return json(stt); }
        if (path === '/api/models/download/stop') { stt = status('stt_faster_whisper', 'cancelled'); return json(stt); }
        if (path === '/api/models/ollama/pull-status') {
            const model = url.searchParams.get('model') ?? '';
            return json(observe(model, pulls.get(model) ?? status(model, 'idle')));
        }
        if (path === '/api/models/ollama/pull' || path === '/api/models/ollama/pull/stop') {
            const next = status(body.model, path.endsWith('/stop') ? 'cancelled' : 'running');
            pulls.set(body.model, next);
            return json(next);
        }
        if (path === '/api/models/ollama/runtime-status') return json(runtime());
        if (path === '/api/models/ollama/runtime/download') { runtimeAvailable = true; return json(runtime()); }
        if (path === '/api/models/ollama/connect') return json({ connected: runtimeAvailable, status: 'managed_ready' });
        if (path === '/api/models/ollama/search') return json({ results: [], has_more: false });
        if (path === '/api/models/ollama/model' && method === 'DELETE') {
            installed.delete(url.searchParams.get('model') ?? '');
            return json({ success: true });
        }
        return json({ detail: `Storybook: unhandled ${method} ${path}` }, 501);
    };
    activeHandler = handler;
    return () => {
        if (activeHandler === handler) activeHandler = undefined;
        sttInstalled = false;
    };
};
