import { DESKTOP_RELEASE_ORIGIN, parseDesktopReleaseIdentity } from '../../../desktop-app/src/desktopRelease.ts';
import type { DesktopRelease } from '../../../desktop-app/src/desktopRelease.ts';

/** First installs have a separate feed and filename; they must never become update packages. */
export function parseDesktopInstallRelease(value: unknown): DesktopRelease | null {
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
}
