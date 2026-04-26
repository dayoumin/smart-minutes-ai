import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <div className="flex h-screen bg-background text-foreground overflow-hidden">
            <Sidebar />
            <div className="flex flex-col flex-1 min-w-0">
                <Header />
                <main className="flex-1 overflow-auto p-6 custom-scrollbar bg-page">
                    {children}
                </main>
            </div>
        </div>
    );
};