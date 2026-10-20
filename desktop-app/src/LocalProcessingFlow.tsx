import React from 'react';
import { ArrowRight, AudioLines, CloudOff, FileAudio, FileText, Laptop } from 'lucide-react';

const STEPS = [
    { label: '영상·음성', Icon: FileAudio },
    { label: '분석', Icon: AudioLines },
    { label: '대화록·요약', Icon: FileText },
] as const;

/**
 * The writer's local-processing promise as a picture: everything happens inside this PC, nothing goes to an outside AI.
 * Read as one image so screen readers hear one sentence instead of scattered labels.
 */
export const LocalProcessingFlow: React.FC = () => (
    <div
        className="local-flow"
        role="img"
        aria-label="이 PC 안에서 영상·음성 분석부터 대화록·요약까지 처리"
    >
        <div className="local-flow-pc">
            <span className="local-flow-step local-flow-pc-label">
                <span className="local-flow-node local-flow-node-plain">
                    <Laptop size={17} aria-hidden="true" />
                </span>
                이 PC 안에서
            </span>
            <span className="local-flow-divider" aria-hidden="true" />
            {STEPS.map(({ label, Icon }, index) => (
                <React.Fragment key={label}>
                    {index > 0 && <ArrowRight size={12} className="local-flow-arrow" aria-hidden="true" />}
                    <span className="local-flow-step">
                        <span className="local-flow-node">
                            <Icon size={15} aria-hidden="true" />
                        </span>
                        {label}
                    </span>
                </React.Fragment>
            ))}
        </div>
        <span className="local-flow-step local-flow-out">
            <span className="local-flow-node local-flow-node-off">
                <CloudOff size={15} aria-hidden="true" />
            </span>
            외부 AI 전송 없음
        </span>
    </div>
);
