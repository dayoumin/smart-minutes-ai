export interface LocalEngineRelease {
    version: string;
    downloadUrl: string;
}

const parseVersion = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const core = match.slice(1, 4).map(Number);
    const prerelease = match[4]?.split('.') ?? [];
    if (core.some(part => !Number.isSafeInteger(part))
        || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
    return { core, prerelease };
};

/** Unknown versions never trigger a download, and newer installs are never downgraded. */
export const isNewerEngineVersion = (latest: string, installed: string): boolean => {
    const candidate = parseVersion(latest);
    const current = parseVersion(installed);
    if (!candidate || !current) return false;
    for (let index = 0; index < 3; index += 1) {
        if (candidate.core[index] !== current.core[index]) return candidate.core[index] > current.core[index];
    }
    if (!candidate.prerelease.length || !current.prerelease.length) {
        return !candidate.prerelease.length && current.prerelease.length > 0;
    }
    for (let index = 0; index < Math.max(candidate.prerelease.length, current.prerelease.length); index += 1) {
        const left = candidate.prerelease[index];
        const right = current.prerelease[index];
        if (left === right) continue;
        if (left === undefined || right === undefined) return right === undefined;
        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric !== rightNumeric) return !leftNumeric;
        // Numeric prerelease identifiers can exceed JavaScript's safe integer range.
        if (leftNumeric && left.length !== right.length) return left.length > right.length;
        return left > right;
    }
    return false;
};

export const parseLocalEngineRelease = (value: unknown, origin: string): LocalEngineRelease | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Record<string, unknown>;
    if (typeof payload.engineVersion !== 'string' || !parseVersion(payload.engineVersion)
        || payload.origin !== origin
        || typeof payload.downloadPath !== 'string'
        || !/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(payload.downloadPath)
        || !Number.isSafeInteger(payload.bytes) || Number(payload.bytes) <= 0
        || typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sha256)) return null;
    return { version: payload.engineVersion, downloadUrl: new URL(payload.downloadPath, origin).href };
};

/** The website's public release metadata never receives local-engine credentials or meeting data. */
export const fetchLocalEngineRelease = async (
    origin: string,
    signal?: AbortSignal,
): Promise<LocalEngineRelease | null> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 5000);
    try {
        const response = await fetch(new URL('/downloads/engine-beta.json', origin), {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
        });
        if (!response.ok) return null;
        return parseLocalEngineRelease(await response.json(), origin);
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
};
