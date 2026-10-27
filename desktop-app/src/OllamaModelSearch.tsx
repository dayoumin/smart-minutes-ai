import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './components/common';

interface OllamaModelSearchProps {
    value: string;
    inputRef: React.Ref<HTMLInputElement>;
    onChange: (value: string) => void;
    onSearch: () => void;
    searching: boolean;
}

/** Search only. Registration, downloads and selection belong to their own steps. */
export const OllamaModelSearch: React.FC<OllamaModelSearchProps> = ({ value, inputRef, onChange, onSearch, searching }) => (
    <form className="settings-model-search" onSubmit={event => { event.preventDefault(); onSearch(); }}>
        <input ref={inputRef} aria-label="요약 모델 검색" value={value}
            onChange={event => onChange(event.target.value)} placeholder="요약 모델 검색"
            maxLength={128} className="input-field" />
        <Button type="submit" variant="outline" className="h-9 min-w-16 shrink-0 px-3 text-xs"
            disabled={!value.trim() || searching} aria-label="검색">
            {searching ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : '검색'}
        </Button>
    </form>
);
