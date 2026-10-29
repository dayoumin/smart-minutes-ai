import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
    stories: ['../stories/**/*.mdx', '../stories/**/*.stories.@(ts|tsx)'],
    addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
    framework: { name: '@storybook/react-vite', options: {} },
    staticDirs: [{ from: '../public/fonts', to: '/fonts' }],
    core: { disableTelemetry: true },
    // Only the fonts above belong in this catalogue, not app public assets.
    viteFinal: config => ({ ...config, publicDir: false }),
};

export default config;
