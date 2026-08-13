import { getApiBase, getDesktopActionHeaders } from './apiBase';
import { createLocalEngineClient } from './localEngineClientCore';

export const localEngineClient = createLocalEngineClient({
    resolveBaseUrl: getApiBase,
    resolveRequestHeaders: getDesktopActionHeaders,
    fetch: (input, init) => fetch(input, init),
});
