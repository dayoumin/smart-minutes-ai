import { getApiBase, getDesktopActionHeaders } from './apiBase';
import { createLocalEngineClient } from './localEngineClientCore';
import { LocalEngineSessionCredentialStore } from './localEngineSession';

export const localEngineSessionCredentials = new LocalEngineSessionCredentialStore();

export const localEngineClient = createLocalEngineClient({
    resolveBaseUrl: getApiBase,
    resolveRequestHeaders: async () => {
        const desktopHeaders = await getDesktopActionHeaders();
        if (Object.keys(desktopHeaders).length > 0) return desktopHeaders;
        return localEngineSessionCredentials.requestHeaders();
    },
    fetch: (input, init) => fetch(input, init),
});
