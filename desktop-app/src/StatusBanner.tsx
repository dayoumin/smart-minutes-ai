import React from 'react';

type StatusTone = 'info' | 'warning' | 'error' | 'neutral';

export interface StatusBannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    tone?: StatusTone;
    heading?: React.ReactNode;
    action?: React.ReactNode;
    children: React.ReactNode;
}

const toneClasses: Record<StatusTone, string> = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-border bg-muted/40 text-muted-foreground',
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
            className={`rounded-md border px-4 py-3 text-sm shadow-sm ${toneClasses[tone]} ${className}`}
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
