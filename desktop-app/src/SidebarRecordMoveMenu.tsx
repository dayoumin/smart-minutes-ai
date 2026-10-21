import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { MeetingFolder } from './meetingRepository';

interface SidebarRecordMoveMenuProps {
    recordId: string;
    folderId?: string;
    folders: MeetingFolder[];
    onMove: (folderId: string) => void;
    onClose: () => void;
}

export const SidebarRecordMoveMenu = ({ recordId, folderId, folders, onMove, onClose }: SidebarRecordMoveMenuProps) => {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const focusOnOpenRef = useRef(false);
    const destinations = folderId ? [{ id: '', name: '폴더에서 빼기' }, ...folders] : folders;
    const hasDestinations = destinations.length > 0;

    useLayoutEffect(() => {
        if (!open) return;
        if (!hasDestinations) {
            setOpen(false);
            return;
        }
        const updatePosition = () => {
            const trigger = triggerRef.current;
            const panel = panelRef.current;
            if (!trigger || !panel) return;
            const bounds = trigger.getBoundingClientRect();
            const width = panel.offsetWidth;
            const height = panel.offsetHeight;
            setPosition({
                left: Math.max(8, bounds.right + width <= window.innerWidth - 8 ? bounds.right : bounds.left - width),
                top: Math.max(8, Math.min(bounds.top, window.innerHeight - height - 8)),
            });
        };
        updatePosition();
        if (focusOnOpenRef.current) {
            focusOnOpenRef.current = false;
            panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
        }
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [open, folders, hasDestinations]);

    const openMenu = (focus: boolean) => {
        if (!hasDestinations) return;
        focusOnOpenRef.current = focus;
        setOpen(true);
        if (open && focus) panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
    };
    const closeMenu = (restoreFocus: boolean) => {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
            event.preventDefault();
            closeMenu(true);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            onClose();
            return;
        }
        const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | null = null;
        if (event.key === 'ArrowDown') next = (index + 1) % items.length;
        if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = items.length - 1;
        if (next !== null) {
            event.preventDefault();
            items[next]?.focus();
        }
    };

    return (
        <div
            className="sidebar-record-move"
            onMouseEnter={() => openMenu(false)}
            onMouseLeave={() => closeMenu(Boolean(panelRef.current?.contains(document.activeElement)))}
            onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(false);
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                className="menu-item px-2 py-1.5"
                aria-haspopup="menu"
                aria-expanded={open && hasDestinations}
                aria-controls={`sidebar-record-move-${recordId}`}
                disabled={!hasDestinations}
                title={!hasDestinations ? '폴더를 만든 뒤 이동할 수 있습니다.' : undefined}
                onClick={() => openMenu(true)}
                onKeyDown={event => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(true);
                }}
            >
                <span className="flex-1">폴더 이동</span>
                <ChevronRight size={13} aria-hidden="true" />
            </button>
            {open && hasDestinations && (
                <div
                    ref={panelRef}
                    id={`sidebar-record-move-${recordId}`}
                    className="menu-panel sidebar-record-move-menu"
                    role="menu"
                    aria-label="이동할 폴더"
                    style={position}
                    onKeyDown={handleKeyDown}
                >
                    {destinations.map(destination => (
                        <button
                            key={destination.id}
                            type="button"
                            role={destination.id ? 'menuitemradio' : 'menuitem'}
                            aria-checked={destination.id ? destination.id === folderId : undefined}
                            tabIndex={-1}
                            className="menu-item px-2 py-1.5"
                            onClick={() => destination.id === (folderId ?? '') ? onClose() : onMove(destination.id)}
                        >
                            <span className="min-w-0 flex-1 truncate" title={destination.name}>{destination.name}</span>
                            {destination.id === (folderId ?? '') && <Check size={13} aria-hidden="true" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
