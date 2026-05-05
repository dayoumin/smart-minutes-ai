import React from 'react';
import { Settings } from 'lucide-react';

interface AnalysisStatus {
    active: boolean;
    progress: number;
    message: string;
}

interface HeaderProps {
    onOpenSettings?: () => void;
    analysisStatus?: AnalysisStatus;
    onShowAnalysis?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenSettings, analysisStatus, onShowAnalysis }) => {
    return (
        <header className="h-16 border-b border-border flex items-center justify-between px-6 glass-card border-x-0 border-t-0 rounded-none z-10 relative">
            <h1 className="text-h3 text-primary">Smart Minutes AI</h1>

            <div className="flex items-center gap-3">
                {analysisStatus?.active && (
                    <button
                        type="button"
                        onClick={onShowAnalysis}
                        className="hidden min-w-48 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-left text-xs text-blue-800 shadow-sm transition-colors hover:bg-blue-100 sm:block"
                        title={analysisStatus.message || '분석 진행 중'}
                        aria-label="진행 중인 분석 보기"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">분석 중</span>
                            <span>{analysisStatus.progress}%</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-blue-100">
                            <div
                                className="h-full rounded-full bg-blue-600 transition-all duration-300"
                                style={{ width: `${analysisStatus.progress}%` }}
                            />
                        </div>
                    </button>
                )}
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted/40 hover:text-primary"
                    title="시스템 설정"
                    aria-label="시스템 설정"
                >
                    <Settings size={18} />
                </button>
            </div>
        </header>
    );
};
