import React, { useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';
import { Settings } from './Settings';

export const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState('minutes');
    const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

    return (
        <Layout
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onSelectMeeting={(id) => {
                setSelectedMeetingId(id);
                setActiveTab('history');
            }}
        >
            {activeTab === 'minutes' && <MeetingWriter onOpenSettings={() => setActiveTab('settings')} />}
            {activeTab === 'history' && (
                <MeetingHistory
                    selectedMeetingId={selectedMeetingId}
                    onSelectedMeetingHandled={() => setSelectedMeetingId(null)}
                />
            )}
            {activeTab === 'settings' && <Settings />}
        </Layout>
    );
};

export default App;
