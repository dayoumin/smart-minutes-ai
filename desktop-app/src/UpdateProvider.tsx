import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, X } from 'lucide-react';
import { Button, IconButton, StatusBanner } from './components/common';
import { UpdateContext } from './UpdateContext';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';
import { isNewerEngineVersion } from './localEngineRelease';
import { getDistributionUrl } from './localEngineDistribution';
import { getRuntimeEnvironment, getTauriInvoke } from './runtimeEnvironment';
import { openExternalUrl } from './apiBase';
import { LOCAL_ENGINE_NAME, withJosa } from './brand';
import { localEngineClient } from './localEngineClient';
import { checkBackendUpdateActivity, type BackendUpdateActivity } from './updateActivity';
import {
    fetchDesktopRelease, isNewerDesktopRelease, parseDesktopReleaseIdentity,
    type DesktopRelease, type DesktopReleaseIdentity,
} from './desktopRelease';

interface Props {
    children: React.ReactNode;
    busy: boolean;
    /** Reads current event sources as well as rendered state at the moment of a click. */
    isBusy: () => boolean;
}

export const UpdateProvider: React.FC<Props> = ({ children, busy, isBusy }) => {
    const desktop = getRuntimeEnvironment().kind === 'tauri-desktop';
    const { snapshot, latestRelease } = useLocalEngineConnection();
    const [installed, setInstalled] = useState<DesktopReleaseIdentity | null>(null);
    const [release, setRelease] = useState<DesktopRelease | null>(null);
    const [checking, setChecking] = useState(false);
    const [checked, setChecked] = useState(false);
    const [open, setOpen] = useState(false);
    const [purpose, setPurpose] = useState<'install' | 'update'>('update');
    const [message, setMessage] = useState('');
    const [downloadStarted, setDownloadStarted] = useState(false);
    const [activity, setActivity] = useState<BackendUpdateActivity>({ busy: false, verified: false });
    const [activityChecking, setActivityChecking] = useState(false);
    const [manuallyChecked, setManuallyChecked] = useState(false);
    const [requestingDownload, setRequestingDownload] = useState(false);
    const latestBusyRef = useRef(isBusy);
    useLayoutEffect(() => { latestBusyRef.current = isBusy; }, [isBusy]);
    const manualCheckRef = useRef(manuallyChecked);
    useLayoutEffect(() => { manualCheckRef.current = manuallyChecked; }, [manuallyChecked]);
    const downloadRequestRef = useRef<AbortController | null>(null);
    const guideEpochRef = useRef(0);
    const dialogRef = useRef<HTMLDivElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const requestRef = useRef<AbortController | null>(null);
    const lastCheckRef = useRef(0);

    const checkDesktop = useCallback(async (force = false) => {
        if (!desktop || (!force && Date.now() - lastCheckRef.current < 60_000)) return;
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        lastCheckRef.current = Date.now();
        setChecking(true);
        try {
            const identity = parseDesktopReleaseIdentity(await getTauriInvoke()?.('get_desktop_release_identity'));
            const latest = await fetchDesktopRelease(controller.signal);
            if (controller.signal.aborted) return;
            setInstalled(identity);
            setRelease(latest);
            setChecked(true);
        } catch {
            if (!controller.signal.aborted) setChecked(true);
        } finally {
            if (!controller.signal.aborted) setChecking(false);
        }
    }, [desktop]);

    useEffect(() => {
        void checkDesktop();
        const focus = () => { void checkDesktop(); };
        window.addEventListener('focus', focus);
        return () => {
            requestRef.current?.abort();
            downloadRequestRef.current?.abort();
            downloadRequestRef.current = null;
            guideEpochRef.current += 1;
            window.removeEventListener('focus', focus);
        };
    }, [checkDesktop]);

    const available = desktop
        ? Boolean(release && installed && isNewerDesktopRelease(release, installed))
        : Boolean(snapshot.updateRequired || (latestRelease && snapshot.engineVersion
            && isNewerEngineVersion(latestRelease.version, snapshot.engineVersion)));
    const openGuide = useCallback((nextPurpose: 'install' | 'update' = 'update') => {
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPurpose(nextPurpose);
        setDownloadStarted(false);
        guideEpochRef.current += 1;
        manualCheckRef.current = false;
        setManuallyChecked(false);
        setActivity({ busy: false, verified: false });
        setMessage('');
        setOpen(true);
        if (desktop) void checkDesktop();
    }, [checkDesktop, desktop]);
    const close = useCallback(() => {
        guideEpochRef.current += 1;
        downloadRequestRef.current?.abort();
        downloadRequestRef.current = null;
        setRequestingDownload(false);
        setOpen(false);
        window.requestAnimationFrame(() => {
            if (openerRef.current?.isConnected) openerRef.current.focus();
            else document.querySelector<HTMLElement>('[data-update-entry]')?.focus();
        });
    }, []);

    useEffect(() => {
        if (!open) return;
        dialogRef.current?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key !== 'Tab') return;
            const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ?? [])];
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
                event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
                event.preventDefault(); first?.focus();
            }
        };
        document.addEventListener('keydown', keydown, true);
        return () => document.removeEventListener('keydown', keydown, true);
    }, [close, open]);

    useEffect(() => {
        if (!open) return;
        // An authorization change invalidates the old check and its download consent.
        // Start unknown again; otherwise an aborted check can leave the button locked.
        guideEpochRef.current += 1;
        downloadRequestRef.current?.abort();
        downloadRequestRef.current = null;
        manualCheckRef.current = false;
        setManuallyChecked(false);
        setRequestingDownload(false);
        setActivityChecking(false);
        setActivity({ busy: false, verified: false });
        setMessage('');
        // Showing recovery guidance must not initiate a loopback permission prompt.
        if (!desktop && snapshot.authorization !== 'authenticated') return;
        const controller = new AbortController();
        const check = async () => {
            setActivityChecking(true);
            const result = await checkBackendUpdateActivity(localEngineClient, controller.signal);
            if (!controller.signal.aborted) {
                setActivity(result);
                if (result.busy) { manualCheckRef.current = false; setManuallyChecked(false); }
                setActivityChecking(false);
            }
        };
        void check();
        const timer = window.setInterval(() => void check(), 15_000);
        return () => { controller.abort(); window.clearInterval(timer); };
    }, [desktop, open, snapshot.authorization]);

    useEffect(() => {
        if (busy) { manualCheckRef.current = false; setManuallyChecked(false); }
    }, [busy]);

    const installerUrl = latestRelease?.downloadUrl
        ?? getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_INSTALLER_URL);
    const engineUpdateUrl = latestRelease?.downloadUrl
        ?? getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_UPDATE_URL);
    const downloadUrl = desktop ? (available ? release?.downloadUrl : undefined)
        : purpose === 'install' ? installerUrl : available ? engineUpdateUrl : undefined;
    const blocked = busy || activity.busy;

    const download = async () => {
        if (latestBusyRef.current() || blocked) {
            setMessage('진행 중인 작업이 끝난 뒤 다시 눌러 주세요.');
            return;
        }
        if (!downloadUrl || downloadStarted || downloadRequestRef.current) return;
        const controller = new AbortController();
        downloadRequestRef.current = controller;
        const epoch = guideEpochRef.current;
        setRequestingDownload(true);
        try {
            const result = desktop || snapshot.authorization === 'authenticated'
                ? await checkBackendUpdateActivity(localEngineClient, controller.signal)
                : { busy: false, verified: false };
            if (epoch !== guideEpochRef.current || controller.signal.aborted) return;
            setActivity(result);
            if (latestBusyRef.current() || result.busy) {
                manualCheckRef.current = false;
                setManuallyChecked(false);
                setMessage('진행 중인 작업이 있습니다. 작업이 끝난 뒤 다시 눌러 주세요.');
                return;
            }
            if (!result.verified && !manualCheckRef.current) {
                setMessage('이 버전에서는 작업 상태를 확인하지 못했습니다. 다른 창에서도 작업 중이 아닌지 확인해 주세요.');
                return;
            }
            // The only navigation to the artifact is this explicit user action.
            if (desktop) await openExternalUrl(downloadUrl);
            else {
                // Attachment errors must never replace a tab containing an unsaved meeting.
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = '';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                document.body.append(link);
                link.click();
                link.remove();
            }
            if (epoch !== guideEpochRef.current) return;
            setDownloadStarted(true);
            setMessage(desktop
                ? '브라우저에서 다운로드를 요청했습니다. 다운로드가 끝나면 앱을 종료하고 아래 순서로 적용해 주세요.'
                : '설치 파일 다운로드를 요청했습니다. 다운로드가 끝나면 아래 순서로 설치해 주세요.');
        } catch {
            if (epoch === guideEpochRef.current) setMessage('다운로드를 열지 못했습니다. 잠시 후 다시 눌러 주세요.');
        } finally {
            if (downloadRequestRef.current === controller) {
                downloadRequestRef.current = null;
                setRequestingDownload(false);
            }
        }
    };

    const title = desktop ? '데스크톱 앱 업데이트' : purpose === 'install' ? `${LOCAL_ENGINE_NAME} 설치` : `${LOCAL_ENGINE_NAME} 업데이트`;
    return <UpdateContext.Provider value={{ available, openGuide }}>
        <div className="contents" inert={open || undefined}>{children}</div>
        {open && createPortal(<div className="local-engine-pairing-backdrop" onMouseDown={event => {
            if (event.target === event.currentTarget) close();
        }}>
            <div ref={dialogRef} className="local-engine-pairing-dialog max-h-[85vh] overflow-y-auto" role="dialog" aria-modal="true"
                aria-labelledby="update-guide-title" aria-describedby="update-guide-description" tabIndex={-1}>
                <div className="local-engine-pairing-header">
                    <h3 id="update-guide-title">{title}</h3>
                    <IconButton aria-label="업데이트 안내 닫기" icon={<X size={18} />} onClick={close} />
                </div>
                <div className="mt-4 space-y-3 text-sm leading-6">
                    <p id="update-guide-description">다운로드 버튼을 눌러야 파일을 받습니다. 설치나 앱 재시작은 자동으로 진행하지 않습니다.</p>
                    {desktop ? <>
                        {available && installed && release ? <p>설치본: {new Date(installed.generatedAt).toLocaleString('ko-KR')}<br />새 버전: {new Date(release.generatedAt).toLocaleString('ko-KR')}</p>
                            : <p>{checking ? '새 버전을 확인하고 있습니다.' : !installed && checked
                                ? '이 실행 파일의 빌드 정보를 확인할 수 없습니다. 자동으로 업데이트 파일을 선택하지 않습니다.'
                                : !release && checked ? '지금은 공개된 업데이트 정보를 확인할 수 없습니다. 현재 앱은 계속 사용할 수 있습니다.'
                                : '새로 받을 업데이트가 없습니다.'}</p>}
                        <ol className="list-decimal space-y-1 pl-5">
                            <li>업데이트 패키지(ZIP)를 받고 별도 폴더에 압축을 풉니다.</li>
                            <li>작업을 저장하고 이 PC의 모든 LMO 회의록 창을 종료합니다.</li>
                            <li>패키지의 안내에 따라 기존 설치 폴더에 적용한 뒤 다시 실행합니다.</li>
                        </ol>
                        <p>기존 회의록·설정·모델을 유지하는 업데이트 패키지를 사용합니다. 다른 PC에서 처음 시작할 때는 신규 설치 패키지가 필요합니다.</p>
                    </> : <>
                        {purpose === 'update' && <p>{snapshot.updateRequired
                            ? '새 분석을 시작하려면 업데이트가 필요합니다.'
                            : available ? '새 버전이 있습니다. 현재 작업을 마친 뒤 업데이트할 수 있습니다.'
                            : '새 업데이트가 확인되지 않았습니다. 웹 화면은 작업을 마친 뒤 직접 새로고침하면 최신 버전으로 열립니다.'}</p>}
                        {latestRelease && <p>설치 파일 버전: {latestRelease.version}</p>}
                        <ol className="list-decimal space-y-1 pl-5">
                            <li>설치 파일을 다운로드합니다.</li>
                            <li>다른 창의 작업까지 저장하고 이 PC의 모든 {LOCAL_ENGINE_NAME} 창을 종료한 뒤 설치 파일을 실행합니다.</li>
                            <li>설치가 끝나면 {withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 켜고 웹으로 돌아옵니다.</li>
                        </ol>
                        <p>기존 회의록·설정·모델은 유지합니다. 웹 화면은 자동으로 새로고침하지 않습니다.</p>
                        {import.meta.env.VITE_LOCAL_ENGINE_TEST_RELEASE === 'true' && <p>테스트 설치 파일이라 Windows 보안 경고가 나올 수 있습니다.</p>}
                    </>}
                    {blocked && <StatusBanner tone="warning" heading="작업이 끝난 뒤 다운로드할 수 있습니다">
                        분석·요약·모델 준비 등 진행 중인 작업이 끝나면 받을 수 있습니다. 작업이 끝나도 자동으로 다운로드하지 않습니다.
                    </StatusBanner>}
                    {downloadUrl && !blocked && !activity.verified && !activityChecking && <StatusBanner tone="warning" heading="작업 상태를 자동으로 확인할 수 없습니다">
                        <p>{purpose === 'install' && !snapshot.engineVersion
                            ? '연결하기 전에는 다른 창의 작업 상태를 확인할 수 없습니다. 이미 사용 중인 앱이 있다면 작업을 마친 뒤 설치해 주세요.'
                            : '이전 버전이거나 연결이 끊겼을 수 있습니다. 다른 창의 분석·요약·모델 다운로드도 끝났는지 확인해 주세요.'}</p>
                        <label className="mt-2 flex items-start gap-2">
                            <input type="checkbox" className="mt-1" checked={manuallyChecked}
                                disabled={requestingDownload}
                                onChange={event => { manualCheckRef.current = event.target.checked; setManuallyChecked(event.target.checked); }} />
                            이 PC의 모든 작업이 끝났고 작성 중인 내용을 저장했습니다.
                        </label>
                    </StatusBanner>}
                    {message && <p role="status">{message}</p>}
                    {!downloadUrl && !checking && <p>받을 파일이 확인되면 다운로드 버튼이 활성화됩니다.</p>}
                </div>
                <div className="local-engine-pairing-actions flex-wrap">
                    {desktop && <Button variant="ghost" disabled={checking} onClick={() => void checkDesktop(true)}><RefreshCw size={15} />다시 확인</Button>}
                    <Button variant="outline" onClick={close}>나중에</Button>
                    <Button disabled={blocked || !downloadUrl || downloadStarted || checking || activityChecking || requestingDownload
                        || (!activity.verified && !manuallyChecked)} onClick={() => void download()}>
                        <Download size={15} />{requestingDownload ? '작업 상태 확인 중' : downloadStarted ? '다운로드 요청됨' : desktop ? '업데이트 패키지 받기' : '설치 파일 받기'}
                    </Button>
                </div>
            </div>
        </div>, document.body)}
    </UpdateContext.Provider>;
};
