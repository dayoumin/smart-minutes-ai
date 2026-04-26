import React, { useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';
import { Settings } from './Settings';

export const App: React.FC = () => {
    // 기본 활성화 탭을 'minutes'(회의록 작성)로 설정
    const [activeTab, setActiveTab] = useState('minutes');

    return (
        <Layout activeTab={activeTab} onTabChange={setActiveTab}>
            {activeTab === 'minutes' && <MeetingWriter onOpenSettings={() => setActiveTab('settings')} />}
            {activeTab === 'history' && <MeetingHistory />}
            {activeTab === 'settings' && <Settings />}
        </Layout>
    );
};

export default App;
