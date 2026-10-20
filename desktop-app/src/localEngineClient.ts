import { getApiBase, getDesktopActionHeaders } from './apiBase';
import {
    createLocalEnginePermissionGate,
    getLocalEngineBrowserAccessState,
    pageNeedsLoopbackPermission,
} from './localEngineBrowserAccess';
import { createLocalEngineClient } from './localEngineClientCore';
import { getRuntimeEnvironment } from './runtimeEnvironment';
import type { LocalEngineAuthorizationRecovery } from './localEngineClientCore';
import { LocalEngineSessionCredentialStore } from './localEngineSession';

export const localEngineSessionCredentials = new LocalEngineSessionCredentialStore();

type AuthorizationRecoveryHandler = (authorization: string) => (() => Promise<LocalEngineAuthorizationRecovery | null>) | null;
let authorizationRecoveryHandler: AuthorizationRecoveryHandler | null = null;
type ProtectedActivityHandler = (authorization: string, signal?: AbortSignal) => () => void;
let protectedActivityHandler: ProtectedActivityHandler | null = null;

export const registerLocalEngineProtectedActivity = (handler: ProtectedActivityHandler): (() => void) => {
    protectedActivityHandler = handler;
    return () => { if (protectedActivityHandler === handler) protectedActivityHandler = null; };
};

export const registerLocalEngineAuthorizationRecovery = (handler: AuthorizationRecoveryHandler): (() => void) => {
    authorizationRecoveryHandler = handler;
    return () => {
        if (authorizationRecoveryHandler === handler) authorizationRecoveryHandler = null;
    };
};

export const toLocalEngineApiPath = (url: string): string => {
    if (url.startsWith('/api')) return url;
    const parsed = new URL(url, 'http://127.0.0.1');
    return `${parsed.pathname}${parsed.search}`;
};

const permissionGate = createLocalEnginePermissionGate({
    applies: () => getRuntimeEnvironment().kind === 'web-local-engine' && pageNeedsLoopbackPermission(),
    accessState: () => getLocalEngineBrowserAccessState(),
});

export const localEngineClient = createLocalEngineClient({
    resolveBaseUrl: getApiBase,
    resolveRequestHeaders: async () => {
        const desktopHeaders = await getDesktopActionHeaders();
        if (Object.keys(desktopHeaders).length > 0) return desktopHeaders;
        return localEngineSessionCredentials.requestHeaders();
    },
    fetch: async (input, init) => {
        const response = await fetch(input, init);
        permissionGate.noteResponse();
        return response;
    },
    captureAuthorizationRecovery: authorization => authorizationRecoveryHandler?.(authorization) ?? null,
    beginProtectedActivity: (authorization, signal) => protectedActivityHandler?.(authorization, signal) ?? (() => {}),
    beforeRequest: permissionGate.beforeRequest,
});
