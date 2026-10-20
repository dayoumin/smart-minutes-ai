import React, { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { LOCAL_ENGINE_NAME } from './brand';
import { Button, IconButton, Input } from './components/common';
import { useLocalEngineConnection } from './LocalEngineConnectionContext';

const PAIRING_CODE_PATTERN = /^\d{6,8}$/;

// One-time code entry for engines that still pair with a code. Mount it only while open, so a new
// opening starts with an empty code.
export const LocalEngineCodeDialog: React.FC<{ onClose: (force?: boolean) => void }> = ({ onClose }) => {
    const { pairingState, completePairing, resetPairing } = useLocalEngineConnection();
    const [pairingCode, setPairingCode] = useState('');
    const [pairingError, setPairingError] = useState('');
    const codeInputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const completing = pairingState.phase === 'completing';
    const hasChallenge = Boolean(pairingState.challenge);

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => {
            window.setTimeout(() => previousFocus?.focus(), 0);
        };
    }, []);

    useEffect(() => {
        // Nothing is shown without a challenge, so nothing may hold the keyboard either.
        if (!hasChallenge) return;
        const focusTimer = window.setTimeout(() => {
            if (completing) {
                dialogRef.current?.focus();
                return;
            }
            codeInputRef.current?.focus();
        }, 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            // Another dialog already handled this key; closing this one too would close two dialogs at once.
            if (event.defaultPrevented) return;
            if (event.key === 'Escape' && !completing) {
                event.preventDefault();
                onClose();
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
        };
    }, [completing, hasChallenge, onClose]);

    if (!pairingState.challenge) return null;
    const challenge = pairingState.challenge;

    const submitPairingCode = async (event: React.FormEvent) => {
        event.preventDefault();
        const code = pairingCode.trim();
        if (!PAIRING_CODE_PATTERN.test(code)) {
            setPairingError('연결 창의 숫자 6~8자리를 입력해 주세요.');
            return;
        }
        setPairingError('');
        try {
            const connected = await completePairing(challenge.pairing_id, code);
            if (!connected) {
                setPairingError('연결을 확인하지 못했습니다. 새 코드로 다시 시도해 주세요.');
                return;
            }
            onClose(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : '연결을 완료하지 못했습니다.';
            resetPairing(message);
            onClose(true);
        }
    };

    return (
        <div className="local-engine-pairing-backdrop" onMouseDown={event => {
            if (event.target === event.currentTarget) onClose();
        }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="local-engine-pairing-title"
                aria-describedby="local-engine-pairing-description"
                aria-busy={completing}
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
                        onClick={() => onClose()}
                        disabled={completing}
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
                        disabled={completing}
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
                        <Button variant="outline" onClick={() => onClose()} disabled={completing}>
                            취소
                        </Button>
                        <Button type="submit" disabled={completing}>
                            {completing && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                            {completing ? '확인 중' : '연결'}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
};
