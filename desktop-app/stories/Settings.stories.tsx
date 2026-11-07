import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Settings } from '../src/Settings';
import { Button } from '../src/components/common';

function SettingsPreview() {
    const [open, setOpen] = useState(true);
    return <>
        <Button onClick={() => setOpen(true)}>설정 열기</Button>
        {open && <Settings onClose={() => setOpen(false)} />}
    </>;
}

const meta = {
    id: 'settings-screen',
    title: 'Settings/실제 설정 화면',
    component: SettingsPreview,
    parameters: {
        layout: 'fullscreen', settingsScenario: 'ready',
        docs: {
            story: { inline: false, height: '940px' },
            description: { component: '실제 Settings.tsx와 제품 CSS를 사용합니다. API는 모의 응답이며 실제 모델·설정·파일에 접근하지 않습니다. 외부 설치 링크도 열지 않습니다. 진행률은0.3%입니다. 중지·실패 예제는 약2초 뒤 진행 상태에서 전환하며, 창을 새로 연 뒤의 중지 상태 복원이나 실제 다운로드 검증이 아닙니다. 넓은 창과 좁은 데스크톱 창에서 함께 확인합니다.' },
        },
    },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
    name: '준비 완료 · 알림 생략',
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole('checkbox', { name: '음량 자동 보정' })).toBeChecked();
        await waitFor(() => expect(canvas.getByRole('checkbox', { name: '음량 자동 보정' })).toBeEnabled());
        await expect(canvas.queryByText('음량을 보정하지 않고 분석합니다.')).not.toBeInTheDocument();
    },
};
export const Missing: Story = { name: '처음 받기', parameters: { settingsScenario: 'missing' } };
export const Downloading: Story = { name: '받는 중 · 0.3%', parameters: { settingsScenario: 'downloading' } };
export const Paused: Story = { name: '중지됨 · 이어받기', parameters: { settingsScenario: 'paused' } };
export const Failed: Story = { name: '실패 · 복구 안내', parameters: { settingsScenario: 'failed' } };
export const RuntimeMissing: Story = { name: '실행 도구 준비 필요', parameters: { settingsScenario: 'runtime-missing' } };
export const Loading: Story = { name: '상태 확인 중', parameters: { settingsScenario: 'loading' } };
export const Paginated: Story = { name: '모델 여러 개 · 페이지 전환', parameters: { settingsScenario: 'many-models' } };
export const NormalizationOff: Story = {
    name: '음량 보정 끄기 · 인접 안내',
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const toggle = await canvas.findByRole('checkbox', { name: '음량 자동 보정' });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        await expect(await canvas.findByText('음량을 보정하지 않고 분석합니다.')).toBeVisible();
        await expect(toggle).not.toBeChecked();
        await userEvent.click(canvas.getByRole('button', { name: '음량 보정 안내 닫기' }));
        await expect(toggle).toHaveFocus();
    },
};
