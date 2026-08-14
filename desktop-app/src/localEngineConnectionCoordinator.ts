import type { LocalEngineClient } from './localEngineClientCore';
import type {
    LocalEngineAuthorizationState,
    LocalEngineCapability,
    LocalEngineProbePayload,
    LocalEngineTransportState,
} from './localEngineConnection';
import type {
    LocalEnginePairingStart,
    LocalEngineSessionCredential,
    LocalEngineSessionCredentialStore,
} from './localEngineSession';

export type LocalEnginePairingPhase =
    | 'idle'
    | 'starting'
    | 'awaiting-code'
    | 'completing'
    | 'connected'
    | 'expired'
    | 'revoked'
    | 'error';

export interface LocalEnginePairingState {
    phase: LocalEnginePairingPhase;
    challenge: LocalEnginePairingStart | null;
    reason?: string;
}

export interface LocalEngineConnectionCoordinatorCallbacks {
    onTransport: (transport: LocalEngineTransportState) => void;
    onProbe: (probe: LocalEngineProbePayload) => void;
    onAuthorization: (
        authorization: LocalEngineAuthorizationState,
        capabilities?: Iterable<LocalEngineCapability>,
    ) => void;
    onPairingState: (state: LocalEnginePairingState) => void;
}

export interface LocalEngineConnectionCoordinatorParsers {
    probe: (value: unknown) => LocalEngineProbePayload | null;
    pairingStart: (value: unknown) => LocalEnginePairingStart | null;
    sessionCredential: (value: unknown) => LocalEngineSessionCredential | null;
}

export class LocalEngineConnectionRequestError extends Error {
    readonly code: 'unreachable' | 'invalid-response' | 'pairing-rejected' | 'rate-limited' | 'session-expired';

    constructor(
        code: 'unreachable' | 'invalid-response' | 'pairing-rejected' | 'rate-limited' | 'session-expired',
        message: string,
    ) {
        super(message);
        this.name = 'LocalEngineConnectionRequestError';
        this.code = code;
    }
}

const responseError = async (
    response: Response,
    context: 'probe' | 'pairing' | 'session',
): Promise<LocalEngineConnectionRequestError> => {
    if (response.status === 401 && context === 'session') {
        return new LocalEngineConnectionRequestError('session-expired', '로컬 엔진 연결이 만료되었습니다.');
    }
    if (response.status === 429) {
        return new LocalEngineConnectionRequestError('rate-limited', '잠시 후 다시 시도해 주세요.');
    }
    if (context === 'probe') {
        return new LocalEngineConnectionRequestError('invalid-response', '로컬 엔진 응답을 확인할 수 없습니다.');
    }
    return new LocalEngineConnectionRequestError('pairing-rejected', '로컬 엔진 연결을 완료하지 못했습니다.');
};

export class LocalEngineConnectionCoordinator {
    private transportOperationId = 0;
    private authorizationOperationId = 0;
    private readonly client: LocalEngineClient;
    private readonly credentials: LocalEngineSessionCredentialStore;
    private readonly callbacks: LocalEngineConnectionCoordinatorCallbacks;
    private readonly parsers: LocalEngineConnectionCoordinatorParsers;
    private completePairingInFlight: Promise<boolean> | null = null;
    private renewSessionInFlight: Promise<boolean> | null = null;
    private currentChallenge: LocalEnginePairingStart | null = null;

    constructor(
        client: LocalEngineClient,
        credentials: LocalEngineSessionCredentialStore,
        callbacks: LocalEngineConnectionCoordinatorCallbacks,
        parsers: LocalEngineConnectionCoordinatorParsers,
    ) {
        this.client = client;
        this.credentials = credentials;
        this.callbacks = callbacks;
        this.parsers = parsers;
    }

    private beginTransportOperation(): number {
        this.transportOperationId += 1;
        return this.transportOperationId;
    }

    private beginAuthorizationOperation(): number {
        this.authorizationOperationId += 1;
        return this.authorizationOperationId;
    }

    private isLatestTransport(operationId: number): boolean {
        return this.transportOperationId === operationId;
    }

    private isLatestAuthorization(operationId: number): boolean {
        return this.authorizationOperationId === operationId;
    }

    private applyCredential(
        operationId: number,
        credential: LocalEngineSessionCredential,
    ): boolean {
        if (!this.isLatestAuthorization(operationId)) return false;
        if (!this.credentials.replace(credential)) {
            this.callbacks.onAuthorization('expired');
            this.callbacks.onPairingState({ phase: 'expired', challenge: null });
            return false;
        }
        this.callbacks.onAuthorization('authenticated', credential.capabilities);
        this.callbacks.onPairingState({ phase: 'connected', challenge: null });
        return true;
    }

    async probe(): Promise<LocalEngineProbePayload | null> {
        const operationId = this.beginTransportOperation();
        this.callbacks.onTransport('checking');
        try {
            const response = await this.client.probe({ cache: 'no-store' });
            if (!response.ok) throw await responseError(response, 'probe');
            const parsed = this.parsers.probe(await response.json());
            if (!parsed) {
                if (this.isLatestTransport(operationId)) this.callbacks.onTransport('error');
                throw new LocalEngineConnectionRequestError('invalid-response', '로컬 엔진 응답을 확인할 수 없습니다.');
            }
            if (!this.isLatestTransport(operationId)) return null;
            this.callbacks.onProbe(parsed);
            return parsed;
        } catch (error) {
            if (this.isLatestTransport(operationId)) {
                this.callbacks.onTransport(
                    error instanceof LocalEngineConnectionRequestError ? 'error' : 'unreachable',
                );
            }
            if (error instanceof LocalEngineConnectionRequestError) throw error;
            throw new LocalEngineConnectionRequestError('unreachable', '로컬 엔진에 연결할 수 없습니다.');
        }
    }

    async startPairing(): Promise<LocalEnginePairingStart | null> {
        const operationId = this.beginAuthorizationOperation();
        this.callbacks.onPairingState({ phase: 'starting', challenge: null });
        try {
            const response = await this.client.pair('/api/pair/start', { method: 'POST' });
            if (!response.ok) throw await responseError(response, 'pairing');
            const challenge = this.parsers.pairingStart(await response.json());
            if (!challenge) {
                throw new LocalEngineConnectionRequestError('invalid-response', '연결 정보를 확인할 수 없습니다.');
            }
            if (!this.isLatestAuthorization(operationId)) return null;
            this.currentChallenge = challenge;
            this.callbacks.onPairingState({ phase: 'awaiting-code', challenge });
            return challenge;
        } catch (error) {
            if (this.isLatestAuthorization(operationId)) {
                this.callbacks.onPairingState({
                    phase: 'error',
                    challenge: null,
                    reason: error instanceof Error ? error.message : '연결을 시작하지 못했습니다.',
                });
            }
            throw error;
        }
    }

    async completePairing(pairingId: string, code: string): Promise<boolean> {
        if (this.completePairingInFlight) return this.completePairingInFlight;
        const operation = this.runCompletePairing(pairingId, code);
        this.completePairingInFlight = operation;
        try {
            return await operation;
        } finally {
            if (this.completePairingInFlight === operation) this.completePairingInFlight = null;
        }
    }

    private async runCompletePairing(pairingId: string, code: string): Promise<boolean> {
        const operationId = this.beginAuthorizationOperation();
        const challenge = this.currentChallenge?.pairing_id === pairingId
            ? this.currentChallenge
            : null;
        this.callbacks.onPairingState({ phase: 'completing', challenge });
        try {
            const response = await this.client.pair('/api/pair/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pairing_id: pairingId, code }),
            });
            if (!response.ok) throw await responseError(response, 'pairing');
            const payload = await response.json();
            const credential = this.parsers.sessionCredential(payload);
            if (!credential) {
                throw new LocalEngineConnectionRequestError('invalid-response', '세션 정보를 확인할 수 없습니다.');
            }
            if (!this.isLatestAuthorization(operationId)) {
                await this.revokeCredentialBestEffort(credential.session_token);
                return false;
            }
            this.currentChallenge = null;
            const applied = this.applyCredential(operationId, credential);
            if (!applied) await this.revokeCredentialBestEffort(credential.session_token);
            return applied;
        } catch (error) {
            if (this.isLatestAuthorization(operationId)) {
                this.callbacks.onPairingState({
                    phase: 'error',
                    challenge,
                    reason: error instanceof Error ? error.message : '연결을 완료하지 못했습니다.',
                });
            }
            throw error;
        }
    }

    async renewSession(): Promise<boolean> {
        if (this.renewSessionInFlight) return this.renewSessionInFlight;
        const operation = this.runRenewSession();
        this.renewSessionInFlight = operation;
        try {
            return await operation;
        } finally {
            if (this.renewSessionInFlight === operation) this.renewSessionInFlight = null;
        }
    }

    private async runRenewSession(): Promise<boolean> {
        const operationId = this.beginAuthorizationOperation();
        const currentCredential = this.credentials.current();
        if (!currentCredential) {
            this.callbacks.onAuthorization('expired');
            this.callbacks.onPairingState({ phase: 'expired', challenge: null });
            return false;
        }
        try {
            const response = await this.client.session(
                '/api/session/renew',
                currentCredential.session_token,
                { method: 'POST' },
            );
            if (response.status === 401) {
                if (this.isLatestAuthorization(operationId)) {
                    this.credentials.clear();
                    this.callbacks.onAuthorization('expired');
                    this.callbacks.onPairingState({ phase: 'expired', challenge: null });
                }
                return false;
            }
            if (!response.ok) throw await responseError(response, 'session');
            const credential = this.parsers.sessionCredential(await response.json());
            if (!credential) {
                throw new LocalEngineConnectionRequestError('invalid-response', '갱신된 세션을 확인할 수 없습니다.');
            }
            if (!this.isLatestAuthorization(operationId)) return false;
            const applied = this.applyCredential(operationId, credential);
            if (!applied) await this.revokeCredentialBestEffort(currentCredential.session_token);
            return applied;
        } catch (error) {
            if (this.isLatestAuthorization(operationId)) {
                this.credentials.clear();
                this.callbacks.onAuthorization('expired');
                this.callbacks.onPairingState({
                    phase: 'expired',
                    challenge: null,
                    reason: error instanceof Error ? error.message : '세션을 갱신하지 못했습니다.',
                });
                await this.revokeCredentialBestEffort(currentCredential.session_token);
            }
            throw error;
        }
    }

    async revokeSession(): Promise<boolean> {
        const operationId = this.beginAuthorizationOperation();
        const currentCredential = this.credentials.current();
        if (!currentCredential) {
            this.callbacks.onAuthorization('expired');
            this.callbacks.onPairingState({ phase: 'expired', challenge: null });
            return false;
        }
        const response = await this.client.session(
            '/api/session/revoke',
            currentCredential.session_token,
            { method: 'POST' },
        );
        if (!response.ok && response.status !== 401) throw await responseError(response, 'session');
        if (!this.isLatestAuthorization(operationId)) return false;
        this.credentials.clear();
        const authorization = response.status === 401 ? 'expired' : 'revoked';
        this.callbacks.onAuthorization(authorization);
        this.callbacks.onPairingState({ phase: authorization, challenge: null });
        return response.ok;
    }

    private async revokeCredentialBestEffort(sessionToken: string): Promise<void> {
        try {
            await this.client.session('/api/session/revoke', sessionToken, { method: 'POST' });
        } catch {
            // A stale credential is never installed locally; its short server TTL remains the fallback.
        }
    }
}
