import { useCallback, useEffect, useState } from 'react';

export type SidebarMode = 'expanded' | 'rail' | 'overlay';
const narrowQuery = '(max-width: 1199.98px)';

const readCollapsed = () => {
    try { return localStorage.getItem('sidebarCollapsed') === '1'; }
    catch { return false; }
};

export function useSidebarCollapse() {
    const [state, setState] = useState(() => {
        const narrow = window.matchMedia(narrowQuery).matches;
        return { narrow, collapsed: narrow ? false : readCollapsed(), overlay: false };
    });
    useEffect(() => {
        const query = window.matchMedia(narrowQuery);
        const change = () => setState({
            narrow: query.matches,
            collapsed: query.matches ? false : readCollapsed(),
            overlay: false,
        });
        query.addEventListener('change', change);
        return () => query.removeEventListener('change', change);
    }, []);
    const choose = useCallback((collapsed: boolean) => {
        if (state.narrow) {
            setState(current => ({ ...current, overlay: !collapsed }));
        } else {
            try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); }
            catch { collapsed = false; }
            setState(current => ({ ...current, collapsed, overlay: false }));
        }
    }, [state.narrow]);
    const collapse = useCallback(() => choose(true), [choose]);
    const expand = useCallback(() => choose(false), [choose]);
    const close = useCallback(() => setState(current => current.overlay ? { ...current, overlay: false } : current), []);
    const mode: SidebarMode = state.narrow ? (state.overlay ? 'overlay' : 'rail') : (state.collapsed ? 'rail' : 'expanded');
    return { mode, narrow: state.narrow, collapse, expand, close };
}
