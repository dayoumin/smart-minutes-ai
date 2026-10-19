export interface ApiErrorInfo {
    message: string;
    detail?: string;
    code?: string;
    retryable?: boolean;
    userAction?: 'retry' | 'open_settings' | string;
    generationKind?: string;
}

const API_ERROR_MESSAGES: Record<string, string> = {
    'Output result not found': '분석 원본을 찾지 못했습니다. 음성 파일을 다시 분석해 주세요.',
    'Transcript segments are required': '대화록이 없어 정리할 수 없습니다. 음성 파일을 다시 분석해 주세요.',
    summary_input_changed: '대화록이 바뀌어 이번 정리는 저장하지 않았습니다. 다시 정리해 주세요.',
    summary_model_not_ready: '요약 AI가 준비되지 않았습니다. 대화록은 사용할 수 있고, 설정에서 요약 모델을 준비한 뒤 다시 실행해 주세요.',
    topic_input_changed: '대화록이나 요약이 바뀌어 주제별 정리를 저장하지 않았습니다. 다시 정리해 주세요.',
    speaker_input_changed: '대화록이나 주제별 정리가 바뀌어 참석자별 정리를 저장하지 않았습니다. 다시 정리해 주세요.',
    report_input_changed: '대화록이나 정리 내용이 바뀌어 이번 보고서는 저장하지 않았습니다. 다시 생성해 주세요.',
    topic_generation_empty: '주제별 정리 결과가 비어 있습니다. 전체 요약을 확인한 뒤 다시 정리해 주세요.',
    speaker_context_generation_empty: '참석자별 정리 결과가 비어 있습니다. 주제별 정리와 대화록을 확인한 뒤 다시 정리해 주세요.',
    meeting_report_generation_empty: '회의록 보고서 결과가 비어 있습니다. 기록 정리와 보고 양식을 확인한 뒤 다시 생성해 주세요.',
    'Summary must be generated before meeting report': '기록 정리를 먼저 완료한 뒤 보고서를 생성해 주세요.',
    audio_required_for_diarization: '참석자 구분에 필요한 원본 음성을 찾지 못했습니다. 음성 파일을 다시 분석해 주세요.',
    diarization_model_not_ready: '참석자 구분 모델이 준비되지 않았습니다. 설정에서 모델 준비 상태를 확인해 주세요.',
    diarization_resource_limit: '음성 파일이 너무 길거나 커서 참석자 구분을 실행하지 않았습니다. 대화록은 그대로 사용할 수 있습니다.',
    diarization_already_completed: '이미 참석자 구분이 완료된 대화록입니다.',
    'diarization generation is already running': '참석자 구분이 이미 진행 중입니다.',
    diarization_runtime_error: '참석자 구분 중 문제가 발생했습니다. 원본 음성과 모델 준비 상태를 확인한 뒤 다시 실행해 주세요.',
    duration_limit_exceeded: '2시간 이하의 음성·영상 파일을 선택해 주세요.',
    media_duration_unavailable: '파일 길이를 확인하지 못했습니다. 재생 가능한 음성·영상 파일을 선택해 주세요.',
    'model must be a valid Ollama model name': '요약 모델 이름 형식을 확인해 주세요. 예: gemma4:e2b',
    runtime_missing: '요약 프로그램을 찾지 못했습니다. 설정에서 요약 프로그램을 준비한 뒤 다시 시도해 주세요.',
    runtime_preparing: '요약 프로그램을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.',
    server_unreachable: '요약 프로그램에 연결하지 못했습니다. 프로그램을 다시 실행한 뒤 다시 시도해 주세요.',
    model_missing: '사용할 요약 모델을 찾지 못했습니다. 설정에서 모델을 준비한 뒤 다시 시도해 주세요.',
    request_timeout: '정리 시간이 초과되었습니다. 기존 대화록과 정리 결과는 보존되었습니다. 잠시 후 다시 시도해 주세요.',
    invalid_model_response: '정리 결과 형식을 확인하지 못했습니다. 기존 결과는 보존되었습니다. 다시 시도해 주세요.',
    generation_cancelled: '정리를 취소했습니다. 기존 결과는 보존되었습니다.',
    generation_disabled: '정리 기능이 꺼져 있습니다. 설정에서 정리 기능을 켠 뒤 다시 시도해 주세요.',
    generation_internal_error: '정리 중 내부 오류가 발생했습니다. 기존 대화록과 정리 결과는 보존되었습니다. 다시 시도해 주세요.',
};

const mapApiErrorDetail = (detail: string): string | undefined => {
    const exactMessage = API_ERROR_MESSAGES[detail];
    if (exactMessage) return exactMessage;
    if (detail.startsWith('요약 프로그램(Ollama)을 찾지 못했습니다.')) {
        return '요약 프로그램을 찾지 못했습니다. 설정에서 요약 프로그램을 준비한 뒤 다시 시도해 주세요.';
    }
    if (detail.startsWith('Ollama 모델 상태를 확인하지 못했습니다')) {
        return '요약 모델 상태를 확인하지 못했습니다. 요약 프로그램을 실행한 뒤 다시 확인해 주세요.';
    }
    if (detail.includes('checksum did not match')) {
        return '받은 요약 프로그램 파일을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 받아 주세요.';
    }
    return undefined;
};

const HANGUL_PATTERN = /[\uAC00-\uD7A3]/;
const BROWSER_FETCH_FAILURE_PATTERN = /^(typeerror: )?(failed to fetch|networkerror when attempting to fetch resource\.?|load failed|network error)$/i;

/** What went wrong, in terms of what the user can do next. */
export type UserErrorCause = 'memory' | 'gpu' | 'unsupported-file' | 'disk-space' | 'engine-disconnected' | 'timeout' | 'other';

export interface UserFacingError {
    cause: UserErrorCause;
    message: string;
}

/** An error that keeps the engine's stable cause code (structured HTTP detail or the analysis stream's `code`). */
export class EngineError extends Error {
    readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'EngineError';
        this.code = code || undefined;
    }
}

const CODE_CAUSES: Record<string, UserErrorCause> = {
    insufficient_memory: 'memory',
    gpu_unavailable: 'gpu',
    insufficient_storage: 'disk-space',
    unsupported_media: 'unsupported-file',
    media_duration_unavailable: 'unsupported-file',
    duration_limit_exceeded: 'unsupported-file',
    analysis_stage_timeout: 'timeout',
    request_timeout: 'timeout',
};

// Raw engine, ffmpeg and runtime wording (and our own Korean sentences) that identify a cause.
const TEXT_CAUSES: Array<[RegExp, UserErrorCause]> = [
    [/out of memory|cannot allocate memory|bad_alloc|not enough memory|메모리가 부족/i, 'memory'],
    [/no space left on device|not enough space on the disk|quota.*exceeded|저장 공간이 부족/i, 'disk-space'],
    // After memory: "CUDA failed with error out of memory" is a memory failure, other CUDA run-time failures are the GPU.
    [/cublas|cudnn|cudart|cuda (driver|runtime|error|failed)|no cuda-capable device/i, 'gpu'],
    // Final ffmpeg errors only: stderr also carries warnings (e.g. codec parameters) for files that decode fine.
    [/invalid data found when processing input|does not contain any stream|moov atom not found/i, 'unsupported-file'],
    [/timed? ?out|timeout/i, 'timeout'],
];

const STATUS_CAUSES: Record<number, UserErrorCause> = {
    408: 'timeout',
    413: 'unsupported-file',
    415: 'unsupported-file',
    504: 'timeout',
    507: 'disk-space',
};

type ActionableCause = Exclude<UserErrorCause, 'engine-disconnected' | 'other'>;

const ANALYSIS_CAUSE_MESSAGES: Record<ActionableCause, string> = {
    memory: '이 PC의 메모리가 부족합니다. 다른 프로그램을 닫은 뒤 다시 시도해 주세요.',
    gpu: 'GPU로 분석하지 못했습니다. 설정에서 분석 장치를 CPU로 바꾸면 분석할 수 있습니다.',
    'disk-space': '저장 공간이 부족합니다. 파일을 정리해 공간을 확보한 뒤 다시 시도해 주세요.',
    'unsupported-file': '이 파일은 읽을 수 없습니다. 재생되는 음성·영상 파일을 선택해 주세요.',
    timeout: '응답이 너무 오래 걸려 멈췄습니다. 잠시 뒤 다시 시도해 주세요.',
};

// Second sentence after "…하지 못했습니다." on screens where the first sentence already says what failed.
const NEXT_STEP_BY_CAUSE: Record<ActionableCause, string> = {
    memory: '메모리가 부족하니 다른 프로그램을 닫은 뒤 다시 시도해 주세요.',
    gpu: 'GPU를 사용하지 못했습니다. 바로록을 다시 실행한 뒤 다시 시도해 주세요.',
    'disk-space': '저장 공간을 확보한 뒤 다시 시도해 주세요.',
    'unsupported-file': '재생되는 음성·영상 파일인지 확인해 주세요.',
    timeout: '응답이 늦어 멈췄습니다. 잠시 뒤 다시 시도해 주세요.',
};

interface ErrorClassification {
    cause: UserErrorCause;
    /** Already a user sentence (a mapped engine code or our own Korean message), shown as is. */
    ownMessage?: string;
    status?: number;
}

// Korean text is not always ours: Windows localizes OS errors ([WinError 2] 지정된 파일을 찾을 수 없습니다) and the
// engine passes exception text through. Such text keeps its cause but is never shown as is.
const RAW_TEXT_MARKER_PATTERN = /\[(WinError|Errno) -?\d+\]|Traceback|\b[A-Za-z]+Error:|\bfailed:|\b[A-Za-z]:\x5c|\.py\b/;

const causeFromText = (text: string): UserErrorCause | undefined => (
    TEXT_CAUSES.find(([pattern]) => pattern.test(text))?.[1]
);

const classifyError = (error: unknown, codeOverride?: string): ErrorClassification => {
    let code = codeOverride || (error instanceof EngineError ? error.code : undefined);
    const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
        ? (error as { name: string }).name
        : '';
    const rawMessage = typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : '';
    let text = rawMessage.trim();
    // A raw response body (JSON detail) is never shown; read its code or detail instead.
    if (text.startsWith('{')) {
        const info = parseApiErrorBody(text, '');
        code = code || info.code;
        text = info.message || (info.code ? '' : info.detail ?? '');
    }

    const codeCause = code ? CODE_CAUSES[code] : undefined;
    const mapped = (code ? API_ERROR_MESSAGES[code] : undefined) ?? (text ? mapApiErrorDetail(text) : undefined);
    if (mapped) return { cause: codeCause ?? CODE_CAUSES[text] ?? causeFromText(mapped) ?? 'other', ownMessage: mapped };
    // A known code wins over the engine's own (often English) wording.
    if (codeCause) return { cause: codeCause };
    if (name === 'TimeoutError') return { cause: 'timeout' };
    if (name === 'QuotaExceededError') return { cause: 'disk-space' };
    if (BROWSER_FETCH_FAILURE_PATTERN.test(text)) return { cause: 'engine-disconnected' };
    const status = text.match(/^서버 응답 오류: (\d{3})$/);
    if (status) {
        const statusCode = Number(status[1]);
        return { cause: STATUS_CAUSES[statusCode] ?? 'other', status: statusCode };
    }
    const textCause = causeFromText(text);
    if (HANGUL_PATTERN.test(text) && !RAW_TEXT_MARKER_PATTERN.test(text)) return { cause: textCause ?? 'other', ownMessage: text };
    return { cause: textCause ?? 'other' };
};

/**
 * Turns an analysis failure (engine code, server detail, HTTP status, network error, timeout) into its cause
 * and a sentence the user can act on. The failure screen title already says the analysis did not finish.
 */
export const describeAnalysisError = (
    error: unknown,
    options: { desktopApp?: boolean; code?: string } = {},
): UserFacingError => {
    const { cause, ownMessage, status } = classifyError(error, options.code);
    if (ownMessage) return { cause, message: ownMessage };
    if (cause === 'engine-disconnected') {
        return {
            cause,
            message: options.desktopApp
                ? '분석 기능에 연결하지 못했습니다. 앱을 다시 실행한 뒤 다시 시도해 주세요.'
                : '이 PC의 분석 기능에 연결하지 못했습니다. 바로록 연결이 실행 중인지 확인한 뒤 다시 시도해 주세요.',
        };
    }
    if (cause !== 'other') return { cause, message: ANALYSIS_CAUSE_MESSAGES[cause] };
    if (status) {
        return {
            cause,
            message: status >= 500
                ? '분석 중 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.'
                : '분석 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
        };
    }
    return { cause, message: '분석 중 문제가 생겼습니다. 다시 시도해 주세요.' };
};

/** Turns an analysis failure into a sentence the user can act on (see `describeAnalysisError`). */
export const toUserFacingAnalysisError = (raw: string | undefined, options: { desktopApp?: boolean } = {}): string => (
    describeAnalysisError(raw ?? '', options).message
);

/**
 * The sentence for any other failed action: `failed` says what did not happen ("…하지 못했습니다."), and the
 * cause adds the next step. Raw `Failed to fetch`, English engine text and JSON bodies never reach the UI.
 */
export const toUserFacingError = (
    error: unknown,
    failed: string,
    options: { desktopApp?: boolean } = {},
): string => {
    const { cause, ownMessage } = classifyError(error);
    if (ownMessage) return ownMessage;
    if (cause === 'engine-disconnected') {
        return `${failed} ${options.desktopApp ? '앱을 다시 실행한 뒤 다시 시도해 주세요.' : '바로록 연결이 실행 중인지 확인해 주세요.'}`;
    }
    return cause === 'other' ? failed : `${failed} ${NEXT_STEP_BY_CAUSE[cause]}`;
};

export const parseApiErrorBody = (body: string, fallback: string): ApiErrorInfo => {
    const normalizedBody = body.trim();
    if (!normalizedBody) return { message: fallback };

    try {
        const parsed = JSON.parse(normalizedBody) as { detail?: unknown };
        if (parsed.detail && typeof parsed.detail === 'object') {
            const structured = parsed.detail as Record<string, unknown>;
            const code = typeof structured.code === 'string' ? structured.code.trim() : '';
            if (!code) return { message: fallback };
            return {
                message: mapApiErrorDetail(code) ?? fallback,
                detail: code,
                code,
                retryable: typeof structured.retryable === 'boolean' ? structured.retryable : undefined,
                userAction: typeof structured.user_action === 'string' ? structured.user_action : undefined,
                generationKind: typeof structured.generation_kind === 'string' ? structured.generation_kind : undefined,
            };
        }
        const detail = typeof parsed.detail === 'string' ? parsed.detail.trim() : '';
        if (!detail) return { message: fallback };
        return {
            message: mapApiErrorDetail(detail) ?? fallback,
            detail,
        };
    } catch {
        return {
            message: mapApiErrorDetail(normalizedBody) ?? fallback,
            detail: normalizedBody,
        };
    }
};

export const readApiErrorInfo = async (response: Response, fallback: string): Promise<ApiErrorInfo> => {
    const body = await response.text().catch(() => '');
    return parseApiErrorBody(body, fallback);
};

export const readApiErrorMessage = async (response: Response, fallback: string): Promise<string> => (
    (await readApiErrorInfo(response, fallback)).message
);
