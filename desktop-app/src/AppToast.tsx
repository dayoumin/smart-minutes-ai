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
    closeLabel?: string;
    onClose: () => void;
}

export const AppToast: React.FC<AppToastProps> = ({
    message,
    tone = 'neutral',
    closeLabel = '알림 닫기',
    onClose,
}) => (
    <div className={`operation-toast status-${tone}`} role="status" aria-live="polite">
        <span className="font-semibold">{message}</span>
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
