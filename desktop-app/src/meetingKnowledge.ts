export type TermGlossaryUse = 'summary' | 'correction' | 'both';

export interface TermGlossaryEntry {
    id: string;
    canonical: string;
    variants?: string[];
    description?: string;
    use: TermGlossaryUse;
    active: boolean;
}

export interface TermGlossary {
    id: string;
    name: string;
    category: string;
    description?: string;
    entries: TermGlossaryEntry[];
    builtIn?: boolean;
}

export interface ContextTemplate {
    id: string;
    name: string;
    purpose: string;
    prompt?: string;
    termGlossaryIds: string[];
    focus: string[];
    updatedAt?: string;
    builtIn?: boolean;
}

export interface ReportTemplate {
    id: string;
    name: string;
    purpose: string;
    instructions?: string;
    sections: string[];
    requiredSections: string[];
    optionalSections: string[];
    tone: 'minutes' | 'review' | 'report';
    detailLevel: 'concise' | 'standard' | 'detailed';
    updatedAt?: string;
    builtIn?: boolean;
}

const TERM_GLOSSARIES_STORAGE_KEY = 'meetingTermGlossaries';
const CONTEXT_TEMPLATES_STORAGE_KEY = 'meetingContextTemplates';
const REPORT_TEMPLATES_STORAGE_KEY = 'meetingReportTemplates';

export const DEFAULT_REPORT_TEMPLATE_ID = 'standard-minutes';
export const DEFAULT_CONTEXT_TEMPLATE_ID = 'general';
export const DEFAULT_MINUTES_OUTPUT_TEMPLATE_ID = 'archive-minutes';
export const MAX_CUSTOM_CONTEXT_TEMPLATES = 10;
export const MAX_CUSTOM_REPORT_TEMPLATES = 10;

export const DEFAULT_CONTEXT_TEMPLATES: ContextTemplate[] = [
    {
        id: 'general',
        name: '일반 회의',
        purpose: '분야가 정해지지 않은 일반 회의 정리입니다.',
        termGlossaryIds: [],
        focus: ['주요 논의', '결정사항', '할 일', '확인 필요'],
        builtIn: true,
    },
    {
        id: 'lmo-review',
        name: 'LMO 심사',
        purpose: 'LMO 심사, 위해성 평가, 기관 심의 회의에서 표기와 쟁점을 맞춥니다.',
        termGlossaryIds: ['lmo'],
        focus: ['심사 안건', '위해성 평가', '보완 요청', '결정사항'],
        builtIn: true,
    },
    {
        id: 'fishery-resources-review',
        name: '수산자원 검토',
        purpose: '수산자원, 어업 관리, 자원 조사 회의에서 용어와 맥락을 맞춥니다.',
        termGlossaryIds: ['fishery-resources'],
        focus: ['자원 현황', '관리 쟁점', '조사 결과', '후속 조치'],
        builtIn: true,
    },
];

export const DEFAULT_REPORT_TEMPLATES: ReportTemplate[] = [
    {
        id: 'standard-minutes',
        name: '기본 보고서',
        purpose: '기록 정리를 바탕으로 보고 개요, 주요 논의, 결정사항, 후속 조치를 정리합니다.',
        sections: ['보고 개요', '주요 논의', '결정사항', '후속 조치', '확인 필요'],
        requiredSections: ['보고 개요', '주요 논의'],
        optionalSections: ['결정사항', '후속 조치', '확인 필요'],
        tone: 'report',
        detailLevel: 'standard',
        builtIn: true,
    },
];

export const FOLLOW_UP_OUTPUT_TEMPLATES: ReportTemplate[] = [
    {
        id: 'archive-minutes',
        name: '대화 보관용 회의록',
        purpose: '1차 기본 회의록을 바탕으로 대화 흐름과 발언 맥락을 보관하기 좋게 정리합니다.',
        sections: ['회의 개요', '대화 흐름', '참석자별 주요 발언', '결정사항', '확인 필요'],
        requiredSections: ['회의 개요', '대화 흐름', '참석자별 주요 발언'],
        optionalSections: ['결정사항', '확인 필요'],
        tone: 'minutes',
        detailLevel: 'detailed',
        builtIn: true,
    },
    {
        id: 'report-ready-minutes',
        name: '보고서용 정리 회의록',
        purpose: '1차 기본 회의록을 바탕으로 보고 양식에 맞춰 핵심 내용과 후속 조치를 재가공합니다.',
        sections: ['보고 개요', '주요 논의', '결정사항', '후속 조치', '보고 참고사항'],
        requiredSections: ['보고 개요', '주요 논의'],
        optionalSections: ['결정사항', '후속 조치', '보고 참고사항'],
        tone: 'report',
        detailLevel: 'concise',
        builtIn: true,
    },
];

export const DEFAULT_TERM_GLOSSARIES: TermGlossary[] = [
    {
        id: 'lmo',
        name: 'LMO',
        category: 'LMO',
        description: 'LMO 심사, 위해성 평가, 기관 심의 회의에서 자주 쓰는 용어입니다.',
        builtIn: true,
        entries: [
            {
                id: 'lmo-term',
                canonical: 'LMO',
                variants: ['엘엠오', '엘 모', 'LM 오'],
                description: '유전자변형생물체 관련 용어. 보고서에서는 LMO 표기를 우선 사용합니다.',
                use: 'both',
                active: true,
            },
            {
                id: 'risk-assessment',
                canonical: '위해성 평가',
                variants: ['위해성평가', '위해성 검토'],
                description: 'LMO 안전성 검토의 핵심 평가 항목입니다.',
                use: 'both',
                active: true,
            },
        ],
    },
    {
        id: 'fishery-resources',
        name: '수산자원',
        category: '수산자원',
        description: '수산자원, 어업, 자원관리 회의에서 자주 쓰는 용어입니다.',
        builtIn: true,
        entries: [
            {
                id: 'fishery-resources-term',
                canonical: '수산자원',
                variants: ['수산 자원', '수산지원'],
                description: '수산 생물과 어업 관리 대상 자원을 뜻합니다.',
                use: 'both',
                active: true,
            },
        ],
    },
];

const parseGlossaries = (value: string | null): TermGlossary[] | null => {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((item): item is TermGlossary => (
            Boolean(item)
            && typeof item === 'object'
            && typeof (item as TermGlossary).id === 'string'
            && typeof (item as TermGlossary).name === 'string'
            && Array.isArray((item as TermGlossary).entries)
        ));
    } catch {
        return null;
    }
};

const parseContextTemplates = (value: string | null): ContextTemplate[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is ContextTemplate => (
            Boolean(item)
            && typeof item === 'object'
            && typeof (item as ContextTemplate).id === 'string'
            && typeof (item as ContextTemplate).name === 'string'
            && typeof (item as ContextTemplate).purpose === 'string'
        )).map(template => ({
            ...template,
            termGlossaryIds: Array.isArray(template.termGlossaryIds) ? template.termGlossaryIds : [],
            focus: Array.isArray(template.focus) ? template.focus : [],
            builtIn: false,
        }));
    } catch {
        return [];
    }
};

const parseReportTemplates = (value: string | null): ReportTemplate[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is ReportTemplate => (
            Boolean(item)
            && typeof item === 'object'
            && typeof (item as ReportTemplate).id === 'string'
            && typeof (item as ReportTemplate).name === 'string'
            && typeof (item as ReportTemplate).purpose === 'string'
            && Array.isArray((item as ReportTemplate).sections)
        )).map(template => ({
            ...template,
            instructions: typeof template.instructions === 'string' ? template.instructions : undefined,
            requiredSections: Array.isArray(template.requiredSections) ? template.requiredSections : template.sections,
            optionalSections: Array.isArray(template.optionalSections) ? template.optionalSections : [],
            tone: template.tone ?? 'report',
            detailLevel: template.detailLevel ?? 'standard',
            builtIn: false,
        }));
    } catch {
        return [];
    }
};

const cloneReportTemplate = (template: ReportTemplate): ReportTemplate => ({
    ...template,
    sections: [...template.sections],
    requiredSections: [...template.requiredSections],
    optionalSections: [...template.optionalSections],
});

const cloneContextTemplate = (template: ContextTemplate): ContextTemplate => ({
    ...template,
    termGlossaryIds: [...template.termGlossaryIds],
    focus: [...template.focus],
});

const cloneTermGlossary = (glossary: TermGlossary): TermGlossary => ({
    ...glossary,
    entries: glossary.entries.map(entry => ({
        ...entry,
        variants: entry.variants ? [...entry.variants] : undefined,
    })),
});

export const listReportTemplates = (): ReportTemplate[] => {
    const builtIns = DEFAULT_REPORT_TEMPLATES.map(cloneReportTemplate);
    if (typeof window === 'undefined') return builtIns;
    const stored = parseReportTemplates(window.localStorage.getItem(REPORT_TEMPLATES_STORAGE_KEY));
    return [...builtIns, ...stored.map(cloneReportTemplate)];
};

export const listCustomReportTemplates = (): ReportTemplate[] => {
    if (typeof window === 'undefined') return [];
    return parseReportTemplates(window.localStorage.getItem(REPORT_TEMPLATES_STORAGE_KEY))
        .map(cloneReportTemplate);
};

export const listContextTemplates = (): ContextTemplate[] => {
    const builtIns = DEFAULT_CONTEXT_TEMPLATES.map(cloneContextTemplate);
    if (typeof window === 'undefined') return builtIns;
    const stored = parseContextTemplates(window.localStorage.getItem(CONTEXT_TEMPLATES_STORAGE_KEY));
    return [...builtIns, ...stored.map(cloneContextTemplate)];
};

export const listCustomContextTemplates = (): ContextTemplate[] => {
    if (typeof window === 'undefined') return [];
    return parseContextTemplates(window.localStorage.getItem(CONTEXT_TEMPLATES_STORAGE_KEY))
        .map(cloneContextTemplate);
};

export const getContextTemplateById = (templateId?: string): ContextTemplate => (
    cloneContextTemplate(listContextTemplates().find(template => template.id === templateId)
    ?? DEFAULT_CONTEXT_TEMPLATES.find(template => template.id === DEFAULT_CONTEXT_TEMPLATE_ID)
    ?? DEFAULT_CONTEXT_TEMPLATES[0])
);

export const saveContextTemplate = (template: ContextTemplate): ContextTemplate => {
    const nextTemplate = cloneContextTemplate({
        ...template,
        builtIn: false,
        updatedAt: template.updatedAt ?? new Date().toISOString(),
    });
    if (typeof window === 'undefined') return nextTemplate;
    const stored = parseContextTemplates(window.localStorage.getItem(CONTEXT_TEMPLATES_STORAGE_KEY));
    const isNewTemplate = !stored.some(item => item.id === nextTemplate.id);
    if (isNewTemplate && stored.length >= MAX_CUSTOM_CONTEXT_TEMPLATES) {
        throw new Error('context_template_limit');
    }
    const next = [
        ...stored.filter(item => item.id !== nextTemplate.id),
        nextTemplate,
    ];
    window.localStorage.setItem(CONTEXT_TEMPLATES_STORAGE_KEY, JSON.stringify(next));
    return cloneContextTemplate(nextTemplate);
};

export const deleteContextTemplate = (templateId: string): void => {
    if (typeof window === 'undefined') return;
    const stored = parseContextTemplates(window.localStorage.getItem(CONTEXT_TEMPLATES_STORAGE_KEY));
    window.localStorage.setItem(
        CONTEXT_TEMPLATES_STORAGE_KEY,
        JSON.stringify(stored.filter(item => item.id !== templateId)),
    );
};

export const saveReportTemplate = (template: ReportTemplate): ReportTemplate => {
    const nextTemplate = cloneReportTemplate({
        ...template,
        builtIn: false,
        updatedAt: template.updatedAt ?? new Date().toISOString(),
    });
    if (typeof window === 'undefined') return nextTemplate;
    const stored = parseReportTemplates(window.localStorage.getItem(REPORT_TEMPLATES_STORAGE_KEY));
    const isNewTemplate = !stored.some(item => item.id === nextTemplate.id);
    if (isNewTemplate && stored.length >= MAX_CUSTOM_REPORT_TEMPLATES) {
        throw new Error('report_template_limit');
    }
    const next = [
        ...stored.filter(item => item.id !== nextTemplate.id),
        nextTemplate,
    ];
    window.localStorage.setItem(REPORT_TEMPLATES_STORAGE_KEY, JSON.stringify(next));
    return cloneReportTemplate(nextTemplate);
};

export const deleteReportTemplate = (templateId: string): void => {
    if (typeof window === 'undefined') return;
    const stored = parseReportTemplates(window.localStorage.getItem(REPORT_TEMPLATES_STORAGE_KEY));
    window.localStorage.setItem(
        REPORT_TEMPLATES_STORAGE_KEY,
        JSON.stringify(stored.filter(item => item.id !== templateId)),
    );
};

export const listMinutesOutputTemplates = (): ReportTemplate[] => FOLLOW_UP_OUTPUT_TEMPLATES.map(cloneReportTemplate);

export const getMinutesOutputTemplateById = (templateId?: string): ReportTemplate => (
    cloneReportTemplate(FOLLOW_UP_OUTPUT_TEMPLATES.find(template => template.id === templateId)
    ?? FOLLOW_UP_OUTPUT_TEMPLATES.find(template => template.id === DEFAULT_MINUTES_OUTPUT_TEMPLATE_ID)
    ?? FOLLOW_UP_OUTPUT_TEMPLATES[0])
);

export const getReportTemplateById = (templateId?: string): ReportTemplate => (
    cloneReportTemplate(listReportTemplates().find(template => template.id === templateId)
    ?? DEFAULT_REPORT_TEMPLATES.find(template => template.id === DEFAULT_REPORT_TEMPLATE_ID)
    ?? DEFAULT_REPORT_TEMPLATES[0])
);

export const listTermGlossaries = (): TermGlossary[] => {
    if (typeof window === 'undefined') return DEFAULT_TERM_GLOSSARIES.map(cloneTermGlossary);
    try {
        const stored = parseGlossaries(window.localStorage.getItem(TERM_GLOSSARIES_STORAGE_KEY));
        if (!stored) {
            window.localStorage.setItem(TERM_GLOSSARIES_STORAGE_KEY, JSON.stringify(DEFAULT_TERM_GLOSSARIES));
            return DEFAULT_TERM_GLOSSARIES.map(cloneTermGlossary);
        }
        const storedIds = new Set(stored.map(glossary => glossary.id));
        const missingBuiltIns = DEFAULT_TERM_GLOSSARIES.filter(glossary => !storedIds.has(glossary.id));
        if (!missingBuiltIns.length) return stored.map(cloneTermGlossary);
        const next = [...stored, ...missingBuiltIns];
        window.localStorage.setItem(TERM_GLOSSARIES_STORAGE_KEY, JSON.stringify(next));
        return next.map(cloneTermGlossary);
    } catch {
        return DEFAULT_TERM_GLOSSARIES.map(cloneTermGlossary);
    }
};

export const getTermGlossariesByIds = (glossaryIds: string[]): TermGlossary[] => {
    const selectedIds = new Set(glossaryIds);
    return listTermGlossaries().filter(glossary => selectedIds.has(glossary.id));
};
