import React, { useState } from 'react';
import { Layout } from './Layout';
import { MeetingWriter } from './MeetingWriter';
import { MeetingHistory } from './MeetingHistory';

export const App: React.FC = () => {
    // 기본 활성화 탭을 'minutes'(회의록 작성)로 설정
    const [activeTab, setActiveTab] = useState('minutes');

    return (
        <Layout activeTab={activeTab} onTabChange={setActiveTab}>
            {activeTab === 'minutes' && <MeetingWriter />}
            {activeTab === 'history' && <MeetingHistory />}
            {activeTab === 'settings' && (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    시스템 설정 화면은 준비 중입니다.
                </div>
            )}
        </Layout>
    );
};

export default App;