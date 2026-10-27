export const SUMMARY_MODEL_PINS_STORAGE_KEY = 'smart-minutes-summary-model-pins-v2';
export const MAX_SUMMARY_MODEL_PINS = 4;

/** null waits for the first confirmed inventory; [] is an explicit user choice. */
export const getSummaryModelPins = (): string[] | null => {
    try {
        const raw = window.localStorage.getItem(SUMMARY_MODEL_PINS_STORAGE_KEY);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string' && value.trim())) return null;
        return [...new Set(parsed.map(value => value.trim()))].slice(0, MAX_SUMMARY_MODEL_PINS);
    } catch { return null; }
};

export const resolveSummaryModelPins = (stored: string[] | null, installed: string[]): string[] => {
    const available = new Set(installed);
    return [...new Set(stored === null ? installed : stored.filter(model => available.has(model)))].slice(0, MAX_SUMMARY_MODEL_PINS);
};

export const saveSummaryModelPins = (models: string[]): boolean => {
    try {
        window.localStorage.setItem(SUMMARY_MODEL_PINS_STORAGE_KEY, JSON.stringify(models.slice(0, MAX_SUMMARY_MODEL_PINS)));
        return true;
    } catch { return false; }
};
