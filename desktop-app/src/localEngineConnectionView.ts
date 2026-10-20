import { LOCAL_ENGINE_NAME, withJosa } from './brand.ts';
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
    | 'browser-blocked'
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
    /** Connected, but analysis still needs something on this PC (e.g. a model); the writer says what. */
    analysisPrerequisitesMissing?: boolean;
    /** The user's check is running while the browser may be showing its allow prompt. */
    permissionPromptPending?: boolean;
}

const ALLOW_PROMPT_HINT = 'Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요.';

const view = (
    value: LocalEngineConnectionViewModel,
): LocalEngineConnectionViewModel => value;

export const getLocalEngineConnectionView = ({
    snapshot,
    pairingPhase,
    connectionStarted,
    installerAvailable = false,
    updateAvailable = false,
    analysisPrerequisitesMissing = false,
    permissionPromptPending = false,
}: GetLocalEngineConnectionViewInput): LocalEngineConnectionViewModel => {
    const analysisReady = snapshot.transport === 'reachable'
        && snapshot.authorization === 'authenticated'
        && snapshot.capabilities.has('analysis')
        && !snapshot.updateRequired;

    if (analysisReady) {
        return view({
            scene: 'connected',
            tone: 'success',
            title: analysisPrerequisitesMissing ? '연결됨' : '분석 준비 완료',
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

    // Comes before every other state, and before the first click: while the browser refuses
    // the request, session, pairing or update guidance would send the user to the wrong fix.
    // A background re-check keeps this view; a manual retry clears the flag to show progress.
    // An undecided permission is not shown here: the intro and unreachable views explain it.
    if ((snapshot.blockedBy === 'browser-permission' || snapshot.blockedBy === 'response-blocked')
        && (snapshot.transport === 'unreachable' || snapshot.transport === 'checking')) {
        return view({
            scene: 'browser-blocked',
            tone: 'warning',
            title: '브라우저가 연결을 막고 있습니다',
            // A response-blocked answer may also come from an older install that does not list
            // this site, so reinstalling stays offered there; a denied permission it cannot fix.
            message: snapshot.blockedBy === 'browser-permission'
                ? '주소창 왼쪽 사이트 정보에서 ‘기기에 있는 앱’을 허용한 뒤 새로고침해 주세요.'
                : `응답은 왔지만 브라우저가 결과를 막았습니다. 요청을 바꾸는 확장 프로그램을 끄고 새로고침하세요. 계속되면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.`,
            primaryAction: 'probe',
            primaryLabel: '연결 확인',
            primaryDisabled: false,
            secondaryAction: snapshot.blockedBy === 'response-blocked' && installerAvailable ? 'download' : null,
            secondaryLabel: snapshot.blockedBy === 'response-blocked' && installerAvailable ? `${LOCAL_ENGINE_NAME} 받기` : null,
            busy: false,
            analysisReady: false,
        });
    }

    // With an undecided permission, background re-checks are held back without a request,
    // so their brief 'checking' must not flash a spinner over the unreachable guidance.
    const heldBackgroundCheck = snapshot.transport === 'checking' && snapshot.blockedBy === 'permission-prompt';

    if (connectionStarted && snapshot.transport === 'checking' && !heldBackgroundCheck
        && pairingPhase !== 'starting' && pairingPhase !== 'completing') {
        return view({
            scene: 'checking',
            tone: 'info',
            title: '연결 확인 중',
            message: permissionPromptPending ? ALLOW_PROMPT_HINT : null,
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

    if (pairingPhase === 'starting' || pairingPhase === 'completing' || pairingPhase === 'awaiting-approval') {
        return view({
            scene: 'pairing',
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
            message: `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인한 뒤 다시 연결해 주세요.`,
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
            message: `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하면 자동으로 연결됩니다.`,
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
            // Undecided browser access: say what the prompt after 연결 확인 is for, before it shows.
            message: snapshot.blockedBy === 'permission-prompt'
                ? `${installerAvailable ? `처음이면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 받아 설치하세요. ` : ''}‘연결 확인’을 누른 뒤 ${ALLOW_PROMPT_HINT}`
                : installerAvailable ? `처음이면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 받아 설치한 뒤 연결을 확인하세요.` : null,
            primaryAction: 'probe',
            primaryLabel: '연결 확인',
            primaryDisabled: false,
            secondaryAction: installerAvailable ? 'download' : null,
            secondaryLabel: installerAvailable ? `${LOCAL_ENGINE_NAME} 받기` : null,
            busy: false,
            analysisReady: false,
        });
    }

    if (snapshot.transport === 'unreachable' || heldBackgroundCheck) {
        return view({
            scene: 'unreachable',
            tone: 'warning',
            title: '분석 기능에 연결하지 못했습니다',
            // Undecided permission after a check: the prompt was closed, or nothing answered so
            // Chrome never asked. The page cannot tell which, so it names both fixes.
            message: snapshot.blockedBy === 'permission-prompt'
                ? `설치했다면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인하세요. ${ALLOW_PROMPT_HINT}`
                : `설치했다면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인하세요.`,
            primaryAction: 'probe',
            primaryLabel: '연결 확인',
            primaryDisabled: false,
            secondaryAction: installerAvailable ? 'download' : null,
            secondaryLabel: installerAvailable ? `${LOCAL_ENGINE_NAME} 받기` : null,
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
