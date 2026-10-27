import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/** Optional explanation without moving the settings layout or toggling its label. */
export const SettingsHint: React.FC<{ label: string; text: string }> = ({ label, text }) => {
    const id = useId();
    const [anchor, setAnchor] = useState<{ left: number; top: number; below: boolean; width: number; height: number } | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const show = useCallback((target: HTMLElement) => {
        triggerRef.current = target;
        const rect = target.getBoundingClientRect();
        const below = rect.top < 85;
        setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: below ? rect.bottom + 8 : rect.top - 8, below, width: window.innerWidth, height: window.innerHeight });
    }, []);
    useEffect(() => {
        if (!anchor) return;
        const hide = () => setAnchor(null);
        const scroll = () => {
            const target = triggerRef.current;
            const bounds = target?.closest('.settings-content')?.getBoundingClientRect();
            const rect = target?.getBoundingClientRect();
            if (target && document.activeElement === target && rect && bounds && rect.top >= bounds.top && rect.bottom <= bounds.bottom) show(target);
            else hide();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            hide();
        };
        const resize = () => { if (window.innerWidth !== anchor.width || window.innerHeight !== anchor.height) hide(); };
        window.addEventListener('keydown', escape, true);
        window.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', resize);
        return () => {
            window.removeEventListener('keydown', escape, true);
            window.removeEventListener('scroll', scroll, true);
            window.removeEventListener('resize', resize);
        };
    }, [anchor, show]);
    return <>
        <span role="img" tabIndex={0} className="settings-hint-trigger" aria-label={label + ' 도움말'}
            aria-describedby={anchor ? id : undefined}
            onMouseEnter={event => show(event.currentTarget)} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) setAnchor(null); }}
            onFocus={event => show(event.currentTarget)} onBlur={event => { if (!event.currentTarget.matches(':hover')) setAnchor(null); }}
            onClick={event => { event.preventDefault(); show(event.currentTarget); }}
            onKeyDown={event => {
                if (event.key === 'Escape' && anchor) { event.preventDefault(); event.stopPropagation(); setAnchor(null); }
            }}>
            <Info size={14} aria-hidden="true" />
        </span>
        {anchor && createPortal(<span id={id} role="tooltip" className="settings-hint-tooltip"
            style={{ left: anchor.left, top: anchor.top, transform: anchor.below ? undefined : 'translateY(-100%)' }}>{text}</span>, document.body)}
    </>;
};
