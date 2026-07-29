import React from 'react';
import { AudioLines } from 'lucide-react';

export const Header: React.FC = () => {
    return (
        <header className="app-header">
            <span className="app-brand-mark" aria-hidden="true"><AudioLines size={19} /></span>
            <span className="app-brand-copy">
                <strong>바로록</strong>
                <small>개인용 로컬 회의록</small>
            </span>
        </header>
    );
};
