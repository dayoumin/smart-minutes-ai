export type DownloadFormat = 'hwpx' | 'txt' | 'docx';

export const DEFAULT_DOWNLOAD_FORMAT: DownloadFormat = 'hwpx';
export const DOWNLOAD_FORMAT_STORAGE_KEY = 'smart-minutes-download-format';

export const isDownloadFormat = (value: unknown): value is DownloadFormat =>
    value === 'hwpx' || value === 'txt' || value === 'docx';

export const getDownloadFormatPreference = (): DownloadFormat => {
    if (typeof window === 'undefined') return DEFAULT_DOWNLOAD_FORMAT;

    const stored = window.localStorage.getItem(DOWNLOAD_FORMAT_STORAGE_KEY);
    return isDownloadFormat(stored) ? stored : DEFAULT_DOWNLOAD_FORMAT;
};

export const setDownloadFormatPreference = (format: DownloadFormat) => {
    window.localStorage.setItem(DOWNLOAD_FORMAT_STORAGE_KEY, format);
};
