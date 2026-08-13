export type RuntimeKind = 'web-local-engine' | 'tauri-desktop';

export type RuntimeCapability =
    | 'browser-downloads'
    | 'desktop-action-token'
    | 'open-saved-file-location'
    | 'restart-local-engine'
    | 'tauri-close-guard';

export interface RuntimeEnvironment {
    kind: RuntimeKind;
    capabilities: ReadonlySet<RuntimeCapability>;
}

export interface RuntimeDetectionInput {
    hasTauriInvoke?: boolean;
    hostname?: string;
    protocol?: string;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
    interface Window {
        __TAURI__?: {
            core?: {
                invoke?: TauriInvoke;
            };
        };
    }
}

const WEB_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
    'browser-downloads',
]);

const TAURI_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
    'desktop-action-token',
    'open-saved-file-location',
    'restart-local-engine',
    'tauri-close-guard',
]);

export const detectRuntimeEnvironment = ({
    hasTauriInvoke = false,
    hostname = '',
    protocol = '',
}: RuntimeDetectionInput): RuntimeEnvironment => {
    const isTauri = hasTauriInvoke
        || hostname === 'tauri.localhost'
        || protocol === 'tauri:';
    return isTauri
        ? { kind: 'tauri-desktop', capabilities: TAURI_CAPABILITIES }
        : { kind: 'web-local-engine', capabilities: WEB_CAPABILITIES };
};

export const getRuntimeEnvironment = (): RuntimeEnvironment => {
    if (typeof window === 'undefined') {
        return detectRuntimeEnvironment({});
    }
    return detectRuntimeEnvironment({
        hasTauriInvoke: Boolean(window.__TAURI__?.core?.invoke),
        hostname: window.location.hostname,
        protocol: window.location.protocol,
    });
};

export const getTauriInvoke = (): TauriInvoke | undefined => (
    typeof window === 'undefined' ? undefined : window.__TAURI__?.core?.invoke
);

export const runtimeHasCapability = (
    environment: RuntimeEnvironment,
    capability: RuntimeCapability,
): boolean => environment.capabilities.has(capability);
