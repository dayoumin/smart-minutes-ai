import type { LocalEngineCapability } from './localEngineConnection';

const KNOWN_CAPABILITIES = new Set<LocalEngineCapability>([
    'analysis',
    'model-management',
    'meeting-storage',
    'export',
]);

export interface LocalEnginePairingStart {
    pairing_id: string;
    expires_in_seconds: number;
}

export interface LocalEngineSessionCredential {
    session_token: string;
    expires_at: number;
    capabilities: LocalEngineCapability[];
}

export const parseLocalEnginePairingStart = (
    value: unknown,
): LocalEnginePairingStart | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<LocalEnginePairingStart>;
    if (
        typeof payload.pairing_id !== 'string'
        || payload.pairing_id.length < 12
        || !Number.isFinite(payload.expires_in_seconds)
        || Number(payload.expires_in_seconds) <= 0
    ) {
        return null;
    }
    return {
        pairing_id: payload.pairing_id,
        expires_in_seconds: Number(payload.expires_in_seconds),
    };
};

export const parseLocalEngineSessionCredential = (
    value: unknown,
): LocalEngineSessionCredential | null => {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<LocalEngineSessionCredential>;
    if (
        typeof payload.session_token !== 'string'
        || payload.session_token.length < 24
        || !Number.isFinite(payload.expires_at)
        || !Array.isArray(payload.capabilities)
        || payload.capabilities.some(capability => typeof capability !== 'string')
    ) {
        return null;
    }
    return {
        session_token: payload.session_token,
        expires_at: Number(payload.expires_at),
        capabilities: payload.capabilities.filter(
            (capability): capability is LocalEngineCapability => KNOWN_CAPABILITIES.has(
                capability as LocalEngineCapability,
            ),
        ),
    };
};

export class LocalEngineSessionCredentialStore {
    private credential: LocalEngineSessionCredential | null = null;
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now() / 1000) {
        this.now = now;
    }

    replace(credential: LocalEngineSessionCredential): boolean {
        if (credential.expires_at <= this.now()) {
            this.clear();
            return false;
        }
        this.credential = {
            ...credential,
            capabilities: [...credential.capabilities],
        };
        return true;
    }

    clear(): void {
        this.credential = null;
    }

    current(): LocalEngineSessionCredential | null {
        if (!this.credential) return null;
        if (this.credential.expires_at <= this.now()) {
            this.clear();
            return null;
        }
        return {
            ...this.credential,
            capabilities: [...this.credential.capabilities],
        };
    }

    requestHeaders(): Record<string, string> {
        const credential = this.current();
        return credential
            ? { Authorization: `Bearer ${credential.session_token}` }
            : {};
    }
}
