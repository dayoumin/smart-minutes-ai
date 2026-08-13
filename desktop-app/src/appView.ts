export type AppView = 'start' | 'minutes' | 'history' | 'archive' | 'asr-benchmark';
export type AppShellVariant = 'ocean' | 'document';

export const getAppShellVariant = (view: AppView): AppShellVariant => (
    view === 'start' || view === 'minutes' ? 'ocean' : 'document'
);

export const getInitialAppView = (): AppView => (
    import.meta.env.DEV && ['minutes', 'archive'].includes(new URLSearchParams(window.location.search).get('view') ?? '')
        ? new URLSearchParams(window.location.search).get('view') as AppView
        : 'start'
);
