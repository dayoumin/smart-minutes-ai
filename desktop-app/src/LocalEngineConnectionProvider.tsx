import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    createInitialLocalEngineConnection,
    applyLocalEngineAuthorization,
    applyLocalEngineProbe,
    isLatestTransportCheck,
    LocalEngineConnectionSnapshot,
    LocalEngineTransportState,
    parseLocalEngineProbe,
    updateLocalEngineTransport,
} from './localEngineConnection';
import { getRuntimeEnvironment } from './runtimeEnvironment';
import { localEngineClient, localEngineSessionCredentials, registerLocalEngineAuthorizationRecovery, registerLocalEngineProtectedActivity } from './localEngineClient';
import {
    LocalEngineConnectionCoordinator,
    LocalEnginePairingState,
} from './localEngineConnectionCoordinator';
import {
    parseLocalEnginePairingStart,
    parseLocalEngineSessionCredential,
} from './localEngineSession';
import { LocalEngineConnectionContext } from './LocalEngineConnectionContext';
import { getLocalEngineBrowserAccessState } from './localEngineBrowserAccess';
import { fetchLocalEngineRelease, isNewerEngineVersion, type LocalEngineRelease } from './localEngineRelease';

export const LocalEngineConnectionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const environment = useMemo(() => getRuntimeEnvironment(), []);
    const [snapshot, setSnapshot] = useState<LocalEngineConnectionSnapshot>(() => (
        createInitialLocalEngineConnection(environment.kind)
    ));
    const [latestRelease, setLatestRelease] = useState<LocalEngineRelease | null>(null);
    const [pairingState, setPairingState] = useState<LocalEnginePairingState>({
        phase: 'idle',
        challenge: null,
    });
    const transportCheckIdRef = useRef(0);
    const beginTransportCheck = useCallback(() => {
        const checkId = transportCheckIdRef.current + 1;
        transportCheckIdRef.current = checkId;
        setSnapshot(previous => updateLocalEngineTransport(previous, 'checking'));
        return checkId;
    }, []);
    const reportTransport = useCallback((checkId: number, transport: LocalEngineTransportState) => {
        if (!isLatestTransportCheck(transportCheckIdRef.current, checkId)) return;
        setSnapshot(previous => updateLocalEngineTransport(previous, transport));
    }, []);
    const [coordinator] = useState(() => {
        return new LocalEngineConnectionCoordinator(
            localEngineClient,
            localEngineSessionCredentials,
            {
                onTransport: (transport, detail) => {
                    setSnapshot(previous => updateLocalEngineTransport(
                        previous,
                        transport,
                        Date.now(),
                        detail?.blockedBy,
                    ));
                },
                browserAccessState: () => getLocalEngineBrowserAccessState(),
                onProbe: probe => {
                    setSnapshot(previous => applyLocalEngineProbe(previous, probe));
                },
                onAuthorization: (authorization, capabilities = []) => {
                    setSnapshot(previous => applyLocalEngineAuthorization(
                        previous,
                        authorization,
                        capabilities,
                    ));
                },
                onPairingState: setPairingState,
            },
            {
                probe: parseLocalEngineProbe,
                pairingStart: parseLocalEnginePairingStart,
                sessionCredential: parseLocalEngineSessionCredential,
            },
        );
    });
    const probeLocalEngine = useCallback((options?: { userInitiated?: boolean }) => (
        coordinator.probe(options)
    ), [coordinator]);
    const startPairing = useCallback(() => (
        coordinator.startBrowserApproval()
    ), [coordinator]);
    const completePairing = useCallback((pairingId: string, code: string) => (
        coordinator.completePairing(pairingId, code)
    ), [coordinator]);
    const resetPairing = useCallback((reason?: string) => {
        coordinator.resetPairing(reason);
    }, [coordinator]);
    const renewSession = useCallback(() => (
        coordinator.renewSession()
    ), [coordinator]);
    const revokeSession = useCallback(() => (
        coordinator.revokeSession()
    ), [coordinator]);
    useEffect(() => {
        if (environment.kind !== 'web-local-engine') return;
        const controller = new AbortController();
        let checking = false;
        let lastCheckedAt = 0;
        const checkRelease = async () => {
            if (checking || Date.now() - lastCheckedAt < 60000) return;
            checking = true;
            lastCheckedAt = Date.now();
            const release = await fetchLocalEngineRelease(window.location.origin, controller.signal);
            // A temporary metadata outage keeps the last verified release and never blocks analysis.
            if (!controller.signal.aborted && release) setLatestRelease(release);
            checking = false;
        };
        void checkRelease();
        window.addEventListener('focus', checkRelease);
        return () => {
            controller.abort();
            window.removeEventListener('focus', checkRelease);
        };
    }, [environment.kind]);
    useEffect(() => {
        if (environment.kind !== 'web-local-engine' || snapshot.authorization !== 'authenticated'
            || !snapshot.engineVersion || !latestRelease
            || !isNewerEngineVersion(latestRelease.version, snapshot.engineVersion)) return;
        const controller = new AbortController();
        let checking = false;
        const checkInstalledVersion = async () => {
            if (checking) return;
            checking = true;
            const startedAt = Date.now();
            try {
                // A public version check keeps the authenticated working state steady and does not pair.
                const response = await localEngineClient.probe({ signal: controller.signal, timeoutMs: 5000, cache: 'no-store' });
                const probe = response.ok ? parseLocalEngineProbe(await response.json()) : null;
                if (!controller.signal.aborted && probe) {
                    setSnapshot(previous => previous.authorization === 'authenticated'
                        && (previous.checkedAt ?? 0) <= startedAt
                        ? applyLocalEngineProbe(previous, probe)
                        : previous);
                }
            } catch {
                // Installation may temporarily stop the engine; normal connection recovery owns that state.
            } finally {
                checking = false;
            }
        };
        const timer = window.setInterval(checkInstalledVersion, 10000);
        window.addEventListener('focus', checkInstalledVersion);
        return () => {
            controller.abort();
            window.clearInterval(timer);
            window.removeEventListener('focus', checkInstalledVersion);
        };
    }, [environment.kind, latestRelease, snapshot.authorization, snapshot.engineVersion]);
    useEffect(() => {
        if (environment.kind !== 'web-local-engine') return;
        const unregister = registerLocalEngineAuthorizationRecovery(
            authorization => coordinator.captureAuthorizationRecovery(authorization),
        );
        const unregisterActivity = registerLocalEngineProtectedActivity(
            (authorization, signal) => coordinator.beginProtectedActivity(authorization, signal),
        );
        let checking = false;
        const reconnect = () => {
            if (checking || !coordinator.shouldReconnectBrowser()) return;
            checking = true;
            void coordinator.probe().catch(() => undefined).finally(() => { checking = false; });
        };
        reconnect();
        const reconnectTimer = window.setInterval(reconnect, 10000);
        window.addEventListener('focus', reconnect);
        return () => {
            unregister();
            unregisterActivity();
            window.clearInterval(reconnectTimer);
            window.removeEventListener('focus', reconnect);
            coordinator.dispose();
        };
    }, [coordinator, environment.kind]);
    useEffect(() => {
        if (environment.kind !== 'web-local-engine' || snapshot.authorization !== 'authenticated') return;
        const synchronizeExpiration = () => {
            if (localEngineSessionCredentials.current()) return;
            setSnapshot(previous => applyLocalEngineAuthorization(previous, 'expired'));
            setPairingState({ phase: 'expired', challenge: null });
            void coordinator.restoreRememberedBrowser();
        };
        const interval = window.setInterval(synchronizeExpiration, 1000);
        synchronizeExpiration();
        return () => window.clearInterval(interval);
    }, [coordinator, environment.kind, snapshot.authorization]);
    const value = useMemo(() => ({
        snapshot,
        latestRelease,
        beginTransportCheck,
        reportTransport,
        pairingState,
        probeLocalEngine,
        startPairing,
        completePairing,
        resetPairing,
        renewSession,
        revokeSession,
    }), [
        beginTransportCheck,
        completePairing,
        pairingState,
        probeLocalEngine,
        reportTransport,
        resetPairing,
        renewSession,
        revokeSession,
        snapshot,
        latestRelease,
        startPairing,
    ]);

    return (
        <LocalEngineConnectionContext.Provider value={value}>
            {children}
        </LocalEngineConnectionContext.Provider>
    );
};
