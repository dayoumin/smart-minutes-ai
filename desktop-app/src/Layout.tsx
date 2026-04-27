import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export interface LayoutProps {
    children: React.ReactNode;
    activeTab?: string;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange, onSelectMeeting }) => {
    return (
        <div className="flex h-screen bg-background text-foreground overflow-hidden">
            <Sidebar activeTab={activeTab} onTabChange={onTabChange} onSelectMeeting={onSelectMeeting} />
            <div className="flex flex-col flex-1 min-w-0">
                <Header onOpenSettings={() => onTabChange?.('settings')} />
                <main className="flex-1 overflow-auto p-6 custom-scrollbar bg-page">
                    {children}
                </main>
            </div>
        </div>
    );
};
