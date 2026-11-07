import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProgressBar } from '../src/components/common';

const meta = {
    id: 'common-progress',
    title: 'Common/진행률', component: ProgressBar,
    args: { value: 0.3, size: 'sm', label: '모델 받기 진행률' },
    decorators: [Story => <div className="story-progress"><Story /></div>],
} satisfies Meta<typeof ProgressBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Beginning: Story = { name: '받는 중 · 0.3%' };
export const InProgress: Story = { name: '진행 중', args: { value: 48 } };
export const Completed: Story = { name: '완료', args: { value: 100 } };
