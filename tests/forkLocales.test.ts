import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import i18n from '../src/i18n/index';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'];

const flattenLeaves = (value: unknown, prefix = ''): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? { [prefix]: String(value ?? '') } : {};
  }
  return Object.entries(value).reduce<Record<string, string>>((leaves, [key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return { ...leaves, ...flattenLeaves(child, path) };
  }, {});
};

const readOverlay = async (locale: string) =>
  flattenLeaves(await Bun.file(`src/i18n/fork/${locale}.json`).json());

const interpolationTokens = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort();

// plural suffixes differ by language (Russian adds _few and _many), so compare base keys
const pluralBase = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');

describe('fork locale overlays', () => {
  test('cover every upstream locale and nothing else', () => {
    const upstream = readdirSync('src/i18n/locales').sort();
    const fork = readdirSync('src/i18n/fork')
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(fork).toEqual(upstream);
    expect(LOCALES.map((locale) => `${locale}.json`).sort()).toEqual(upstream);
  });

  for (const locale of LOCALES.filter((locale) => locale !== 'en')) {
    test(`${locale} translates every English fork key with matching interpolation`, async () => {
      const english = await readOverlay('en');
      const translated = await readOverlay(locale);
      const englishBases = new Set(Object.keys(english).map(pluralBase));
      const translatedBases = new Set(Object.keys(translated).map(pluralBase));
      const missing = Object.keys(english).filter((key) => !translatedBases.has(pluralBase(key)));
      const extra = Object.keys(translated).filter((key) => !englishBases.has(pluralBase(key)));
      const mismatched = Object.keys(english)
        .filter((key) => key in translated)
        .filter(
          (key) =>
            interpolationTokens(english[key]).join('|') !==
            interpolationTokens(translated[key]).join('|')
        );
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
      expect(mismatched).toEqual([]);
    });
  }

  test('are merged into the runtime instance over upstream wording', () => {
    const english = i18n.getFixedT('en');
    expect(english('config_management.visual.sections.network.strategy_ordered')).toBe('Ordered');
    expect(english('auth_files.priority_label')).toBe('Routing order');
    // upstream keys the fork leaves alone still resolve
    expect(english('nav.quota_management')).not.toBe('nav.quota_management');
  });
});
