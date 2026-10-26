import React, { useEffect, useRef } from 'react';
import {
    AlertTriangle,
    CheckCircle2,
    CircleHelp,
    Download,
    Info,
    Link2,
    Loader2,
    RefreshCw,
    Settings,
    Upload,
    XCircle,
} from 'lucide-react';
import { Button } from './components/common';
import { useUpdateControls } from './UpdateContext';
import type { WriterStatusAction, WriterStatusRow } from './writerStatusRow';

interface WriterActionRowProps {
    row: WriterStatusRow;
    statusRef: React.RefObject<HTMLDivElement | null>;
    showHelp: boolean;
    onToggleHelp: () => void;
    onAction: (action: WriterStatusAction) => void;
    installerUrl?: string;
    updateUrl?: string;
    /** The readiness re-check is running (its button spins instead of changing its label). */
    recheckingReadiness?: boolean;
    /** The saved analyses are being checked again (상태 확인 spins the same way). */
    refreshingAnalysisStatus?: boolean;
    /** 분석 시작, always the last button. */
    children: React.ReactNode;
}

const StatusIcon: React.FC<{ row: WriterStatusRow }> = ({ row }) => {
    if (row.busy) return <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />;
    if (row.tone === 'success') return <CheckCircle2 size={16} />;
    if (row.tone === 'warning') return <AlertTriangle size={16} />;
    if (row.tone === 'error') return <XCircle size={16} />;
    return <Info size={16} />;
};

const actionIcon = (action: WriterStatusAction, spinning: boolean) => {
    switch (action.kind) {
        case 'download':
        case 'update':
        case 'models':
            return <Download size={15} aria-hidden="true" />;
        case 'pair':
        case 'open-code':
            return <Link2 size={15} aria-hidden="true" />;
        case 'device':
        case 'diarization':
        case 'troubleshoot':
            return <Settings size={15} aria-hidden="true" />;
        case 'choose-file':
            return <Upload size={15} aria-hidden="true" />;
        default:
            return <RefreshCw size={15} className={spinning ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />;
    }
};

// The new-meeting action row: one status line naming the first blocked step, the buttons that fix it,
// then 분석 시작. The line is the only live region and stays mounted even when it has nothing to say
// (desktop app and development UI once ready); the `?` help sits outside it.
export const WriterActionRow: React.FC<WriterActionRowProps> = ({
    row,
    statusRef,
    showHelp,
    onToggleHelp,
    onAction,
    installerUrl,
    updateUrl,
    recheckingReadiness = false,
    refreshingAnalysisStatus = false,
    children,
}) => {
    const { openGuide } = useUpdateControls();
    const rootRef = useRef<HTMLDivElement>(null);
    const helpButtonRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!showHelp || !row.help) return;
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onToggleHelp();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
            event.preventDefault();
            onToggleHelp();
            helpButtonRef.current?.focus();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape);
        };
    }, [showHelp, row.help, onToggleHelp]);
    return <div ref={rootRef} className="writer-action-row" data-stage={row.stage} data-state={row.state}>
        <div className={`writer-status-line writer-status-${row.busy ? 'busy' : row.tone}`}>
            <div
                ref={statusRef}
                id="writer-local-engine-requirement"
                className="writer-status"
                role="status"
                aria-atomic="true"
                tabIndex={-1}
            >
                {row.title && (
                    <>
                        <span className="writer-status-icon" aria-hidden="true">
                            <StatusIcon row={row} />
                        </span>
                        <strong className="writer-status-title">{row.title}</strong>
                    </>
                )}
                {row.message && <span id={row.messageId} className="writer-status-message">{row.message}</span>}
            </div>
            {row.help && (
                <button
                    ref={helpButtonRef}
                    type="button"
                    className="writer-status-help-toggle"
                    aria-label="문제 해결 도움말"
                    title="문제 해결 도움말"
                    aria-expanded={showHelp}
                    aria-controls="writer-status-help"
                    onClick={onToggleHelp}
                >
                    <CircleHelp size={16} aria-hidden="true" />
                </button>
            )}
        </div>
        {row.help && (
            <div id="writer-status-help" className="writer-status-help" role="note" aria-label="문제 해결 안내" hidden={!showHelp}>
                {row.help}
            </div>
        )}
        <div className="writer-action-buttons">
            {row.actions.map(action => {
                const href = action.kind === 'download' ? installerUrl : action.kind === 'update' ? updateUrl : undefined;
                if (href) {
                    return (
                        <Button
                            key={action.kind}
                            variant="outline"
                            className="writer-hint-action"
                            onClick={() => openGuide(action.kind === 'download' ? 'install' : 'update')}
                        >
                            {actionIcon(action, false)}
                            {action.kind === 'download' ? '설치 안내' : '업데이트 안내'}
                        </Button>
                    );
                }
                if (action.kind === 'download' || action.kind === 'update') return null;
                const rechecking = action.kind === 'recheck-readiness' && recheckingReadiness;
                // A repeated 상태 확인 only queues one more check, so it spins without losing focus.
                const spinning = rechecking || (action.kind === 'refresh-analysis-status' && refreshingAnalysisStatus);
                return (
                    <Button
                        key={action.kind}
                        variant="outline"
                        className="writer-hint-action"
                        onClick={() => onAction(action)}
                        disabled={action.disabled || rechecking}
                    >
                        {actionIcon(action, spinning)}
                        {action.label}
                    </Button>
                );
            })}
            {children}
        </div>
    </div>;
};
