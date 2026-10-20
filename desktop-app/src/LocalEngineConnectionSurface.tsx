import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    CheckCircle2,
    CircleHelp,
    Download,
    Link2,
    Loader2,
    RefreshCw,
    ShieldCheck,
    X,
} from 'lucide-react';
import { LOCAL_ENGINE_NAME, withJosa } from './brand';
import { Button, IconButton, Input } from './components/common';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';
import type { LocalEngineProbePayload } from './localEngineConnection';
import { getDistributionUrl } from './localEngineDistribution';
import {
    getLocalEngineConnectionView,
    LocalEngineConnectionAction,
} from './localEngineConnectionView';

interface LocalEngineConnectionSurfaceProps {
    installerUrl?: string;
    updateUrl?: string;
    /** Connected but not ready to analyze (e.g. a required model is missing); the title must not say 분석 준비 완료. */
    analysisPrerequisitesMissing?: boolean;
    /** The writer already started a recovery probe from its compact action row. */
    connectionRequested?: boolean;
    onProbeCompleted?: (probe: LocalEngineProbePayload) => Promise<void>;
}

const PAIRING_CODE_PATTERN = /^\d{6,8}$/;
// A refused loopback request fails within milliseconds; without a floor the retry
// flips straight back to the same message and looks like the button did nothing.
const MIN_MANUAL_CHECK_MS = 700;

const SceneIcon: React.FC<{ scene: string; busy: boolean }> = ({ scene, busy }) => {
    if (busy) return <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
    if (scene === 'connected') return <CheckCircle2 size={18} aria-hidden="true" />;
    if (scene === 'intro' || scene === 'pairing-required') return <ShieldCheck size={18} aria-hidden="true" />;
    return <AlertTriangle size={18} aria-hidden="true" />;
};

export const LocalEngineConnectionSurface: React.FC<LocalEngineConnectionSurfaceProps> = ({
    installerUrl = getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_INSTALLER_URL),
    updateUrl = getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_UPDATE_URL),
    analysisPrerequisitesMissing = false,
    connectionRequested = false,
    onProbeCompleted,
}) => {
    const {
        snapshot,
        pairingState,
        probeLocalEngine,
        startPairing,
        completePairing,
        resetPairing,
    } = useLocalEngineConnection();
    const [connectionStarted, setConnectionStarted] = useState(false);
    const [manualCheckPending, setManualCheckPending] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [isCodeDialogOpen, setIsCodeDialogOpen] = useState(false);
    const [pairingCode, setPairingCode] = useState('');
    const [pairingError, setPairingError] = useState('');
    const codeInputRef = useRef<HTMLInputElement>(null);
    const codeTriggerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const statusRef = useRef<HTMLDivElement>(null);

    const view = useMemo(() => getLocalEngineConnectionView({
        snapshot: manualCheckPending && ['unreachable', 'error', 'checking'].includes(snapshot.transport)
            ? { ...snapshot, transport: 'checking', blockedBy: undefined }
            : snapshot,
        pairingPhase: pairingState.phase,
        connectionStarted: connectionStarted || connectionRequested,
        installerAvailable: Boolean(installerUrl),
        updateAvailable: Boolean(updateUrl),
        analysisPrerequisitesMissing,
        // The cause survives the 'checking' state, so it tells whether the prompt may be up now.
        permissionPromptPending: manualCheckPending && snapshot.blockedBy === 'permission-prompt',
    }), [analysisPrerequisitesMissing, connectionRequested, connectionStarted, installerUrl, manualCheckPending, pairingState.phase, snapshot, updateUrl]);

    useEffect(() => {
        if (pairingState.phase !== 'awaiting-code') return;
        setIsCodeDialogOpen(true);
    }, [pairingState.phase]);

    useEffect(() => {
        if (view.scene !== 'checking') return;
        statusRef.current?.focus({ preventScroll: true });
    }, [view.scene]);

    const closeCodeDialog = useCallback(() => {
        if (pairingState.phase === 'completing') return;
        setIsCodeDialogOpen(false);
        setPairingCode('');
        setPairingError('');
    }, [pairingState.phase]);

    useEffect(() => {
        if (pairingState.phase !== 'awaiting-code' || !pairingState.challenge) return;
        const timeout = window.setTimeout(() => {
            resetPairing('연결 코드가 만료되었습니다. 새 코드를 받아 다시 연결해 주세요.');
            closeCodeDialog();
        }, pairingState.challenge.expires_in_seconds * 1000);
        return () => window.clearTimeout(timeout);
    }, [closeCodeDialog, pairingState.challenge, pairingState.phase, resetPairing]);

    useEffect(() => {
        if (!isCodeDialogOpen) return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const codeTrigger = codeTriggerRef.current;
        const focusTimer = window.setTimeout(() => {
            if (pairingState.phase === 'completing') {
                dialogRef.current?.focus();
                return;
            }
            codeInputRef.current?.focus();
        }, 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && pairingState.phase !== 'completing') {
                event.preventDefault();
                closeCodeDialog();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ) ?? [])];
            if (focusable.length === 0) {
                event.preventDefault();
                dialogRef.current?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
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
            window.setTimeout(() => (codeTrigger || previousFocus)?.focus(), 0);
        };
    }, [closeCodeDialog, isCodeDialogOpen, pairingState.phase]);

    const probe = async () => {
        setConnectionStarted(true);
        setShowHelp(false);
        setManualCheckPending(true);
        const startedAt = Date.now();
        try {
            const result = await probeLocalEngine({ userInitiated: true });
            if (result) await onProbeCompleted?.(result);
        } catch {
            // The provider owns the durable transport state shown by this surface.
        } finally {
            const remaining = MIN_MANUAL_CHECK_MS - (Date.now() - startedAt);
            if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
            setManualCheckPending(false);
        }
    };

    const beginPairing = async () => {
        setConnectionStarted(true);
        setPairingError('');
        if (pairingState.phase === 'awaiting-code' && pairingState.challenge) {
            setIsCodeDialogOpen(true);
            return;
        }
        try {
            await startPairing();
        } catch {
            // The provider owns the durable pairing error shown by this surface.
        }
    };

    const runAction = async (action: LocalEngineConnectionAction | null) => {
        if (action === 'probe') {
            await probe();
            return;
        }
        if (action === 'pair' || action === 'open-code') {
            await beginPairing();
            return;
        }
        // Download and update navigation use native links in the render path.
    };

    const submitPairingCode = async (event: React.FormEvent) => {
        event.preventDefault();
        const code = pairingCode.trim();
        if (!PAIRING_CODE_PATTERN.test(code)) {
            setPairingError('연결 창의 숫자 6~8자리를 입력해 주세요.');
            return;
        }
        if (!pairingState.challenge) {
            setPairingError('연결 코드가 만료되었습니다. 다시 연결해 주세요.');
            return;
        }
        setPairingError('');
        try {
            const connected = await completePairing(pairingState.challenge.pairing_id, code);
            if (!connected) {
                setPairingError('연결을 확인하지 못했습니다. 새 코드로 다시 시도해 주세요.');
                return;
            }
            setIsCodeDialogOpen(false);
            setPairingCode('');
        } catch (error) {
            const message = error instanceof Error ? error.message : '연결을 완료하지 못했습니다.';
            resetPairing(message);
            closeCodeDialog();
        }
    };

    const primaryIcon = view.primaryAction === 'probe'
        ? <RefreshCw size={15} aria-hidden="true" />
        : view.primaryAction === 'download' || view.primaryAction === 'update'
            ? <Download size={15} aria-hidden="true" />
            : <Link2 size={15} aria-hidden="true" />;
    const testInstallerNotice = import.meta.env.VITE_LOCAL_ENGINE_TEST_RELEASE === 'true'
        && installerUrl && (view.primaryAction === 'download' || view.secondaryAction === 'download')
        ? '테스트 설치 파일이라 Windows 보안 경고가 나올 수 있습니다.'
        : undefined;
    const hasHelp = !['intro', 'checking', 'pairing', 'connected'].includes(view.scene);
    // With 문제 해결 present, the install warning moves into its help so the row stays short.
    const statusMessage = [pairingState.phase === 'error' ? pairingState.reason || view.message : view.message, hasHelp ? undefined : testInstallerNotice].filter(Boolean).join(' ');

    return (
        <div className={`local-engine-connection local-engine-connection-${view.tone}`} data-scene={view.scene}>
            <div
                ref={statusRef}
                id="writer-local-engine-requirement"
                className="local-engine-connection-status"
                role="status"
                tabIndex={-1}
            >
                <span className="local-engine-connection-icon">
                    <SceneIcon scene={view.scene} busy={view.busy} />
                </span>
                <span className="local-engine-connection-copy">
                    <span className="local-engine-connection-heading">
                        <strong>{view.title}</strong>
                    </span>
                    {statusMessage && <span>{statusMessage}</span>}
                </span>
            </div>

            <div className="local-engine-connection-actions">
                {view.secondaryAction === 'download' && view.secondaryLabel && installerUrl ? (
                    <a
                        className="btn btn-outline local-engine-secondary-action"
                        href={installerUrl}
                        aria-label={`${LOCAL_ENGINE_NAME} 설치 파일 받기`}
                        title={`${LOCAL_ENGINE_NAME} 설치 파일 받기`}
                    >
                        <Download size={15} aria-hidden="true" />
                        {view.secondaryLabel}
                    </a>
                ) : view.secondaryAction && view.secondaryLabel && (
                    <Button
                        variant="outline"
                        className="local-engine-secondary-action"
                        onClick={() => void runAction(view.secondaryAction)}
                        disabled={view.busy}
                    >
                        <RefreshCw size={15} aria-hidden="true" />
                        {view.secondaryLabel}
                    </Button>
                )}
                {(view.primaryAction === 'download' && installerUrl) || (view.primaryAction === 'update' && updateUrl) ? (
                    <a
                        className="btn btn-primary local-engine-primary-action"
                        href={view.primaryAction === 'download' ? installerUrl : updateUrl}
                    >
                        {primaryIcon}
                        {view.primaryLabel}
                    </a>
                ) : view.primaryAction && view.primaryLabel && (
                    <Button
                        ref={view.primaryAction === 'pair' || view.primaryAction === 'open-code' ? codeTriggerRef : undefined}
                        variant="primary"
                        className="local-engine-primary-action"
                        onClick={() => void runAction(view.primaryAction)}
                        disabled={view.primaryDisabled || view.busy}
                        title={view.primaryDisabled ? view.primaryLabel : undefined}
                    >
                        {primaryIcon}
                        {view.primaryLabel}
                    </Button>
                )}
                {hasHelp && (
                    <Button
                        variant="ghost"
                        className="local-engine-help-action"
                        onClick={() => setShowHelp(previous => !previous)}
                        aria-expanded={showHelp}
                        aria-controls="local-engine-help"
                    >
                        <CircleHelp size={15} aria-hidden="true" />
                        문제 해결
                    </Button>
                )}
            </div>

            {showHelp && (
                <div id="local-engine-help" className="local-engine-help">
                    Windows 시작 메뉴에서 {withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하세요. Chrome에서는 이 사이트의 ‘기기에 있는 앱’을 허용한 뒤 새로고침해 주세요. 회사 정책으로 차단되면 관리자에게 문의하세요.{testInstallerNotice && ` ${testInstallerNotice}`}
                </div>
            )}

            {isCodeDialogOpen && pairingState.challenge && (
                <div className="local-engine-pairing-backdrop" onMouseDown={event => {
                    if (event.target === event.currentTarget) closeCodeDialog();
                }}>
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="local-engine-pairing-title"
                        aria-describedby="local-engine-pairing-description"
                        aria-busy={pairingState.phase === 'completing'}
                        className="local-engine-pairing-dialog"
                        tabIndex={-1}
                    >
                        <div className="local-engine-pairing-header">
                            <div>
                                <h3 id="local-engine-pairing-title">이 브라우저 연결</h3>
                                <p id="local-engine-pairing-description">{LOCAL_ENGINE_NAME} 창에 표시된 일회성 코드를 입력합니다.</p>
                            </div>
                            <IconButton
                                variant="ghost"
                                icon={<X size={18} />}
                                onClick={closeCodeDialog}
                                disabled={pairingState.phase === 'completing'}
                                aria-label="연결 코드 입력 닫기"
                            />
                        </div>
                        <form noValidate onSubmit={submitPairingCode} className="local-engine-pairing-form">
                            <label htmlFor="local-engine-pairing-code">연결 코드</label>
                            <Input
                                ref={codeInputRef}
                                id="local-engine-pairing-code"
                                name="local-engine-pairing-code"
                                value={pairingCode}
                                onChange={event => {
                                    setPairingCode(event.target.value.replace(/\D/g, '').slice(0, 8));
                                    setPairingError('');
                                }}
                                inputMode="numeric"
                                spellCheck={false}
                                autoComplete="one-time-code"
                                pattern="[0-9]{6,8}"
                                placeholder="예: 123456"
                                aria-invalid={Boolean(pairingError)}
                                aria-describedby={pairingError ? 'local-engine-pairing-error' : 'local-engine-pairing-note'}
                                disabled={pairingState.phase === 'completing'}
                            />
                            <p id="local-engine-pairing-note" className="local-engine-pairing-note">
                                코드는 저장되지 않으며 연결을 마치면 바로 지워집니다.
                            </p>
                            {pairingError && (
                                <p id="local-engine-pairing-error" className="local-engine-pairing-error" role="alert">
                                    {pairingError}
                                </p>
                            )}
                            <div className="local-engine-pairing-actions">
                                <Button variant="outline" onClick={closeCodeDialog} disabled={pairingState.phase === 'completing'}>
                                    취소
                                </Button>
                                <Button type="submit" disabled={pairingState.phase === 'completing'}>
                                    {pairingState.phase === 'completing' && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                                    {pairingState.phase === 'completing' ? '확인 중' : '연결'}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
