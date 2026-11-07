import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { withJosa } from '../../brand';
import { Button } from './Button';
import { Input } from './Input';
import { AppDialogContext, type AppChoice, type AppChoiceOptions, type AppConfirmOptions, type AppDialogApi, type AppPromptOptions } from './appDialogContext';

type DialogRequestInput =
    | { kind: 'confirm'; options: AppConfirmOptions; resolve: (value: boolean) => void }
    | { kind: 'choose'; options: AppChoiceOptions; resolve: (value: AppChoice) => void }
    | { kind: 'prompt'; options: AppPromptOptions; resolve: (value: string | null) => void };

type DialogRequest = DialogRequestInput & { id: number };


const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const AppDialogView: React.FC<{ request: DialogRequest; onSettle: (value: boolean | AppChoice | string | null) => void }> = ({
    request,
    onSettle,
}) => {
    const titleId = useId();
    const descriptionId = useId();
    const inputId = useId();
    const errorId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const initialFocusRef = useRef<HTMLButtonElement & HTMLInputElement>(null);
    const [value, setValue] = useState(request.kind === 'prompt' ? request.options.initialValue ?? '' : '');
    const [error, setError] = useState('');
    const cancel = useCallback(() => onSettle(request.kind === 'confirm' ? false : null), [onSettle, request.kind]);
    const cancelRef = useRef(cancel);
    useEffect(() => {
        cancelRef.current = cancel;
    }, [cancel]);

    useEffect(() => {
        const target = initialFocusRef.current;
        target?.focus();
        if (request.kind === 'prompt') target?.select();
        // Capture phase so a dialog underneath (settings) does not also close on Escape or move focus on Tab.
        const handleKeyDown = (event: KeyboardEvent) => {
            const dialog = dialogRef.current;
            if (!dialog) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRef.current();
                return;
            }
            if (event.key !== 'Tab') return;
            event.stopPropagation();
            const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!dialog.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [request]);

    const { title } = request.options;
    const description = request.kind === 'prompt' ? undefined : request.options.description;
    const cancelLabel = request.options.cancelLabel ?? '취소';
    const danger = request.kind === 'confirm' && request.options.tone === 'danger';

    const submitPrompt = (event: React.FormEvent) => {
        event.preventDefault();
        if (request.kind !== 'prompt') return;
        const nextValue = value.trim();
        if (!nextValue) {
            setError(`${withJosa(request.options.label, '을/를')} 입력해 주세요.`);
            return;
        }
        const validationError = request.options.validate?.(nextValue) ?? null;
        if (validationError) {
            setError(validationError);
            return;
        }
        onSettle(nextValue);
    };

    return (
        // No close on a backdrop click: the click that opened the dialog can be followed by a second one
        // (a double click) that would dismiss a delete or discard question before it is read. Esc and 취소 close it.
        <div className="app-dialog-backdrop">
            <div
                ref={dialogRef}
                role={request.kind === 'prompt' ? 'dialog' : 'alertdialog'}
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descriptionId : undefined}
                className="app-dialog"
            >
                <h2 id={titleId} className="app-dialog-title">{title}</h2>
                {description && <p id={descriptionId} className="app-dialog-description">{description}</p>}
                {request.kind === 'prompt' ? (
                    <form className="app-dialog-form" onSubmit={submitPrompt} noValidate>
                        <label htmlFor={inputId} className="app-dialog-label">{request.options.label}</label>
                        <Input
                            ref={initialFocusRef}
                            id={inputId}
                            value={value}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? errorId : undefined}
                            onChange={event => {
                                setValue(event.target.value);
                                if (error) setError('');
                            }}
                        />
                        <p id={errorId} className="app-dialog-error" role={error ? 'alert' : undefined}>{error}</p>
                        <div className="app-dialog-actions">
                            <Button variant="outline" onClick={cancel}>{cancelLabel}</Button>
                            <Button type="submit">{request.options.confirmLabel}</Button>
                        </div>
                    </form>
                ) : (
                    <div className="app-dialog-actions">
                        <Button ref={danger ? initialFocusRef : undefined} variant="outline" onClick={cancel}>{cancelLabel}</Button>
                        {request.kind === 'choose' ? (
                            <>
                                <Button variant="outline" onClick={() => onSettle('secondary')}>{request.options.secondaryLabel}</Button>
                                <Button ref={initialFocusRef} onClick={() => onSettle('primary')}>{request.options.primaryLabel}</Button>
                            </>
                        ) : (
                            <Button
                                ref={danger ? undefined : initialFocusRef}
                                className={danger ? 'app-dialog-danger' : ''}
                                onClick={() => onSettle(true)}
                            >
                                {request.options.confirmLabel}
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

/** In-app replacement for window.confirm/prompt: one dialog at a time, focus returns to where it was opened. */
export const AppDialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [queue, setQueue] = useState<DialogRequest[]>([]);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const current = queue[0] ?? null;

    const nextIdRef = useRef(0);
    const settledIdRef = useRef(0);
    const enqueue = useCallback((input: DialogRequestInput) => {
        nextIdRef.current += 1;
        const request: DialogRequest = { ...input, id: nextIdRef.current };
        setQueue(items => {
            if (items.length === 0) {
                returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }
            return [...items, request];
        });
    }, []);

    const settle = useCallback((value: boolean | AppChoice | string | null) => {
        const request = current;
        // A double click must not settle the same request twice or drop the next one in the queue.
        if (!request || settledIdRef.current === request.id) return;
        settledIdRef.current = request.id;
        const returnFocus = returnFocusRef.current;
        setQueue(items => items.slice(1));
        // Restore focus first so the caller can move it elsewhere after the promise resolves.
        if (queue.length <= 1 && returnFocus?.isConnected) returnFocus.focus();
        (request.resolve as (result: typeof value) => void)(value);
    }, [current, queue.length]);

    const api = useMemo<AppDialogApi>(() => ({
        confirm: options => new Promise<boolean>(resolve => enqueue({ kind: 'confirm', options, resolve })),
        choose: options => new Promise<AppChoice>(resolve => enqueue({ kind: 'choose', options, resolve })),
        prompt: options => new Promise<string | null>(resolve => enqueue({ kind: 'prompt', options, resolve })),
    }), [enqueue]);

    return (
        <AppDialogContext.Provider value={api}>
            {children}
            {current && createPortal(<AppDialogView key={current.id} request={current} onSettle={settle} />, document.body)}
        </AppDialogContext.Provider>
    );
};
