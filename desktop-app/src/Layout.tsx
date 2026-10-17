import React from 'react';
import { Sidebar } from './Sidebar';
import { AppView } from './appView';

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
    activeTab: AppView;
    selectedMeetingId?: string | null;
    onTabChange?: (tab: AppView) => void;
    onSelectMeeting?: (id: string) => void;
    onCreateMeeting?: () => void;
    onDeleteMeeting?: (id: string, fallbackId: string | null) => void;
    onSelectResumeDraft?: (jobId: string) => void;
    onOpenStart?: () => void;
    onOpenArchive?: () => void;
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
    resumeSelectionBlocked?: boolean;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    showAsrBenchmark?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, selectedMeetingId, onTabChange, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenStart, onOpenArchive, newMeetingBlocked, newMeetingBlockedReason, resumeSelectionBlocked, onOpenSettings, analysisStatus, showAsrBenchmark }) => {
    return (
        <div className="barorok-app-frame flex min-w-[320px] flex-col overflow-hidden text-foreground">
            <div className="barorok-shell-body flex min-h-0 flex-1 flex-row">
                <Sidebar
                    activeTab={activeTab}
                    selectedMeetingId={selectedMeetingId}
                    onSelectMeeting={onSelectMeeting}
                    onCreateMeeting={onCreateMeeting}
                    onDeleteMeeting={onDeleteMeeting}
                    onSelectResumeDraft={onSelectResumeDraft}
                    onOpenStart={onOpenStart}
                    onOpenArchive={onOpenArchive}
                    newMeetingBlocked={newMeetingBlocked}
                    newMeetingBlockedReason={newMeetingBlockedReason}
                    resumeSelectionBlocked={resumeSelectionBlocked}
                    onOpenSettings={onOpenSettings}
                    onOpenAsrBenchmark={showAsrBenchmark ? () => onTabChange?.('asr-benchmark') : undefined}
                    analysisStatus={analysisStatus}
                />
                <main className="barorok-workspace custom-scrollbar flex-1 overflow-auto p-4 sm:p-6 xl:p-8">
                    <div className="barorok-workspace-content">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
};
