export type AppView = 'minutes' | 'history' | 'archive' | 'asr-benchmark';

export const getInitialAppView = (): AppView => (
    import.meta.env.DEV && new URLSearchParams(window.location.search).get('view') === 'archive'
        ? 'archive'
        : 'minutes'
);

// Asked before leaving the current work surface; it may open an app dialog, so callers await it.
export type LeaveGuard = () => boolean | Promise<boolean>;
