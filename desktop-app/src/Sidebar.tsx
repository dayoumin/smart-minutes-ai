import React, { useEffect, useMemo, useState } from 'react';
import { FileText, History, PlusCircle } from 'lucide-react';
import { getAllMeetings, MeetingRecord } from './meetingRepository';

export interface SidebarProps {
    activeTab?: string;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab = 'minutes', onTabChange, onSelectMeeting }) => {
    const [records, setRecords] = useState<MeetingRecord[]>([]);

    useEffect(() => {
        const loadRecords = async () => {
            try {
                const data = await getAllMeetings();
                setRecords(data);
            } catch {
                setRecords([]);
            }
        };

        loadRecords();
        window.addEventListener('focus', loadRecords);
        window.addEventListener('meetings:updated', loadRecords);
        return () => {
            window.removeEventListener('focus', loadRecords);
            window.removeEventListener('meetings:updated', loadRecords);
        };
    }, [activeTab]);

    const recentRecords = useMemo(
        () => records
            .slice()
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 6),
        [records],
    );

    return (
        <aside className="w-72 border-r border-border h-screen bg-background flex flex-col p-4 z-10 relative">
            <div className="mb-6 pl-3 mt-2">
                <span className="text-overline">NIFS AI</span>
                <div className="mt-2 text-sm font-semibold text-foreground">스마트 회의록</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    음성/영상 회의 자료를 요약하고 기록합니다.
                </div>
            </div>

            <nav className="flex flex-col gap-1">
                <button
                    className={`${activeTab === 'minutes' ? 'nav-item-active' : 'nav-item'} flex w-full items-center gap-2 border-none text-left`}
                    onClick={() => onTabChange?.('minutes')}
                    type="button"
                >
                    <PlusCircle size={16} />
                    회의록 작성
                </button>
                <button
                    className={`${activeTab === 'history' ? 'nav-item-active' : 'nav-item'} flex w-full items-center gap-2 border-none text-left`}
                    onClick={() => onTabChange?.('history')}
                    type="button"
                >
                    <History size={16} />
                    이전 회의 기록
                </button>
            </nav>

            <div className="mt-4 min-h-0 flex-1 border-t border-border pt-4">
                <div className="mb-2 px-3 text-xs font-semibold text-muted-foreground">최근 회의</div>
                <div className="flex max-h-full flex-col gap-1 overflow-y-auto pr-1 custom-scrollbar">
                    {recentRecords.length ? (
                        recentRecords.map(record => (
                            <button
                                key={record.id}
                                type="button"
                                className="group rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/40"
                                onClick={() => onSelectMeeting?.(record.id)}
                                title={record.title}
                            >
                                <div className="flex items-start gap-2">
                                    <FileText size={14} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                                    <div className="min-w-0">
                                        <div className="truncate text-xs font-medium text-foreground">{record.title}</div>
                                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{record.date}</div>
                                    </div>
                                </div>
                            </button>
                        ))
                    ) : (
                        <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            아직 저장된 회의 기록이 없습니다.
                        </div>
                    )}
                </div>
            </div>

            <div className="mt-4 pl-3 text-caption">
                로컬 MVP · FastAPI 연결
            </div>
        </aside>
    );
};
