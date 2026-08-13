export type AppView = 'start' | 'minutes' | 'history' | 'asr-benchmark';
export type AppShellVariant = 'ocean' | 'document';

export const getAppShellVariant = (view: AppView): AppShellVariant => (
    view === 'start' || view === 'minutes' ? 'ocean' : 'document'
);

export const getInitialAppView = (): AppView => (
    import.meta.env.DEV && new URLSearchParams(window.location.search).get('view') === 'minutes'
        ? 'minutes'
        : 'start'
);
