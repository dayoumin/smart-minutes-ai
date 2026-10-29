import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalEngineConnectionContext } from '../../src/LocalEngineConnectionContext';
import type { LocalEngineConnectionContextValue } from '../../src/LocalEngineConnectionContext';
import { UpdateProvider } from '../../src/UpdateProvider';
import { UpdateEntry } from '../../src/UpdateEntry';
import { WriterActionRow } from '../../src/WriterActionRow';
import { createInitialLocalEngineConnection } from '../../src/localEngineConnection';
import type { LocalEngineAuthorizationState } from '../../src/localEngineConnection';
import { getRuntimeEnvironment } from '../../src/runtimeEnvironment';
import '../../src/index.css';

export const Harness = () => {
    const [busy, setBusy] = useState(false);
    const [required, setRequired] = useState(false);
    const [authorization, setAuthorization] = useState<LocalEngineAuthorizationState>('authenticated');
    const [engineVersion, setEngineVersion] = useState<string | undefined>('0.1.8-beta-20261018');
    Object.assign(window, { setUpdateBusy: setBusy, setUpdateRequired: setRequired, setUpdateAuthorization: setAuthorization,
        setUpdateEngineVersion: setEngineVersion });
    const context = {
        snapshot: {
            ...createInitialLocalEngineConnection(getRuntimeEnvironment().kind),
            transport: 'reachable', authorization, engineVersion,
            capabilities: new Set(['analysis']), updateRequired: required,
        },
        latestRelease: { version: '0.1.12-beta-20261026', downloadUrl: `${location.origin}/downloads/engine-test.exe` },
    } as LocalEngineConnectionContextValue;
    return <LocalEngineConnectionContext.Provider value={context}>
        <UpdateProvider busy={busy} isBusy={() => busy}>
            <aside className="w-52"><UpdateEntry /></aside>
            <input aria-label="작성 중인 내용" defaultValue="저장 전 내용 유지" />
            <WriterActionRow row={{ actions: [{ kind: 'download', label: '설치 파일' }], stage: 'connection', state: 'intro', tone: 'info', busy: false, title: '설치', message: '', help: null, blocksStart: true }}
                {...{ showHelp: false, onToggleHelp: () => undefined }}
                statusRef={{ current: null }} onAction={() => undefined}
                installerUrl={`${location.origin}/downloads/engine-test.exe`}><button>분석 시작</button></WriterActionRow>
        </UpdateProvider>
    </LocalEngineConnectionContext.Provider>;
};

createRoot(document.getElementById('root')!).render(<Harness />);
