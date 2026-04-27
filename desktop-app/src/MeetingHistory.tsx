import React, { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { deleteMeeting, getAllMeetings, MeetingRecord } from './meetingRepository';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

export const MeetingHistory: React.FC = () => {
    const [searchTerm, setSearchTerm] = useState('');
    const [records, setRecords] = useState<MeetingRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedMeeting, setSelectedMeeting] = useState<MeetingRecord | null>(null);
    const [modalTab, setModalTab] = useState<'summary' | 'script'>('summary');

    useEffect(() => {
        const fetchRecords = async () => {
            try {
                setIsLoading(true);
                setErrorMessage('');
                const data = await getAllMeetings();
                setRecords(data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
            } catch (error) {
                const message = error instanceof Error ? error.message : '회의록을 불러오지 못했습니다.';
                setErrorMessage(message);
            } finally {
                setIsLoading(false);
            }
        };

        fetchRecords();
    }, []);

    const filteredRecords = useMemo(() => {
        const keyword = searchTerm.trim().toLowerCase();
        if (!keyword) return records;

        return records.filter(record =>
            [record.title, record.summary, record.participants]
                .some(value => value.toLowerCase().includes(keyword))
        );
    }, [records, searchTerm]);

    const handleDownloadMarkdown = () => {
        if (!selectedMeeting) return;

        const hasApproximateTiming = selectedMeeting.segments?.some(segment => segment.timingApproximate);
        const script = selectedMeeting.segments?.map(segment => {
            const timingLabel = segment.timingApproximate ? ' (시간 추정)' : '';
            return `- ${segment.start}-${segment.end}${timingLabel} ${segment.speaker}: ${segment.text}`;
        }).join('\n') || '발화 스크립트가 없습니다.';

        const timingNote = hasApproximateTiming
            ? '\n> 일부 시간표는 STT 모델의 전체 문장을 음성 길이에 맞춰 나눈 추정값입니다.\n'
            : '';
        const markdownContent = `# ${selectedMeeting.title}\n\n- **일시:** ${selectedMeeting.date}\n- **참석자:** ${selectedMeeting.participants}\n${timingNote}\n## 요약\n\n${selectedMeeting.summary}\n\n## 발화 스크립트\n\n${script}\n`;
        const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeTitle = selectedMeeting.title.replace(/[/\\?%*:|"<>]/g, '-');

        link.href = url;
        link.download = `회의록_${safeTitle}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleDownloadTranscriptText = () => {
        if (!selectedMeeting) return;

        const safeTitle = selectedMeeting.title.replace(/[/\\?%*:|"<>]/g, '-');
        const lines = [
            selectedMeeting.title,
            `일시: ${selectedMeeting.date}`,
            `참석자: ${selectedMeeting.participants}`,
            '',
            '[요약]',
            selectedMeeting.summary,
            '',
            '[화자 분리 / 발화 스크립트]',
            ...(selectedMeeting.segments?.length
                ? selectedMeeting.segments.map(segment => {
                    const timingLabel = segment.timingApproximate ? ' 시간 추정' : '';
                    return `${segment.start}-${segment.end}${timingLabel} ${segment.speaker}: ${segment.text}`;
                })
                : ['발화 스크립트 데이터가 없습니다. 실제 분석 모드로 다시 분석해 주세요.']),
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = `회의록_${safeTitle}_transcript.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleDownloadArtifact = (kind: 'txt' | 'md' | 'docx' | 'json') => {
        if (!selectedMeeting) return;

        const outputUrl = selectedMeeting.outputFiles?.[kind];
        if (!outputUrl) {
            if (kind === 'md') handleDownloadMarkdown();
            if (kind === 'txt') handleDownloadTranscriptText();
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
            if (selectedMeeting?.id === id) setSelectedMeeting(null);
        } catch (error) {
            const message = error instanceof Error ? error.message : '회의록 삭제 중 오류가 발생했습니다.';
            setErrorMessage(message);
        }
    };

    return (
        <div className="flex flex-col h-full gap-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
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

            <div className="bg-background border border-border rounded-lg overflow-hidden flex-1">
                <table className="w-full text-left border-collapse">
                    <thead className="bg-muted text-foreground border-b border-border">
                        <tr>
                            <th className="p-4 font-semibold w-1/5">일시</th>
                            <th className="p-4 font-semibold w-1/4">회의 제목</th>
                            <th className="p-4 font-semibold w-1/5">참석자</th>
                            <th className="p-4 font-semibold">요약</th>
                            <th className="p-4 font-semibold w-32 text-center">관리</th>
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading ? (
                            <tr>
                                <td colSpan={5} className="p-10 text-center text-muted-foreground">데이터를 불러오는 중입니다...</td>
                            </tr>
                        ) : filteredRecords.length > 0 ? (
                            filteredRecords.map((record) => (
                                <tr key={record.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                                    <td className="p-4 text-sm">{record.date}</td>
                                    <td className="p-4 font-medium">{record.title}</td>
                                    <td className="p-4 text-sm">{record.participants}</td>
                                    <td className="p-4 text-sm text-muted-foreground truncate max-w-xs">{record.summary}</td>
                                    <td className="p-4 text-center">
                                        <div className="flex items-center justify-center gap-2">
                                            <Button variant="outline" className="text-xs py-1.5 px-3" onClick={() => { setSelectedMeeting(record); setModalTab('summary'); }}>
                                                상세
                                            </Button>
                                            <Button variant="outline" className="text-xs py-1.5 px-3 text-red-500 hover:bg-red-50 border-red-200" onClick={() => handleDelete(record.id)}>
                                                삭제
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={5} className="p-10 text-center text-muted-foreground">검색된 회의 기록이 없습니다.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {selectedMeeting && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-background border border-border rounded-xl shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
                        <div className="flex justify-between items-center p-6 border-b border-border">
                            <h3 className="text-h3 font-semibold text-foreground">{selectedMeeting.title}</h3>
                            <div className="flex items-center gap-4">
                                <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('md')}>
                                    MD
                                </Button>
                                <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('txt')}>
                                    TXT
                                </Button>
                                <Button variant="outline" className="text-sm py-1.5 px-3" onClick={() => handleDownloadArtifact('docx')} disabled={!selectedMeeting.outputFiles?.docx}>
                                    DOCX
                                </Button>
                                <button onClick={() => setSelectedMeeting(null)} className="text-muted-foreground hover:text-foreground text-2xl leading-none">
                                    &times;
                                </button>
                            </div>
                        </div>

                        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 flex flex-col gap-6 text-foreground">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm font-medium text-muted-foreground">일시</span>
                                    <span>{selectedMeeting.date}</span>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm font-medium text-muted-foreground">참석자</span>
                                    <span>{selectedMeeting.participants}</span>
                                </div>
                                {selectedMeeting.sourceFile && (
                                    <div className="flex flex-col gap-1">
                                        <span className="text-sm font-medium text-muted-foreground">원본 파일</span>
                                        <span>{selectedMeeting.sourceFile}</span>
                                    </div>
                                )}
                                {selectedMeeting.jobId && (
                                    <div className="flex flex-col gap-1">
                                        <span className="text-sm font-medium text-muted-foreground">작업 ID</span>
                                        <span className="text-xs">{selectedMeeting.jobId}</span>
                                    </div>
                                )}
                            </div>

                            <div className="flex border-b border-border mt-2">
                                <button className={`pb-2 px-4 text-sm font-medium border-b-2 transition-colors ${modalTab === 'summary' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setModalTab('summary')}>
                                    요약 내용
                                </button>
                                <button className={`pb-2 px-4 text-sm font-medium border-b-2 transition-colors ${modalTab === 'script' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setModalTab('script')}>
                                    발화 스크립트
                                </button>
                            </div>

                            {modalTab === 'summary' ? (
                                <div className="flex flex-col gap-4">
                                    <div className="bg-muted/50 p-4 rounded-md whitespace-pre-wrap leading-relaxed text-sm">
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
                                            <div key={`${seg.start}-${idx}`} className="flex gap-4 p-3 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors">
                                                <div className="w-28 shrink-0 flex flex-col text-xs text-muted-foreground">
                                                    <span className="font-semibold text-primary">{seg.speaker}</span>
                                                    <span>{seg.start} - {seg.end}</span>
                                                    {seg.timingApproximate && (
                                                        <span className="mt-1 w-fit rounded-sm bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                                                            시간 추정
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex-1 text-sm text-foreground">{seg.text}</div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="p-8 text-center text-sm text-muted-foreground bg-muted/30 rounded-md">
                                            발화 스크립트 데이터가 없습니다.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
