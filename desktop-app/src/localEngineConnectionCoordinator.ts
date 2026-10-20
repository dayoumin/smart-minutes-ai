import type { LocalEngineAuthorizationRecovery, LocalEngineClient } from './localEngineClientCore';
import { createBrowserApprovalToken, LocalEngineBrowserCredentialStore } from './localEngineBrowserCredential.ts';
import type {
    LocalEngineAuthorizationState,
    LocalEngineBlockedCause,
    LocalEngineCapability,
    LocalEngineProbePayload,
    LocalEngineTransportState,
} from './localEngineConnection';
import type { LocalEngineBrowserAccessState } from './localEngineBrowserAccess';
import type {
    LocalEnginePairingStart,
    LocalEngineSessionCredential,
    LocalEngineSessionCredentialStore,
} from './localEngineSession';

// Short: a stopped engine refuses at once, and a slow answer must not hold the failure screen.
const REACH_CHECK_TIMEOUT_MS = 3000;

export type LocalEnginePairingPhase =
    | 'idle'
    | 'starting'
    | 'awaiting-code'
    | 'awaiting-approval'
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
    onTransport: (transport: LocalEngineTransportState, detail?: { blockedBy?: LocalEngineBlockedCause }) => void;
    /** Asked after a probe gets no response, to separate a browser block from a stopped engine. */
    browserAccessState?: () => Promise<LocalEngineBrowserAccessState>;
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

interface ProtectedActivityClock {
    now: () => number;
    setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>;
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
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
    private authorizationIntentId = 0;
    private authorizationIntentPending = false;
    private readonly client: LocalEngineClient;
    private readonly credentials: LocalEngineSessionCredentialStore;
    private readonly callbacks: LocalEngineConnectionCoordinatorCallbacks;
    private readonly parsers: LocalEngineConnectionCoordinatorParsers;
    private completePairingInFlight: Promise<boolean> | null = null;
    private renewSessionInFlight: Promise<boolean> | null = null;
    private currentChallenge: LocalEnginePairingStart | null = null;
    private readonly protectedActivities = new Set<() => void>();
    private protectedActivityTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    private readonly activityClock: ProtectedActivityClock;
    private approvalAbort: AbortController | null = null;
    private readonly browserCredentials: LocalEngineBrowserCredentialStore;
    private explicitlyDisconnected = false;

    constructor(
        client: LocalEngineClient,
        credentials: LocalEngineSessionCredentialStore,
        callbacks: LocalEngineConnectionCoordinatorCallbacks,
        parsers: LocalEngineConnectionCoordinatorParsers,
        activityClock: ProtectedActivityClock = {
            now: () => Date.now() / 1000,
            setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
            clearTimeout: timer => globalThis.clearTimeout(timer),
        },
        browserCredentials = new LocalEngineBrowserCredentialStore(),
    ) {
        this.client = client;
        this.credentials = credentials;
        this.callbacks = callbacks;
        this.parsers = parsers;
        this.activityClock = activityClock;
        this.browserCredentials = browserCredentials;
    }

    private beginTransportOperation(): number {
        this.transportOperationId += 1;
        return this.transportOperationId;
    }

    private beginAuthorizationOperation(): number {
        this.authorizationOperationId += 1;
        return this.authorizationOperationId;
    }

    private beginUserAuthorizationOperation(pending = true): number {
        this.approvalAbort?.abort();
        this.approvalAbort = null;
        this.clearProtectedActivities();
        this.authorizationIntentId += 1;
        this.authorizationIntentPending = pending;
        return this.beginAuthorizationOperation();
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
        if (credential.browser_token) this.browserCredentials.replace(credential.browser_token);
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
            if (this.shouldReconnectBrowser() && this.browserCredentials.current()) {
                await this.restoreRememberedBrowser();
            }
            if (parsed.pairing_mode === 'browser-connection' && this.shouldReconnectBrowser()) {
                await this.startBrowserApproval();
            }
            return parsed;
        } catch (error) {
            if (error instanceof LocalEngineConnectionRequestError) {
                if (this.isLatestTransport(operationId)) this.callbacks.onTransport('error');
                throw error;
            }
            if (this.isLatestTransport(operationId)) {
                const blockedBy = await this.diagnoseUnreachable();
                if (this.isLatestTransport(operationId)) {
                    this.callbacks.onTransport('unreachable', { blockedBy });
                }
            }
            throw new LocalEngineConnectionRequestError('unreachable', '로컬 엔진에 연결할 수 없습니다.');
        }
    }

    // A failed fetch looks the same whether the engine is stopped or the browser refused it.
    private async diagnoseUnreachable(): Promise<LocalEngineBlockedCause | undefined> {
        const access = await this.callbacks.browserAccessState?.().catch(() => 'unsupported' as const) ?? 'unsupported';
        if (access === 'denied') return 'browser-permission';
        // While Chrome may still ask, another request would raise (or re-raise) its prompt.
        if (access === 'prompt') return undefined;
        try {
            // A no-cors request still completes against a running engine when only the
            // readable response was refused, so it separates that from a stopped engine.
            await this.client.reach({ cache: 'no-store', timeoutMs: REACH_CHECK_TIMEOUT_MS });
            return 'response-blocked';
        } catch {
            return undefined;
        }
    }

    private async restoreBrowser(operationId: number, browserToken: string, signal?: AbortSignal): Promise<boolean> {
        const response = await this.client.pair('/api/pair/restore', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ browser_token: browserToken }), signal,
        });
        if (!this.isLatestAuthorization(operationId)) return false;
        if (response.status === 401 || response.status === 403) {
            if (this.browserCredentials.current() === browserToken) this.browserCredentials.clear();
            return false;
        }
        if (!response.ok) throw await responseError(response, 'session');
        const credential = this.parsers.sessionCredential(await response.json());
        if (!credential) throw new LocalEngineConnectionRequestError('invalid-response', '저장된 연결을 확인하지 못했습니다.');
        const applied = this.applyCredential(operationId, credential);
        if (!applied) await this.revokeCredentialBestEffort(credential.session_token);
        return applied;
    }

    async restoreRememberedBrowser(): Promise<boolean> {
        const token = this.browserCredentials.current();
        if (!token || this.authorizationIntentPending) return false;
        const operationId = this.beginAuthorizationOperation();
        try { return await this.restoreBrowser(operationId, token); }
        catch { return false; } // Preserve remembered approval across temporary engine/network outages.
    }

    shouldRestoreBrowser(): boolean {
        return Boolean(this.browserCredentials.current()) && !this.credentials.current() && !this.authorizationIntentPending;
    }

    shouldReconnectBrowser(): boolean {
        return !this.explicitlyDisconnected && !this.credentials.current() && !this.authorizationIntentPending;
    }

    async startBrowserApproval(): Promise<LocalEnginePairingStart | null> {
        this.explicitlyDisconnected = false;
        const operationId = this.beginUserAuthorizationOperation();
        const controller = new AbortController();
        this.approvalAbort = controller;
        let freshBrowserToken: string | null = null;
        this.callbacks.onPairingState({ phase: 'starting', challenge: null });
        try {
            const saved = this.browserCredentials.current();
            if (saved && await this.restoreBrowser(operationId, saved, controller.signal)) return null;
            if (!this.isLatestAuthorization(operationId)) return null;
            freshBrowserToken = createBrowserApprovalToken();
            const response = await this.client.pair('/api/pair/start', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'browser-connection', browser_token: freshBrowserToken }), signal: controller.signal,
            });
            if (!response.ok) throw await responseError(response, 'pairing');
            const challenge = this.parsers.pairingStart(await response.json());
            if (challenge?.mode !== 'browser-connection') {
                throw new LocalEngineConnectionRequestError('invalid-response', '바로록 연결 프로그램을 업데이트한 뒤 다시 연결해 주세요.');
            }
            if (!this.isLatestAuthorization(operationId)) return null;
            this.currentChallenge = challenge;
            this.callbacks.onPairingState({ phase: 'awaiting-approval', challenge });
            const deadline = Date.now() + challenge.expires_in_seconds * 1000;
            while (Date.now() < deadline && this.isLatestAuthorization(operationId)) {
                const result = await this.client.pair('/api/pair/complete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pairing_id: challenge.pairing_id, mode: 'browser-connection' }),
                    signal: controller.signal,
                });
                if (result.status === 202) {
                    await new Promise<void>((resolve, reject) => {
                        const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
                        const timer = setTimeout(() => {
                            controller.signal.removeEventListener('abort', abort);
                            resolve();
                        }, 800);
                        controller.signal.addEventListener('abort', abort, { once: true });
                        if (controller.signal.aborted) abort();
                    });
                    continue;
                }
                if (!result.ok) throw new LocalEngineConnectionRequestError('pairing-rejected', '연결 요청이 만료됐습니다. 다시 연결해 주세요.');
                const credential = this.parsers.sessionCredential(await result.json());
                if (!credential) throw new LocalEngineConnectionRequestError('invalid-response', '연결 승인을 저장하지 못했습니다.');
                if (this.applyCredential(operationId, { ...credential, browser_token: freshBrowserToken })) freshBrowserToken = null;
                return challenge;
            }
            if (this.isLatestAuthorization(operationId)) throw new LocalEngineConnectionRequestError('pairing-rejected', '연결 요청이 만료됐습니다. 다시 연결해 주세요.');
            return null;
        } catch (error) {
            if (!this.isLatestAuthorization(operationId)) return null;
            this.callbacks.onPairingState({ phase: 'error', challenge: null, reason: error instanceof LocalEngineConnectionRequestError ? error.message : '바로록 연결을 확인하지 못했습니다. 연결 프로그램을 실행한 뒤 다시 시도해 주세요.' });
            throw error;
        } finally {
            if (freshBrowserToken) {
                await this.client.pair('/api/pair/forget', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ browser_token: freshBrowserToken }), timeoutMs: 5000,
                }).catch(() => undefined);
            }
            if (this.isLatestAuthorization(operationId)) this.authorizationIntentPending = false;
            if (this.approvalAbort === controller) this.approvalAbort = null;
        }
    }

    async startPairing(): Promise<LocalEnginePairingStart | null> {
        const operationId = this.beginUserAuthorizationOperation();
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
                this.authorizationIntentPending = false;
                this.callbacks.onPairingState({
                    phase: 'error',
                    challenge: null,
                    reason: error instanceof Error ? error.message : '연결을 시작하지 못했습니다.',
                });
            }
            throw error;
        }
    }

    resetPairing(reason?: string): void {
        this.beginUserAuthorizationOperation(false);
        this.currentChallenge = null;
        this.callbacks.onPairingState({
            phase: reason ? 'error' : 'idle',
            challenge: null,
            ...(reason ? { reason } : {}),
        });
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
        const operationId = this.beginUserAuthorizationOperation();
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
            this.authorizationIntentPending = false;
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

    beginProtectedActivity(authorization: string, signal?: AbortSignal): () => void {
        if (signal?.aborted || this.authorizationIntentPending
            || this.credentials.requestHeaders().Authorization !== authorization) return () => {};
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', finish);
            this.protectedActivities.delete(finish);
            if (this.protectedActivities.size === 0 && this.protectedActivityTimer !== null) {
                this.activityClock.clearTimeout(this.protectedActivityTimer);
                this.protectedActivityTimer = null;
            }
        };
        this.protectedActivities.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        this.scheduleProtectedActivityRenewal();
        return finish;
    }

    private clearProtectedActivities(): void {
        for (const finish of this.protectedActivities) finish();
    }

    private scheduleProtectedActivityRenewal(): void {
        if (this.protectedActivityTimer !== null || this.protectedActivities.size === 0) return;
        const credential = this.credentials.current();
        if (!credential || this.authorizationIntentPending) { this.clearProtectedActivities(); return; }
        const intentId = this.authorizationIntentId;
        const remainingSeconds = credential.expires_at - this.activityClock.now();
        if (remainingSeconds <= 0) { this.clearProtectedActivities(); return; }
        this.protectedActivityTimer = this.activityClock.setTimeout(() => {
            this.protectedActivityTimer = null;
            if (this.authorizationIntentId !== intentId || this.authorizationIntentPending || this.protectedActivities.size === 0) return;
            const authorization = this.credentials.requestHeaders().Authorization;
            const previousExpiry = this.credentials.current()?.expires_at;
            const recover = authorization ? this.captureAuthorizationRecovery(authorization) : null;
            if (!recover) { this.clearProtectedActivities(); return; }
            // Reuse the same intent/current-credential/singleflight guards as 401 recovery.
            void recover().then(recovery => {
                if (this.authorizationIntentId !== intentId) return;
                const refreshed = this.credentials.current();
                if (!recovery || !refreshed || previousExpiry === undefined
                    || refreshed.expires_at <= previousExpiry
                    || refreshed.expires_at - this.activityClock.now() <= 60) {
                    // A malformed/non-extending renewal must not create an immediate retry loop.
                    this.clearProtectedActivities();
                    return;
                }
                this.scheduleProtectedActivityRenewal();
            }).catch(() => {
                if (this.authorizationIntentId === intentId) this.clearProtectedActivities();
            });
        }, Math.max(0, (remainingSeconds - 60) * 1000));
    }

    captureAuthorizationRecovery(authorization: string): (() => Promise<LocalEngineAuthorizationRecovery | null>) | null {
        if (this.authorizationIntentPending || this.credentials.requestHeaders().Authorization !== authorization) return null;
        const intentId = this.authorizationIntentId;
        const operationId = this.authorizationOperationId;
        return () => this.recoverAuthorization(authorization, intentId, operationId);
    }

    private async recoverAuthorization(
        authorization: string, intentId: number, capturedOperationId: number,
    ): Promise<LocalEngineAuthorizationRecovery | null> {
        if (this.authorizationIntentPending || this.authorizationIntentId !== intentId || !this.credentials.current()) return null;
        let operationId = this.authorizationOperationId;
        if (capturedOperationId === operationId || this.renewSessionInFlight) {
            if (capturedOperationId === operationId && this.credentials.requestHeaders().Authorization !== authorization) return null;
            const renewal = this.renewSession();
            operationId = this.authorizationOperationId;
            try {
                if (!await renewal) return null;
            } catch {
                // renewSession publishes failure and clears only the current credential.
                return null;
            }
        }
        if (this.authorizationIntentPending || this.authorizationIntentId !== intentId || !this.isLatestAuthorization(operationId)) return null;
        const credential = this.credentials.current();
        if (!credential) return null;
        const isCurrent = () => (
            this.isLatestAuthorization(operationId)
            && this.authorizationIntentId === intentId && !this.authorizationIntentPending
            && this.credentials.current()?.session_token === credential.session_token
        );
        return {
            authorization: `Bearer ${credential.session_token}`,
            isCurrent,
            expire: () => {
                if (!isCurrent()) return;
                this.beginAuthorizationOperation();
                this.credentials.clear();
                this.callbacks.onAuthorization('expired');
                this.callbacks.onPairingState({ phase: 'expired', challenge: null });
            },
        };
    }

    dispose(): void {
        this.beginTransportOperation();
        this.beginUserAuthorizationOperation(false);
        this.currentChallenge = null;
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
                { method: 'POST', timeoutMs: 5000 },
            );
            if (response.status === 401) {
                if (this.isLatestAuthorization(operationId)) {
                    this.credentials.clear();
                    const saved = this.browserCredentials.current();
                    if (saved && await this.restoreBrowser(operationId, saved)) return true;
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
        this.explicitlyDisconnected = true;
        const operationId = this.beginUserAuthorizationOperation();
        try {
            const browserToken = this.browserCredentials.current();
            if (browserToken) {
                const response = await this.client.pair('/api/pair/forget', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ browser_token: browserToken }),
                });
                if (!response.ok && response.status !== 401) throw await responseError(response, 'session');
                if (!this.isLatestAuthorization(operationId)) return false;
                this.browserCredentials.clear();
                this.credentials.clear();
                this.callbacks.onAuthorization('revoked');
                this.callbacks.onPairingState({ phase: 'revoked', challenge: null });
                return true;
            }
            const currentCredential = this.credentials.current();
            if (!currentCredential) {
                this.callbacks.onAuthorization('expired');
                this.callbacks.onPairingState({ phase: 'expired', challenge: null });
                return false;
            }
            const response = await this.client.session(
                '/api/session/revoke', currentCredential.session_token, { method: 'POST' },
            );
            if (!response.ok && response.status !== 401) throw await responseError(response, 'session');
            if (!this.isLatestAuthorization(operationId)) return false;
            this.credentials.clear();
            const authorization = response.status === 401 ? 'expired' : 'revoked';
            this.callbacks.onAuthorization(authorization);
            this.callbacks.onPairingState({ phase: authorization, challenge: null });
            return response.ok;
        } finally {
            if (this.isLatestAuthorization(operationId)) this.authorizationIntentPending = false;
        }
    }

    private async revokeCredentialBestEffort(sessionToken: string): Promise<void> {
        try {
            await this.client.session('/api/session/revoke', sessionToken, { method: 'POST', timeoutMs: 5000 });
        } catch {
            // A stale credential is never installed locally; its short server TTL remains the fallback.
        }
    }
}
