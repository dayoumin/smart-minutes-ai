export type AppView = 'minutes' | 'history' | 'archive' | 'asr-benchmark';

export const getInitialAppView = (): AppView => (
    import.meta.env.DEV && new URLSearchParams(window.location.search).get('view') === 'archive'
        ? 'archive'
        : 'minutes'
);
