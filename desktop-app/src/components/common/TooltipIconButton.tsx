import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, type IconButtonProps } from './IconButton';

export interface TooltipIconButtonProps extends IconButtonProps {
    'aria-label': string;
    tooltip: string;
}

/** An icon action with the same explanation on hover and keyboard focus. */
export const TooltipIconButton = React.forwardRef<HTMLButtonElement, TooltipIconButtonProps>(({
    tooltip, onClick, 'aria-describedby': describedBy, ...props
}, ref) => {
    const id = useId();
    const trigger = useRef<HTMLSpanElement>(null);
    const bubble = useRef<HTMLSpanElement>(null);
    const hideTimer = useRef<number | null>(null);
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    const cancelHide = () => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); hideTimer.current = null; };
    const close = () => { cancelHide(); setOpen(false); setPosition(null); };
    const show = () => { cancelHide(); setOpen(true); };
    const leave = () => {
        if (trigger.current?.contains(document.activeElement)) return;
        cancelHide();
        hideTimer.current = window.setTimeout(close, 150);
    };
    useEffect(() => () => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); }, []);

    useLayoutEffect(() => {
        if (!open || !trigger.current || !bubble.current) return;
        const anchor = trigger.current.getBoundingClientRect();
        const width = bubble.current.offsetWidth;
        const height = bubble.current.offsetHeight;
        const below = anchor.bottom + 8;
        setPosition({
            left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
            top: Math.max(8, below + height <= window.innerHeight - 8 ? below : anchor.top - height - 8),
        });
    }, [open, tooltip]);
    useEffect(() => {
        if (!open) return;
        const hide = () => { setOpen(false); setPosition(null); };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation(); hide();
        };
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        window.addEventListener('keydown', escape, true);
        return () => {
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
            window.removeEventListener('keydown', escape, true);
        };
    }, [open]);

    return <span ref={trigger} className="action-tooltip-trigger"
        onMouseEnter={show} onMouseLeave={leave}
        onFocus={show} onBlur={close}>
        <IconButton {...props} ref={ref}
            aria-describedby={[describedBy, open ? id : ''].filter(Boolean).join(' ') || undefined}
            onClick={event => { close(); onClick?.(event); }} />
        {open && createPortal(<span ref={bubble} id={id} role="tooltip" className="action-tooltip"
            onMouseEnter={show} onMouseLeave={leave}
            style={position ?? { visibility: 'hidden' }}>{tooltip}</span>, document.body)}
    </span>;
});
TooltipIconButton.displayName = 'TooltipIconButton';
