import { createContext, useContext } from 'react';

export interface UpdateControls {
    available: boolean;
    openGuide: (purpose?: 'install' | 'update') => void;
}

export const UpdateContext = createContext<UpdateControls>({ available: false, openGuide: () => undefined });
export const useUpdateControls = (): UpdateControls => useContext(UpdateContext);
