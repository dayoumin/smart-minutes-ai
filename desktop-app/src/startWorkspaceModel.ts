import type { AnalysisResumeDraft } from './analysisResumeDrafts';
import {
    isActionableResumeDraft,
    selectPrimaryRecoveryDraft,
    type AnalysisResumeSnapshot,
} from './analysisResumeState';
import type { MeetingRecord } from './meetingRepository';

export type StartWorkspaceScene = 'empty' | 'recent' | 'recovery';

export interface StartWorkspaceModel {
    scene: StartWorkspaceScene;
    recentMeeting: MeetingRecord | null;
    recoveryDraft: AnalysisResumeDraft | null;
    recoveryAction: 'resume' | 'refresh' | 'wait' | null;
}

const meetingTimestamp = (meeting: MeetingRecord): number => {
    const value = meeting.updatedAt || meeting.createdAt || meeting.date;
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
};

export const selectRecentMeeting = (meetings: MeetingRecord[]): MeetingRecord | null => (
    [...meetings].sort((left, right) => meetingTimestamp(right) - meetingTimestamp(left))[0] || null
);

export const createStartWorkspaceModel = (
    meetings: MeetingRecord[],
    recoverySnapshot: AnalysisResumeSnapshot,
): StartWorkspaceModel => {
    const recoveryDraft = selectPrimaryRecoveryDraft(recoverySnapshot);
    if (recoveryDraft) {
        const recoveryAction = isActionableResumeDraft(recoveryDraft, recoverySnapshot)
            ? 'resume'
            : recoverySnapshot.syncStatus === 'error'
                ? 'refresh'
                : 'wait';
        return {
            scene: 'recovery',
            recentMeeting: null,
            recoveryDraft,
            recoveryAction,
        };
    }

    const recentMeeting = selectRecentMeeting(meetings);
    return {
        scene: recentMeeting ? 'recent' : 'empty',
        recentMeeting,
        recoveryDraft: null,
        recoveryAction: null,
    };
};
