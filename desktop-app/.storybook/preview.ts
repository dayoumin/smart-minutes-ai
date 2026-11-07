import type { Preview } from '@storybook/react-vite';
import '../src/index.css';
import './preview.css';
import { installStoryNetworkFence, configureSettingsScenario } from '../stories/settingsScenario';

// The catalogue must never contact a real local engine, even for an unhandled API.
installStoryNetworkFence();

const preview: Preview = {
    tags: ['autodocs'],
    beforeEach: context => configureSettingsScenario(context.parameters.settingsScenario),
    parameters: {
        layout: 'padded',
        a11y: { test: 'error' },
        options: { storySort: { order: ['Guide', 'Common', 'Settings'] } },
    },
};

export default preview;
