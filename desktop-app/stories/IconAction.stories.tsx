import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Mail } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { TooltipIconButton } from '../src/components/common';

const meta = {
    id: 'common-icon-action', title: 'Common/설명 있는 아이콘 버튼', component: TooltipIconButton,
    args: { 'aria-label': 'AI 모델 받기', tooltip: 'AI 모델 받기', icon: <Download size={16} aria-hidden="true" /> },
} satisfies Meta<typeof TooltipIconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DownloadAction: Story = {
    name: '모델 받기 · 키보드 설명',
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.tab();
        await expect(canvas.getByRole('button', { name: 'AI 모델 받기' })).toHaveFocus();
        await expect(await page.findByRole('tooltip')).toHaveTextContent('AI 모델 받기');
        await userEvent.keyboard('{Escape}');
        await expect(page.queryByRole('tooltip')).not.toBeInTheDocument();
    },
};
export const Contact: Story = { name: '문의', args: { 'aria-label': '문의 연락처 보기', tooltip: '문의', icon: <Mail size={16} aria-hidden="true" /> } };
export const Disabled: Story = { name: '받기 불가', args: { disabled: true } };
