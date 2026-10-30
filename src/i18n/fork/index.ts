/**
 * Fork-only translations, layered over the upstream locale files.
 *
 * Each JSON here holds only the keys this fork adds or rewords, so the upstream
 * locale files stay byte-identical and never conflict on a rebase. Keep the six
 * files in step: tests/forkLocales.test.ts checks they cover the same keys.
 */

import type { i18n as I18n } from 'i18next';
import zhCN from './zh-CN.json';
import zhTW from './zh-TW.json';
import en from './en.json';
import ru from './ru.json';
import vi from './vi.json';
import ko from './ko.json';

export const FORK_LOCALES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ru,
  vi,
  ko,
};

/** Deep-merges the fork keys into each language, overriding upstream wording where they overlap */
export function addForkTranslations(instance: I18n) {
  for (const [language, messages] of Object.entries(FORK_LOCALES)) {
    instance.addResourceBundle(language, 'translation', messages, true, true);
  }
}
