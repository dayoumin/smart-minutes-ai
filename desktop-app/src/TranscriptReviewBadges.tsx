import type { TranscriptReviewIssue } from './meetingRepository';
import { formatReviewTime, isTimingReview, reviewReasonLabels } from './transcriptReview';

interface Props {
    issues: TranscriptReviewIssue[];
    audioAvailable: boolean;
    onListen: (start: number, end: number) => void;
}

export const TranscriptReviewBadges = ({ issues, audioAvailable, onListen }: Props) => (
    <>
        {[true, false].map(timing => {
            const entries = issues.filter(issue => isTimingReview(issue) === timing);
            if (!entries.length) return null;
            return (
                <details className="script-review-details" key={String(timing)}>
                    <summary className="script-badge">{timing ? '시간 추정' : '참석자 확인 필요'}</summary>
                    <ul className="script-review-list" aria-label={timing ? '시간 확인 구간과 이유' : '참석자 확인 구간과 이유'}>
                        {entries.map(entry => (
                            <li key={`${entry.reason}:${entry.start}:${entry.end}`}>
                                <span className="script-review-range">{formatReviewTime(entry.start)}–{formatReviewTime(entry.end)}</span>
                                <span>{reviewReasonLabels[entry.reason]}</span>
                                <button type="button" className="script-review-listen" disabled={!audioAvailable || entry.end <= entry.start}
                                    onClick={() => onListen(entry.start, entry.end)}
                                    aria-label={`${formatReviewTime(entry.start)}부터 ${formatReviewTime(entry.end)}까지 듣기`}>이 구간 듣기</button>
                            </li>
                        ))}
                    </ul>
                </details>
            );
        })}
    </>
);
