import React, { useEffect, useMemo, useState } from 'react';
import { Download, Edit3, FileText, PlusCircle, Save, Search, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { deleteMeeting, getAllMeetings, MeetingRecord, updateMeeting } from './meetingRepository';
import {
    DownloadFormat,
    DOWNLOAD_FORMAT_CHANGE_EVENT,
    getDownloadFormatPreference,
    setDownloadFormatPreference,
} from './downloadPreferences';
import { toApiUrl } from './apiBase';
import { Input } from './Input';

interface MeetingHistoryProps {
    selectedMeetingId?: string | null;
    onSelectedMeetingHandled?: () => void;
    onCreateMeeting?: () => void;
}

type DetailTab = 'summary' | 'script';

const safeFileName = (title: string): string => title.replace(/[/\\?%*:|"<>]/g, '-');
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
const speakerToneCount = 6;

const getSpeakerTone = (speaker: string, index: number): string => {
    const match = speaker.match(/(\d+)/);
    const speakerIndex = match ? Number.parseInt(match[1], 10) : index;
    return `speaker-tone-${speakerIndex % speakerToneCount}`;
};

const looksLikeKoreanMisrecognition = (text: string): boolean => {
    const compact = text.replace(/\s/g, '');
    if (compact.length < 20) return false;

    const hangulCount = (compact.match(/[\uac00-\ud7a3]/g) || []).length;
    const latinCount = (compact.match(/[A-Za-z]/g) || []).length;
    return latinCount > hangulCount * 2 && latinCount > 24;
};

export const MeetingHistory: React.FC<MeetingHistoryProps> = ({ selectedMeetingId, onSelectedMeetingHandled, onCreateMeeting }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [detailTab, setDetailTab] = useState<DetailTab>('summary');
    const [downloadKind, setDownloadKind] = useState<DownloadFormat>(() => getDownloadFormatPreference());
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDate, setEditDate] = useState('');
    const [editParticipants, setEditParticipants] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    const loadRecords = async (event?: Event) => {
        try {
            setIsLoading(true);
            setErrorMessage('');
            const data = await getAllMeetings();
            const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            const nextSelectedId = (event as CustomEvent<{ id?: string }> | undefined)?.detail?.id;
            setRecords(sorted);
            setSelectedMeeting(prev => {
                if (nextSelectedId) {
                    return sorted.find(record => record.id === nextSelectedId) ?? prev;
                }
                if (prev && sorted.some(record => record.id === prev.id)) {
                    return sorted.find(record => record.id === prev.id) ?? prev;
                }
                return sorted[0] ?? null;
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : '회의 기록을 불러오지 못했습니다.';
            setErrorMessage(message);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadRecords();
        window.addEventListener('meetings:updated', loadRecords);
        return () => window.removeEventListener('meetings:updated', loadRecords);
    }, []);

    useEffect(() => {
        const syncDownloadPreference = () => setDownloadKind(getDownloadFormatPreference());
        window.addEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
        window.addEventListener('focus', syncDownloadPreference);
        return () => {
            window.removeEventListener(DOWNLOAD_FORMAT_CHANGE_EVENT, syncDownloadPreference);
            window.removeEventListener('focus', syncDownloadPreference);
        };
    }, []);

    useEffect(() => {
        if (!selectedMeetingId || !records.length) return;

        const meeting = records.find(record => record.id === selectedMeetingId);
        if (meeting) {
            setSelectedMeeting(meeting);
            setDetailTab('summary');
            onSelectedMeetingHandled?.();
        }
    }, [selectedMeetingId, records, onSelectedMeetingHandled]);

    useEffect(() => {
        if (!selectedMeeting) return;
        setEditTitle(selectedMeeting.title);
        setEditDate(selectedMeeting.date.replace(' ', 'T'));
        setEditParticipants(selectedMeeting.participants);
        setIsEditing(false);
    }, [selectedMeeting?.id]);

    const recordCountLabel = useMemo(() => `${records.length}개 회의 저장됨`, [records.length]);
    const filteredRecords = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return records;
        return records.filter(record => [
            record.title,
            record.date,
            record.participants,
            record.sourceFile,
            record.summary,
        ].filter(Boolean).join(' ').toLowerCase().includes(query));
    }, [records, searchQuery]);

    const buildTranscriptText = (meeting: MeetingRecord): string => {
        const lines = [
            meeting.title,
            `일시: ${meeting.date}`,
            `참석자: ${meeting.participants}`,
            meeting.sourceFile ? `원본 파일: ${meeting.sourceFile}` : '',
            '',
            '[요약]',
            meeting.summary,
            '',
            '[발화 기록]',
            ...(meeting.segments?.length
                ? meeting.segments.map(segment => {
                    const timingLabel = segment.timingApproximate ? ' 시간 추정' : '';
                    return `${segment.start}-${segment.end}${timingLabel} ${segment.speaker}: ${segment.text}`;
                })
                : ['발화 기록이 없습니다. 다시 분석해 주세요.']),
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

    const handleDownloadArtifact = async (kind: DownloadFormat) => {
        if (!selectedMeeting) return;
        setErrorMessage('');

        const downloadLocalText = () => {
            downloadBlob(
                buildTranscriptText(selectedMeeting),
                `회의록_${safeFileName(selectedMeeting.title)}_transcript.txt`,
                'text/plain;charset=utf-8;',
            );
        };

        try {
            const response = await fetch(await toApiUrl(`/api/export-record/${kind}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(selectedMeeting),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                downloadLocalText();
                setErrorMessage(`${kind.toUpperCase()} 파일을 만들지 못해 TXT로 다운로드했습니다.${detail ? ` (${detail})` : ''}`);
                return;
            }

            const blob = await response.blob();
            const fallbackName = `${safeFileName(selectedMeeting.title)}.${extensionByKind[kind]}`;
            const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
            downloadBlob(blob, filename);
        } catch (error) {
            downloadLocalText();
            const message = error instanceof Error ? error.message : '파일 다운로드 중 오류가 발생했습니다.';
            setErrorMessage(`${message} TXT로 다운로드했습니다.`);
        }
    };

    const handleDelete = async (id: string) => {
        const meeting = records.find(record => record.id === id);
        if (!window.confirm('회의록 기록을 삭제합니다. 분석 파일 정리도 함께 시도합니다. 계속할까요?')) return;

        try {
            await deleteMeeting(id);
            setRecords(prev => prev.filter(record => record.id !== id));
            setSelectedMeeting(prev => prev?.id === id ? null : prev);
            window.dispatchEvent(new Event('meetings:updated'));
            setErrorMessage('');
        } catch (error) {
            const message = error instanceof Error ? error.message : '회의록 삭제 중 오류가 발생했습니다.';
            setErrorMessage(message);
            return;
        }

        try {
            if (meeting?.jobId) {
                const response = await fetch(await toApiUrl(`/api/outputs/${encodeURIComponent(meeting.jobId)}`), {
                    method: 'DELETE',
                });
                if (!response.ok && response.status !== 404) {
                    setErrorMessage('회의록은 삭제했지만 일부 분석 파일을 정리하지 못했습니다. 앱을 다시 실행한 뒤 다시 확인해 주세요.');
                }
            }
        } catch (error) {
            setErrorMessage('회의록은 삭제했지만 분석 파일 정리 상태를 확인하지 못했습니다. 앱을 다시 실행한 뒤 다시 확인해 주세요.');
        }
    };

    const handlePreferredDownload = () => {
        setDownloadFormatPreference(downloadKind);
        handleDownloadArtifact(downloadKind);
    };

    const handleSaveEdit = async () => {
        if (!selectedMeeting) return;

        const nextTitle = editTitle.trim();
        const nextParticipants = editParticipants.trim();
        if (!nextTitle || !editDate || !nextParticipants) {
            setErrorMessage('회의 제목, 일시, 참석자를 모두 입력해 주세요.');
            return;
        }

        const nextMeeting: MeetingRecord = {
            ...selectedMeeting,
            title: nextTitle,
            date: editDate.replace('T', ' '),
            participants: nextParticipants,
        };

        try {
            await updateMeeting(nextMeeting);
            setSelectedMeeting(nextMeeting);
            setRecords(prev => prev.map(record => record.id === nextMeeting.id ? nextMeeting : record));
            setIsEditing(false);
            setErrorMessage('');
            window.dispatchEvent(new Event('meetings:updated'));
        } catch (error) {
            const message = error instanceof Error ? error.message : '회의록 정보를 저장하지 못했습니다.';
            setErrorMessage(message);
        }
    };

    const handleCancelEdit = () => {
        if (!selectedMeeting) return;
        setEditTitle(selectedMeeting.title);
        setEditDate(selectedMeeting.date.replace(' ', 'T'));
        setEditParticipants(selectedMeeting.participants);
        setIsEditing(false);
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            {errorMessage && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {errorMessage}
                </div>
            )}

            <section className="app-panel min-h-0 flex-1">
                {isLoading ? (
                    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                        회의 기록을 불러오는 중입니다...
                    </div>
                ) : selectedMeeting ? (
                    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
                        <aside className="min-h-0 border-b border-border bg-muted/10 lg:border-b-0 lg:border-r">
                            <div className="border-b border-border p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <h3 className="text-base font-semibold text-foreground">회의 기록</h3>
                                    <span className="text-xs text-muted-foreground">{recordCountLabel}</span>
                                </div>
                                <label className="mt-3 flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                                    <Search size={15} className="shrink-0 text-muted-foreground" />
                                    <input
                                        value={searchQuery}
                                        onChange={event => setSearchQuery(event.target.value)}
                                        placeholder="제목, 참석자, 요약 검색"
                                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                                    />
                                </label>
                            </div>
                            <div className="max-h-64 overflow-y-auto p-2 custom-scrollbar lg:max-h-none lg:h-[calc(100%-81px)]">
                                {filteredRecords.length ? filteredRecords.map(record => (
                                    <button
                                        key={record.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedMeeting(record);
                                            setDetailTab('summary');
                                        }}
                                        className={`mb-1 flex w-full flex-col rounded-md px-3 py-2 text-left transition-colors ${selectedMeeting.id === record.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted/60'}`}
                                    >
                                        <span className="truncate text-sm font-semibold">{record.title}</span>
                                        <span className="mt-1 truncate text-xs text-muted-foreground">{record.date} · {record.participants}</span>
                                    </button>
                                )) : (
                                    <div className="p-4 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
                                )}
                            </div>
                        </aside>

                        <div className="flex h-full min-h-0 flex-col">
                        <div className="app-panel-header">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                <div className="min-w-0 flex-1">
                                    {isEditing ? (
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <label className="md:col-span-2 text-xs font-medium text-muted-foreground">
                                                회의 제목
                                                <Input className="mt-1" value={editTitle} onChange={event => setEditTitle(event.target.value)} />
                                            </label>
                                            <label className="text-xs font-medium text-muted-foreground">
                                                일시
                                                <Input className="mt-1" type="datetime-local" value={editDate} onChange={event => setEditDate(event.target.value)} />
                                            </label>
                                            <label className="text-xs font-medium text-muted-foreground">
                                                참석자
                                                <Input className="mt-1" value={editParticipants} onChange={event => setEditParticipants(event.target.value)} />
                                            </label>
                                        </div>
                                    ) : (
                                        <>
                                            <h3 className="text-h3 font-semibold text-foreground">{selectedMeeting.title}</h3>
                                            <div className="mt-2 grid grid-cols-1 gap-1 text-sm text-muted-foreground md:grid-cols-2">
                                                <span>일시: {selectedMeeting.date}</span>
                                                <span>참석자: {selectedMeeting.participants}</span>
                                                {selectedMeeting.sourceFile && <span className="md:col-span-2">원본 파일: {selectedMeeting.sourceFile}</span>}
                                            </div>
                                        </>
                                    )}
                                </div>
                                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                    <select
                                        value={downloadKind}
                                        onChange={event => setDownloadKind(event.target.value as DownloadFormat)}
                                        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                                        aria-label="다운로드 형식 선택"
                                    >
                                        {Object.entries(downloadFormatLabels).map(([value, label]) => (
                                            <option key={value} value={value}>{label}</option>
                                        ))}
                                    </select>
                                    <Button
                                        variant="outline"
                                        className="inline-flex h-10 w-10 items-center justify-center p-0"
                                        onClick={handlePreferredDownload}
                                        title={`${downloadFormatLabels[downloadKind]} 다운로드`}
                                        aria-label="회의록 다운로드"
                                    >
                                        <Download size={18} />
                                    </Button>
                                    {isEditing ? (
                                        <>
                                            <Button
                                                variant="outline"
                                                className="inline-flex h-10 w-10 items-center justify-center p-0"
                                                onClick={handleSaveEdit}
                                                title="수정 저장"
                                                aria-label="수정 저장"
                                            >
                                                <Save size={18} />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                className="inline-flex h-10 w-10 items-center justify-center p-0"
                                                onClick={handleCancelEdit}
                                                title="수정 취소"
                                                aria-label="수정 취소"
                                            >
                                                <X size={18} />
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            variant="outline"
                                            className="inline-flex h-10 w-10 items-center justify-center p-0"
                                            onClick={() => setIsEditing(true)}
                                            title="회의 정보 수정"
                                            aria-label="회의 정보 수정"
                                        >
                                            <Edit3 size={18} />
                                        </Button>
                                    )}
                                    <Button
                                        variant="outline"
                                        className="inline-flex h-10 w-10 items-center justify-center border-red-200 p-0 text-red-500 hover:bg-red-50"
                                        onClick={() => handleDelete(selectedMeeting.id)}
                                        title="회의록 삭제"
                                        aria-label="회의록 삭제"
                                    >
                                        <Trash2 size={18} />
                                    </Button>
                                </div>
                            </div>

                            <div className="tab-list mt-5" role="tablist" aria-label="회의록 상세">
                                <button
                                    type="button"
                                    id="meeting-summary-tab"
                                    role="tab"
                                    aria-selected={detailTab === 'summary'}
                                    aria-controls="meeting-summary-panel"
                                    className={`tab-button ${detailTab === 'summary' ? 'tab-button-active' : ''}`}
                                    onClick={() => setDetailTab('summary')}
                                >
                                    회의 요약
                                </button>
                                <button
                                    type="button"
                                    id="meeting-script-tab"
                                    role="tab"
                                    aria-selected={detailTab === 'script'}
                                    aria-controls="meeting-script-panel"
                                    className={`tab-button ${detailTab === 'script' ? 'tab-button-active' : ''}`}
                                    onClick={() => setDetailTab('script')}
                                >
                                    발화 기록
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
                            {detailTab === 'summary' ? (
                                <div id="meeting-summary-panel" role="tabpanel" aria-labelledby="meeting-summary-tab" className="flex flex-col gap-5">
                                    <div className="summary-block">
                                        {selectedMeeting.summary}
                                    </div>
                                    {!!selectedMeeting.topics?.length && (
                                        <div>
                                            <h4 className="section-title mb-2">주요 주제</h4>
                                            <div className="flex flex-wrap gap-2">
                                                {selectedMeeting.topics.map(topic => (
                                                    <span key={topic} className="topic-chip">{topic}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {!!selectedMeeting.actions?.length && (
                                        <div>
                                            <h4 className="section-title mb-2">할 일</h4>
                                            <ul className="list-disc pl-5 text-sm text-foreground">
                                                {selectedMeeting.actions.map(action => <li key={action}>{action}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div id="meeting-script-panel" role="tabpanel" aria-labelledby="meeting-script-tab" className="flex flex-col gap-3">
                                    <div className="flex flex-col gap-2">
                                        {selectedMeeting.segments?.some(seg => seg.timingApproximate) && (
                                            <div className="status-note border-amber-200 bg-amber-50 text-amber-800">
                                                일부 시간 정보는 음성 길이에 맞춘 추정값입니다. 화자와 내용 확인용으로 사용해 주세요.
                                            </div>
                                        )}
                                        {selectedMeeting.segments?.some(seg => looksLikeKoreanMisrecognition(seg.text)) && (
                                            <div className="status-note border-red-200 bg-red-50 text-red-700">
                                                일부 구간은 음성 인식 품질 확인이 필요합니다. 원본 음성과 대조해 주세요.
                                            </div>
                                        )}
                                    </div>
                                    {selectedMeeting.segments?.length ? (
                                        <div className="flex flex-col gap-3">
                                            {selectedMeeting.segments.map((seg, idx) => (
                                                <div key={`${seg.start}-${idx}`} className={`speaker-turn ${getSpeakerTone(seg.speaker, idx)} ${looksLikeKoreanMisrecognition(seg.text) ? 'speaker-turn-warning' : ''}`}>
                                                    <div className="speaker-meta">
                                                        <div className="speaker-label">
                                                            <span className="speaker-dot" aria-hidden="true" />
                                                            <span>{seg.speaker}</span>
                                                        </div>
                                                        <div>{seg.start} - {seg.end}</div>
                                                        {seg.timingApproximate && <div className="mt-1 w-fit rounded-sm bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">시간 추정</div>}
                                                        {looksLikeKoreanMisrecognition(seg.text) && <div className="mt-1 w-fit rounded-sm bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">인식 확인</div>}
                                                    </div>
                                                    <div className="speaker-text">{seg.text}</div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-md bg-muted/30 p-8 text-center text-sm text-muted-foreground">
                                            <div>발화 기록이 없습니다.</div>
                                            <Button className="mt-4" variant="outline" onClick={onCreateMeeting}>
                                                <PlusCircle size={16} />
                                                새 회의록 작성
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        </div>
                    </div>
                ) : records.length === 0 ? (
                    <div className="flex h-full items-center justify-center p-8 text-center">
                        <div className="flex max-w-sm flex-col items-center gap-4">
                            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted/50 text-primary">
                                <FileText size={22} />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-foreground">아직 저장된 회의록이 없습니다</h3>
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                    첫 회의 자료를 업로드하면 회의 요약과 발화 기록이 이곳에 저장됩니다.
                                </p>
                            </div>
                            <Button onClick={onCreateMeeting}>
                                <PlusCircle size={16} />
                                새 회의록 작성
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                        왼쪽 목록에서 회의 기록을 선택하면 이 영역에서 바로 확인할 수 있습니다.
                    </div>
                )}
            </section>
        </div>
    );
};
