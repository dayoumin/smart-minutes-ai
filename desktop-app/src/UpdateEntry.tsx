import { Download } from 'lucide-react';
import { useUpdateControls } from './UpdateContext';

export const UpdateEntry = ({ compact = false }: { compact?: boolean }) => {
    const { available, openGuide } = useUpdateControls();
    const label = available ? '새 업데이트 안내' : '업데이트 확인';
    return <button type="button" data-update-entry className={`relative ${compact ? 'sidebar-rail-button' : 'sidebar-utility-button'}`}
        aria-label={label} title={label} onClick={() => openGuide()}>
        <Download size={compact ? 18 : 15} aria-hidden="true" />
        {!compact && label}
        {available && <span className="sidebar-rail-dot" aria-hidden="true" />}
    </button>;
};
