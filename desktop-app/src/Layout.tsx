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
    transcriptReady?: boolean;
    etaSeconds?: number | null;
}

export interface LayoutProps {
    children: React.ReactNode;
    activeTab?: string;
    selectedMeetingId?: string | null;
    onTabChange?: (tab: string) => void;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string, fallbackId: string | null) => void;
    onSelectResumeDraft?: (jobId: string) => void;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    showAsrBenchmark?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, selectedMeetingId, onTabChange, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenSettings, analysisStatus, showAsrBenchmark }) => {
    return (
        <div className="barorok-app-frame flex min-w-[320px] flex-col text-foreground overflow-hidden">
            <Header />
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <Sidebar
                    activeTab={activeTab}
                    selectedMeetingId={selectedMeetingId}
                    onSelectMeeting={onSelectMeeting}
                    onCreateMeeting={onCreateMeeting}
                    onDeleteMeeting={onDeleteMeeting}
                    onSelectResumeDraft={onSelectResumeDraft}
                    onOpenSettings={onOpenSettings}
                    onOpenAsrBenchmark={showAsrBenchmark ? () => onTabChange?.('asr-benchmark') : undefined}
                    analysisStatus={analysisStatus}
                />
                <main className="barorok-workspace flex-1 overflow-auto p-4 custom-scrollbar sm:p-6">
                    {children}
                </main>
            </div>
        </div>
    );
};
