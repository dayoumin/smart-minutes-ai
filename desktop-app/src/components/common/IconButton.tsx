import React from 'react';
import { Button, ButtonProps } from './Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
    icon: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(({
    icon,
    className = '',
    variant = 'outline',
    ...props
}, ref) => {
    return (
        <Button
            ref={ref}
            variant={variant}
            className={`icon-button ${className}`}
            {...props}
        >
            {icon}
        </Button>
    );
});

IconButton.displayName = 'IconButton';
