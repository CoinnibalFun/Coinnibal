// The interface ships in English only.

export type Locale = 'en';

export interface LocaleInfo {
  code: Locale;
  /** BCP 47 tag for `<html lang>` and `Intl`. */
  tag: string;
  /** The language's own name. */
  name: string;
  /** Two-letter mark. */
  short: string;
}

export const LOCALES: readonly LocaleInfo[] = [{ code: 'en', tag: 'en', name: 'English', short: 'EN' }];
