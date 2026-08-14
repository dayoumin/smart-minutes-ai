import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
    createInitialLocalEngineConnection,
    applyLocalEngineAuthorization,
    applyLocalEngineProbe,
    isLatestTransportCheck,
    LocalEngineConnectionSnapshot,
    LocalEngineProbePayload,
    LocalEngineTransportState,
    parseLocalEngineProbe,
    updateLocalEngineTransport,
} from './localEngineConnection';
import { getRuntimeEnvironment } from './runtimeEnvironment';
import { localEngineClient, localEngineSessionCredentials } from './localEngineClient';
import {
    LocalEngineConnectionCoordinator,
    LocalEnginePairingState,
} from './localEngineConnectionCoordinator';
import {
    parseLocalEnginePairingStart,
    parseLocalEngineSessionCredential,
} from './localEngineSession';
import type { LocalEnginePairingStart } from './localEngineSession';

interface LocalEngineConnectionContextValue {
    snapshot: LocalEngineConnectionSnapshot;
    beginTransportCheck: () => number;
    reportTransport: (checkId: number, transport: LocalEngineTransportState) => void;
    pairingState: LocalEnginePairingState;
    probeLocalEngine: () => Promise<LocalEngineProbePayload | null>;
    startPairing: () => Promise<LocalEnginePairingStart | null>;
    completePairing: (pairingId: string, code: string) => Promise<boolean>;
    renewSession: () => Promise<boolean>;
    revokeSession: () => Promise<boolean>;
}

const LocalEngineConnectionContext = createContext<LocalEngineConnectionContextValue | null>(null);

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
    const coordinatorTransportCheckIdRef = useRef(0);
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
    const reportProbe = useCallback((checkId: number, probe: LocalEngineProbePayload) => {
        if (!isLatestTransportCheck(transportCheckIdRef.current, checkId)) return;
        setSnapshot(previous => applyLocalEngineProbe(previous, probe));
    }, []);
    const coordinator = useMemo(() => new LocalEngineConnectionCoordinator(
        localEngineClient,
        localEngineSessionCredentials,
        {
            onTransport: transport => {
                if (transport === 'checking') {
                    coordinatorTransportCheckIdRef.current = beginTransportCheck();
                    return;
                }
                reportTransport(coordinatorTransportCheckIdRef.current, transport);
            },
            onProbe: probe => {
                reportProbe(coordinatorTransportCheckIdRef.current, probe);
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
    ), [beginTransportCheck, reportProbe, reportTransport]);
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
        probeLocalEngine: () => coordinator.probe(),
        startPairing: () => coordinator.startPairing(),
        completePairing: (pairingId: string, code: string) => coordinator.completePairing(pairingId, code),
        renewSession: () => coordinator.renewSession(),
        revokeSession: () => coordinator.revokeSession(),
    }), [
        beginTransportCheck,
        coordinator,
        pairingState,
        reportTransport,
        snapshot,
    ]);

    return (
        <LocalEngineConnectionContext.Provider value={value}>
            {children}
        </LocalEngineConnectionContext.Provider>
    );
};

export const useLocalEngineConnection = (): LocalEngineConnectionContextValue => {
    const context = useContext(LocalEngineConnectionContext);
    if (!context) {
        throw new Error('useLocalEngineConnection must be used within LocalEngineConnectionProvider');
    }
    return context;
};
