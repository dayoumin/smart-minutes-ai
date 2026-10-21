import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function MeetingParticipants({ names, placeholder }: { names: string[]; placeholder: string }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const id = useId();
    useEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
            }
        };
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', dismiss);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);
    return (
        <div className="meeting-participants" ref={rootRef}>
            <span className="meeting-participant-preview" title={names.join(', ')}>{names.join(' · ') || placeholder}</span>
            {names.length > 0 && (
                <>
                    <button ref={buttonRef} type="button" className="meeting-participant-count" aria-label={`참석자 ${names.length}명 전체 보기`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
                        {names.length}명 <ChevronDown size={13} aria-hidden="true" />
                    </button>
                    {open && <div id={id} className="meeting-participant-popover"><strong>참석자 {names.length}명</strong><ul>{names.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}</ul></div>}
                </>
            )}
        </div>
    );
}
