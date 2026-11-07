import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/components/common';

const meta = { id: 'common-button', title: 'Common/버튼', component: Button, args: { children: 'AI 모델 받기' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'outline', children: '이어받기' } };
export const Disabled: Story = { args: { variant: 'outline', children: '중지 중', disabled: true } };
export const LongLabel: Story = { args: { variant: 'outline', children: '선택한 항목을 다시 확인하고 계속하기' } };
