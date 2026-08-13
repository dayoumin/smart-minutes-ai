import type { RuntimeKind } from './runtimeEnvironment';

export type LocalEngineTransportState =
    | 'checking'
    | 'unreachable'
    | 'reachable'
    | 'incompatible'
    | 'error';

export type LocalEngineAuthorizationState =
    | 'unknown'
    | 'unpaired'
    | 'authenticated'
    | 'expired'
    | 'revoked';

export type LocalEngineCapability =
    | 'analysis'
    | 'model-management'
    | 'meeting-storage'
    | 'export';

export interface LocalEngineConnectionSnapshot {
    runtime: RuntimeKind;
    transport: LocalEngineTransportState;
    authorization: LocalEngineAuthorizationState;
    capabilities: ReadonlySet<LocalEngineCapability>;
    checkedAt: number | null;
    reason?: string;
}

export const createInitialLocalEngineConnection = (
    runtime: RuntimeKind,
): LocalEngineConnectionSnapshot => ({
    runtime,
    transport: 'checking',
    authorization: 'unknown',
    capabilities: new Set(),
    checkedAt: null,
});

export const updateLocalEngineTransport = (
    previous: LocalEngineConnectionSnapshot,
    transport: LocalEngineTransportState,
    checkedAt = Date.now(),
): LocalEngineConnectionSnapshot => ({
        ...previous,
        transport,
        checkedAt,
    });

export const transportFromHealthEvidence = (
    responseReceived: boolean,
): LocalEngineTransportState => responseReceived ? 'reachable' : 'unreachable';

export const isLatestTransportCheck = (
    currentCheckId: number,
    candidateCheckId: number,
): boolean => currentCheckId === candidateCheckId;

export const isLocalEngineConnected = (
    snapshot: LocalEngineConnectionSnapshot,
): boolean => snapshot.transport === 'reachable'
    && snapshot.authorization === 'authenticated';

export const canUseLocalEngineCapability = (
    snapshot: LocalEngineConnectionSnapshot,
    capability: LocalEngineCapability,
): boolean => isLocalEngineConnected(snapshot) && snapshot.capabilities.has(capability);
