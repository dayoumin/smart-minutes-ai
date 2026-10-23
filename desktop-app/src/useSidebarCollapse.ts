import { useCallback, useEffect, useState } from 'react';

export type SidebarMode = 'expanded' | 'rail' | 'overlay';
const narrowQuery = '(max-width: 1199.98px)';

export function useSidebarCollapse() {
    const [state, setState] = useState(() => {
        const narrow = window.matchMedia(narrowQuery).matches;
        return { narrow, overlay: false };
    });
    useEffect(() => {
        const query = window.matchMedia(narrowQuery);
        const change = () => setState({
            narrow: query.matches,
            overlay: false,
        });
        query.addEventListener('change', change);
        return () => query.removeEventListener('change', change);
    }, []);
    const expand = useCallback(() => setState(current => current.narrow ? { ...current, overlay: true } : current), []);
    const close = useCallback(() => setState(current => current.overlay ? { ...current, overlay: false } : current), []);
    const mode: SidebarMode = state.narrow ? (state.overlay ? 'overlay' : 'rail') : 'expanded';
    return { mode, narrow: state.narrow, expand, close };
}
