import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'outline';
}

export const Button: React.FC<ButtonProps> = ({
    variant = 'primary',
    type = 'button',
    className = '',
    children,
    ...props
}) => {
    return (
        <button type={type} className={`btn btn-${variant} ${className}`} {...props}>
            {children}
        </button>
    );
};