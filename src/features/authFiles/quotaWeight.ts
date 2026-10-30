/**
 * quota_weight on an auth file: how large a credential's quota is next to others of its provider
 * in pooled quota views, such as 1 for Claude Pro, 5 for Max 5x, and 10 for Max 20x. Routing does
 * not use it.
 */

import type { AuthFileFieldsPatch } from '@/services/api';

// the proxy accepts up to 1000
const MAX_QUOTA_WEIGHT = 1000;

/** i18n key for an invalid quota weight */
export type QuotaWeightError = 'auth_files.quota_weight_invalid';

/**
 * Editor fields for quota_weight. They are optional so editor states built without them, by
 * upstream code paths and tests, stay valid; a missing value means the default weight
 */
export type QuotaWeightEditorFields = {
  quotaWeight?: string;
  quotaWeightError?: string | null;
};

export const readQuotaWeight = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_QUOTA_WEIGHT
    ? value
    : undefined;

const parseQuotaWeightText = (text: string | undefined): number | undefined | 'invalid' => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return readQuotaWeight(value) ?? 'invalid';
};

/** Initial editor fields from the auth file JSON */
export const quotaWeightEditorFields = (json: Record<string, unknown>): QuotaWeightEditorFields => {
  const quotaWeight = readQuotaWeight(json.quota_weight);
  return {
    quotaWeight: quotaWeight !== undefined ? String(quotaWeight) : '',
    quotaWeightError: null,
  };
};

/** Editor fields after the user edits the quota weight */
export const updateQuotaWeight = (
  value: unknown,
  resolveError: (key: QuotaWeightError) => string
): QuotaWeightEditorFields => {
  const quotaWeight = String(value);
  return {
    quotaWeight,
    quotaWeightError:
      parseQuotaWeightText(quotaWeight) === 'invalid'
        ? resolveError('auth_files.quota_weight_invalid')
        : null,
  };
};

/** Adds quota_weight to the fields patch when the edit changes it; null restores the default */
export function addQuotaWeightPatch(
  patch: AuthFileFieldsPatch,
  editor: QuotaWeightEditorFields,
  original: Record<string, unknown>,
  resolveError: (key: QuotaWeightError) => string
) {
  const nextQuotaWeight = parseQuotaWeightText(editor.quotaWeight);
  if (nextQuotaWeight === 'invalid') {
    throw new Error(resolveError('auth_files.quota_weight_invalid'));
  }
  const originalQuotaWeight = readQuotaWeight(original.quota_weight);
  if (nextQuotaWeight === undefined) {
    if (originalQuotaWeight !== undefined) patch.quota_weight = null;
  } else if (nextQuotaWeight !== originalQuotaWeight) {
    patch.quota_weight = nextQuotaWeight;
  }
}

/** Mirrors a quota_weight patch into the auth file JSON preview */
export function applyQuotaWeightPatch(next: Record<string, unknown>, patch: AuthFileFieldsPatch) {
  if (patch.quota_weight === undefined) return;
  if (patch.quota_weight === null) {
    delete next.quota_weight;
  } else {
    next.quota_weight = patch.quota_weight;
  }
}
