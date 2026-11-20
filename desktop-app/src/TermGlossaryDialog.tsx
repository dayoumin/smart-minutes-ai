import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { Button, IconButton, Input } from './components/common';
import {
    MAX_MEETING_KEY_TERMS,
    meetingKeyTermsError,
    normalizeMeetingKeyTerms,
    type TermGlossary,
    type TermGlossaryEntry,
} from './meetingKnowledge';

interface TermGlossaryDialogProps {
    glossary?: TermGlossary;
    onClose: () => void;
    onSave: (glossary: TermGlossary) => void;
    onDelete: (id: string) => void;
}

export function TermGlossaryDialog({ glossary, onClose, onSave, onDelete }: TermGlossaryDialogProps) {
    const titleId = useId();
    const nameId = useId();
    const dialogRef = useRef<HTMLDialogElement>(null);
    const addedTermRef = useRef<HTMLInputElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const focusAddedTerm = useRef(false);
    const [id] = useState(() => glossary && !glossary.builtIn ? glossary.id : crypto.randomUUID());
    const [name, setName] = useState(() => glossary?.builtIn ? `${glossary.name} 복사본` : glossary?.name ?? '');
    const [entries, setEntries] = useState<TermGlossaryEntry[]>(() => glossary?.entries ?? []);
    const [error, setError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const title = glossary?.builtIn ? '용어집 복제' : glossary ? '용어집 편집' : '새 용어집';

    useEffect(() => {
        const dialog = dialogRef.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);

    useEffect(() => {
        if (!focusAddedTerm.current) return;
        focusAddedTerm.current = false;
        addedTermRef.current?.focus();
    }, [entries.length]);

    const addTerm = () => {
        focusAddedTerm.current = true;
        setEntries(current => [...current, { id: crypto.randomUUID(), canonical: '', use: 'summary', active: true }]);
    };

    const save = () => {
        const nextEntries = entries.map(entry => ({
            ...entry,
            canonical: normalizeMeetingKeyTerms([entry.canonical])[0] ?? '',
        }));
        const terms = nextEntries.map(entry => entry.canonical);
        const issue = !name.trim() ? '용어집 이름을 입력해 주세요.'
            : terms.includes('') ? '비어 있는 용어를 입력하거나 삭제해 주세요.'
                : new Set(terms).size !== terms.length ? '같은 용어는 한 번만 넣어 주세요.'
                    : meetingKeyTermsError(terms);
        if (issue) {
            setError(issue);
            return;
        }
        const next: TermGlossary = {
            ...glossary,
            id,
            name: name.trim(),
            category: glossary?.category || '회의',
            entries: nextEntries,
            builtIn: false,
        };
        try {
            onSave(next);
        } catch {
            setError('용어집을 저장할 수 없습니다. 브라우저의 저장 공간과 권한을 확인해 주세요.');
            return;
        }
    };

    const removeGlossary = () => {
        try {
            onDelete(id);
        } catch {
            setError('용어집을 삭제할 수 없습니다. 브라우저의 저장 공간과 권한을 확인해 주세요.');
            return;
        }
    };

    return createPortal(
        <dialog ref={dialogRef} className="app-dialog glossary-dialog" aria-labelledby={titleId}
            onCancel={event => { event.preventDefault(); onClose(); }}
            onKeyDown={event => {
                if (event.key === 'Tab' || event.key === 'Escape') event.stopPropagation();
            }}>
            <h2 id={titleId} className="app-dialog-title">{title}</h2>
            <form className="app-dialog-form" onSubmit={event => {
                event.preventDefault();
                if (!confirmDelete) save();
            }} onKeyDown={event => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            }}>
                <label htmlFor={nameId} className="app-dialog-label">용어집 이름</label>
                <Input id={nameId} value={name} onChange={event => { setName(event.target.value); setError(''); }} />
                <fieldset className="glossary-dialog-terms">
                    <legend>용어</legend>
                    {entries.map((entry, index) => (
                        <div key={entry.id} className="glossary-dialog-row">
                            <Input ref={index === entries.length - 1 ? addedTermRef : undefined}
                                aria-label={`용어 ${index + 1}`} value={entry.canonical}
                                onChange={event => {
                                    setEntries(current => current.map(item => item.id === entry.id
                                        ? { ...item, canonical: event.target.value } : item));
                                    setError('');
                                }} />
                            <IconButton variant="ghost" aria-label={`용어 ${index + 1} 삭제`} icon={<X size={16} />}
                                onClick={() => {
                                    setEntries(current => current.filter(item => item.id !== entry.id));
                                    addButtonRef.current?.focus();
                                    setError('');
                                }} />
                        </div>
                    ))}
                    <Button ref={addButtonRef} variant="outline" type="button" disabled={entries.length >= MAX_MEETING_KEY_TERMS}
                        onClick={addTerm}><Plus size={16} aria-hidden="true" />용어 추가</Button>
                </fieldset>
                {error && <p className="app-dialog-error" role="alert">{error}</p>}
                {confirmDelete && (
                    <div className="glossary-delete-confirm">
                        <p>이 용어집을 삭제할까요?</p>
                        <Button variant="outline" type="button" onClick={() => setConfirmDelete(false)}>삭제 취소</Button>
                        <Button variant="outline" type="button" onClick={removeGlossary}>용어집 삭제 확인</Button>
                    </div>
                )}
                <div className="app-dialog-actions">
                    {glossary && !glossary.builtIn && !confirmDelete && (
                        <Button className="glossary-delete-trigger" variant="ghost" type="button" onClick={() => setConfirmDelete(true)}>
                            <Trash2 size={16} aria-hidden="true" />삭제
                        </Button>
                    )}
                    <Button variant="outline" type="button" onClick={onClose}>취소</Button>
                    <Button type="submit" disabled={confirmDelete}>저장</Button>
                </div>
            </form>
        </dialog>,
        document.body,
    );
}
