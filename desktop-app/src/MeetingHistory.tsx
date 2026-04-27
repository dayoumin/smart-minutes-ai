import React, { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { deleteMeeting, getAllMeetings, MeetingRecord } from './meetingRepository';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

interface MeetingHistoryProps {
    selectedMeetingId?: string | null;
    onSelectedMeetingHandled?: () => void;
}

type DownloadKind = 'hwpx' | 'txt' | 'docx' | 'md' | 'json';
type DetailTab = 'summary' | 'script';

const safeFileName = (title: string): string => title.replace(/[/\\?%*:|"<>]/g, '-');

export const MeetingHistory: React.FC<MeetingHistoryProps> = ({ selectedMeetingId, onSelectedMeetingHandled }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [detailTab, setDetailTab] = useState<DetailTab>('summary');

    const loadRecords = async () => {
        try {
            setIsLoading(true);
            setErrorMessage('');
            const data = await getAllMeetings();
            const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            setRecords(sorted);
            setSelectedMeeting(prev => {
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
        if (!selectedMeetingId || !records.length) return;

        const meeting = records.find(record => record.id === selectedMeetingId);
        if (meeting) {
            setSelectedMeeting(meeting);
            setDetailTab('summary');
            onSelectedMeetingHandled?.();
        }
    }, [selectedMeetingId, records, onSelectedMeetingHandled]);

    const filteredRecords = useMemo(() => {
        const keyword = searchTerm.trim().toLowerCase();
        if (!keyword) return records;

        return records.filter(record =>
            [record.title, record.summary, record.participants]
                .some(value => value.toLowerCase().includes(keyword))
        );
    }, [records, searchTerm]);

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
            '[화자 분리 / 발화 스크립트]',
            ...(meeting.segments?.length
                ? meeting.segments.map(segment => {
                    const timingLabel = segment.timingApproximate ? ' 시간 추정' : '';
                    return `${segment.start}-${segment.end}${timingLabel} ${segment.speaker}: ${segment.text}`;
                })
                : ['발화 스크립트 데이터가 없습니다. 실제 분석 모드로 다시 분석해 주세요.']),
        ];
        return lines.filter(Boolean).join('\n');
    };

    const downloadBlob = (content: string, filename: string, type: string) => {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleDownloadArtifact = (kind: DownloadKind) => {
        if (!selectedMeeting) return;

        if (kind === 'txt' && !selectedMeeting.outputFiles?.txt && !selectedMeeting.jobId) {
            downloadBlob(
                buildTranscriptText(selectedMeeting),
                `회의록_${safeFileName(selectedMeeting.title)}_transcript.txt`,
                'text/plain;charset=utf-8;',
            );
            return;
        }

        const outputUrl = selectedMeeting.outputFiles?.[kind]
            ?? (selectedMeeting.jobId ? `/api/outputs/${selectedMeeting.jobId}/${kind}` : null);

        if (!outputUrl) {
            setErrorMessage('이 형식은 실제 분석 결과에서만 다운로드할 수 있습니다.');
            return;
        }

        const absoluteUrl = outputUrl.startsWith('http') ? outputUrl : `${API_BASE}${outputUrl}`;
        window.open(absoluteUrl, '_blank', 'noopener,noreferrer');
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm('정말로 이 회의록을 삭제하시겠습니까? 삭제한 데이터는 복구할 수 없습니다.')) return;

        try {
            await deleteMeeting(id);
            setRecords(prev => prev.filter(record => record.id !== id));
            setSelectedMeeting(prev => prev?.id === id ? null : prev);
            window.dispatchEvent(new Event('meetings:updated'));
        } catch (error) {
            const message = error instanceof Error ? error.message : '회의록 삭제 중 오류가 발생했습니다.';
            setErrorMessage(message);
        }
    };

    return (
        <div className="grid h-full min-h-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(360px,0.95fr)_minmax(520px,1.4fr)]">
            <section className="flex min-h-0 flex-col gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <h2 className="text-h3 font-semibold text-primary">이전 회의 기록</h2>
                    <div className="w-full md:w-72">
                        <Input
                            type="text"
                            placeholder="회의 제목, 요약, 참석자 검색..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>

                {errorMessage && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {errorMessage}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
                    <div className="max-h-full overflow-y-auto custom-scrollbar">
                        {isLoading ? (
                            <div className="p-10 text-center text-sm text-muted-foreground">회의 기록을 불러오는 중입니다...</div>
                        ) : filteredRecords.length ? (
                            <div className="divide-y divide-border">
                                {filteredRecords.map(record => {
                                    const isSelected = selectedMeeting?.id === record.id;
                                    return (
                                        <button
                                            key={record.id}
                                            type="button"
                                            className={`block w-full p-4 text-left transition-colors ${isSelected ? 'bg-blue-50/80' : 'hover:bg-muted/30'}`}
                                            onClick={() => {
                                                setSelectedMeeting(record);
                                                setDetailTab('summary');
                                            }}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="truncate font-medium text-foreground">{record.title}</div>
                                                    <div className="mt-1 text-xs text-muted-foreground">{record.date} · {record.participants}</div>
                                                </div>
                                                <span className="shrink-0 text-xs text-muted-foreground">{record.segments?.length ?? 0}개 발화</span>
                                            </div>
                                            <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">{record.summary}</div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="p-10 text-center text-sm text-muted-foreground">검색된 회의 기록이 없습니다.</div>
                        )}
                    </div>
                </div>
            </section>

            <section className="min-h-0 rounded-lg border border-border bg-background">
                {selectedMeeting ? (
                    <div className="flex h-full min-h-0 flex-col">
                        <div className="border-b border-border p-5">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                <div className="min-w-0">
                                    <h3 className="text-h3 font-semibold text-foreground">{selectedMeeting.title}</h3>
                                    <div className="mt-2 grid grid-cols-1 gap-1 text-sm text-muted-foreground md:grid-cols-2">
                                        <span>일시: {selectedMeeting.date}</span>
                                        <span>참석자: {selectedMeeting.participants}</span>
                                        {selectedMeeting.sourceFile && <span className="md:col-span-2">원본 파일: {selectedMeeting.sourceFile}</span>}
                                    </div>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                    <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('hwpx')}>
                                        HWPX
                                    </Button>
                                    <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('txt')}>
                                        TXT
                                    </Button>
                                    <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('docx')} disabled={!selectedMeeting.outputFiles?.docx && !selectedMeeting.jobId}>
                                        DOCX
                                    </Button>
                                    <Button variant="outline" className="text-sm py-1.5 px-3 text-red-500 hover:bg-red-50 border-red-200" onClick={() => handleDelete(selectedMeeting.id)}>
                                        삭제
                                    </Button>
                                </div>
                            </div>

                            <div className="mt-5 flex border-b border-border">
                                <button className={`pb-2 px-4 text-sm font-medium border-b-2 transition-colors ${detailTab === 'summary' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setDetailTab('summary')}>
                                    요약 내용
                                </button>
                                <button className={`pb-2 px-4 text-sm font-medium border-b-2 transition-colors ${detailTab === 'script' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setDetailTab('script')}>
                                    화자 분리 / 발화 스크립트
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
                            {detailTab === 'summary' ? (
                                <div className="flex flex-col gap-5">
                                    <div className="rounded-md bg-muted/50 p-4 text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                                        {selectedMeeting.summary}
                                    </div>
                                    {!!selectedMeeting.topics?.length && (
                                        <div>
                                            <h4 className="mb-2 text-sm font-semibold text-foreground">주요 주제</h4>
                                            <div className="flex flex-wrap gap-2">
                                                {selectedMeeting.topics.map(topic => (
                                                    <span key={topic} className="rounded-md bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">{topic}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {!!selectedMeeting.actions?.length && (
                                        <div>
                                            <h4 className="mb-2 text-sm font-semibold text-foreground">할 일</h4>
                                            <ul className="list-disc pl-5 text-sm text-foreground">
                                                {selectedMeeting.actions.map(action => <li key={action}>{action}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-3">
                                    {selectedMeeting.segments?.some(seg => seg.timingApproximate) && (
                                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                            이 회의록의 시간표는 음성 길이에 맞춰 나눈 추정값입니다. 화자와 내용 확인용으로 사용해 주세요.
                                        </div>
                                    )}
                                    {selectedMeeting.segments?.length ? (
                                        selectedMeeting.segments.map((seg, idx) => (
                                            <div key={`${seg.start}-${idx}`} className="flex gap-4 rounded-md bg-muted/30 p-3 transition-colors hover:bg-muted/50">
                                                <div className="w-32 shrink-0 text-xs text-muted-foreground">
                                                    <div className="font-semibold text-primary">{seg.speaker}</div>
                                                    <div>{seg.start} - {seg.end}</div>
                                                    {seg.timingApproximate && <div className="mt-1 w-fit rounded-sm bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">시간 추정</div>}
                                                </div>
                                                <div className="flex-1 text-sm leading-relaxed text-foreground">{seg.text}</div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="rounded-md bg-muted/30 p-8 text-center text-sm text-muted-foreground">
                                            발화 스크립트 데이터가 없습니다. 실제 분석 모드로 다시 분석해 주세요.
                                        </div>
                                    )}
                                </div>
                            )}
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
