import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
    createInitialLocalEngineConnection,
    isLatestTransportCheck,
    LocalEngineConnectionSnapshot,
    LocalEngineTransportState,
    updateLocalEngineTransport,
} from './localEngineConnection';
import { getRuntimeEnvironment } from './runtimeEnvironment';

interface LocalEngineConnectionContextValue {
    snapshot: LocalEngineConnectionSnapshot;
    beginTransportCheck: () => number;
    reportTransport: (checkId: number, transport: LocalEngineTransportState) => void;
}

const LocalEngineConnectionContext = createContext<LocalEngineConnectionContextValue | null>(null);

export const LocalEngineConnectionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const environment = useMemo(() => getRuntimeEnvironment(), []);
    const [snapshot, setSnapshot] = useState<LocalEngineConnectionSnapshot>(() => (
        createInitialLocalEngineConnection(environment.kind)
    ));
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
    const value = useMemo(() => ({
        snapshot,
        beginTransportCheck,
        reportTransport,
    }), [beginTransportCheck, reportTransport, snapshot]);

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
