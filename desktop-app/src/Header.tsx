import React from 'react';
import { Settings } from 'lucide-react';

interface HeaderProps {
    onOpenSettings?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenSettings }) => {
    return (
        <header className="h-16 border-b border-border flex items-center justify-between gap-4 px-4 bg-surface shadow-sm z-10 relative sm:px-6">
            <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">LMO 스마트 회의시스템</h1>

            <div className="flex shrink-0 items-center gap-3">
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted/40 hover:text-primary"
                    title="시스템 설정"
                    aria-label="시스템 설정"
                >
                    <Settings size={18} />
                </button>
            </div>
        </header>
    );
};
