/**
 * Display names for Claude and Codex plan types on the recorded-usage cards.
 * codexPlanLabel mirrors getPlanLabel in CodexQuotaBody, which is left as
 * upstream wrote it; keep the two in step.
 */

import type { TFunction } from 'i18next';
import { normalizePlanType, PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota';

/** Codex plan name, or the raw plan type when it has no translation. */
export function codexPlanLabel(planType: string | null | undefined, t: TFunction): string | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'self_serve_business_prolite') return t('codex_quota.plan_business_premium');
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized)) return t('codex_quota.plan_prolite');
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
}

/**
 * Claude plan name. Live quota reads report `plan_max`-style keys; the
 * recorded history may report the bare name, so both are looked up.
 */
export function claudePlanLabel(
  planType: string | null | undefined,
  t: TFunction,
  exists: (key: string) => boolean
): string | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  for (const key of [`claude_quota.${normalized}`, `claude_quota.plan_${normalized}`]) {
    if (exists(key)) return t(key);
  }
  return planType ?? normalized;
}
