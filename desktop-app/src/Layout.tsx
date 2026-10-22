import React, { useRef } from 'react';
import { Sidebar } from './Sidebar';
import { AppView } from './appView';
import { useSidebarCollapse } from './useSidebarCollapse';

interface AnalysisStatus {
    active: boolean;
    completionVisible?: boolean;
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
    onOpenAnalysis?: () => void;
    onOpenArchive?: () => void;
    newMeetingBlocked?: boolean;
    newMeetingBlockedReason?: string;
    resumeSelectionBlocked?: boolean;
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    showAsrBenchmark?: boolean;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, selectedMeetingId, onTabChange, onSelectMeeting, onCreateMeeting, onDeleteMeeting, onSelectResumeDraft, onOpenStart, onOpenAnalysis, onOpenArchive, newMeetingBlocked, newMeetingBlockedReason, resumeSelectionBlocked, onOpenSettings, analysisStatus, showAsrBenchmark }) => {
    const { mode, collapse, expand, close } = useSidebarCollapse();
    const slotRef = useRef<HTMLDivElement>(null);
    const closeOverlay = () => {
        if (mode !== 'overlay') return;
        close();
        window.requestAnimationFrame(() => slotRef.current?.querySelector<HTMLElement>('.sidebar-rail-expand')?.focus());
    };
    const navigate = <Args extends unknown[]>(action?: (...args: Args) => void) => action ? (...args: Args) => {
        close();
        action(...args);
    } : undefined;
    const openSettings = onOpenSettings ? () => {
        if (mode !== 'overlay') { onOpenSettings(); return; }
        close();
        // Settings remembers its opener. Let the stable rail button become that
        // opener after the temporary overlay has closed.
        window.requestAnimationFrame(() => {
            slotRef.current?.querySelector<HTMLElement>('.sidebar-rail-settings')?.focus();
            onOpenSettings();
        });
    } : undefined;
    return (
        <div className="barorok-app-frame flex min-w-[320px] flex-col overflow-hidden text-foreground">
            <div className="barorok-shell-body flex min-h-0 flex-1 flex-row">
                <div ref={slotRef} className={`barorok-sidebar-slot ${mode === 'expanded' ? 'sidebar-slot-expanded' : 'sidebar-slot-rail'}`}>
                {mode === 'overlay' && <div className="sidebar-rail-spacer" aria-hidden="true" />}
                <Sidebar
                    mode={mode}
                    onCollapse={mode === 'overlay' ? closeOverlay : collapse}
                    onExpand={expand}
                    onRequestClose={closeOverlay}
                    activeTab={activeTab}
                    selectedMeetingId={selectedMeetingId}
                    onSelectMeeting={navigate(onSelectMeeting)}
                    onCreateMeeting={navigate(onCreateMeeting)}
                    onDeleteMeeting={onDeleteMeeting}
                    onSelectResumeDraft={navigate(onSelectResumeDraft)}
                    onOpenStart={navigate(onOpenStart)}
                    onOpenAnalysis={navigate(onOpenAnalysis)}
                    onOpenArchive={navigate(onOpenArchive)}
                    newMeetingBlocked={newMeetingBlocked}
                    newMeetingBlockedReason={newMeetingBlockedReason}
                    resumeSelectionBlocked={resumeSelectionBlocked}
                    onOpenSettings={openSettings}
                    onOpenAsrBenchmark={showAsrBenchmark ? navigate(() => onTabChange?.('asr-benchmark')) : undefined}
                    analysisStatus={analysisStatus}
                />
                </div>
                {mode === 'overlay' && <button type="button" className="sidebar-scrim" aria-label="메뉴 닫기" tabIndex={-1} onClick={closeOverlay} />}
                <main inert={mode === 'overlay'} className="barorok-workspace custom-scrollbar min-w-0 flex-1 overflow-auto p-4 sm:p-6 xl:p-8">
                    <div className="barorok-workspace-content">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
};
