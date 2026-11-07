/** Portable desktop releases have build identities; tauri.conf.json's version is not a release version. */
export interface DesktopReleaseIdentity {
    commit: string;
    generatedAt: string;
}

export interface DesktopRelease extends DesktopReleaseIdentity {
    downloadUrl: string;
    bytes: number;
    sha256: string;
}

export const DESKTOP_RELEASE_ORIGIN = 'https://barorok.ecomarin.workers.dev';
const commitPattern = /^[a-f0-9]{40}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;

const isBuildTimestamp = (value: string): boolean => {
    if (!timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
    // Date.parse normalizes impossible dates such as February 30 instead of rejecting them.
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
        && Number(value.slice(11, 13)) < 24;
};

export const parseDesktopReleaseIdentity = (value: unknown): DesktopReleaseIdentity | null => {
    if (!value || typeof value !== 'object') return null;
    const identity = value as Record<string, unknown>;
    if (typeof identity.commit !== 'string' || !commitPattern.test(identity.commit)
        || typeof identity.generatedAt !== 'string' || !isBuildTimestamp(identity.generatedAt)) return null;
    return { commit: identity.commit, generatedAt: identity.generatedAt };
};

/** Same builds and older build dates never prompt an update; unknown/development builds fail closed. */
export const isNewerDesktopRelease = (latest: unknown, installed: unknown): boolean => {
    const candidate = parseDesktopReleaseIdentity(latest);
    const current = parseDesktopReleaseIdentity(installed);
    return !!candidate && !!current && candidate.commit !== current.commit
        && Date.parse(candidate.generatedAt) > Date.parse(current.generatedAt);
};

export const parseDesktopRelease = (value: unknown): DesktopRelease | null => {
    const identity = parseDesktopReleaseIdentity(value);
    if (!identity) return null;
    const payload = value as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || payload.type !== 'portable-update'
        || payload.origin !== DESKTOP_RELEASE_ORIGIN
        || payload.downloadPath !== `/downloads/lmo_audio_update_${identity.commit}.zip`
        || !Number.isSafeInteger(payload.bytes) || Number(payload.bytes) <= 0
        || typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sha256)) return null;
    return {
        ...identity, downloadUrl: `${DESKTOP_RELEASE_ORIGIN}${payload.downloadPath}`,
        bytes: Number(payload.bytes), sha256: payload.sha256,
    };
};

/** A new installation is a different artifact from an existing installation's update. */
export const parseDesktopInstallRelease = (value: unknown): DesktopRelease | null => {
    const identity = parseDesktopReleaseIdentity(value);
    if (!identity) return null;
    const payload = value as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || payload.type !== 'portable-install'
        || payload.origin !== DESKTOP_RELEASE_ORIGIN
        || payload.downloadPath !== `/downloads/lmo_audio_install_${identity.commit}.zip`
        || !Number.isSafeInteger(payload.bytes) || Number(payload.bytes) <= 0
        || typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sha256)) return null;
    return {
        ...identity, downloadUrl: `${DESKTOP_RELEASE_ORIGIN}${payload.downloadPath}`,
        bytes: Number(payload.bytes), sha256: payload.sha256,
    };
};

export type DesktopInstallLookup =
    | { status: 'available'; release: DesktopRelease }
    | { status: 'unpublished' | 'error' };

/** Read public metadata only; the archive is requested by the user's separate download click. */
export const fetchDesktopInstallRelease = async (signal?: AbortSignal): Promise<DesktopInstallLookup> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 5000);
    try {
        const response = await fetch(`${DESKTOP_RELEASE_ORIGIN}/downloads/desktop-install-beta.json`, {
            signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
            referrerPolicy: 'no-referrer',
        });
        if (response.status === 404) return { status: 'unpublished' };
        if (!response.ok) return { status: 'error' };
        const release = parseDesktopInstallRelease(await response.json());
        return release ? { status: 'available', release } : { status: 'error' };
    } catch {
        return { status: 'error' };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
};

/** Only public release metadata leaves the app. Local credentials and meeting data are never sent. */
export const fetchDesktopRelease = async (signal?: AbortSignal): Promise<DesktopRelease | null> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 5000);
    try {
        const response = await fetch(`${DESKTOP_RELEASE_ORIGIN}/downloads/desktop-beta.json`, {
            signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok) return null;
        return parseDesktopRelease(await response.json());
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
};
