import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauriRuntime, toApiUrl } from './apiBase';
import { localEngineClient } from './localEngineClient';
import { createLocalAudioPlaybackSource } from './localAudioPlayback';
import type { LocalAudioPlaybackSource } from './localAudioPlayback';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';

type AudioAvailability = 'idle' | 'checking' | 'available' | 'missing' | 'error';
interface PlaybackState { key: string; sourceUrl: string; availability: AudioAvailability; error: string; }
interface PlaybackOwner { key: string; controller: AbortController; source?: LocalAudioPlaybackSource; }
interface MeetingAudioPlayback {
    sourceUrl: string; availability: AudioAvailability; error: string;
    retry: () => void; markMissing: () => void; reportPlaybackError: () => void;
}
const confirmationError = '음성을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
const playbackError = '음성을 재생하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';

export const useMeetingAudioPlayback = (meetingId?: string, jobId?: string, audioReference?: string | null): MeetingAudioPlayback => {
    const { snapshot } = useLocalEngineConnection();
    const key = JSON.stringify([meetingId, jobId, audioReference]);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<PlaybackState>({ key: '', sourceUrl: '', availability: 'idle', error: '' });
    const active = useRef<PlaybackOwner | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        const owner: PlaybackOwner = { key, controller };
        active.current = owner;
        const publish = (patch: Omit<PlaybackState, 'key'>) => {
            if (!controller.signal.aborted) setState({ key, ...patch });
        };
        const load = async () => {
            if (!jobId) { publish({ sourceUrl: '', availability: 'idle', error: '' }); return; }
            if (snapshot.authorization === 'expired' || snapshot.authorization === 'revoked') {
                publish({ sourceUrl: '', availability: 'error', error: confirmationError }); return;
            }
            publish({ sourceUrl: '', availability: 'checking', error: '' });
            const path = '/api/outputs/' + encodeURIComponent(jobId) + '/audio';
            try {
                const response = await localEngineClient.request(path, { method: 'HEAD', signal: controller.signal, timeoutMs: 10000, cache: 'no-store' });
                if (controller.signal.aborted) return;
                if (!response.ok) {
                    publish({ sourceUrl: '', availability: response.status === 404 ? 'missing' : 'error', error: response.status === 404 ? '' : confirmationError });
                    return;
                }
                // Source availability is independent of browser playback preparation.
                publish({ sourceUrl: '', availability: 'available', error: '' });
                if (isTauriRuntime()) {
                    publish({ sourceUrl: await toApiUrl(path), availability: 'available', error: '' });
                    return;
                }
                try {
                    owner.source = await createLocalAudioPlaybackSource(jobId, controller.signal);
                    if (controller.signal.aborted) { owner.source.dispose(); return; }
                    publish({ sourceUrl: owner.source.url, availability: 'available', error: '' });
                } catch {
                    publish({ sourceUrl: '', availability: 'available', error: playbackError });
                }
            } catch { publish({ sourceUrl: '', availability: 'error', error: confirmationError }); }
        };
        void load();
        return () => {
            controller.abort();
            owner.source?.dispose();
            if (active.current === owner) active.current = null;
        };
    }, [key, jobId, snapshot.authorization, attempt]);
    const stopPlayback = useCallback((missing: boolean) => {
        const owner = active.current;
        if (!owner || owner.key !== key) return;
        owner.controller.abort();
        owner.source?.dispose();
        setState({ key, sourceUrl: '', availability: missing ? 'missing' : 'available', error: missing ? '' : playbackError });
    }, [key]);
    const retry = useCallback(() => setAttempt(value => value + 1), []);
    return {
        sourceUrl: state.key === key ? state.sourceUrl : '',
        availability: state.key === key ? state.availability : 'checking',
        error: state.key === key ? state.error : '',
        retry,
        markMissing: useCallback(() => stopPlayback(true), [stopPlayback]),
        reportPlaybackError: useCallback(() => stopPlayback(false), [stopPlayback]),
    };
};
