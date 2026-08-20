import type {
    LocalEngineConnectionSnapshot,
} from './localEngineConnection';
import type {
    LocalEnginePairingPhase,
} from './localEngineConnectionCoordinator';

export type LocalEngineConnectionScene =
    | 'intro'
    | 'checking'
    | 'unreachable'
    | 'invalid-response'
    | 'pairing-required'
    | 'pairing'
    | 'connected'
    | 'session-ended'
    | 'update-required'
    | 'capability-missing';

export type LocalEngineConnectionAction =
    | 'probe'
    | 'download'
    | 'pair'
    | 'open-code'
    | 'update';

export interface LocalEngineConnectionViewModel {
    scene: LocalEngineConnectionScene;
    tone: 'neutral' | 'info' | 'warning' | 'error' | 'success';
    title: string;
    message: string | null;
    primaryAction: LocalEngineConnectionAction | null;
    primaryLabel: string | null;
    primaryDisabled: boolean;
    secondaryAction: LocalEngineConnectionAction | null;
    secondaryLabel: string | null;
    busy: boolean;
    analysisReady: boolean;
}

export interface GetLocalEngineConnectionViewInput {
    snapshot: LocalEngineConnectionSnapshot;
    pairingPhase: LocalEnginePairingPhase;
    connectionStarted: boolean;
    installerAvailable?: boolean;
    updateAvailable?: boolean;
}

const view = (
    value: LocalEngineConnectionViewModel,
): LocalEngineConnectionViewModel => value;

export const getLocalEngineConnectionView = ({
    snapshot,
    pairingPhase,
    connectionStarted,
    installerAvailable = false,
    updateAvailable = false,
}: GetLocalEngineConnectionViewInput): LocalEngineConnectionViewModel => {
    const analysisReady = snapshot.transport === 'reachable'
        && snapshot.authorization === 'authenticated'
        && snapshot.capabilities.has('analysis')
        && !snapshot.updateRequired;

    if (analysisReady) {
        return view({
            scene: 'connected',
            tone: 'success',
            title: '분석 준비 완료',
            message: null,
            primaryAction: null,
            primaryLabel: null,
            primaryDisabled: false,
            secondaryAction: null,
            secondaryLabel: null,
            busy: false,
            analysisReady: true,
        });
    }

    if (connectionStarted && snapshot.transport === 'checking'
        && pairingPhase !== 'starting' && pairingPhase !== 'completing') {
        return view({
            scene: 'checking',
            tone: 'info',
            title: '연결 확인 중',
            message: null,
            primaryAction: null,
            primaryLabel: null,
            primaryDisabled: true,
            secondaryAction: null,
            secondaryLabel: null,
            busy: true,
            analysisReady: false,
        });
    }

    if (snapshot.updateRequired || snapshot.transport === 'incompatible') {
        return view({
            scene: 'update-required',
            tone: 'warning',
            title: '업데이트가 필요합니다',
            message: '업데이트한 뒤 다시 확인해 주세요.',
            primaryAction: updateAvailable ? 'update' : 'probe',
            primaryLabel: updateAvailable ? '업데이트 안내' : '다시 확인',
            primaryDisabled: false,
            secondaryAction: updateAvailable ? 'probe' : null,
            secondaryLabel: updateAvailable ? '다시 확인' : null,
            busy: false,
            analysisReady: false,
        });
    }

    if (snapshot.authorization === 'expired' || snapshot.authorization === 'revoked'
        || pairingPhase === 'expired' || pairingPhase === 'revoked') {
        return view({
            scene: 'session-ended',
            tone: 'warning',
            title: '연결이 만료되었습니다',
            message: '입력 내용은 유지됩니다. 다시 연결해 주세요.',
            primaryAction: 'pair',
            primaryLabel: '다시 연결',
            primaryDisabled: snapshot.transport !== 'reachable',
            secondaryAction: 'probe',
            secondaryLabel: '다시 확인',
            busy: false,
            analysisReady: false,
        });
    }

    if (pairingPhase === 'starting' || pairingPhase === 'completing') {
        return view({
            scene: 'pairing',
            tone: 'info',
            title: pairingPhase === 'completing' ? '연결 확인 중' : '연결 준비 중',
            message: null,
            primaryAction: null,
            primaryLabel: null,
            primaryDisabled: true,
            secondaryAction: null,
            secondaryLabel: null,
            busy: true,
            analysisReady: false,
        });
    }

    if (pairingPhase === 'awaiting-code') {
        return view({
            scene: 'pairing-required',
            tone: 'info',
            title: '이 브라우저를 연결해 주세요',
            message: '연결 창의 일회성 코드를 입력하세요.',
            primaryAction: 'open-code',
            primaryLabel: '코드 입력',
            primaryDisabled: false,
            secondaryAction: null,
            secondaryLabel: null,
            busy: false,
            analysisReady: false,
        });
    }

    if (pairingPhase === 'error') {
        return view({
            scene: 'pairing-required',
            tone: 'error',
            title: '연결을 완료하지 못했습니다',
            message: '새 코드를 받아 다시 시도해 주세요.',
            primaryAction: snapshot.transport === 'reachable' ? 'pair' : 'probe',
            primaryLabel: snapshot.transport === 'reachable' ? '다시 연결' : '다시 확인',
            primaryDisabled: false,
            secondaryAction: null,
            secondaryLabel: null,
            busy: false,
            analysisReady: false,
        });
    }

    if (snapshot.transport === 'reachable' && snapshot.authorization === 'authenticated') {
        return view({
            scene: 'capability-missing',
            tone: 'warning',
            title: '분석 권한을 확인해 주세요',
            message: '다시 연결해 분석 권한을 확인해 주세요.',
            primaryAction: 'pair',
            primaryLabel: '다시 연결',
            primaryDisabled: false,
            secondaryAction: null,
            secondaryLabel: null,
            busy: false,
            analysisReady: false,
        });
    }

    if (snapshot.transport === 'reachable' && snapshot.authorization !== 'authenticated') {
        return view({
            scene: 'pairing-required',
            tone: 'info',
            title: '이 브라우저를 연결해 주세요',
            message: '일회성 코드로 한 번 연결합니다.',
            primaryAction: 'pair',
            primaryLabel: '연결 시작',
            primaryDisabled: false,
            secondaryAction: 'probe',
            secondaryLabel: '다시 확인',
            busy: false,
            analysisReady: false,
        });
    }

    if (!connectionStarted) {
        return view({
            scene: 'intro',
            tone: 'neutral',
            title: '이 PC에서 분석합니다',
            message: null,
            primaryAction: 'probe',
            primaryLabel: '연결 확인',
            primaryDisabled: false,
            secondaryAction: null,
            secondaryLabel: null,
            busy: false,
            analysisReady: false,
        });
    }

    if (snapshot.transport === 'unreachable') {
        return view({
            scene: 'unreachable',
            tone: 'warning',
            title: '분석 기능에 연결하지 못했습니다',
            message: '바로록 연결을 실행한 뒤 다시 시도하세요.',
            primaryAction: installerAvailable ? 'download' : 'probe',
            primaryLabel: installerAvailable ? '로컬 엔진 받기' : '다시 연결',
            primaryDisabled: false,
            secondaryAction: installerAvailable ? 'probe' : null,
            secondaryLabel: installerAvailable ? '다시 연결' : null,
            busy: false,
            analysisReady: false,
        });
    }

    return view({
        scene: 'invalid-response',
            tone: 'error',
            title: '연결 상태를 확인하지 못했습니다',
            message: '다시 시도하고 계속되면 문제 해결을 확인하세요.',
        primaryAction: 'probe',
        primaryLabel: '다시 확인',
        primaryDisabled: false,
        secondaryAction: null,
        secondaryLabel: null,
        busy: false,
        analysisReady: false,
    });
};
