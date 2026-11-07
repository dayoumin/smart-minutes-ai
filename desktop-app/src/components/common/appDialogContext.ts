import { createContext, useContext } from 'react';

export interface AppConfirmOptions {
    title: string;
    description?: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Destructive actions start focus on the cancel button and color the confirm button as an error. */
    tone?: 'default' | 'danger';
}

export interface AppChoiceOptions {
    title: string;
    description?: string;
    primaryLabel: string;
    secondaryLabel: string;
    cancelLabel?: string;
}

export interface AppPromptOptions {
    title: string;
    label: string;
    initialValue?: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Returns the inline error for a value that cannot be accepted, or null. Runs on the trimmed value. */
    validate?: (value: string) => string | null;
}

export type AppChoice = 'primary' | 'secondary' | null;

export interface AppDialogApi {
    confirm: (options: AppConfirmOptions) => Promise<boolean>;
    choose: (options: AppChoiceOptions) => Promise<AppChoice>;
    /** Resolves to the trimmed value, or null when cancelled. */
    prompt: (options: AppPromptOptions) => Promise<string | null>;
}

export const AppDialogContext = createContext<AppDialogApi | null>(null);

export const useAppDialog = (): AppDialogApi => {
    const api = useContext(AppDialogContext);
    if (!api) throw new Error('useAppDialog must be used inside AppDialogProvider.');
    return api;
};
