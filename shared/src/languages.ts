export interface LanguageInfo {
  code: string;
  label: string;
  flag: string;
}

/** Language filter chips, in display order. */
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'he', label: 'Hebrew', flag: '🇮🇱' },
  { code: 'tr', label: 'Turkish', flag: '🇹🇷' },
  { code: 'de', label: 'German', flag: '🇩🇪' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', label: 'French', flag: '🇫🇷' },
];

export function languageInfo(code: string): LanguageInfo {
  return LANGUAGES.find((l) => l.code === code) ?? { code, label: code.toUpperCase(), flag: '🎵' };
}

/** `lang` of a playlist that mixes languages (e.g. Eurovision): it gets no language chip. */
export const MULTILINGUAL = 'multi';

/**
 * Themed shelves shown as chips before the languages. A seed playlist joins one
 * with `"collection": "<code>"`; it still appears under its language too,
 * unless its `lang` is "multi".
 */
export const COLLECTIONS: readonly LanguageInfo[] = [
  { code: 'eurovision', label: 'Eurovision', flag: '🎤' },
  { code: 'themes', label: 'Themes', flag: '✨' },
];

export function collectionInfo(code: string): LanguageInfo {
  return COLLECTIONS.find((c) => c.code === code) ?? { code, label: code.charAt(0).toUpperCase() + code.slice(1), flag: '⭐' };
}
