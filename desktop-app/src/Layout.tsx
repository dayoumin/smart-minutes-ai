import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
}

export interface LayoutProps {
    children: React.ReactNode;
    activeTab?: string;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange, onSelectMeeting, onOpenSettings, analysisStatus }) => {
    return (
        <div className="flex h-screen min-w-[320px] flex-col bg-background text-foreground overflow-hidden lg:flex-row">
            <Sidebar activeTab={activeTab} onTabChange={onTabChange} onSelectMeeting={onSelectMeeting} />
            <div className="flex flex-col flex-1 min-w-0">
                <Header
                    onOpenSettings={onOpenSettings}
                    analysisStatus={analysisStatus}
                    onShowAnalysis={() => onTabChange?.('minutes')}
                />
                <main className="flex-1 overflow-auto bg-page p-4 custom-scrollbar sm:p-6">
                    {children}
                </main>
            </div>
        </div>
    );
};
