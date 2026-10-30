type Messages = Record<string, unknown>;

const isMessages = (value: unknown): value is Messages =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (base: Messages, overlay: Messages): Messages => {
  const merged: Messages = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] = isMessages(current) && isMessages(value) ? deepMerge(current, value) : value;
  }
  return merged;
};

/** A locale as the app sees it: the upstream file with the fork overlay merged in */
export async function readLocale(locale: string): Promise<Messages> {
  const upstream = (await Bun.file(`src/i18n/locales/${locale}.json`).json()) as Messages;
  const fork = (await Bun.file(`src/i18n/fork/${locale}.json`).json()) as Messages;
  return deepMerge(upstream, fork);
}
