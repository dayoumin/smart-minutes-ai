import { LOCAL_ENGINE_NAME, withJosa } from './brand.ts';
import type {
    LocalEngineConnectionAction,
    LocalEngineConnectionViewModel,
} from './localEngineConnectionView';

// The new-meeting action row in the web connection build: one status line beside 분석 시작 that names
// the first blocked step (connection → readiness), plus the buttons that fix that step.
// Analysis-start conditions and required fields join this order in a later slice.

export type WriterStatusActionKind =
    | LocalEngineConnectionAction
    | 'models'
    | 'device'
    | 'diarization'
    | 'recheck-readiness'
    /** The user's own connection check, then a fresh readiness round. */
    | 'recheck-engine';

export interface WriterStatusAction {
    kind: WriterStatusActionKind;
    label: string;
    disabled?: boolean;
}

export interface WriterStatusRow {
    stage: 'connection' | 'readiness' | 'ready';
    /** Stable name of the state, exposed as data-state for tests and screenshots. */
    state: string;
    tone: 'neutral' | 'info' | 'warning' | 'error' | 'success';
    busy: boolean;
    title: string;
    message: string | null;
    help: string | null;
    /** In visual order; the last one sits right beside 분석 시작. */
    actions: WriterStatusAction[];
    /** 분석 시작 stays unavailable while this row explains why. */
    blocksStart: boolean;
}

export type WriterReadinessState = 'checking' | 'server-waiting' | 'ready' | 'missing-models' | 'error';

export interface WriterMissingModel {
    key: string;
    label: string;
    downloadable?: boolean;
}

export interface SelectWriterStatusRowInput {
    connection: LocalEngineConnectionViewModel;
    readinessState: WriterReadinessState;
    /** The engine's own reason when readiness could not be confirmed; shown behind `?`. */
    readinessMessage: string;
    /** The readiness check has gone 45s without an answer from the engine (only while it is checking). */
    readinessNoResponse?: boolean;
    /** Required models that are not installed. */
    missingModels: WriterMissingModel[];
    /** 참석자 구분까지 이어서 실행 is on, which makes the diarization model required. */
    diarizationDuringAnalysis: boolean;
    /** The selected analysis device is a GPU this PC cannot use. */
    gpuUnavailable: boolean;
    installerAvailable: boolean;
    canOpenModelSettings: boolean;
    canOpenAnalysisSettings: boolean;
    /** Appended where the installer is offered (test releases warn about Windows security prompts). */
    installerNotice?: string;
}

// Short names for the list under 모델을 받아야 분석할 수 있습니다 (음성 인식, 참석자 구분).
const getShortModelLabel = (model: WriterMissingModel): string => {
    if (model.key === 'stt_faster_whisper') return '음성 인식';
    if (model.key === 'diarization') return '참석자 구분';
    return model.label;
};

const withInstallerNotice = (row: WriterStatusRow, notice: string | undefined): WriterStatusRow => {
    if (!notice || !row.actions.some(action => action.kind === 'download')) return row;
    // With a `?`, the warning moves into its help so the line stays short.
    return row.help
        ? { ...row, help: `${row.help} ${notice}` }
        : { ...row, message: [row.message, notice].filter(Boolean).join(' ') };
};

const connectionRow = (connection: LocalEngineConnectionViewModel): WriterStatusRow => {
    const actions: WriterStatusAction[] = [];
    if (connection.secondaryAction && connection.secondaryLabel) {
        actions.push({ kind: connection.secondaryAction, label: connection.secondaryLabel });
    }
    if (connection.primaryAction && connection.primaryLabel) {
        actions.push({ kind: connection.primaryAction, label: connection.primaryLabel, disabled: connection.primaryDisabled });
    }
    return {
        stage: 'connection',
        state: connection.scene,
        tone: connection.tone,
        busy: connection.busy,
        title: connection.title,
        message: connection.message,
        help: connection.help,
        actions,
        blocksStart: true,
    };
};

const readinessRow = (
    value: Omit<WriterStatusRow, 'stage' | 'busy' | 'help' | 'blocksStart'> & Partial<WriterStatusRow>,
): WriterStatusRow => ({ stage: 'readiness', busy: false, help: null, blocksStart: true, ...value });

const selectReadinessRow = (input: SelectWriterStatusRowInput): WriterStatusRow | null => {
    const recheck: WriterStatusAction = { kind: 'recheck-readiness', label: '다시 확인' };
    switch (input.readinessState) {
        case 'ready':
            return null;
        case 'checking':
        case 'server-waiting':
            if (input.readinessNoResponse) {
                return readinessRow({
                    state: 'no-response',
                    tone: 'warning',
                    title: `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 응답하지 않습니다`,
                    message: '잠시 뒤 다시 확인해 주세요.',
                    help: `계속되면 Windows 시작 메뉴에서 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 실행하세요.`,
                    actions: [{ kind: 'recheck-engine', label: '다시 확인' }],
                });
            }
            return readinessRow({
                state: 'readiness-checking',
                tone: 'neutral',
                busy: true,
                title: '분석 준비 확인 중',
                message: null,
                actions: [],
            });
        case 'error':
            return readinessRow({
                state: 'readiness-error',
                tone: 'warning',
                title: '분석 준비 상태를 확인하지 못했습니다',
                message: '잠시 뒤 다시 확인해 주세요.',
                help: input.readinessMessage || null,
                actions: [recheck],
            });
        case 'missing-models':
            break;
    }

    const missing = input.missingModels;
    // A model Settings can download is fixed first, even when the GPU is also unusable.
    if (missing.some(model => model.downloadable)) {
        return readinessRow({
            state: 'models-missing',
            tone: 'info',
            title: '모델을 받아야 분석할 수 있습니다',
            message: [...new Set(missing.map(getShortModelLabel))].join(', '),
            actions: input.canOpenModelSettings ? [{ kind: 'models', label: '모델 받기' }] : [],
        });
    }
    if (missing.length > 0) {
        // Only the diarization model is missing and 참석자 구분까지 이어서 실행 requires it: turning that off is the fix.
        if (input.diarizationDuringAnalysis && input.canOpenAnalysisSettings
            && missing.every(model => model.key === 'diarization')) {
            return readinessRow({
                state: 'diarization-model-missing',
                tone: 'warning',
                title: '참석자 구분 모델이 없습니다',
                message: '이어서 실행을 끄면 대화록부터 만들 수 있습니다.',
                actions: [{ kind: 'diarization', label: '참석자 구분 설정' }],
            });
        }
        return readinessRow({
            state: 'models-reinstall',
            tone: 'error',
            title: '필요한 모델이 없어 분석을 시작할 수 없습니다',
            message: `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.`,
            actions: input.installerAvailable ? [{ kind: 'download', label: '설치 파일' }] : [],
        });
    }
    if (input.gpuUnavailable) {
        return readinessRow({
            state: 'gpu-unavailable',
            tone: 'warning',
            title: 'GPU를 쓸 수 없습니다',
            message: '분석 장치를 CPU로 바꿔 주세요.',
            actions: input.canOpenAnalysisSettings ? [{ kind: 'device', label: '분석 장치 설정' }] : [],
        });
    }
    // Not ready for a reason the engine only describes in words (its first error).
    return readinessRow({
        state: 'readiness-blocked',
        tone: 'warning',
        title: '분석을 시작할 수 없습니다',
        message: '잠시 뒤 다시 확인해 주세요.',
        help: input.readinessMessage || null,
        actions: [recheck],
    });
};

export const selectWriterStatusRow = (input: SelectWriterStatusRowInput): WriterStatusRow => {
    const row = !input.connection.analysisReady
        ? connectionRow(input.connection)
        : selectReadinessRow(input) ?? {
            stage: 'ready',
            state: 'ready',
            tone: 'success',
            busy: false,
            title: '연결됨',
            message: null,
            help: null,
            actions: [],
            blocksStart: false,
        };
    return withInstallerNotice(row, input.installerNotice);
};
