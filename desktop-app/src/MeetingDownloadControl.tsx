import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
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
    scope?: 'transcript' | 'organized' | 'report' | 'full';
    presentation?: 'icon' | 'button';
    label?: string;
    className?: string;
    onNotice?: (message: string) => void;
    onError?: (message: string) => void;
    onSaved?: (savedPath: string | null) => void;
    onDownloadingChange?: (isDownloading: boolean) => void;
    beforeDownload?: () => boolean;
    disabled?: boolean;
}

interface SaveCopyResponse {
    saved_path?: string | null;
}

type DownloadScope = NonNullable<MeetingDownloadControlProps['scope']>;

const MAX_DOWNLOAD_STEM_CHARS = 96;

const scopeLabels: Record<DownloadScope, string> = {
    transcript: '대화록',
    organized: '기록 정리',
    report: '보고서',
    full: '전체 회의록',
};

const scopeFileSuffixes: Record<DownloadScope, string> = {
    transcript: '대화록',
    organized: '기록정리',
    report: '보고서',
    full: '전체',
};

const resolveDownloadKind = (preferredKind: DownloadFormat, scope: DownloadScope): DownloadFormat => {
    if (scope === 'transcript') return 'txt';
    if ((scope === 'organized' || scope === 'report') && preferredKind === 'txt') return 'md';
    return preferredKind;
};

const scopedMeetingTitle = (meeting: MeetingRecord, scope: DownloadScope): string => (
    scope === 'full' ? meeting.title : `${meeting.title}_${scopeFileSuffixes[scope]}`
);

const safeFileName = (title: string): string => {
    const safe = title.replace(/[/\\?%*:|"<>]/g, '-').trim().replace(/^[.\-\s]+|[.\-\s]+$/g, '');
    return safe.slice(0, MAX_DOWNLOAD_STEM_CHARS).replace(/[.\-\s]+$/g, '') || 'meeting-minutes';
};

const participantLabel = (value?: string): string => {
    const label = String(value || '').trim();
    const speakerNumber = label.match(/^SPEAKER[_\s-]?(\d+)$/i);
    if (speakerNumber) return `참석자${String(Number(speakerNumber[1]) + 1).padStart(2, '0')}`;
    const legacyKoreanNumber = label.match(/^화자(\d+)$/);
    if (legacyKoreanNumber) {
        const [, digits] = legacyKoreanNumber;
        const parsed = Number(digits);
        const participantNumber = digits.length >= 2 ? parsed + 1 : Math.max(1, parsed);
        return `참석자${String(participantNumber).padStart(2, '0')}`;
    }
    return label || '참석자';
};

const formatSegmentLine = (segment: MeetingSegment): string => {
    const timingLabel = segment.timingApproximate ? ' 시간 추정' : '';
    return `${segment.start}-${segment.end}${timingLabel} ${participantLabel(segment.displaySpeaker || segment.speaker)}: ${segment.text}`;
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
        '[대화록]',
        ...(transcriptSegmentsForExport(meeting).length
            ? transcriptSegmentsForExport(meeting).map(segment => ({
                ...segment,
                displaySpeaker: meeting.speakerLabels?.[segment.speaker] || segment.displaySpeaker || participantLabel(segment.speaker),
            })).map(formatSegmentLine)
            : ['대화록이 없습니다. 다시 분석해 주세요.']),
    ];
    return lines.filter(Boolean).join('\n');
};

const buildOrganizedText = (meeting: MeetingRecord): string => {
    const lines = [
        meeting.title,
        `일시: ${meeting.date}`,
        `회의 목적: ${meeting.meetingPurpose || '-'}`,
        meeting.sourceFile ? `원본 파일: ${meeting.sourceFile}` : '',
        '',
        '[전체 요약]',
        meeting.summary || '정리 내용이 없습니다.',
        '',
    ];

    if (meeting.topics?.length) {
        lines.push('[주요 내용]', ...meeting.topics.map(topic => `- ${topic}`), '');
    }
    if (meeting.topicSections?.length) {
        lines.push('[주제별 정리]');
        meeting.topicSections.forEach(section => {
            lines.push(`- ${section.topic || '주제'}: ${section.summary || ''}`);
            (section.evidence ?? []).forEach(item => lines.push(`  - 근거: ${item}`));
            (section.actions ?? []).forEach(item => lines.push(`  - 할 일: ${item}`));
        });
        lines.push('');
    }
    const speakerSummaries = meeting.speakerContextSummaries?.length
        ? meeting.speakerContextSummaries.map(item => ({
            name: item.display_name || item.speaker || '참석자',
            summary: item.summary,
            points: item.key_points ?? [],
            actions: item.actions ?? [],
        }))
        : (meeting.participantSummaries ?? []).map(item => ({
            name: item.participant || '참석자',
            summary: item.summary,
            points: item.key_points ?? [],
            actions: item.actions ?? [],
        }));
    if (speakerSummaries.length) {
        lines.push('[참석자별 정리]');
        speakerSummaries.forEach(item => {
            lines.push(`- ${item.name}: ${item.summary || ''}`);
            item.points.forEach(point => lines.push(`  - 핵심: ${point}`));
            item.actions.forEach(action => lines.push(`  - 할 일: ${action}`));
        });
        lines.push('');
    }
    if (meeting.decisions?.length) {
        lines.push('[결정사항]', ...meeting.decisions.map(item => `- ${item}`), '');
    }
    if (meeting.actions?.length) {
        lines.push('[할 일]', ...meeting.actions.map(item => `- ${item}`), '');
    }
    if (meeting.needsCheck?.length) {
        lines.push('[확인 필요]', ...meeting.needsCheck.map(item => `- ${item}`), '');
    }

    return lines.filter(Boolean).join('\n');
};

const resolveReportTemplateName = (meeting: MeetingRecord): string => {
    const report = meeting.meetingReport;
    const snapshotName = report?.templateSnapshot?.name?.trim();
    if (snapshotName) return snapshotName;
    const storedName = report?.templateName?.trim();
    if (storedName) return storedName;
    if (!report?.templateId || report.templateId === meeting.reportTemplate?.id) {
        return meeting.reportTemplate?.name?.trim() ?? '';
    }
    return '';
};

const buildReportText = (meeting: MeetingRecord): string => {
    const report = meeting.meetingReport;
    const sections = report?.sections ?? [];
    const reportTemplateName = resolveReportTemplateName(meeting);
    const lines = [
        meeting.title,
        `일시: ${meeting.date}`,
        `회의 목적: ${meeting.meetingPurpose || '-'}`,
        reportTemplateName ? `보고 양식: ${reportTemplateName}` : '',
        '',
        '[회의록 보고서]',
    ];

    if (sections.length) {
        sections.forEach(section => {
            lines.push('', `[${section.title || '보고서'}]`, section.content || '');
        });
    } else {
        lines.push(report?.content || '보고서 내용이 없습니다.');
    }

    return lines.filter(Boolean).join('\n');
};

const buildFullText = (meeting: MeetingRecord): string => [
    buildOrganizedText(meeting),
    meeting.meetingReport?.content || meeting.meetingReport?.sections?.length ? buildReportText(meeting) : '',
    '',
    buildTranscriptText(meeting),
].filter(Boolean).join('\n');

const buildFallbackText = (meeting: MeetingRecord, scope: DownloadScope): string => {
    if (scope === 'transcript') return buildTranscriptText(meeting);
    if (scope === 'organized') return buildOrganizedText(meeting);
    if (scope === 'report') return buildReportText(meeting);
    return buildFullText(meeting);
};

const buildExportPayload = (meeting: MeetingRecord, scope: DownloadScope) => ({
    ...meeting,
    title: scopedMeetingTitle(meeting, scope),
    exportScope: scope,
    displaySegments: transcriptSegmentsForExport(meeting),
});

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

export const MeetingDownloadControl: React.FC<MeetingDownloadControlProps> = ({
    meeting,
    scope = 'full',
    presentation = 'icon',
    label,
    className = '',
    onNotice,
    onError,
    onSaved,
    onDownloadingChange,
    beforeDownload,
    disabled = false,
}) => {
    const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'saved'>('idle');
    const [preferredDownloadKind, setPreferredDownloadKind] = useState<DownloadFormat>(() => getDownloadFormatPreference());
    const isMountedRef = useRef(true);
    const savedTimerRef = useRef<number | null>(null);
    const isDownloading = downloadState === 'downloading';
    const downloadKind = resolveDownloadKind(preferredDownloadKind, scope);
    const scopeLabel = scopeLabels[scope];
    const buttonLabel = label ?? (scope === 'full' ? '전체 저장' : `${scopeLabel} 저장`);

    const updateDownloading = (nextDownloading: boolean) => {
        if (isMountedRef.current) {
            setDownloadState(nextDownloading ? 'downloading' : 'idle');
        }
        onDownloadingChange?.(nextDownloading);
    };

    const finishDownloading = () => {
        onDownloadingChange?.(false);
        if (isMountedRef.current) {
            setDownloadState(current => current === 'downloading' ? 'idle' : current);
        }
    };

    const markSaved = (savedPath: string | null = null) => {
        onSaved?.(savedPath);
        if (isMountedRef.current) {
            setDownloadState('saved');
            if (savedTimerRef.current) {
                window.clearTimeout(savedTimerRef.current);
            }
            savedTimerRef.current = window.setTimeout(() => {
                if (isMountedRef.current) setDownloadState('idle');
            }, 1600);
        }
    };

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            if (savedTimerRef.current) {
                window.clearTimeout(savedTimerRef.current);
            }
            onDownloadingChange?.(false);
        };
    }, [onDownloadingChange]);

    useEffect(() => {
        const syncDownloadPreference = () => setPreferredDownloadKind(getDownloadFormatPreference());
        window.addEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
        window.addEventListener('focus', syncDownloadPreference);
        return () => {
            window.removeEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
            window.removeEventListener('focus', syncDownloadPreference);
        };
    }, []);

    const downloadLocalText = () => {
        downloadBlob(
            buildFallbackText(meeting, scope),
            `${safeFileName(scopedMeetingTitle(meeting, scope))}.txt`,
            'text/plain;charset=utf-8;',
        );
        markSaved(null);
    };

    const canUseStoredOutputFallback = scope === 'full' || scope === 'transcript';

    const tryDownloadFromUrl = async (url: string, fallbackName: string): Promise<boolean> => {
        try {
            const response = await fetch(await toApiUrl(url));
            if (!response.ok) return false;

            const blob = await response.blob();
            const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
            downloadBlob(blob, filename);
            markSaved(null);
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
                body: JSON.stringify(buildExportPayload(meeting, scope)),
            });
            if (!response.ok) return false;
            const data = await response.json().catch(() => null) as SaveCopyResponse | null;
            markSaved(data?.saved_path ?? null);
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
        const fallbackName = `${safeFileName(scopedMeetingTitle(meeting, scope))}.${extensionByKind[downloadKind]}`;

        try {
            if (await trySaveCopyToDownloads()) {
                return;
            }

            const response = await fetch(await toApiUrl(`/api/export-record/${downloadKind}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildExportPayload(meeting, scope)),
            });

            if (response.ok) {
                const blob = await response.blob();
                const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
                downloadBlob(blob, filename);
                markSaved(null);
                return;
            }

            const detail = await response.text().catch(() => '');
            const outputUrl = meeting.outputFiles?.[downloadKind]
                || (meeting.jobId ? `/api/outputs/${encodeURIComponent(meeting.jobId)}/${downloadKind}` : null);
            if (canUseStoredOutputFallback && outputUrl && await tryDownloadFromUrl(outputUrl, fallbackName)) {
                onError?.(`${downloadKind.toUpperCase()} 파일을 현재 화면 기준으로 새로 만들지 못해 저장된 파일로 다운로드했습니다.${detail ? ` (${detail})` : ''}`);
                return;
            }

            downloadLocalText();
            onError?.(`${downloadKind.toUpperCase()} 파일을 만들지 못해 TXT로 다운로드했습니다.${detail ? ` (${detail})` : ''}`);
        } catch (error) {
            const outputUrl = meeting.outputFiles?.[downloadKind]
                || (meeting.jobId ? `/api/outputs/${encodeURIComponent(meeting.jobId)}/${downloadKind}` : null);
            if (canUseStoredOutputFallback && outputUrl && await tryDownloadFromUrl(outputUrl, fallbackName)) {
                const message = error instanceof Error ? error.message : '파일 다운로드 중 오류가 발생했습니다.';
                onError?.(`${message} 저장된 파일로 다운로드했습니다.`);
                return;
            }

            downloadLocalText();
            const message = error instanceof Error ? error.message : '파일 다운로드 중 오류가 발생했습니다.';
            onError?.(`${message} TXT로 다운로드했습니다.`);
        } finally {
            finishDownloading();
        }
    };

    const icon = isDownloading
        ? <Loader2 size={18} className="animate-spin" aria-hidden="true" />
        : downloadState === 'saved'
            ? <Check size={18} aria-hidden="true" />
            : <Download size={18} aria-hidden="true" />;
    const title = isDownloading
        ? `${scopeLabel} 저장 중`
        : downloadState === 'saved'
            ? `${scopeLabel} 저장됨`
            : `${scopeLabel} ${downloadFormatLabels[downloadKind]} 파일을 다운로드 폴더에 저장`;

    return presentation === 'button' ? (
        <button
            type="button"
            className={`btn btn-outline detail-download-button ${className}`}
            onClick={handleDownload}
            disabled={isDownloading || disabled}
            title={title}
            aria-label={title}
        >
            {icon}
            {isDownloading ? '저장 중' : downloadState === 'saved' ? '저장됨' : buttonLabel}
        </button>
    ) : (
        <div className="flex overflow-hidden rounded-md border border-input bg-background shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-primary/30">
            <button
                type="button"
                className={`inline-flex h-10 w-10 items-center justify-center text-foreground transition-colors hover:bg-muted/50 hover:text-primary disabled:cursor-wait disabled:opacity-60 ${className}`}
                onClick={handleDownload}
                disabled={isDownloading || disabled}
                title={title}
                aria-label={title}
            >
                {icon}
            </button>
        </div>
    );
};
