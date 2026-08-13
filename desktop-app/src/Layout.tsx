import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { OceanBackdrop } from './OceanBackdrop';
import { AppView, getAppShellVariant } from './appView';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
    rawMessage?: string;
    startedAt?: number | null;
    stalled?: boolean;
    transcriptReady?: boolean;
    etaSeconds?: number | null;
    surfaceTone?: 'immersive' | 'calm';
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
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
    resumeSelectionBlocked?: boolean;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    showAsrBenchmark?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, selectedMeetingId, onTabChange, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenStart, newMeetingBlocked, newMeetingBlockedReason, resumeSelectionBlocked, onOpenSettings, analysisStatus, showAsrBenchmark }) => {
    const shellVariant = getAppShellVariant(activeTab);
    const oceanShellActive = shellVariant === 'ocean';
    return (
        <div className={`barorok-app-frame flex min-w-[320px] flex-col overflow-hidden text-foreground ${oceanShellActive ? 'barorok-app-frame-minutes' : ''}`} data-shell-variant={shellVariant}>
            {!oceanShellActive && <Header />}
            <div className="barorok-shell-body flex min-h-0 flex-1 flex-row">
                <Sidebar
                    activeTab={activeTab}
                    selectedMeetingId={selectedMeetingId}
                    onSelectMeeting={onSelectMeeting}
                    onCreateMeeting={onCreateMeeting}
                    onDeleteMeeting={onDeleteMeeting}
                    onSelectResumeDraft={onSelectResumeDraft}
                    onOpenStart={onOpenStart}
                    newMeetingBlocked={newMeetingBlocked}
                    newMeetingBlockedReason={newMeetingBlockedReason}
                    resumeSelectionBlocked={resumeSelectionBlocked}
                    onOpenSettings={onOpenSettings}
                    onOpenAsrBenchmark={showAsrBenchmark ? () => onTabChange?.('asr-benchmark') : undefined}
                    analysisStatus={analysisStatus}
                />
                <main className={`barorok-workspace custom-scrollbar flex-1 ${oceanShellActive ? 'barorok-workspace-minutes' : 'overflow-auto p-4 sm:p-6 xl:p-8'}`}>
                    {oceanShellActive && <OceanBackdrop tone={analysisStatus?.surfaceTone ?? (analysisStatus?.active ? 'calm' : 'immersive')} />}
                    <div className="barorok-workspace-content">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
};
