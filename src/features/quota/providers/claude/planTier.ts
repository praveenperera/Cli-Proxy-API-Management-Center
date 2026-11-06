/**
 * Claude subscription size on the plan badge: Pro, Max (5x) and Ultra (20x).
 *
 * Upstream's resolveClaudePlanType only knows that an account has Max. The
 * profile's organization.rate_limit_tier names the size, such as
 * `default_claude_max_20x`, so a Max account is refined to plan_max5 or
 * plan_max20. The fork locales label those Max and Ultra.
 */

import type { ClaudeProfileResponse } from '@/types';
import type { QuotaClassMap } from '../../types';

type BasePlanResolver = (profile: ClaudeProfileResponse | null) => string | null;

/** Plan key with the Max size resolved; other plans pass through unchanged */
export function resolveClaudePlanTier(
  profile: ClaudeProfileResponse | null,
  resolveBase: BasePlanResolver
): string | null {
  const base = resolveBase(profile);
  if (base !== 'plan_max') return base;

  const tier = profile?.organization?.rate_limit_tier?.toLowerCase() ?? '';
  if (tier.includes('max_20x')) return 'plan_max20';
  if (tier.includes('max_5x')) return 'plan_max5';
  // an unknown size keeps the generic Max label
  return base;
}

/** Badge style matching Codex: platinum for the top tier, gold for the middle one */
export function claudePlanValueClass(planType: string | null, classes: QuotaClassMap): string {
  if (planType === 'plan_max20') return classes.elitePlanValue;
  if (planType === 'plan_max5' || planType === 'plan_max') return classes.premiumPlanValue;
  return classes.codexPlanValue;
}
