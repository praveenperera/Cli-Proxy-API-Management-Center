import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { apiCallApi, type ApiCallResult } from '@/services/api/apiCall';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { claudePlanLabel } from '@/features/quota/planLabel';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { CLAUDE_USAGE_URL } from '@/utils/quota';
import type { ClaudeProfileResponse } from '@/types';
import fixture from './fixtures/claude-oauth-usage.json';

const translations = i18n.cloneInstance({ lng: 'en' });
const file = { name: 'claude-tier.json', type: 'claude', authIndex: 'synthetic-index' };
const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'claude-plan-tier-test'
);
const result = (body: unknown): ApiCallResult => ({
  statusCode: 200,
  header: {},
  body,
  bodyText: JSON.stringify(body),
});

const fetchPlan = async (profile: ClaudeProfileResponse) => {
  apiCallApi.request = async (request) =>
    request.url === CLAUDE_USAGE_URL ? result(fixture) : result(profile);
  return CLAUDE_CONFIG.buildSuccessState(await CLAUDE_CONFIG.fetchQuota(file, translations.t));
};

const maxProfile = (tier?: string): ClaudeProfileResponse => ({
  account: { has_claude_max: true, has_claude_pro: false },
  organization: { organization_type: 'claude_max', rate_limit_tier: tier },
});

describe('Claude plan tier badge', () => {
  const originalRequest = apiCallApi.request;
  afterEach(() => {
    apiCallApi.request = originalRequest;
  });

  test.each([
    [maxProfile('default_claude_max_20x'), 'plan_max20', 'Ultra', 'elitePlanValue'],
    [maxProfile('default_claude_max_5x'), 'plan_max5', 'Max', 'premiumPlanValue'],
    [maxProfile(undefined), 'plan_max', 'Max', 'premiumPlanValue'],
    [
      { account: { has_claude_pro: true }, organization: { rate_limit_tier: 'default_claude_ai' } },
      'plan_pro',
      'Pro',
      'codexPlanValue',
    ],
  ] as const)('%j reads as %s', async (profile, planType, label, badgeClass) => {
    const state = await fetchPlan(profile);
    expect(state.planType).toBe(planType);

    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: translations },
        createElement(ClaudeQuotaBody, { quota: state, classes })
      )
    );
    expect(html).toContain(`<span class="${badgeClass}">${label}</span>`);

    // the pooled account cards read the same cached plan key
    expect(claudePlanLabel(planType, translations.t, (key) => translations.exists(key))).toBe(
      label
    );
  });
});
