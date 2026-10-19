const INTRO_SEEN_STORAGE_KEY = 'localProcessingIntroSeen';
// Keeps the intro from reappearing on remount when browser storage is blocked.
let introSeenThisSession = false;

export const hasSeenLocalProcessingIntro = (): boolean => {
    if (introSeenThisSession) return true;
    try {
        return window.localStorage.getItem(INTRO_SEEN_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

export const markLocalProcessingIntroSeen = (): void => {
    introSeenThisSession = true;
    try {
        window.localStorage.setItem(INTRO_SEEN_STORAGE_KEY, '1');
    } catch {
        // The session flag still prevents a repeat in this tab.
    }
};
