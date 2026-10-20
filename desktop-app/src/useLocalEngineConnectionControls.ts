import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';
import type { LocalEngineProbePayload, LocalEngineTransportState } from './localEngineConnection';
import { getDistributionUrl } from './localEngineDistribution';
import {
    getLocalEngineConnectionView,
    LocalEngineConnectionAction,
    LocalEngineConnectionViewModel,
} from './localEngineConnectionView';

interface LocalEngineConnectionControlsOptions {
    installerUrl?: string;
    updateUrl?: string;
    /** The writer already started a recovery probe from its compact action row. */
    connectionRequested?: boolean;
    /** That recovery probe is still running, so the row shows the check like its own. */
    checkRequested?: boolean;
    onProbeCompleted?: (probe: LocalEngineProbePayload) => Promise<void>;
}

export interface LocalEngineConnectionControls {
    view: LocalEngineConnectionViewModel;
    installerUrl?: string;
    updateUrl?: string;
    /** Test releases warn that Windows may question the installer. */
    installerNotice?: string;
    showHelp: boolean;
    setShowHelp: React.Dispatch<React.SetStateAction<boolean>>;
    runAction: (action: LocalEngineConnectionAction) => Promise<void>;
    codeDialogOpen: boolean;
    /** `force` closes even while the code is being checked (the check itself finished). */
    closeCodeDialog: (force?: boolean) => void;
}

// A refused loopback request fails within milliseconds; without a floor the retry
// flips straight back to the same message and looks like the button did nothing.
const MIN_MANUAL_CHECK_MS = 700;

// Connection state the writer's status row needs: whether the user started connecting, the manual
// check in progress, and the `?` help. The connection step itself is getLocalEngineConnectionView.
export const useLocalEngineConnectionControls = ({
    installerUrl = getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_INSTALLER_URL),
    updateUrl = getDistributionUrl(import.meta.env.VITE_LOCAL_ENGINE_UPDATE_URL),
    connectionRequested = false,
    checkRequested = false,
    onProbeCompleted,
}: LocalEngineConnectionControlsOptions = {}): LocalEngineConnectionControls => {
    const {
        snapshot,
        pairingState,
        probeLocalEngine,
        startPairing,
        resetPairing,
    } = useLocalEngineConnection();
    const [connectionStarted, setConnectionStarted] = useState(false);
    const [manualCheckPending, setManualCheckPending] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [codeDialogOpen, setCodeDialogOpen] = useState(false);
    // The last answer the engine (or browser) gave, so a background re-check can keep showing it.
    const [settledTransport, setSettledTransport] = useState<LocalEngineTransportState | null>(null);
    useEffect(() => {
        if (snapshot.transport !== 'checking') setSettledTransport(snapshot.transport);
    }, [snapshot.transport]);

    const userCheckPending = manualCheckPending || checkRequested;
    const view = useMemo(() => getLocalEngineConnectionView({
        snapshot: userCheckPending && ['unreachable', 'error', 'checking'].includes(snapshot.transport)
            ? { ...snapshot, transport: 'checking', blockedBy: undefined }
            // A background re-check (every 10s, or on window focus) must not flash a spinner, drop the
            // buttons the user may be on, or re-announce the line; it keeps the settled state.
            : snapshot.transport === 'checking' && settledTransport
                ? { ...snapshot, transport: settledTransport }
                : snapshot,
        pairingPhase: pairingState.phase,
        connectionStarted: connectionStarted || connectionRequested,
        installerAvailable: Boolean(installerUrl),
        updateAvailable: Boolean(updateUrl),
        // The cause survives the 'checking' state, so it tells whether the prompt may be up now.
        permissionPromptPending: userCheckPending && snapshot.blockedBy === 'permission-prompt',
        pairingErrorReason: pairingState.phase === 'error' ? pairingState.reason : undefined,
    }), [connectionRequested, connectionStarted, installerUrl, pairingState.phase, pairingState.reason, settledTransport, snapshot, updateUrl, userCheckPending]);

    useEffect(() => {
        if (pairingState.phase !== 'awaiting-code') return;
        setCodeDialogOpen(true);
    }, [pairingState.phase]);

    const closeCodeDialog = useCallback((force = false) => {
        if (!force && pairingState.phase === 'completing') return;
        setCodeDialogOpen(false);
    }, [pairingState.phase]);

    useEffect(() => {
        if (pairingState.phase !== 'awaiting-code' || !pairingState.challenge) return;
        const timeout = window.setTimeout(() => {
            resetPairing('연결 코드가 만료되었습니다. 새 코드를 받아 다시 연결해 주세요.');
            closeCodeDialog();
        }, pairingState.challenge.expires_in_seconds * 1000);
        return () => window.clearTimeout(timeout);
    }, [closeCodeDialog, pairingState.challenge, pairingState.phase, resetPairing]);

    const probe = useCallback(async () => {
        setConnectionStarted(true);
        setShowHelp(false);
        setManualCheckPending(true);
        const startedAt = Date.now();
        try {
            const result = await probeLocalEngine({ userInitiated: true });
            if (result) await onProbeCompleted?.(result);
        } catch {
            // The provider owns the durable transport state shown by the status row.
        } finally {
            const remaining = MIN_MANUAL_CHECK_MS - (Date.now() - startedAt);
            if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
            setManualCheckPending(false);
        }
    }, [onProbeCompleted, probeLocalEngine]);

    const beginPairing = useCallback(async () => {
        setConnectionStarted(true);
        if (pairingState.phase === 'awaiting-code' && pairingState.challenge) {
            setCodeDialogOpen(true);
            return;
        }
        try {
            await startPairing();
        } catch {
            // The provider owns the durable pairing error shown by the status row.
        }
    }, [pairingState.challenge, pairingState.phase, startPairing]);

    const runAction = useCallback(async (action: LocalEngineConnectionAction) => {
        if (action === 'probe') {
            await probe();
            return;
        }
        if (action === 'pair' || action === 'open-code') {
            await beginPairing();
        }
        // Download and update navigation are native links in the render path.
    }, [beginPairing, probe]);

    const installerNotice = import.meta.env.VITE_LOCAL_ENGINE_TEST_RELEASE === 'true' && installerUrl
        ? '테스트 설치 파일이라 Windows 보안 경고가 나올 수 있습니다.'
        : undefined;

    return {
        view,
        installerUrl,
        updateUrl,
        installerNotice,
        showHelp,
        setShowHelp,
        runAction,
        codeDialogOpen,
        closeCodeDialog,
    };
};
