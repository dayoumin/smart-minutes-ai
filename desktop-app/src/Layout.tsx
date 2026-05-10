import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
    rawMessage?: string;
    startedAt?: number | null;
    stalled?: boolean;
}

export interface LayoutProps {
    children: React.ReactNode;
    activeTab?: string;
    selectedMeetingId?: string | null;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string) => void;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    showAsrBenchmark?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, selectedMeetingId, onTabChange, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onOpenSettings, analysisStatus, showAsrBenchmark }) => {
    return (
        <div className="flex h-screen min-w-[320px] flex-col bg-background text-foreground overflow-hidden">
            <Header
                onOpenSettings={onOpenSettings}
            />
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <Sidebar
                    activeTab={activeTab}
                    selectedMeetingId={selectedMeetingId}
                    onSelectMeeting={onSelectMeeting}
                    onCreateMeeting={onCreateMeeting}
                    onDeleteMeeting={onDeleteMeeting}
                    onOpenAsrBenchmark={showAsrBenchmark ? () => onTabChange?.('asr-benchmark') : undefined}
                    analysisStatus={analysisStatus}
                />
                <main className="flex-1 overflow-auto bg-page p-4 custom-scrollbar sm:p-6">
                    {children}
                </main>
            </div>
        </div>
    );
};
