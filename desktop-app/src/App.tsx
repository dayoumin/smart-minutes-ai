import React, { useEffect, useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';
import { Settings } from './Settings';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
}

export const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState('minutes');
    const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({
        active: false,
        progress: 0,
        message: '',
    });

    useEffect(() => {
        const handleAnalysisStatus = (event: Event) => {
            const detail = (event as CustomEvent<AnalysisStatus>).detail;
            if (!detail) return;
            setAnalysisStatus({
                active: detail.active,
                progress: Math.min(100, Math.max(0, detail.progress || 0)),
                message: detail.message || '',
            });
        };

        window.addEventListener('analysis:status', handleAnalysisStatus);
        return () => window.removeEventListener('analysis:status', handleAnalysisStatus);
    }, []);

    return (
        <>
            <Layout
                activeTab={activeTab}
                onTabChange={setActiveTab}
                onOpenSettings={() => setIsSettingsOpen(true)}
                analysisStatus={analysisStatus}
                onSelectMeeting={(id) => {
                    setSelectedMeetingId(id);
                    setActiveTab('history');
                }}
            >
                {analysisStatus.active && activeTab !== 'minutes' && (
                    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 shadow-sm">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <div className="font-semibold">회의록을 분석하고 있습니다.</div>
                                <div className="mt-0.5 text-xs text-blue-700">
                                    {analysisStatus.message || `분석 진행 중... (${analysisStatus.progress}%)`}
                                </div>
                            </div>
                            <button
                                type="button"
                                className="h-8 rounded-md border border-blue-200 bg-white px-3 text-xs font-medium text-blue-700 shadow-sm transition-colors hover:bg-blue-100"
                                onClick={() => setActiveTab('minutes')}
                            >
                                진행 화면 보기
                            </button>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
                            <div
                                className="h-full rounded-full bg-blue-600 transition-all duration-300"
                                style={{ width: `${analysisStatus.progress}%` }}
                            />
                        </div>
                    </div>
                )}
                <div className={activeTab === 'minutes' ? 'contents' : 'hidden'}>
                    <MeetingWriter onOpenSettings={() => setIsSettingsOpen(true)} />
                </div>
                <div className={activeTab === 'history' ? 'contents' : 'hidden'}>
                    <MeetingHistory
                        selectedMeetingId={selectedMeetingId}
                        onSelectedMeetingHandled={() => setSelectedMeetingId(null)}
                        onCreateMeeting={() => setActiveTab('minutes')}
                    />
                </div>
            </Layout>
            {isSettingsOpen && <Settings onClose={() => setIsSettingsOpen(false)} />}
        </>
    );
};

export default App;
