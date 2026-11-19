import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppDialogProvider, Button, useAppDialog } from '../src/components/common';

const DialogExample = ({ title }: { title: string }) => {
    const dialog = useAppDialog();
    const [result, setResult] = useState('');
    return <>
        <Button onClick={async () => setResult(await dialog.confirm({
            title,
            description: '회의 기록과 이 PC의 분석 결과가 함께 삭제됩니다. 이 예제에서는 실제 자료를 삭제하지 않습니다.',
            confirmLabel: '삭제',
            tone: 'danger',
        }) ? '확인했습니다. 실제 자료는 삭제하지 않았습니다.' : '취소했습니다.')}>확인창 열기</Button>
        <p role="status">{result}</p>
    </>;
};

const meta = {
    id: 'common-app-dialog',
    title: 'Common/확인창',
    component: DialogExample,
    decorators: [Story => <AppDialogProvider><Story /></AppDialogProvider>],
    args: { title: '"정기 회의" 회의록을 삭제할까요?' },
} satisfies Meta<typeof DialogExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongTitle: Story = {
    name: '긴 제목 · 스크롤',
    args: { title: `"${'회의제목'.repeat(250)}" 회의록을 삭제할까요?` },
};
