import { ANALYSIS_DURATION_LIMIT_MESSAGE, ANALYSIS_DURATION_LIMIT_TITLE } from './analysisMediaLimit.ts';
import { LOCAL_ENGINE_NAME, withJosa } from './brand.ts';
import type {
    LocalEngineConnectionAction,
    LocalEngineConnectionViewModel,
} from './localEngineConnectionView';

// The new-meeting action row in the web connection build: one status line beside 분석 시작 that names
// the first blocked step (connection → readiness → analysis-start conditions → required fields),
// plus the buttons that fix that step.

export type WriterStatusActionKind =
    | LocalEngineConnectionAction
    | 'models'
    | 'device'
    | 'diarization'
    | 'recheck-readiness'
    /** The user's own connection check, then a fresh readiness round. */
    | 'recheck-engine'
    /** Opens the file picker. */
    | 'choose-file'
    /** Asks the engine again how the saved analyses stand. */
    | 'refresh-analysis-status';

export interface WriterStatusAction {
    kind: WriterStatusActionKind;
    label: string;
    disabled?: boolean;
}

export interface WriterStatusRow {
    stage: 'connection' | 'readiness' | 'input' | 'ready';
    /** Stable name of the state, exposed as data-state for tests and screenshots. */
    state: string;
    tone: 'neutral' | 'info' | 'warning' | 'error' | 'success';
    busy: boolean;
    title: string;
    message: string | null;
    /** Set when form fields point at the message with aria-describedby. */
    messageId?: string;
    help: string | null;
    /** In visual order; the last one sits right beside 분석 시작. */
    actions: WriterStatusAction[];
    /** 분석 시작 stays unavailable while this row explains why. */
    blocksStart: boolean;
}

/** What the form itself still blocks, checked once the engine is connected and ready. */
export interface WriterInputState {
    /**
     * The selected resume draft cannot continue: its run is still going elsewhere, it already finished
     * (its result is a saved meeting), or nothing is left to reuse.
     */
    resumeUnavailable?: 'running' | 'completed' | 'unavailable' | null;
    /** The chosen file is already being analyzed by another run. */
    sameFileRunning?: boolean;
    /** Another run, or a cancelled one still being cleaned up, holds the engine. */
    otherAnalysisRunning?: boolean;
    /** Browser metadata says the chosen file is over the length limit. */
    fileTooLong?: boolean;
    /** A resume draft is selected and its file is not chosen yet, or a different file is. */
    resumeFile?: { sourceFilename: string; problem: 'missing' | 'mismatch' } | null;
    /** Empty required fields after 분석 시작 was pressed, in screen order; empty while nothing was attempted. */
    missingRequired?: string[];
}

/** The required-field list's id; the empty fields point at it with aria-describedby. */
export const WRITER_REQUIRED_FIELDS_MESSAGE_ID = 'writer-form-error';

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
    input?: WriterInputState;
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

const inputRow = (
    value: Omit<WriterStatusRow, 'stage' | 'busy' | 'help' | 'blocksStart'> & Partial<WriterStatusRow>,
): WriterStatusRow => ({ stage: 'input', busy: false, help: null, blocksStart: true, ...value });

// Analysis-start conditions, then required fields. A selected draft that cannot continue and the same file
// already running come first: they are the specific form of another analysis holding the engine.
const selectInputRow = (state: WriterInputState | undefined): WriterStatusRow | null => {
    if (!state) return null;
    const chooseFile: WriterStatusAction = { kind: 'choose-file', label: '다른 파일 선택' };
    if (state.resumeUnavailable === 'completed') {
        // Nothing went wrong: the run finished elsewhere and its meeting is saved, so do not suggest analyzing again.
        return inputRow({
            state: 'resume-completed',
            tone: 'info',
            title: '이 분석은 이미 끝났습니다',
            message: '결과는 회의록에서 확인해 주세요.',
            actions: [],
        });
    }
    if (state.resumeUnavailable) {
        return inputRow({
            state: 'resume-unavailable',
            tone: 'error',
            title: '이전 분석을 이어서 진행할 수 없습니다',
            message: state.resumeUnavailable === 'running'
                ? '진행이 끝나거나 중단된 뒤 이어갈 수 있습니다.'
                : '새 분석으로 시작할 수 있습니다.',
            actions: [],
        });
    }
    if (state.sameFileRunning) {
        return inputRow({
            state: 'same-file-running',
            tone: 'info',
            title: '같은 파일 분석이 이미 진행 중입니다',
            message: '먼저 상태를 확인해 주세요.',
            actions: [{ kind: 'refresh-analysis-status', label: '상태 확인' }],
        });
    }
    if (state.otherAnalysisRunning) {
        // The way to the running analysis is the sidebar's 분석 중 card, so there is no button here.
        return inputRow({
            state: 'other-analysis',
            tone: 'info',
            title: '진행 중인 분석이 있습니다',
            message: '끝나면 새 회의록을 분석할 수 있습니다.',
            actions: [],
        });
    }
    if (state.fileTooLong) {
        return inputRow({
            state: 'file-too-long',
            tone: 'warning',
            title: ANALYSIS_DURATION_LIMIT_TITLE,
            message: ANALYSIS_DURATION_LIMIT_MESSAGE,
            actions: [chooseFile],
        });
    }
    if (state.resumeFile?.problem === 'missing') {
        return inputRow({
            state: 'resume-choose-file',
            tone: 'info',
            title: '이어서 분석할 파일을 선택해 주세요',
            message: state.resumeFile.sourceFilename,
            actions: [{ kind: 'choose-file', label: '파일 선택' }],
        });
    }
    if (state.resumeFile?.problem === 'mismatch') {
        return inputRow({
            state: 'resume-other-file',
            tone: 'warning',
            title: '선택한 파일이 다릅니다',
            message: `${state.resumeFile.sourceFilename} 파일을 다시 선택해 주세요.`,
            actions: [chooseFile],
        });
    }
    if (state.missingRequired && state.missingRequired.length > 0) {
        // Checked when 분석 시작 is pressed, so the button stays available; the list shrinks as fields fill.
        return inputRow({
            state: 'required-fields',
            tone: 'error',
            title: '필수 항목이 비어 있습니다',
            message: state.missingRequired.join(', '),
            messageId: WRITER_REQUIRED_FIELDS_MESSAGE_ID,
            actions: [],
            blocksStart: false,
        });
    }
    return null;
};

export const selectWriterStatusRow = (input: SelectWriterStatusRowInput): WriterStatusRow => {
    const row = !input.connection.analysisReady
        ? connectionRow(input.connection)
        : selectReadinessRow(input) ?? selectInputRow(input.input) ?? {
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
