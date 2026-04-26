import React, { useEffect, useState } from 'react';

export const Header: React.FC = () => {
    const [isDark, setIsDark] = useState(false);

    useEffect(() => {
        if (document.documentElement.classList.contains('dark')) {
            setIsDark(true);
        }
    }, []);

    const toggleTheme = () => {
        setIsDark(!isDark);
        document.documentElement.classList.toggle('dark');
    };

    return (
        <header className="h-16 border-b border-border flex items-center justify-between px-6 glass-card border-x-0 border-t-0 rounded-none z-10 relative">
            {/* 타이포그래피 계층: Header 제목 */}
            <h1 className="text-h3 text-primary">Smart Minutes AI</h1>

            <div className="flex items-center gap-4">
                {/* 타이포그래피 계층: 부가 설명 */}
                <span className="text-caption hidden sm:inline-block">관리자님 환영합니다</span>

                {/* 다크 모드 토글 버튼 */}
                <button
                    onClick={toggleTheme}
                    className="text-sm font-semibold text-interactive mr-2"
                >
                    {isDark ? '☀️ 라이트 모드' : '🌙 다크 모드'}
                </button>

                {/* 인터랙티브 상태가 적용된 텍스트 버튼 */}
                <button className="text-sm font-semibold text-interactive">
                    로그아웃
                </button>
            </div>
        </header>
    );
};