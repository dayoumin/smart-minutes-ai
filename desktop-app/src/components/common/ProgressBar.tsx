import React from 'react';

type ProgressTone = 'primary' | 'info' | 'error';
type ProgressSize = 'sm' | 'md';

export interface ProgressBarProps {
    value: number;
    tone?: ProgressTone;
    size?: ProgressSize;
    className?: string;
    label?: string;
    decorative?: boolean;
}

const toneClasses: Record<ProgressTone, string> = {
    primary: 'progress-fill-primary',
    info: 'progress-fill-info',
    error: 'progress-fill-error',
};

const sizeClasses: Record<ProgressSize, string> = {
    sm: 'h-1.5',
    md: 'h-2.5',
};

export const ProgressBar: React.FC<ProgressBarProps> = ({
    value,
    tone = 'primary',
    size = 'md',
    className = '',
    label = '진행률',
    decorative = false,
}) => {
    const progress = Math.min(100, Math.max(0, value || 0));

    return (
        <div
            className={`progress-track ${sizeClasses[size]} ${className}`}
            {...(decorative
                ? { 'aria-hidden': true }
                : {
                    role: 'progressbar',
                    'aria-label': label,
                    'aria-valuemin': 0,
                    'aria-valuemax': 100,
                    'aria-valuenow': progress,
                })}
        >
            <div
                className={`progress-fill ${sizeClasses[size]} ${toneClasses[tone]}`}
                style={{ width: `${progress}%` }}
            />
        </div>
    );
};
