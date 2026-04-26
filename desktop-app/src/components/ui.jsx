import React from 'react';
import './components.css';

export function Card({ children, className = '', ...props }) {
  return (
    <div className={`glass-panel card-container ${className}`} {...props}>
      {children}
    </div>
  );
}

export function Button({ children, variant = 'primary', icon: Icon, className = '', ...props }) {
  return (
    <button className={`btn btn-${variant} ${className}`} {...props}>
      {Icon && <Icon size={18} />}
      {children}
    </button>
  );
}

export function ProgressBar({ progress, label, status }) {
  return (
    <div className="progress-container">
      <div className="progress-header">
        <span className="progress-label">{label}</span>
        <span className="progress-status">{status || `${progress}%`}</span>
      </div>
      <div className="progress-bar-bg">
        <div 
          className="progress-bar-fill" 
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}
