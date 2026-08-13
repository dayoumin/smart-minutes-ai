import React from 'react';

export type OceanBackdropTone = 'immersive' | 'calm';

interface OceanBackdropProps {
    tone?: OceanBackdropTone;
}

export const OceanBackdrop: React.FC<OceanBackdropProps> = ({ tone = 'immersive' }) => (
    <div className="ocean-backdrop" data-tone={tone} aria-hidden="true">
        <div className="ocean-backdrop-contrast" />
    </div>
);
