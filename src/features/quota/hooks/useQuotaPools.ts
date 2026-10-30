/**
 * The quota page's pooled view: one pool card per provider, its recorded account usage, and the
 * per-account cards behind an Accounts toggle.
 *
 * QuotaPage keeps upstream's file list, quota cache, sorting and paging; this hook owns the pooled
 * view's own state and data so the page only needs a few hooks. The Claude and Codex account usage
 * sections read only the server-recorded /quota/history (re-read every minute) and never call the
 * upstream quota endpoints, so they cannot trip rate limits.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { resolveCodexPlanType } from '@/utils/quota/resolvers';
import {
  DEFAULT_ACCOUNT_RANGE_DAYS,
  USAGE_HISTORY_PROVIDERS,
  type AccountRangeDays,
} from '../accountUsageModel';
import type { QuotaEmailToggleProps } from '../components/QuotaEmailToggle';
import type { QuotaPoolToolbarProps } from '../components/QuotaPoolToolbar';
import { QUOTA_PAGE_SIZE, type QuotaTabId } from '../constants';
import { filterEntriesByTab, type QuotaFileEntry } from '../logic';
import { claudePlanLabel, codexPlanLabel } from '../planLabel';
import { readQuotaPoolUiState, writeQuotaPoolUiState } from '../poolUiState';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { collectPoolAccounts } from '../quotaPoolAccounts';
import {
  FUTURE_USAGE_MULTIPLIER,
  POOL_RANGE_MAX_OFFSET,
  poolRange,
  type BurnWindowHours,
  type FutureUsageMode,
  type PoolChartMode,
} from '../quotaPoolModel';
import { startOfDay } from '../quotaTimelineModel';
import { useQuotaHistory } from './useQuotaHistory';

export type UseQuotaPoolsOptions = {
  entries: QuotaFileEntry[];
  tab: QuotaTabId;
  getQuota: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  loadQuota: (targets: QuotaFileEntry[]) => Promise<void>;
};

export function useQuotaPools({ entries, tab, getQuota, loadQuota }: UseQuotaPoolsOptions) {
  const { t, i18n } = useTranslation();
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);

  const [chartMode, setChartMode] = useState<PoolChartMode>(
    () => readQuotaPoolUiState()?.chartMode ?? 'remaining'
  );
  const [burnWindowHours, setBurnWindowHours] = useState<BurnWindowHours>(
    () => readQuotaPoolUiState()?.burnWindowHours ?? 3
  );
  const [futureUsage, setFutureUsage] = useState<FutureUsageMode>(
    () => readQuotaPoolUiState()?.futureUsage ?? 'same'
  );
  const [showAccounts, setShowAccounts] = useState(
    () => readQuotaPoolUiState()?.showAccounts ?? false
  );
  const [showEmails, setShowEmails] = useState(() => readQuotaPoolUiState()?.showEmails ?? false);
  const [accountRangeDays, setAccountRangeDays] = useState<AccountRangeDays>(
    () => readQuotaPoolUiState()?.accountRangeDays ?? DEFAULT_ACCOUNT_RANGE_DAYS
  );
  const [rangeOffset, setRangeOffset] = useState(0);

  // The pool cards project from the current minute, so this clock always runs. The page's sort
  // clock still only ticks in recovery order, keeping its pageItems stable in default order.
  const now = useNow();

  // Pools cover the whole tab; search only narrows the per-account cards.
  const tabEntries = useMemo(() => filterEntriesByTab(entries, tab), [entries, tab]);

  const handleRangeOffsetChange = useCallback((next: number) => {
    setRangeOffset(Math.min(next, POOL_RANGE_MAX_OFFSET));
  }, []);

  const handleChartModeChange = useCallback((next: PoolChartMode) => {
    setChartMode(next);
    writeQuotaPoolUiState({ chartMode: next });
  }, []);

  const handleBurnWindowChange = useCallback((next: BurnWindowHours) => {
    setBurnWindowHours(next);
    writeQuotaPoolUiState({ burnWindowHours: next });
  }, []);

  const handleFutureUsageChange = useCallback((next: FutureUsageMode) => {
    setFutureUsage(next);
    writeQuotaPoolUiState({ futureUsage: next });
  }, []);

  const handleShowAccountsChange = useCallback((next: boolean) => {
    setShowAccounts(next);
    writeQuotaPoolUiState({ showAccounts: next });
  }, []);

  const handleShowEmailsChange = useCallback((next: boolean) => {
    setShowEmails(next);
    writeQuotaPoolUiState({ showEmails: next });
  }, []);

  const handleAccountRangeDaysChange = useCallback((next: AccountRangeDays) => {
    setAccountRangeDays(next);
    writeQuotaPoolUiState({ accountRangeDays: next });
  }, []);

  /* ---------- pools ---------- */

  // Keyed on the day, not the minute, so the history refetches when the range
  // actually moves rather than on every clock tick.
  const today = startOfDay(now);
  const range = useMemo(() => poolRange(rangeOffset, today), [rangeOffset, today]);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const {
    history,
    loaded: historyLoaded,
    failed: historyFailed,
  } = useQuotaHistory(range.startMs, range.endMs, accountRangeDays, historyRefreshKey);

  const pools = useMemo(
    () =>
      collectPoolAccounts({ entries: tabEntries, quotaFor: getQuota, history, showEmails, now }),
    [tabEntries, getQuota, history, showEmails, now]
  );

  /* ---------- account usage (recorded history only, never the upstream endpoints) ---------- */

  // Plans the page already knows without asking a provider: the Codex id token,
  // or a Claude profile read by an earlier manual refresh
  const usagePlanTypeFor = useCallback(
    (file: AuthFileItem): string | null => {
      if (file.type === 'codex' || file.provider === 'codex') return resolveCodexPlanType(file);
      const cached = claudeQuota[getQuotaCacheKey(file)] as
        { planType?: string | null } | undefined;
      return cached?.planType ?? null;
    },
    [claudeQuota]
  );
  // stable per provider, so each section's accounts rebuild only when an input changes
  const usageFilesByProvider = useMemo(() => {
    const out = new Map<QuotaProviderType, AuthFileItem[]>();
    tabEntries.forEach((entry) => {
      if (!USAGE_HISTORY_PROVIDERS.has(entry.type)) return;
      out.set(entry.type, [...(out.get(entry.type) ?? []), entry.file]);
    });
    return out;
  }, [tabEntries]);
  const usagePlanLabels = useMemo(
    () => ({
      claude: (planType: string) => claudePlanLabel(planType, t, (key) => i18n.exists(key)),
      codex: (planType: string) => codexPlanLabel(planType, t),
    }),
    [t, i18n]
  );

  /* ---------- refresh all ---------- */

  // Replaces the page's load of the visible page after Refresh all: the pools need every
  // credential in the tab. Batches of one page keep the upstream fan-out at the old bound.
  const loadTabQuota = useCallback(
    async (requestedSession: number) => {
      for (let start = 0; start < tabEntries.length; start += QUOTA_PAGE_SIZE) {
        if (useQuotaStore.getState().cacheGeneration !== requestedSession) return;
        await loadQuota(tabEntries.slice(start, start + QUOTA_PAGE_SIZE));
      }
      setHistoryRefreshKey((key) => key + 1);
    },
    [loadQuota, tabEntries]
  );

  const emailToggle: QuotaEmailToggleProps = {
    showEmails,
    onShowEmailsChange: handleShowEmailsChange,
  };
  const toolbar: QuotaPoolToolbarProps = {
    chartMode,
    burnWindowHours,
    futureUsage,
    showAccounts,
    rangeStartMs: range.startMs,
    rangeEndMs: range.endMs,
    rangeOffset,
    onChartModeChange: handleChartModeChange,
    onBurnWindowChange: handleBurnWindowChange,
    onFutureUsageChange: handleFutureUsageChange,
    onShowAccountsChange: handleShowAccountsChange,
    onRangeOffsetChange: handleRangeOffsetChange,
  };
  const view = {
    tab,
    tabEntries,
    pools,
    history,
    historyLoaded,
    historyFailed,
    chartMode,
    burnWindowHours,
    multiplier: FUTURE_USAGE_MULTIPLIER[futureUsage],
    range,
    now,
    showAccounts,
    showEmails,
    accountRangeDays,
    onAccountRangeDaysChange: handleAccountRangeDaysChange,
    usageFilesByProvider,
    usagePlanTypeFor,
    usagePlanLabels,
  };

  return { loadTabQuota, showAccounts, emailToggle, toolbar, view };
}

export type QuotaPoolView = ReturnType<typeof useQuotaPools>['view'];
