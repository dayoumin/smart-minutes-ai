import React from 'react';
import { History, PlusCircle } from 'lucide-react';

export interface SidebarProps {
    activeTab?: string;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab = 'minutes', onTabChange, onSelectMeeting }) => {
    void onSelectMeeting;

    return (
        <aside className="relative z-10 flex max-h-[42vh] shrink-0 flex-col border-b border-border bg-background p-4 lg:h-screen lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
            <div className="mb-4 pl-1 sm:pl-3 lg:mt-2 lg:mb-6">
                <span className="text-overline">NIFS AI</span>
                <div className="mt-2 text-sm font-semibold text-foreground">스마트 회의록</div>
                <div className="mt-1 hidden text-xs leading-relaxed text-muted-foreground sm:block">
                    음성/영상 회의 자료를 요약하고 기록합니다.
                </div>
            </div>

            <nav className="grid grid-cols-2 gap-1 lg:flex lg:flex-col">
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

            <div className="mt-auto hidden pl-3 text-caption lg:block">
                로컬 분석
            </div>
        </aside>
    );
};
