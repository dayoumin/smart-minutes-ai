import React from 'react';

export interface SidebarProps {
    activeTab?: string;
    onTabChange?: (tab: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab = 'minutes', onTabChange }) => {
    return (
        <aside className="w-64 border-r border-border h-screen bg-background flex flex-col p-4 z-10 relative">
            {/* 상단 로고/기관명 영역 */}
            <div className="mb-8 pl-3 mt-2">
                <span className="text-overline">NIFS AI</span>
                <div className="mt-2 text-sm font-semibold text-foreground">스마트 회의록</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    음성/영상 회의 자료를 요약하고 기록합니다.
                </div>
            </div>

            {/* 내비게이션 메뉴 */}
            <nav className="flex flex-col gap-1">
                <button
                    className={`${activeTab === 'minutes' ? 'nav-item-active' : 'nav-item'} text-left w-full border-none`}
                    onClick={() => onTabChange?.('minutes')}
                >
                    회의록 작성
                </button>
                <button
                    className={`${activeTab === 'history' ? 'nav-item-active' : 'nav-item'} text-left w-full border-none`}
                    onClick={() => onTabChange?.('history')}
                >
                    이전 회의 기록
                </button>
                <button
                    className={`${activeTab === 'settings' ? 'nav-item-active' : 'nav-item'} text-left w-full border-none`}
                    onClick={() => onTabChange?.('settings')}
                >
                    시스템 설정
                </button>
            </nav>

            {/* 하단 버전 정보 영역 */}
            <div className="mt-auto pl-3 mb-2">
                <span className="text-caption">로컬 MVP · FastAPI 연결</span>
            </div>
        </aside>
    );
};
