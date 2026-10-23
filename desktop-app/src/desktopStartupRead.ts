interface StartupReadOptions<T> {
    desktop: boolean;
    signal: AbortSignal;
    timeoutMs?: number;
    retryDelayMs?: number;
    retryResult?: (result: T) => boolean;
}

const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

const readUntilAbort = <T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
        if (signal.aborted) throw aborted();
        return read(signal);
    }).then(result => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
    }, error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
    });
});

const waitForRetry = (delay: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const onAbort = () => {
        clearTimeout(timer);
        reject(aborted());
    };
    const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
});

/** Retry only idempotent metadata/HEAD reads while native services start. Never wrap writes. */
export const readWithDesktopStartupRecovery = async <T>(
    read: (signal: AbortSignal) => Promise<T>,
    { desktop, signal, timeoutMs = 45000, retryDelayMs = 1000, retryResult }: StartupReadOptions<T>,
): Promise<T> => {
    if (signal.aborted) throw aborted();
    if (!desktop) return read(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let lastPendingResult: { value: T } | null = null;
    try {
        while (!controller.signal.aborted) {
            try {
                const result = await readUntilAbort(read, controller.signal);
                if (controller.signal.aborted) throw aborted();
                if (retryResult?.(result)) {
                    lastPendingResult = { value: result };
                    await waitForRetry(retryDelayMs, controller.signal);
                    continue;
                }
                return result;
            } catch (error) {
                if (controller.signal.aborted) {
                    if (!signal.aborted && lastPendingResult) return lastPendingResult.value;
                    throw aborted();
                }
                // HTTP failures and invalid JSON are answers, not startup transport failures.
                const name = error instanceof Error ? error.name : '';
                if (!['TypeError', 'TimeoutError', 'AbortError'].includes(name)) throw error;
                await waitForRetry(retryDelayMs, controller.signal);
            }
        }
        if (!signal.aborted && lastPendingResult) return lastPendingResult.value;
        throw aborted();
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
    }
};
