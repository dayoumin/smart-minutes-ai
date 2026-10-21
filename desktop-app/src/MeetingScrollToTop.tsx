import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import { IconButton } from './components/common';

interface MeetingScrollToTopProps {
    surfaceRef: RefObject<HTMLDivElement | null>;
    viewKey: string;
}

/** Uses the existing workspace scroll; short records and the top of long records stay quiet. */
export function MeetingScrollToTop({ surfaceRef, viewKey }: MeetingScrollToTopProps) {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const surface = surfaceRef.current;
        const workspace = surface?.closest<HTMLElement>('.barorok-workspace');
        if (!surface || !workspace) return;
        const measure = () => setVisible(
            surface.getClientRects().length > 0
            && surface.scrollHeight > workspace.clientHeight * 2
            && workspace.scrollTop > workspace.clientHeight,
        );
        const observer = new ResizeObserver(measure);
        observer.observe(surface);
        observer.observe(workspace);
        workspace.addEventListener('scroll', measure, { passive: true });
        const frame = requestAnimationFrame(measure);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            workspace.removeEventListener('scroll', measure);
        };
    }, [surfaceRef, viewKey]);

    if (!visible) return null;
    return (
        <IconButton
            className="meeting-scroll-to-top"
            icon={<ArrowUp size={18} aria-hidden="true" />}
            aria-label="맨 위로"
            title="맨 위로"
            onClick={() => {
                const surface = surfaceRef.current;
                surface?.querySelector<HTMLElement>('.meeting-detail-title')?.focus({ preventScroll: true });
                surface?.closest<HTMLElement>('.barorok-workspace')?.scrollTo({
                    top: 0,
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
                });
            }}
        />
    );
}
