import type { MeetingRecord } from './meetingRepository';

export type MeetingArchiveKind = 'decision' | 'action' | 'meeting';
export type MeetingArchiveFilter = 'decisions' | 'actions' | 'meetings' | 'all';

export interface MeetingArchiveItem {
    id: string;
    kind: MeetingArchiveKind;
    meetingId: string;
    meetingTitle: string;
    meetingDate: string;
    text: string;
    topics: string[];
    searchableText: string;
}

export interface MeetingArchiveQuery {
    query: string;
    filter: MeetingArchiveFilter;
    periodDays: number | null;
    now?: number;
}

const normalizeSearchText = (value: string): string => (
    value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
);

const meetingTimestamp = (meeting: MeetingRecord): number => {
    const raw = meeting.date || meeting.createdAt || '';
    const timestamp = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    return Number.isNaN(timestamp) ? 0 : timestamp;
};

const commonMeetingSearchText = (meeting: MeetingRecord): string => normalizeSearchText([
    meeting.title,
    meeting.date,
    meeting.summary,
    meeting.meetingPurpose,
    meeting.participants,
    ...(meeting.topics ?? []),
    ...(meeting.topicSections ?? []).flatMap(section => [
        section.topic,
        section.summary,
        ...(section.evidence ?? []),
    ]),
].filter(Boolean).join(' '));

export const buildMeetingArchiveItems = (meetings: MeetingRecord[]): MeetingArchiveItem[] => {
    const timestampByMeetingId = new Map(meetings.map(meeting => [meeting.id, meetingTimestamp(meeting)]));
    return meetings.flatMap(meeting => {
        const commonSearchText = commonMeetingSearchText(meeting);
        const itemContextSearchText = normalizeSearchText([
            meeting.title,
            meeting.date,
            meeting.participants,
        ].filter(Boolean).join(' '));
        const topics = Array.from(new Set([
            ...(meeting.topics ?? []),
            ...(meeting.topicSections ?? []).map(section => section.topic),
        ].filter(Boolean))).slice(0, 4);
        const base = {
            meetingId: meeting.id,
            meetingTitle: meeting.title || '제목 없는 회의',
            meetingDate: meeting.date || meeting.createdAt || '',
            topics,
        };
        const meetingItem: MeetingArchiveItem = {
            ...base,
            id: `meeting:${meeting.id}`,
            kind: 'meeting',
            text: meeting.summary?.trim() || meeting.meetingPurpose?.trim() || '회의록과 대화록을 확인하세요.',
            searchableText: commonSearchText,
        };
        const decisionItems = (meeting.decisions ?? []).filter(Boolean).map((decision, index): MeetingArchiveItem => ({
            ...base,
            id: `decision:${meeting.id}:${index}`,
            kind: 'decision',
            text: decision,
            searchableText: normalizeSearchText(`${decision} ${itemContextSearchText}`),
        }));
        const actionItems = (meeting.actions ?? []).filter(Boolean).map((action, index): MeetingArchiveItem => ({
            ...base,
            id: `action:${meeting.id}:${index}`,
            kind: 'action',
            text: action,
            searchableText: normalizeSearchText(`${action} ${itemContextSearchText}`),
        }));
        return [meetingItem, ...decisionItems, ...actionItems];
    }).sort((a, b) => {
        return (timestampByMeetingId.get(b.meetingId) ?? 0) - (timestampByMeetingId.get(a.meetingId) ?? 0);
    })
};

export const filterMeetingArchiveItems = (
    items: MeetingArchiveItem[],
    { query, filter, periodDays, now = Date.now() }: MeetingArchiveQuery,
): MeetingArchiveItem[] => {
    const normalizedQuery = normalizeSearchText(query);
    const cutoff = periodDays === null ? null : now - periodDays * 86_400_000;
    return items.filter(item => {
        if (filter === 'decisions' && item.kind !== 'decision') return false;
        if (filter === 'actions' && item.kind !== 'action') return false;
        if (filter === 'meetings' && item.kind !== 'meeting') return false;
        if (normalizedQuery && !item.searchableText.includes(normalizedQuery)) return false;
        if (cutoff !== null) {
            const timestamp = Date.parse(item.meetingDate.includes('T')
                ? item.meetingDate
                : item.meetingDate.replace(' ', 'T'));
            if (Number.isNaN(timestamp) || timestamp < cutoff) return false;
        }
        return true;
    });
};

export const countMeetingArchiveKinds = (items: MeetingArchiveItem[]) => ({
    meetings: items.filter(item => item.kind === 'meeting').length,
    decisions: items.filter(item => item.kind === 'decision').length,
    actions: items.filter(item => item.kind === 'action').length,
});
