import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TermGlossaryDialog } from '../src/TermGlossaryDialog';
import { Button } from '../src/components/common';
import type { TermGlossary } from '../src/meetingKnowledge';

const fixture: TermGlossary = {
    id: 'glossary-fixture', name: '기술 회의', category: '회의',
    entries: [{ id: 'term-fixture', canonical: '1,000톤', use: 'summary', active: true }],
};

function GlossaryExample({ failSave }: { failSave: boolean }) {
    const [open, setOpen] = useState(false);
    const [glossary, setGlossary] = useState<TermGlossary | undefined>(fixture);
    const close = () => setOpen(false);
    return <>
        <Button onClick={() => setOpen(true)}>{glossary ? '용어집 편집' : '새 용어집'}</Button>
        {open && <TermGlossaryDialog glossary={glossary} onClose={close} onSave={next => {
            if (failSave) throw new Error('Fixture storage error');
            setGlossary(next);
            close();
        }} onDelete={() => { setGlossary(undefined); close(); }} />}
    </>;
}

const meta = {
    id: 'common-term-glossary-dialog',
    title: 'Common/용어집',
    component: GlossaryExample,
    args: { failSave: false },
} satisfies Meta<typeof GlossaryExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Edit: Story = {};
export const SaveFailure: Story = { name: '저장 실패', args: { failSave: true } };
