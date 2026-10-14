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
import { localEngineClient, localEngineSessionCredentials, registerLocalEngineAuthorizationRecovery } from './localEngineClient';
import {
    LocalEngineConnectionCoordinator,
    LocalEnginePairingState,
} from './localEngineConnectionCoordinator';
import {
    parseLocalEnginePairingStart,
    parseLocalEngineSessionCredential,
} from './localEngineSession';
import { LocalEngineConnectionContext } from './LocalEngineConnectionContext';

export const LocalEngineConnectionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const environment = useMemo(() => getRuntimeEnvironment(), []);
    const [snapshot, setSnapshot] = useState<LocalEngineConnectionSnapshot>(() => (
        createInitialLocalEngineConnection(environment.kind)
    ));
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
                onTransport: transport => {
                    setSnapshot(previous => updateLocalEngineTransport(previous, transport));
                },
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
    const probeLocalEngine = useCallback(() => (
        coordinator.probe()
    ), [coordinator]);
    const startPairing = useCallback(() => (
        coordinator.startPairing()
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
        const unregister = registerLocalEngineAuthorizationRecovery(
            authorization => coordinator.captureAuthorizationRecovery(authorization),
        );
        return () => {
            unregister();
            coordinator.dispose();
        };
    }, [coordinator, environment.kind]);
    useEffect(() => {
        if (environment.kind !== 'web-local-engine' || snapshot.authorization !== 'authenticated') return;
        const synchronizeExpiration = () => {
            if (localEngineSessionCredentials.current()) return;
            setSnapshot(previous => applyLocalEngineAuthorization(previous, 'expired'));
            setPairingState({ phase: 'expired', challenge: null });
        };
        const interval = window.setInterval(synchronizeExpiration, 1000);
        synchronizeExpiration();
        return () => window.clearInterval(interval);
    }, [environment.kind, snapshot.authorization]);
    const value = useMemo(() => ({
        snapshot,
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
        startPairing,
    ]);

    return (
        <LocalEngineConnectionContext.Provider value={value}>
            {children}
        </LocalEngineConnectionContext.Provider>
    );
};
