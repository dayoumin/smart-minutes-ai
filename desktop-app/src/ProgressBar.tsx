import React from 'react';

type ProgressTone = 'primary' | 'info' | 'error';
type ProgressSize = 'sm' | 'md';

export interface ProgressBarProps {
    value: number;
    tone?: ProgressTone;
    size?: ProgressSize;
    className?: string;
    label?: string;
}

const toneClasses: Record<ProgressTone, string> = {
    primary: 'bg-primary',
    info: 'bg-blue-600',
    error: 'bg-red-500',
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
}) => {
    const progress = Math.min(100, Math.max(0, value || 0));

    return (
        <div
            className={`w-full overflow-hidden rounded-full bg-muted ${sizeClasses[size]} ${className}`}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
        >
            <div
                className={`${sizeClasses[size]} rounded-full ${toneClasses[tone]} transition-all duration-300`}
                style={{ width: `${progress}%` }}
            />
        </div>
    );
};
