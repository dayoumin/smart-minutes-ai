import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppToast, StatusBanner, Button } from '../src/components/common';

const meta = {
    id: 'common-feedback',
    title: 'Common/안내 선택',
    decorators: [Story => <div className="story-feedback"><Story /></div>],
    parameters: { docs: { description: { component: '표시를 생략할지 먼저 판단합니다. 일시 결과는 맥락 가까이에, 복구가 필요한 오류는 해당 항목에 유지합니다. AppToast는 모양만 제공하며 인접 배치·수명·초점 처리는 포함하지 않습니다. 실제 인접 동작은 Settings의 음량 보정 예제를 확인합니다.' } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Transient: Story = {
    name: '짧은 결과 · 모양만 확인',
    render: () => <AppToast message="복사했습니다." onClose={fn()} />,
};
export const Recovery: Story = {
    name: '지속 오류 · 다음 행동',
    render: () => <StatusBanner tone="error" action={<Button variant="outline" onClick={fn()}>다시 시도</Button>}>받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.</StatusBanner>,
};
export const Connection: Story = {
    name: '공통 문제 · 연결 상태',
    render: () => <StatusBanner tone="warning">음성 분석 연결이 끊겼습니다. 연결 상태를 확인해 주세요.</StatusBanner>,
};
