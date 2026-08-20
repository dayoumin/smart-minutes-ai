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
    updateRequired: boolean;
    checkedAt: number | null;
    reason?: string;
}

export interface LocalEngineProbePayload {
    product_id: string;
    engine_version: string;
    api_contract_version: number;
    capabilities: string[];
    auth_state: string;
    pairing_available: boolean;
    update_required: boolean;
}

export const LOCAL_ENGINE_PRODUCT_ID = 'barorok-local-engine';
export const SUPPORTED_API_CONTRACT_VERSIONS = new Set([1]);
const LOCAL_ENGINE_CAPABILITIES = new Set<LocalEngineCapability>([
    'analysis',
    'model-management',
    'meeting-storage',
    'export',
]);

export const createInitialLocalEngineConnection = (
    runtime: RuntimeKind,
): LocalEngineConnectionSnapshot => ({
    runtime,
    transport: 'checking',
    authorization: 'unknown',
    capabilities: new Set(),
    updateRequired: false,
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

export const parseLocalEngineProbe = (value: unknown): LocalEngineProbePayload | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<LocalEngineProbePayload>;
    if (
        payload.product_id !== LOCAL_ENGINE_PRODUCT_ID
        || typeof payload.engine_version !== 'string'
        || !Number.isInteger(payload.api_contract_version)
        || !Array.isArray(payload.capabilities)
        || payload.capabilities.some(item => typeof item !== 'string')
        || typeof payload.auth_state !== 'string'
        || typeof payload.pairing_available !== 'boolean'
        || typeof payload.update_required !== 'boolean'
    ) {
        return null;
    }
    return payload as LocalEngineProbePayload;
};

export const applyLocalEngineProbe = (
    previous: LocalEngineConnectionSnapshot,
    payload: LocalEngineProbePayload,
    checkedAt = Date.now(),
): LocalEngineConnectionSnapshot => {
    const compatible = SUPPORTED_API_CONTRACT_VERSIONS.has(payload.api_contract_version);
    const authorization: LocalEngineAuthorizationState = previous.authorization === 'unknown'
        ? 'unpaired'
        : previous.authorization;
    const supportedCapabilities = new Set(payload.capabilities.filter(
        (capability): capability is LocalEngineCapability => LOCAL_ENGINE_CAPABILITIES.has(
            capability as LocalEngineCapability,
        ),
    ));
    const capabilities = authorization === 'authenticated'
        ? new Set(
            [...previous.capabilities].filter(capability => supportedCapabilities.has(capability)),
        )
        : supportedCapabilities;
    return {
        ...previous,
        transport: compatible ? 'reachable' : 'incompatible',
        authorization,
        capabilities: compatible ? capabilities : new Set(),
        updateRequired: payload.update_required,
        checkedAt,
        reason: compatible ? undefined : '지원하지 않는 로컬 엔진 API 버전입니다.',
    };
};

export const applyLocalEngineAuthorization = (
    previous: LocalEngineConnectionSnapshot,
    authorization: LocalEngineAuthorizationState,
    capabilities: Iterable<LocalEngineCapability> = [],
    checkedAt = Date.now(),
): LocalEngineConnectionSnapshot => ({
    ...previous,
    authorization,
    capabilities: authorization === 'authenticated'
        ? new Set(
            [...capabilities].filter(capability => LOCAL_ENGINE_CAPABILITIES.has(capability)),
        )
        : new Set(),
    checkedAt,
});

export const transportFromHealthEvidence = (
    responseReceived: boolean,
): LocalEngineTransportState => responseReceived ? 'reachable' : 'unreachable';

export const isLatestTransportCheck = (
    currentCheckId: number,
    candidateCheckId: number,
): boolean => currentCheckId === candidateCheckId;

export const isLatestAuthorizationCheck = isLatestTransportCheck;

export const isLocalEngineConnected = (
    snapshot: LocalEngineConnectionSnapshot,
): boolean => snapshot.transport === 'reachable'
    && snapshot.authorization === 'authenticated';

export const canUseLocalEngineCapability = (
    snapshot: LocalEngineConnectionSnapshot,
    capability: LocalEngineCapability,
): boolean => isLocalEngineConnected(snapshot) && snapshot.capabilities.has(capability);
