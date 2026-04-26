import React, { useRef, useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { addMeeting, MeetingRecord, MeetingSegment } from './meetingRepository';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;

interface AnalyzeResult {
    status?: string;
    progress?: number;
    summary?: string;
    segments?: MeetingSegment[];
}

const parseSseChunk = (chunk: string): string[] => {
    return chunk
        .split('\n\n')
        .map(block =>
            block
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim())
                .join('\n')
        )
        .filter(Boolean);
};

const formatFileSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
};

const getFileKind = (selectedFile: File): 'audio' | 'video' | 'unknown' => {
    if (selectedFile.type.startsWith('audio/')) return 'audio';
    if (selectedFile.type.startsWith('video/')) return 'video';
    return 'unknown';
};

export const MeetingWriter: React.FC = () => {
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
    const [participants, setParticipants] = useState('');
    const [analysisMode, setAnalysisMode] = useState<'mock' | 'real'>('mock');
    const [file, setFile] = useState<File | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0] ?? null;
        setErrorMessage('');

        if (!selectedFile) {
            setFile(null);
            return;
        }

        setFile(selectedFile);
    };

    const handleStartAnalysis = async () => {
        if (!title.trim() || !date || !participants.trim() || !file) {
            setErrorMessage('회의 제목, 일시, 참석자, 음성/영상 파일을 모두 입력해 주세요.');
            return;
        }

        setIsAnalyzing(true);
        setProgress(0);
        setStatusMessage('분석 요청을 전송하고 있습니다.');
        setErrorMessage('');

        try {
            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('date', date);
            formData.append('participants', participants.trim());
            formData.append('mode', analysisMode);
            formData.append('file', file);

            const response = await fetch(`${API_BASE}/api/analyze`, {
                method: 'POST',
                body: formData,
                headers: { Accept: 'text/event-stream' },
            });

            if (!response.ok) {
                throw new Error(`서버 응답 오류: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('응답 스트림을 읽을 수 없습니다.');
            }

            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let finalData: AnalyzeResult | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const boundary = buffer.lastIndexOf('\n\n');
                if (boundary === -1) continue;

                const completeChunk = buffer.slice(0, boundary + 2);
                buffer = buffer.slice(boundary + 2);

                for (const dataStr of parseSseChunk(completeChunk)) {
                    if (dataStr === '[DONE]') continue;

                    let parsed: AnalyzeResult & { message?: string };
                    try {
                        parsed = JSON.parse(dataStr) as AnalyzeResult & { message?: string };
                    } catch {
                        console.warn('Ignoring malformed SSE event:', dataStr);
                        continue;
                    }
                    if (typeof parsed.progress === 'number') {
                        setProgress(Math.min(100, Math.max(0, parsed.progress)));
                    }
                    if (parsed.message) {
                        setStatusMessage(parsed.message);
                    }
                    if (parsed.status === 'completed' || parsed.summary) {
                        finalData = parsed;
                    }
                }
            }

            if (!finalData) {
                throw new Error('최종 분석 결과를 수신하지 못했습니다.');
            }

            const newRecord: MeetingRecord = {
                id: crypto.randomUUID(),
                date: date.replace('T', ' '),
                title: title.trim(),
                participants: participants.trim(),
                summary: finalData.summary || '요약 결과가 없습니다.',
                segments: finalData.segments || [],
            };

            await addMeeting(newRecord);
            setProgress(100);
            setStatusMessage('회의록 저장이 완료되었습니다.');
            setTitle('');
            setParticipants('');
            setFile(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
            setErrorMessage(message);
            setStatusMessage('');
        } finally {
            setIsAnalyzing(false);
        }
    };

    return (
        <div className="flex flex-col h-full gap-6 max-w-3xl mx-auto w-full">
            <h2 className="text-h3 font-semibold text-primary mb-2">새 회의록 작성</h2>
            <p className="text-sm text-muted-foreground -mt-4">
                음성 파일뿐 아니라 회의 녹화 영상도 업로드할 수 있습니다. 영상은 서버에서 음성만 추출해 분석하는 흐름으로 확장됩니다.
            </p>

            <div className="bg-background border border-border rounded-lg p-6 flex flex-col gap-5 shadow-sm">
                <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">회의 제목 *</label>
                    <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="예: 2026년 상반기 기획 회의" disabled={isAnalyzing} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground">일시 *</label>
                        <Input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} disabled={isAnalyzing} />
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground">참석자 *</label>
                        <Input value={participants} onChange={e => setParticipants(e.target.value)} placeholder="예: 홍길동, 김철수" disabled={isAnalyzing} />
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">분석 모드</label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <button
                            type="button"
                            disabled={isAnalyzing}
                            onClick={() => setAnalysisMode('mock')}
                            className={`rounded-md border px-4 py-3 text-left transition-colors ${analysisMode === 'mock' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-muted/40'}`}
                        >
                            <div className="text-sm font-semibold">빠른 테스트</div>
                            <div className="mt-1 text-xs text-muted-foreground">Mock SSE로 UI 흐름을 확인합니다.</div>
                        </button>
                        <button
                            type="button"
                            disabled={isAnalyzing}
                            onClick={() => setAnalysisMode('real')}
                            className={`rounded-md border px-4 py-3 text-left transition-colors ${analysisMode === 'real' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-muted/40'}`}
                        >
                            <div className="text-sm font-semibold">실제 로컬 분석</div>
                            <div className="mt-1 text-xs text-muted-foreground">ffmpeg/STT/요약 파이프라인을 실행합니다.</div>
                        </button>
                    </div>
                    {analysisMode === 'real' && (
                        <p className="text-xs text-amber-700">
                            실제 분석은 로컬 모델과 ffmpeg가 준비되어 있어야 하며, 긴 영상은 청크 단위로 오래 처리될 수 있습니다.
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-2 mt-2">
                    <label className="text-sm font-medium text-foreground">음성/영상 파일 첨부 *</label>
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.mp4,.mov,.mkv,.avi,.webm"
                        onChange={handleFileChange}
                        disabled={isAnalyzing}
                        className="file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer text-sm text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                        지원 형식: MP3, WAV, M4A, MP4, MOV, MKV, AVI, WEBM. 큰 영상은 음성만 추출한 뒤 구간별로 나누어 분석하는 방식이 적합합니다.
                    </p>
                    {file && (
                        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                            <div className="font-medium">{file.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {getFileKind(file) === 'video' ? '영상 파일' : getFileKind(file) === 'audio' ? '음성 파일' : '알 수 없는 형식'} · {formatFileSize(file.size)}
                            </div>
                            {file.size >= LARGE_FILE_WARNING_BYTES && (
                                <div className="mt-2 text-xs text-amber-700">
                                    큰 파일은 업로드와 음성 추출에 시간이 오래 걸릴 수 있습니다. 실제 분석 단계에서는 음성 트랙을 만든 뒤 긴 구간을 나누어 처리하는 흐름으로 확장할 예정입니다.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {errorMessage}
                </div>
            )}

            {statusMessage && (
                <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                    {statusMessage}
                </div>
            )}

            <Button className="w-full py-3 text-base" onClick={handleStartAnalysis} disabled={isAnalyzing}>
                {isAnalyzing ? `분석 진행 중... (${progress}%)` : 'AI 분석 시작'}
            </Button>

            {isAnalyzing && (
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div className="bg-primary h-2.5 rounded-full transition-all duration-300 ease-in-out" style={{ width: `${progress}%` }} />
                </div>
            )}
        </div>
    );
};
