import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, MonitorDown, X } from 'lucide-react';
import { Button, IconButton, StatusBanner } from './components/common';
import { fetchDesktopInstallRelease, type DesktopInstallLookup } from './desktopRelease';

const InstallGuide: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [lookup, setLookup] = useState<DesktopInstallLookup | { status: 'loading' }>({ status: 'loading' });
    const [retry, setRetry] = useState(0);
    const [requested, setRequested] = useState(false);

    useEffect(() => {
        const dialog = dialogRef.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void fetchDesktopInstallRelease(controller.signal).then(result => {
            if (!controller.signal.aborted) setLookup(result);
        });
        return () => controller.abort();
    }, [retry]);

    const download = () => {
        if (lookup.status !== 'available' || requested) return;
        const link = document.createElement('a');
        link.href = lookup.release.downloadUrl;
        link.download = '';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.append(link);
        link.click();
        link.remove();
        setRequested(true);
    };

    return createPortal(<dialog ref={dialogRef} className="desktop-install-dialog local-engine-pairing-dialog"
        aria-labelledby="desktop-install-title" aria-describedby="desktop-install-description"
        onCancel={event => { event.preventDefault(); onClose(); }}
        onKeyDown={event => {
            // A background custom modal must not intercept native dialog navigation.
            if (event.key === 'Tab' || event.key === 'Escape') event.stopPropagation();
        }}>
        <div className="local-engine-pairing-header">
            <h3 id="desktop-install-title">데스크톱 앱 받기</h3>
            <IconButton aria-label="데스크톱 앱 안내 닫기" variant="ghost" icon={<X size={18} />} onClick={onClose} />
        </div>
        <div className="desktop-install-content text-sm leading-6">
            <p id="desktop-install-description">Windows에서 브라우저를 열지 않고 회의록을 작성할 수 있습니다.</p>
            <ol className="list-decimal space-y-3 pl-5">
                <li>받은 ZIP 파일을 원하는 폴더에 <strong>모두 압축 풀기</strong> 합니다.</li>
                <li>폴더 안의 <strong>lmo_audio.exe</strong>를 실행합니다.</li>
                <li>앱 안내에 따라 처음 한 번 <strong>분석·요약에 필요한 모델</strong>을 받습니다. 모델 준비에는 인터넷과 추가 저장 공간이 필요합니다.</li>
            </ol>
            <div className="desktop-install-notes text-muted-foreground">
                <p>웹에서 작성한 회의록은 데스크톱 앱으로 자동으로 옮겨지지 않습니다.</p>
                <p>새 폴더에서 시작하는 신규 설치 패키지입니다. 기존 데스크톱 앱은 앱의 업데이트 안내를 이용해 주세요.</p>
            </div>
            {lookup.status === 'unpublished' && <StatusBanner tone="info" heading="아직 다운로드가 공개되지 않았습니다">
                현재 웹은 계속 사용할 수 있습니다. 잠시 후 다시 확인해 주세요.
            </StatusBanner>}
            {lookup.status === 'error' && <StatusBanner tone="warning" heading="다운로드 정보를 확인하지 못했습니다">
                인터넷 연결을 확인한 뒤 다시 시도해 주세요.
            </StatusBanner>}
        </div>
        <p role="status" className="desktop-install-download-state text-sm text-muted-foreground">
            {lookup.status === 'loading' ? '다운로드 정보를 확인하고 있습니다.'
                : requested ? '브라우저에 다운로드를 요청했습니다. 받은 파일을 직접 실행해 주세요.'
                    : lookup.status === 'available' ? `Windows용 ZIP · ${Math.ceil(lookup.release.bytes / 1_000_000)} MB · 자동으로 설치하지 않습니다.` : ''}
        </p>
        <div className="local-engine-pairing-actions flex-wrap">
            <Button variant="outline" onClick={onClose}>닫기</Button>
            {(lookup.status === 'error' || lookup.status === 'unpublished')
                ? <Button onClick={() => { setLookup({ status: 'loading' }); setRetry(n => n + 1); }}>다시 확인</Button>
                : <Button disabled={lookup.status !== 'available' || requested} onClick={download}>
                    {lookup.status === 'loading' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                    {requested ? '다운로드 요청됨' : 'Windows용 ZIP 받기'}
                </Button>}
        </div>
    </dialog>, document.body);
};

/** Web-only entry; never starts an archive request until the receive button is clicked. */
export const DesktopInstallDownload: React.FC = () => {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const close = () => {
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    return <>
        <Button ref={triggerRef} variant="outline" className="shrink-0 text-sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
            <MonitorDown size={16} aria-hidden="true" />데스크톱 앱 받기
        </Button>
        {open && <InstallGuide onClose={close} />}
    </>;
};
