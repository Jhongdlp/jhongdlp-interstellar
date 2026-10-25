// Two languages, no dictionary: each string carries its own translation, t('es', 'en').
export const tr = (lang?: string) => (es: string, en: string) => (lang === 'en' ? en : es);
