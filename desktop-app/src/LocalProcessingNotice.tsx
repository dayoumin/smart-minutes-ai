import React, { useCallback, useEffect, useRef } from 'react';
import { Globe, HardDrive, Laptop, ShieldCheck, Trash2 } from 'lucide-react';
import { LOCAL_ENGINE_NAME } from './brand';
import { Button } from './components/common';
import { markLocalProcessingIntroSeen } from './localProcessingIntro';
import type { RuntimeKind } from './runtimeEnvironment';

export type LocalProcessingNoticeMode = 'intro' | 'help';

interface LocalProcessingNoticeProps {
    /** Both modes show the full notice; only `intro` includes first-use preparation. */
    mode: LocalProcessingNoticeMode;
    runtime: RuntimeKind;
    /** Setting-aware storage sentence, so the help never promises a retention the engine does not apply. */
    storageMessage: string;
    onClose: () => void;
}

export const LocalProcessingNotice: React.FC<LocalProcessingNoticeProps> = ({
    mode,
    runtime,
    storageMessage,
    onClose,
}) => {
    const dialogRef = useRef<HTMLDivElement>(null);
    const primaryRef = useRef<HTMLButtonElement>(null);
    // Any way of closing the intro (button, Escape, backdrop) counts as having read it.
    const close = useCallback(() => {
        if (mode === 'intro') markLocalProcessingIntroSeen();
        onClose();
    }, [mode, onClose]);
    const closeRef = useRef(close);
    useEffect(() => {
        closeRef.current = close;
    }, [close]);
    const isWeb = runtime === 'web-local-engine';

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const focusTimer = window.setTimeout(() => primaryRef.current?.focus(), 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            const dialog = dialogRef.current;
            // A dialog opened above this one (the pairing code dialog) owns Escape and Tab while it has focus.
            if (event.defaultPrevented || !dialog) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('[aria-modal="true"]') && !dialog.contains(target)) return;
            // Without focus in either dialog, the one opened later (later in the page) is on top.
            const modals = document.querySelectorAll('[aria-modal="true"]');
            if (modals[modals.length - 1] !== dialog) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeRef.current();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...dialog.querySelectorAll<HTMLElement>(
                'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            )];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!dialog.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', handleKeyDown);
            window.setTimeout(() => previousFocus?.isConnected && previousFocus.focus(), 0);
        };
    }, []);

    return (
        <div
            className="local-processing-backdrop"
            onMouseDown={event => {
                if (event.target === event.currentTarget) close();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="local-processing-title"
                aria-describedby="local-processing-summary"
                className="local-processing-dialog"
            >
                <div className="local-processing-content" role="region" aria-label="처리 방식 안내 내용" tabIndex={0}>
                    <div className="local-processing-header">
                        <span className="icon-badge" aria-hidden="true">
                            <ShieldCheck size={20} />
                        </span>
                        <h2 id="local-processing-title">회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다</h2>
                    </div>
                    <p id="local-processing-summary" className="local-processing-summary">
                        외부 AI 서버 없이 이 PC에서 분석하고 요약합니다.
                    </p>
                    {isWeb && mode === 'intro' && (
                        <section className="local-processing-setup" aria-labelledby="local-processing-setup-title">
                            <h3 id="local-processing-setup-title">처음 한 번 준비해 주세요</h3>
                            <p>‘{LOCAL_ENGINE_NAME}’ 설치와 분석에 필요한 파일 받기는 다음 화면에서 진행합니다.</p>
                        </section>
                    )}
                    <dl id="local-processing-details" className="local-processing-details">
                        <div>
                            <dt><Laptop size={15} aria-hidden="true" />처리</dt>
                            <dd>음성 인식, 참석자 구분, 요약까지 모두 이 PC에서 합니다.</dd>
                        </div>
                        <div>
                            <dt><Globe size={15} aria-hidden="true" />인터넷</dt>
                            <dd>
                                {isWeb
                                    ? `웹사이트 접속과 ${LOCAL_ENGINE_NAME}·모델 받기에만 씁니다.`
                                    : '프로그램·모델 받기에만 씁니다.'}
                            </dd>
                        </div>
                        <div>
                            <dt><HardDrive size={15} aria-hidden="true" />보관</dt>
                            <dd>{storageMessage}</dd>
                        </div>
                        <div>
                            <dt><Trash2 size={15} aria-hidden="true" />삭제</dt>
                            <dd>회의록을 지우면 분석 결과도 지웁니다. 연결이 꺼져 있으면 다음 연결 때 지웁니다. 따로 저장한 파일은 직접 지워 주세요.</dd>
                        </div>
                    </dl>
                </div>
                <div className="local-processing-actions">
                    <Button ref={primaryRef} onClick={close}>
                        {mode === 'intro' ? '시작하기' : '확인'}
                    </Button>
                </div>
            </div>
        </div>
    );
};
