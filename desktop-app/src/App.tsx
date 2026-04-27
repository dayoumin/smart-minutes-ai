import React, { useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';
import { Settings } from './Settings';

export const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState('minutes');
    const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    return (
        <>
            <Layout
                activeTab={activeTab}
                onTabChange={setActiveTab}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onSelectMeeting={(id) => {
                    setSelectedMeetingId(id);
                    setActiveTab('history');
                }}
            >
                {activeTab === 'minutes' && <MeetingWriter onOpenSettings={() => setIsSettingsOpen(true)} />}
                {activeTab === 'history' && (
                    <MeetingHistory
                        selectedMeetingId={selectedMeetingId}
                        onSelectedMeetingHandled={() => setSelectedMeetingId(null)}
                    />
                )}
            </Layout>
            {isSettingsOpen && <Settings onClose={() => setIsSettingsOpen(false)} />}
        </>
    );
};

export default App;
