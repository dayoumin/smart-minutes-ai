import React from 'react';
import { Button, ButtonProps } from './Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
    icon: React.ReactNode;
}

export const IconButton: React.FC<IconButtonProps> = ({
    icon,
    className = '',
    variant = 'outline',
    ...props
}) => {
    return (
        <Button
            variant={variant}
            className={`inline-flex h-10 w-10 items-center justify-center p-0 ${className}`}
            {...props}
        >
            {icon}
        </Button>
    );
};

