import React from 'react';

export const Header: React.FC = () => {
    return (
        <header className="h-16 border-b border-border flex items-center gap-4 px-4 bg-surface shadow-sm z-10 relative sm:px-6">
            <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">AI 회의록 도우미</h1>
        </header>
    );
};
