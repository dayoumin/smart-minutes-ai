import { LOCAL_ENGINE_NAME, withJosa } from './brand.ts';
import type {
    LocalEngineConnectionSnapshot,
} from './localEngineConnection';
import type {
    LocalEnginePairingPhase,
} from './localEngineConnectionCoordinator';
import { isNewerEngineVersion, type LocalEngineRelease } from './localEngineRelease.ts';

export type LocalEngineConnectionScene =
    | 'intro'
    | 'checking'
    | 'unreachable'
    | 'browser-blocked'
    | 'invalid-response'
    | 'pairing-required'
    | 'pairing'
    | 'connected'
    | 'update-available'
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
    /** States the step (`…니다`); the writer's status row shows it as the title. */
    title: string;
    /** One line: what to do (`…해 주세요.`). Longer explanations go to `help`. */
    message: string | null;
    /** Behind the row's `?`: only for warnings the first button may not fix. */
    help: string | null;
    /** The fix that sits right beside 분석 시작. */
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
    latestRelease?: LocalEngineRelease | null;
    /** The user's check is running while the browser may be showing its allow prompt. */
    permissionPromptPending?: boolean;
    /** Why the last browser connection failed, when the coordinator knows. */
    pairingErrorReason?: string;
}

const ALLOW_PROMPT_HINT = 'Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요.';
const NOT_RUNNING_HELP = `Windows 시작 메뉴에서 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하세요. Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 누르세요. 회사 정책으로 막히면 관리자에게 문의하세요.`;

const view = (
    value: Omit<LocalEngineConnectionViewModel, 'help' | 'primaryDisabled' | 'secondaryAction' | 'secondaryLabel' | 'busy' | 'analysisReady'>
        & Partial<LocalEngineConnectionViewModel>,
): LocalEngineConnectionViewModel => ({
    help: null,
    primaryDisabled: false,
    secondaryAction: null,
    secondaryLabel: null,
    busy: false,
    analysisReady: false,
    ...value,
});

export const getLocalEngineConnectionView = ({
    snapshot,
    pairingPhase,
    connectionStarted,
    installerAvailable = false,
    updateAvailable = false,
    latestRelease,
    permissionPromptPending = false,
    pairingErrorReason,
}: GetLocalEngineConnectionViewInput): LocalEngineConnectionViewModel => {
    const analysisReady = snapshot.transport === 'reachable'
        && snapshot.authorization === 'authenticated'
        && snapshot.capabilities.has('analysis')
        && !snapshot.updateRequired;
    const installer = installerAvailable
        ? { secondaryAction: 'download' as const, secondaryLabel: '설치 파일' }
        : {};
    const updateView = (ready: boolean): LocalEngineConnectionViewModel | null => {
        if (latestRelease && snapshot.engineVersion && isNewerEngineVersion(latestRelease.version, snapshot.engineVersion)) {
            const installedCore = snapshot.engineVersion.split(/[+-]/)[0];
            const latestCore = latestRelease.version.split(/[+-]/)[0];
            return view({
                scene: 'update-available',
                tone: 'info',
                title: '새 버전이 있습니다',
                message: installedCore === latestCore
                    ? `${snapshot.engineVersion} → ${latestRelease.version}`
                    : `${installedCore} → ${latestCore}`,
                help: `설치된 버전 ${snapshot.engineVersion}, 최신 버전 ${latestRelease.version}. 다운로드한 설치 파일을 실행해 주세요. 설치가 끝나면 자동으로 다시 확인합니다. 분석 중이라면 끝난 뒤 설치해 주세요.`,
                primaryAction: 'update',
                primaryLabel: '업데이트 안내',
                secondaryAction: 'probe',
                secondaryLabel: '다시 확인',
                analysisReady: ready,
            });
        }
        return null;
    };

    if (analysisReady) {
        const update = updateView(true);
        if (update) return update;
        // Model and device checks come next; the writer, not this view, says whether analysis can start.
        return view({
            scene: 'connected',
            tone: 'success',
            title: '연결됨',
            message: null,
            primaryAction: null,
            primaryLabel: null,
            analysisReady: true,
        });
    }

    // Comes before every other state, and before the first click: while the browser refuses
    // the request, session, pairing or update guidance would send the user to the wrong fix.
    // A background re-check keeps this view; a manual retry clears the flag to show progress.
    // An undecided permission is not shown here: the intro and unreachable views explain it.
    if ((snapshot.blockedBy === 'browser-permission' || snapshot.blockedBy === 'response-blocked')
        && (snapshot.transport === 'unreachable' || snapshot.transport === 'checking')) {
        const permissionDenied = snapshot.blockedBy === 'browser-permission';
        return view({
            scene: 'browser-blocked',
            tone: 'warning',
            title: '브라우저가 연결을 막고 있습니다',
            message: permissionDenied
                ? '사이트 정보에서 ‘기기에 있는 앱’을 허용해 주세요.'
                : '요청을 바꾸는 확장 프로그램을 꺼 주세요.',
            // A response-blocked answer may also come from an older install that does not list
            // this site, so reinstalling stays offered there; a denied permission it cannot fix.
            help: permissionDenied
                ? '주소창 왼쪽의 사이트 정보 아이콘을 누르면 ‘기기에 있는 앱’ 설정이 있습니다. 허용한 뒤에도 같으면 새로고침해 주세요.'
                : `로컬 AI 도우미 같은 확장 프로그램을 끈 뒤 새로고침해 주세요. 계속되면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.`,
            primaryAction: 'probe',
            primaryLabel: '다시 확인',
            ...(permissionDenied ? {} : installer),
        });
    }

    // With an undecided permission, background re-checks are held back without a request,
    // so their brief 'checking' must not flash a spinner over the unreachable guidance.
    const heldBackgroundCheck = snapshot.transport === 'checking' && snapshot.blockedBy === 'permission-prompt';

    if (connectionStarted && snapshot.transport === 'checking' && !heldBackgroundCheck
        && pairingPhase !== 'starting' && pairingPhase !== 'completing') {
        return view({
            scene: 'checking',
            tone: 'neutral',
            title: '연결 확인 중',
            message: permissionPromptPending ? ALLOW_PROMPT_HINT : null,
            primaryAction: null,
            primaryLabel: null,
            primaryDisabled: true,
            busy: true,
        });
    }

    if (snapshot.updateRequired || snapshot.transport === 'incompatible') {
        return view({
            scene: 'update-required',
            tone: 'warning',
            title: `${LOCAL_ENGINE_NAME} 업데이트가 필요합니다`,
            message: '업데이트한 뒤 다시 확인해 주세요.',
            primaryAction: updateAvailable ? 'update' : 'probe',
            primaryLabel: updateAvailable ? '업데이트 안내' : '다시 확인',
            ...(updateAvailable ? { secondaryAction: 'probe' as const, secondaryLabel: '다시 확인' } : {}),
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
        });
    }

    if (pairingPhase === 'starting' || pairingPhase === 'completing' || pairingPhase === 'awaiting-approval') {
        return view({
            scene: 'pairing',
            tone: 'neutral',
            title: '연결 확인 중',
            message: null,
            primaryAction: null,
            primaryLabel: null,
            primaryDisabled: true,
            busy: true,
        });
    }

    if (pairingPhase === 'awaiting-code') {
        const update = snapshot.transport === 'reachable' ? updateView(false) : null;
        if (update) return update;
        return view({
            scene: 'pairing-required',
            tone: 'info',
            title: '이 브라우저를 연결해 주세요',
            message: '연결 창의 일회성 코드를 입력해 주세요.',
            primaryAction: 'open-code',
            primaryLabel: '코드 입력',
        });
    }

    if (snapshot.transport === 'reachable') {
        const update = updateView(false);
        if (update) return update;
    }

    if (pairingPhase === 'error') {
        return view({
            scene: 'pairing-required',
            tone: 'warning',
            title: '연결을 완료하지 못했습니다',
            message: pairingErrorReason || `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`,
            primaryAction: snapshot.transport === 'reachable' ? 'pair' : 'probe',
            primaryLabel: snapshot.transport === 'reachable' ? '다시 연결' : '다시 확인',
        });
    }

    if (snapshot.transport === 'reachable' && snapshot.authorization === 'authenticated') {
        return view({
            scene: 'capability-missing',
            tone: 'warning',
            title: '이 브라우저에 분석 권한이 없습니다',
            message: '다시 연결해 주세요.',
            primaryAction: 'pair',
            primaryLabel: '다시 연결',
        });
    }

    if (snapshot.transport === 'reachable' && snapshot.authorization !== 'authenticated') {
        return view({
            scene: 'pairing-required',
            tone: 'info',
            title: '이 브라우저를 연결해 주세요',
            message: `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중이면 자동으로 연결됩니다.`,
            primaryAction: 'pair',
            primaryLabel: '연결 시작',
            secondaryAction: 'probe',
            secondaryLabel: '다시 확인',
        });
    }

    if (!connectionStarted) {
        // Before any check the page cannot know whether the engine is installed, so it never
        // promises an automatic connection; an undecided permission says what the prompt is for.
        return view({
            scene: 'intro',
            tone: 'info',
            title: `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 필요합니다`,
            message: snapshot.blockedBy === 'permission-prompt'
                ? '연결 확인 후 Chrome이 물으면 ‘허용’을 눌러 주세요.'
                : '설치했다면 연결 확인을 눌러 주세요.',
            primaryAction: 'probe',
            primaryLabel: '연결 확인',
            ...installer,
        });
    }

    if (snapshot.transport === 'unreachable' || heldBackgroundCheck) {
        return view({
            scene: 'unreachable',
            tone: 'warning',
            title: '연결하지 못했습니다',
            // Undecided permission after a check: the prompt was closed, or nothing answered so
            // Chrome never asked. The page cannot tell which, so it names both fixes.
            message: snapshot.blockedBy === 'permission-prompt'
                ? `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하고, Chrome이 물으면 ‘허용’을 눌러 주세요.`
                : `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인해 주세요.`,
            help: NOT_RUNNING_HELP,
            primaryAction: 'probe',
            primaryLabel: '다시 확인',
            ...installer,
        });
    }

    return view({
        scene: 'invalid-response',
        tone: 'warning',
        title: '연결 상태를 확인하지 못했습니다',
        message: '잠시 뒤 다시 확인해 주세요.',
        help: `계속되면 Windows 시작 메뉴에서 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 실행하세요. 그래도 같으면 다시 설치해 주세요.`,
        primaryAction: 'probe',
        primaryLabel: '다시 확인',
    });
};
