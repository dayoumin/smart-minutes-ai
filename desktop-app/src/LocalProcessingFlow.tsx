import React from 'react';
import { ArrowRight, AudioLines, FileAudio, FileText } from 'lucide-react';

const STEPS = [
    { label: '영상·음성', Icon: FileAudio },
    { label: '이 PC에서 처리', Icon: AudioLines },
    { label: '대화록·회의 요약', Icon: FileText },
] as const;

/**
 * The writer's local-processing promise as a picture: everything happens inside this PC, nothing goes to an outside AI.
 * Read as one image so screen readers hear one sentence instead of scattered labels.
 */
export const LocalProcessingFlow: React.FC = () => (
    <div
        className="local-flow local-flow-illustration"
        role="img"
        aria-label="이 PC 안에서 영상·음성 분석부터 대화록·요약까지 처리"
    >
        <div className="local-illustration-screen">
            <div className="local-illustration-steps">
                {STEPS.map(({ label, Icon }, index) => (
                    <span className="local-illustration-step" key={label}>
                        <span className="local-illustration-node">
                            <Icon size={24} aria-hidden="true" />
                        </span>
                        <span className="local-illustration-label">
                            {index === 1 ? <>이 PC에서<br />처리</> : index === 2 ? <>대화록·<br />회의 요약</> : label}
                        </span>
                        {index < STEPS.length - 1 && <ArrowRight size={14} className="local-illustration-arrow" aria-hidden="true" />}
                    </span>
                ))}
            </div>
        </div>
        <svg className="local-illustration-base" viewBox="0 0 288 34" aria-hidden="true">
            <path className="local-laptop-deck" d="M13 1H275L287 24H1Z" />
            <path className="local-laptop-keys" d="M27 5H261L268 16H20Z" />
            <path className="local-laptop-key-lines" d="M25 9H264M23 13H266M46 5L43 16M68 5L66 16M90 5L89 16M112 5L111 16M134 5V16M156 5V16M178 5L179 16M200 5L201 16M222 5L224 16M244 5L247 16" />
            <path className="local-laptop-trackpad" d="M117 19H171L173 23H115Z" />
            <path className="local-laptop-lip" d="M1 24H287L281 29Q280 31 275 31H13Q8 31 7 29Z" />
        </svg>
    </div>
);
