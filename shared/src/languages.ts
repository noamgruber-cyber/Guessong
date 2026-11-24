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
