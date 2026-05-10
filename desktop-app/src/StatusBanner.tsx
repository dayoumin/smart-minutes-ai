import React from 'react';

type StatusTone = 'info' | 'warning' | 'error' | 'success' | 'neutral';

export interface StatusBannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    tone?: StatusTone;
    heading?: React.ReactNode;
    action?: React.ReactNode;
    children: React.ReactNode;
}

const toneClasses: Record<StatusTone, string> = {
    info: 'status-banner-info',
    warning: 'status-banner-warning',
    error: 'status-banner-error',
    success: 'status-banner-success',
    neutral: 'status-banner-neutral',
};

export const StatusBanner: React.FC<StatusBannerProps> = ({
    tone = 'neutral',
    heading,
    action,
    children,
    className = '',
    role,
    'aria-live': ariaLive,
    ...props
}) => {
    const liveRole = role ?? (tone === 'error' ? 'alert' : 'status');
    const liveSetting = ariaLive ?? (tone === 'error' ? 'assertive' : 'polite');

    return (
        <div
            className={`status-banner ${toneClasses[tone]} ${className}`}
            role={liveRole}
            aria-live={liveSetting}
            {...props}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    {heading && <div className="font-semibold text-current">{heading}</div>}
                    <div className={heading ? 'mt-1 opacity-90' : ''}>{children}</div>
                </div>
                {action && <div className="shrink-0">{action}</div>}
            </div>
        </div>
    );
};
