import React from 'react';
import { X } from 'lucide-react';

export type AppToastTone = 'warning' | 'neutral' | 'error' | 'success';

export interface AppToastMessage {
    id: number;
    message: string;
    tone: AppToastTone;
}

interface AppToastProps {
    message: string;
    tone?: AppToastTone;
    actionLabel?: string;
    onAction?: () => void;
    closeLabel?: string;
    onClose: () => void;
}

export const AppToast: React.FC<AppToastProps> = ({
    message,
    tone = 'neutral',
    actionLabel,
    onAction,
    closeLabel = '알림 닫기',
    onClose,
}) => (
    <div className={`operation-toast status-${tone}`} role="status" aria-live="polite">
        <span className="font-semibold">{message}</span>
        {actionLabel && onAction && (
            <button
                type="button"
                className="operation-toast-action"
                onClick={onAction}
            >
                {actionLabel}
            </button>
        )}
        <button
            type="button"
            className="operation-toast-close"
            aria-label={closeLabel}
            onClick={onClose}
        >
            <X size={14} />
        </button>
    </div>
);
