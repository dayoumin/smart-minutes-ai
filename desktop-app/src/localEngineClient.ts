import { getApiBase, getDesktopActionHeaders } from './apiBase';
import { createLocalEngineClient } from './localEngineClientCore';
import type { LocalEngineAuthorizationRecovery } from './localEngineClientCore';
import { LocalEngineSessionCredentialStore } from './localEngineSession';

export const localEngineSessionCredentials = new LocalEngineSessionCredentialStore();

type AuthorizationRecoveryHandler = (authorization: string) => (() => Promise<LocalEngineAuthorizationRecovery | null>) | null;
let authorizationRecoveryHandler: AuthorizationRecoveryHandler | null = null;

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

export const localEngineClient = createLocalEngineClient({
    resolveBaseUrl: getApiBase,
    resolveRequestHeaders: async () => {
        const desktopHeaders = await getDesktopActionHeaders();
        if (Object.keys(desktopHeaders).length > 0) return desktopHeaders;
        return localEngineSessionCredentials.requestHeaders();
    },
    fetch: (input, init) => fetch(input, init),
    captureAuthorizationRecovery: authorization => authorizationRecoveryHandler?.(authorization) ?? null,
});
