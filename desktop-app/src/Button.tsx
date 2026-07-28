import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({
    variant = 'primary',
    type = 'button',
    className = '',
    children,
    ...props
}, ref) => {
    return (
        <button ref={ref} type={type} className={`btn btn-${variant} ${className}`} {...props}>
            {children}
        </button>
    );
});

Button.displayName = 'Button';
