// The product's display name lives only in configs/brand.json, which the web app (here and the page
// <title> in vite.config.js), the backend's user-facing messages (backend/brand.py) and the installer build read.
import brand from '../../configs/brand.json' with { type: 'json' };

export const BRAND_NAME: string = brand.brandName;

// The installed Windows connection program, as web copy names it.
export const LOCAL_ENGINE_NAME = `${BRAND_NAME} 연결`;

type Josa = '을/를' | '이/가' | '은/는' | '으로/로';

// Appends the particle that fits the word's last syllable, so copy stays grammatical when a name changes.
export const withJosa = (word: string, josa: Josa): string => {
    const [withFinal, withoutFinal] = josa.split('/');
    const offset = (word.at(-1) ?? '').charCodeAt(0) - 0xac00;
    if (!(offset >= 0 && offset <= 11171)) return `${word}${withFinal}(${withoutFinal})`;
    const finalConsonant = offset % 28;
    // 로 also follows a final ㄹ (연결로, 서울로).
    const takesShortForm = finalConsonant === 0 || (josa === '으로/로' && finalConsonant === 8);
    return `${word}${takesShortForm ? withoutFinal : withFinal}`;
};
