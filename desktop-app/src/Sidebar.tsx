import React from 'react';

export const Sidebar: React.FC = () => {
    return (
        <aside className="w-64 border-r border-border h-screen bg-background flex flex-col p-4 z-10 relative">
            {/* 상단 로고/기관명 영역 */}
            <div className="mb-8 pl-3 mt-2">
                <span className="text-overline">NIFS AI</span>
            </div>

            {/* 내비게이션 메뉴 */}
            <nav className="flex flex-col gap-1">
                <button className="nav-item-active text-left w-full border-none">
                    회의록 작성
                </button>
                <button className="nav-item text-left w-full border-none">
                    이전 회의 기록
                </button>
                <button className="nav-item text-left w-full border-none">
                    시스템 설정
                </button>
            </nav>

            {/* 하단 버전 정보 영역 */}
            <div className="mt-auto pl-3 mb-2">
                <span className="text-caption">버전 1.0.0</span>
            </div>
        </aside>
    );
};