/**
 * Session-scoped preferences for the quota page's pooled view (sessionStorage).
 *
 * Kept under their own key: upstream's writeQuotaUiState rebuilds its object from the fields it
 * knows, so storing these beside the tab and sort would drop them on every tab change.
 */

import { ACCOUNT_RANGE_DAYS, type AccountRangeDays } from './accountUsageModel';
import {
  BURN_WINDOWS_HOURS,
  FUTURE_USAGE_MODES,
  POOL_CHART_MODES,
  type BurnWindowHours,
  type FutureUsageMode,
  type PoolChartMode,
} from './quotaPoolModel';

export type QuotaPoolUiState = {
  chartMode?: PoolChartMode;
  burnWindowHours?: BurnWindowHours;
  futureUsage?: FutureUsageMode;
  showAccounts?: boolean;
  showEmails?: boolean;
  accountRangeDays?: AccountRangeDays;
};

const QUOTA_POOL_UI_STATE_KEY = 'quotaPage.poolUiState';

const isOneOf =
  <T>(values: readonly T[]) =>
  (value: unknown): value is T =>
    values.includes(value as T);

const isPoolChartMode = isOneOf(POOL_CHART_MODES);
const isBurnWindowHours = isOneOf(BURN_WINDOWS_HOURS);
const isFutureUsageMode = isOneOf(FUTURE_USAGE_MODES);
const isAccountRangeDays = isOneOf(ACCOUNT_RANGE_DAYS);
const booleanOrUndefined = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export const readQuotaPoolUiState = (): QuotaPoolUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_POOL_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      chartMode: isPoolChartMode(parsed.chartMode) ? parsed.chartMode : undefined,
      burnWindowHours: isBurnWindowHours(parsed.burnWindowHours)
        ? parsed.burnWindowHours
        : undefined,
      futureUsage: isFutureUsageMode(parsed.futureUsage) ? parsed.futureUsage : undefined,
      showAccounts: booleanOrUndefined(parsed.showAccounts),
      showEmails: booleanOrUndefined(parsed.showEmails),
      accountRangeDays: isAccountRangeDays(parsed.accountRangeDays)
        ? parsed.accountRangeDays
        : undefined,
    };
  } catch {
    return null;
  }
};

/** Merges one preference into what is stored, like upstream's writeQuotaUiState */
export const writeQuotaPoolUiState = (state: QuotaPoolUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaPoolUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_POOL_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
