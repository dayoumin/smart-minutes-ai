import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, FileText, ListChecks, RotateCw, Search } from 'lucide-react';
import { getAllMeetings, MeetingRecord } from './meetingRepository';
import {
    buildMeetingArchiveItems,
    countMeetingArchiveKinds,
    filterMeetingArchiveItems,
    MeetingArchiveFilter,
    MeetingArchiveItem,
} from './meetingArchiveModel';

interface MeetingArchiveProps {
    active: boolean;
    onOpenMeeting: (meetingId: string) => void;
}

const filterOptions: Array<{ value: MeetingArchiveFilter; label: string }> = [
    { value: 'decisions', label: '결정' },
    { value: 'actions', label: '할 일' },
    { value: 'meetings', label: '회의록' },
    { value: 'all', label: '전체' },
];

const formatArchiveDate = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '날짜 미정';
    return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(date);
};

const kindLabel: Record<MeetingArchiveItem['kind'], string> = {
    decision: '결정',
    action: '할 일',
    meeting: '회의록',
};

const kindIcon = (kind: MeetingArchiveItem['kind']) => {
    if (kind === 'decision') return <CheckCircle2 size={15} aria-hidden="true" />;
    if (kind === 'action') return <ListChecks size={15} aria-hidden="true" />;
    return <FileText size={15} aria-hidden="true" />;
};

const highlightText = (text: string, query: string): React.ReactNode => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return text;
    const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, index) => part.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase()
        ? <mark key={`${part}-${index}`} className="archive-search-highlight">{part}</mark>
        : part);
};

export const MeetingArchive: React.FC<MeetingArchiveProps> = ({ active, onOpenMeeting }) => {
    const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<MeetingArchiveFilter>('decisions');
    const [periodDays, setPeriodDays] = useState<number | null>(null);

    const loadMeetings = useCallback(async () => {
        setLoaded(false);
        setLoadError(null);
        try {
            setMeetings(await getAllMeetings());
        } catch {
            setLoadError('저장된 회의 기록을 불러오지 못했습니다.');
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!active) return undefined;
        void loadMeetings();
        const handleMeetingsUpdated = () => void loadMeetings();
        window.addEventListener('meetings:updated', handleMeetingsUpdated);
        return () => window.removeEventListener('meetings:updated', handleMeetingsUpdated);
    }, [active, loadMeetings]);

    const archiveItems = useMemo(() => buildMeetingArchiveItems(meetings), [meetings]);
    const counts = useMemo(() => countMeetingArchiveKinds(archiveItems), [archiveItems]);
    const visibleItems = useMemo(() => filterMeetingArchiveItems(archiveItems, {
        query,
        filter,
        periodDays,
    }), [archiveItems, filter, periodDays, query]);
    const visibleLabel = filterOptions.find(option => option.value === filter)?.label ?? '기록';

    return (
        <section className="meeting-archive" aria-labelledby="meeting-archive-title">
            <header className="meeting-archive-header">
                <div>
                    <h1 id="meeting-archive-title">기록 찾기</h1>
                    <p>여러 회의에 흩어진 결정과 할 일을 날짜순으로 확인합니다.</p>
                </div>
                <dl className="meeting-archive-counts" aria-label="저장된 기록 요약">
                    <div><dt>회의</dt><dd>{counts.meetings}</dd></div>
                    <div><dt>결정</dt><dd>{counts.decisions}</dd></div>
                    <div><dt>할 일</dt><dd>{counts.actions}</dd></div>
                </dl>
            </header>

            <div className="app-panel meeting-archive-controls">
                <div className="meeting-archive-search-field">
                    <Search size={18} aria-hidden="true" />
                    <label className="sr-only" htmlFor="meeting-archive-search">선택한 종류의 기록 검색</label>
                    <input
                        id="meeting-archive-search"
                        type="search"
                        value={query}
                        placeholder="제목, 기록 내용, 참석자 검색"
                        onChange={event => setQuery(event.target.value)}
                    />
                </div>
                <label className="meeting-archive-period-field">
                    <CalendarDays size={16} aria-hidden="true" />
                    <span className="sr-only">기간</span>
                    <select
                        value={periodDays ?? ''}
                        onChange={event => setPeriodDays(event.target.value ? Number(event.target.value) : null)}
                    >
                        <option value="">전체 기간</option>
                        <option value="30">최근 30일</option>
                        <option value="180">최근 6개월</option>
                        <option value="365">최근 1년</option>
                    </select>
                </label>
                <div className="meeting-archive-filter-list" aria-label="기록 종류">
                    {filterOptions.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            className={filter === option.value ? 'meeting-archive-filter-active' : ''}
                            aria-pressed={filter === option.value}
                            onClick={() => setFilter(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="meeting-archive-result-heading" aria-live="polite">
                <h2>{visibleLabel}</h2>
                <span>{visibleItems.length}건</span>
            </div>

            {!loaded ? (
                <div className="empty-state" aria-busy="true">기록을 불러오고 있습니다.</div>
            ) : loadError ? (
                <div className="empty-state meeting-archive-error" role="alert">
                    <p>{loadError}</p>
                    <button type="button" className="btn btn-outline" onClick={() => void loadMeetings()}>
                        <RotateCw size={15} aria-hidden="true" /> 다시 확인
                    </button>
                </div>
            ) : visibleItems.length === 0 ? (
                <div className="empty-state meeting-archive-empty">
                    <strong>{query ? '검색 결과가 없습니다.' : `${visibleLabel} 기록이 없습니다.`}</strong>
                    <p>{query ? '검색어나 기간을 바꿔 보세요.' : '회의 상세에서 기록 정리를 만들면 이곳에 모아 볼 수 있습니다.'}</p>
                </div>
            ) : (
                <ol className="meeting-archive-timeline" aria-label={`${visibleLabel} 검색 결과`}>
                    {visibleItems.map(item => (
                        <li key={item.id} className={`meeting-archive-item meeting-archive-item-${item.kind}`}>
                            <span className="meeting-archive-marker" aria-hidden="true" />
                            <button type="button" onClick={() => onOpenMeeting(item.meetingId)}>
                                <span className="meeting-archive-item-meta">
                                    <span className={`meeting-archive-kind meeting-archive-kind-${item.kind}`}>
                                        {kindIcon(item.kind)} {kindLabel[item.kind]}
                                    </span>
                                    <time dateTime={item.meetingDate}>{formatArchiveDate(item.meetingDate)}</time>
                                </span>
                                <strong>{highlightText(item.text, query)}</strong>
                                <span className="meeting-archive-source">
                                    {highlightText(item.meetingTitle, query)}
                                    <ArrowRight size={14} aria-hidden="true" />
                                </span>
                                {item.topics.length > 0 && (
                                    <span className="meeting-archive-topics" aria-label="회의 주제">
                                        {item.topics.map(topic => <span key={topic}>{highlightText(topic, query)}</span>)}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
};
