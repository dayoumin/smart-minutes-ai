import React from 'react';
import { Settings } from 'lucide-react';

interface HeaderProps {
    onOpenSettings?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenSettings }) => {
    return (
        <header className="h-16 border-b border-border flex items-center justify-between px-6 glass-card border-x-0 border-t-0 rounded-none z-10 relative">
            <h1 className="text-h3 text-primary">Smart Minutes AI</h1>

            <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted/40 hover:text-primary"
                title="시스템 설정"
                aria-label="시스템 설정"
            >
                <Settings size={18} />
            </button>
        </header>
    );
};
