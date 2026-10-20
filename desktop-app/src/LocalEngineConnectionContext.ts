import { createContext, useContext } from 'react';
import type {
    LocalEngineConnectionSnapshot, LocalEngineProbePayload, LocalEngineTransportState,
} from './localEngineConnection';
import type { LocalEnginePairingState } from './localEngineConnectionCoordinator';
import type { LocalEnginePairingStart } from './localEngineSession';

export interface LocalEngineConnectionContextValue {
    snapshot: LocalEngineConnectionSnapshot;
    beginTransportCheck: () => number;
    reportTransport: (checkId: number, transport: LocalEngineTransportState) => void;
    pairingState: LocalEnginePairingState;
    /** userInitiated: the user pressed a check button, so the browser may ask for access now. */
    probeLocalEngine: (options?: { userInitiated?: boolean }) => Promise<LocalEngineProbePayload | null>;
    startPairing: () => Promise<LocalEnginePairingStart | null>;
    completePairing: (pairingId: string, code: string) => Promise<boolean>;
    resetPairing: (reason?: string) => void;
    renewSession: () => Promise<boolean>;
    revokeSession: () => Promise<boolean>;
}

export const LocalEngineConnectionContext = createContext<LocalEngineConnectionContextValue | null>(null);

export const useLocalEngineConnection = (): LocalEngineConnectionContextValue => {
    const context = useContext(LocalEngineConnectionContext);
    if (!context) {
        throw new Error('useLocalEngineConnection must be used within LocalEngineConnectionProvider');
    }
    return context;
};
