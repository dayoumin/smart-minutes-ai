import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { MeetingRecord, MeetingSegment } from './meetingRepository';
import {
    DownloadFormat,
    DOWNLOAD_FORMAT_CHANGE_EVENT,
    getDownloadFormatPreference,
} from './downloadPreferences';
import { toApiUrl } from './apiBase';

const extensionByKind: Record<DownloadFormat, string> = {
    hwpx: 'hwpx',
    md: 'md',
    txt: 'txt',
    docx: 'docx',
};
const downloadFormatLabels: Record<DownloadFormat, string> = {
    hwpx: 'HWPX',
    md: 'MD',
    txt: 'TXT',
    docx: 'DOCX',
};

interface MeetingDownloadControlProps {
    meeting: MeetingRecord;
    onNotice?: (message: string) => void;
    onError?: (message: string) => void;
    onDownloadingChange?: (isDownloading: boolean) => void;
    beforeDownload?: () => boolean;
    disabled?: boolean;
}

const MAX_DOWNLOAD_STEM_CHARS = 96;

const safeFileName = (title: string): string => {
    const safe = title.replace(/[/\\?%*:|"<>]/g, '-').trim().replace(/^[.\-\s]+|[.\-\s]+$/g, '');
    return safe.slice(0, MAX_DOWNLOAD_STEM_CHARS).replace(/[.\-\s]+$/g, '') || 'meeting-minutes';
};

const formatSegmentLine = (segment: MeetingSegment): string => {
    const timingLabel = segment.timingApproximate ? ' 시간 추정' : '';
    return `${segment.start}-${segment.end}${timingLabel} ${segment.displaySpeaker || segment.speaker}: ${segment.text}`;
};

const transcriptSegmentsForExport = (meeting: MeetingRecord): MeetingSegment[] => (
    meeting.editedDisplaySegments?.length
        ? meeting.editedDisplaySegments
        : meeting.displaySegments?.length
            ? meeting.displaySegments
            : meeting.segments ?? []
);

const buildTranscriptText = (meeting: MeetingRecord): string => {
    const lines = [
        meeting.title,
        `일시: ${meeting.date}`,
        `회의 목적: ${meeting.meetingPurpose || '-'}`,
        meeting.sourceFile ? `원본 파일: ${meeting.sourceFile}` : '',
        '',
        '[요약]',
        meeting.summary,
        '',
        '[대화록]',
        ...(transcriptSegmentsForExport(meeting).length
            ? transcriptSegmentsForExport(meeting).map(segment => ({
                ...segment,
                displaySpeaker: segment.displaySpeaker || meeting.speakerLabels?.[segment.speaker],
            })).map(formatSegmentLine)
            : ['대화록이 없습니다. 다시 분석해 주세요.']),
    ];
    return lines.filter(Boolean).join('\n');
};

const downloadBlob = (content: BlobPart | Blob, filename: string, type?: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const filenameFromDisposition = (disposition: string | null, fallback: string): string => {
    if (!disposition) return fallback;

    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);

    const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
    return plainMatch?.[1] ?? fallback;
};

export const MeetingDownloadControl: React.FC<MeetingDownloadControlProps> = ({ meeting, onNotice, onError, onDownloadingChange, beforeDownload, disabled = false }) => {
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadKind, setDownloadKind] = useState<DownloadFormat>(() => getDownloadFormatPreference());
    const isMountedRef = useRef(true);

    const updateDownloading = (nextDownloading: boolean) => {
        if (isMountedRef.current) {
            setIsDownloading(nextDownloading);
        }
        onDownloadingChange?.(nextDownloading);
    };

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            onDownloadingChange?.(false);
        };
    }, [onDownloadingChange]);

    useEffect(() => {
        const syncDownloadPreference = () => setDownloadKind(getDownloadFormatPreference());
        window.addEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
        window.addEventListener('focus', syncDownloadPreference);
        return () => {
            window.removeEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
            window.removeEventListener('focus', syncDownloadPreference);
        };
    }, []);

    const downloadLocalText = () => {
        downloadBlob(
            buildTranscriptText(meeting),
            `회의록_${safeFileName(meeting.title)}_transcript.txt`,
            'text/plain;charset=utf-8;',
        );
    };

    const tryDownloadFromUrl = async (url: string, fallbackName: string): Promise<boolean> => {
        try {
            const response = await fetch(await toApiUrl(url));
            if (!response.ok) return false;

            const blob = await response.blob();
            const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
            downloadBlob(blob, filename);
            return true;
        } catch {
            return false;
        }
    };

    const trySaveCopyToDownloads = async (): Promise<boolean> => {
        try {
            const response = await fetch(await toApiUrl(`/api/export-record/${downloadKind}/save-copy`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...meeting,
                    displaySegments: transcriptSegmentsForExport(meeting),
                }),
            });
            if (!response.ok) return false;
            await response.json().catch(() => null);
            onNotice?.(`${downloadFormatLabels[downloadKind]} 파일을 다운로드 폴더에 저장했습니다.`);
            return true;
        } catch {
            return false;
        }
    };

    const handleDownload = async () => {
        if (isDownloading || disabled) return;
        if (beforeDownload && !beforeDownload()) return;

        updateDownloading(true);
        onNotice?.('');
        onError?.('');
        const fallbackName = `${safeFileName(meeting.title)}.${extensionByKind[downloadKind]}`;

        try {
            if (await trySaveCopyToDownloads()) {
                return;
            }

            const response = await fetch(await toApiUrl(`/api/export-record/${downloadKind}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...meeting,
                    displaySegments: transcriptSegmentsForExport(meeting),
                }),
            });

            if (response.ok) {
                const blob = await response.blob();
                const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
                downloadBlob(blob, filename);
                return;
            }

            const detail = await response.text().catch(() => '');
            const outputUrl = meeting.outputFiles?.[downloadKind]
                || (meeting.jobId ? `/api/outputs/${encodeURIComponent(meeting.jobId)}/${downloadKind}` : null);
            if (outputUrl && await tryDownloadFromUrl(outputUrl, fallbackName)) {
                onError?.(`${downloadKind.toUpperCase()} 파일을 현재 화면 기준으로 새로 만들지 못해 저장된 파일로 다운로드했습니다.${detail ? ` (${detail})` : ''}`);
                return;
            }

            downloadLocalText();
            onError?.(`${downloadKind.toUpperCase()} 파일을 만들지 못해 TXT로 다운로드했습니다.${detail ? ` (${detail})` : ''}`);
        } catch (error) {
            const outputUrl = meeting.outputFiles?.[downloadKind]
                || (meeting.jobId ? `/api/outputs/${encodeURIComponent(meeting.jobId)}/${downloadKind}` : null);
            if (outputUrl && await tryDownloadFromUrl(outputUrl, fallbackName)) {
                const message = error instanceof Error ? error.message : '파일 다운로드 중 오류가 발생했습니다.';
                onError?.(`${message} 저장된 파일로 다운로드했습니다.`);
                return;
            }

            downloadLocalText();
            const message = error instanceof Error ? error.message : '파일 다운로드 중 오류가 발생했습니다.';
            onError?.(`${message} TXT로 다운로드했습니다.`);
        } finally {
            updateDownloading(false);
        }
    };

    return (
        <div className="flex overflow-hidden rounded-md border border-input bg-background shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-primary/30">
            <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center text-foreground transition-colors hover:bg-muted/50 hover:text-primary disabled:cursor-wait disabled:opacity-60"
                onClick={handleDownload}
                disabled={isDownloading || disabled}
                title={`${downloadFormatLabels[downloadKind]} 파일을 다운로드 폴더에 저장`}
                aria-label={`회의록 ${downloadFormatLabels[downloadKind]} 파일을 다운로드 폴더에 저장`}
            >
                <Download size={18} />
            </button>
        </div>
    );
};
