import type { LocalEngineClient } from './localEngineClientCore';

export interface BackendUpdateActivity {
    busy: boolean;
    verified: boolean;
    message?: string;
}

let settingsRequestCount = 0;

/** A request can outlive the settings dialog, so its activity belongs to the request. */
export const beginSettingsUpdateActivity = (): (() => void) => {
    settingsRequestCount += 1;
    window.dispatchEvent(new CustomEvent('backend-task:state', {
        detail: { source: 'settings-requests', active: true },
    }));
    let released = false;
    return () => {
        if (released) return;
        released = true;
        settingsRequestCount -= 1;
        window.dispatchEvent(new CustomEvent('backend-task:state', {
            detail: { source: 'settings-requests', active: settingsRequestCount > 0 },
        }));
    };
};

/** Reads only activity flags through the normal authenticated local engine client. */
export const checkBackendUpdateActivity = async (
    client: Pick<LocalEngineClient, 'request'>,
    signal?: AbortSignal,
): Promise<BackendUpdateActivity> => {
    try {
        const response = await client.request('/api/update-activity', {
            method: 'GET', cache: 'no-store', bufferJson: true, timeoutMs: 5000, signal,
        });
        if (!response.ok) throw new Error('Activity status unavailable');
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object' || typeof (payload as { busy?: unknown }).busy !== 'boolean') {
            throw new Error('Invalid activity status');
        }
        const busy = (payload as { busy: boolean }).busy;
        return {
            busy, verified: true,
            ...(busy ? { message: '진행 중인 작업이 끝난 뒤 업데이트를 받을 수 있습니다.' } : {}),
        };
    } catch {
        return {
            busy: false, verified: false,
            message: '진행 중인 작업을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
        };
    }
};
