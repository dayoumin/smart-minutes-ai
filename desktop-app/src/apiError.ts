export interface ApiErrorInfo {
    message: string;
    detail?: string;
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
    'model must be a valid Ollama model name': '요약 모델 이름 형식을 확인해 주세요. 예: gemma4:e2b',
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

export const parseApiErrorBody = (body: string, fallback: string): ApiErrorInfo => {
    const normalizedBody = body.trim();
    if (!normalizedBody) return { message: fallback };

    try {
        const parsed = JSON.parse(normalizedBody) as { detail?: unknown };
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
