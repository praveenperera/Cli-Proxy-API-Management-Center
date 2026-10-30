/**
 * The quota page body in the pooled view, rendered in place of upstream's card grid: one pool
 * card per provider, its recorded account usage, and (behind the Accounts toggle) that provider's
 * per-account cards in the paginated order.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { USAGE_HISTORY_PROVIDERS } from '../accountUsageModel';
import type { useQuotaActions } from '../hooks/useQuotaActions';
import type { QuotaPoolView } from '../hooks/useQuotaPools';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { AccountUsageSection } from './AccountUsageSection';
import { QuotaCard } from './QuotaCard';
import { QuotaPoolCard } from './QuotaPoolCard';
import { QuotaTimeline, type QuotaTimelineProps } from './QuotaTimeline';
import pageStyles from '../QuotaPage.module.scss';
import styles from './QuotaPoolBody.module.scss';

const SKELETON_POOL_COUNT = 2;
const NO_FILES: AuthFileItem[] = [];

type QuotaActions = ReturnType<typeof useQuotaActions>;

export type QuotaPoolBodyProps = QuotaPoolView & {
  loading: boolean;
  /** Entries left after search, before paging */
  filteredCount: number;
  pageItems: QuotaFileEntry[];
  getQuota: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  canUseActions: boolean;
  resettingQuotaName: string | null;
  cardEntranceDelay: (index: number) => number | null;
  onTabChange: (tab: string) => void;
  onSearchChange: (value: string) => void;
  onRefresh: QuotaActions['refreshQuota'];
  onReset: QuotaActions['resetQuota'];
};

export function QuotaPoolBody(props: QuotaPoolBodyProps) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const { loading, tab, tabEntries, pools, history, pageItems, showAccounts, showEmails } = props;

  if (loading) {
    return (
      <div className={styles.pools} aria-hidden="true">
        {Array.from({ length: SKELETON_POOL_COUNT }, (_, index) => (
          <Skeleton key={index} height={340} rounded={14} />
        ))}
      </div>
    );
  }

  if (tabEntries.length === 0) {
    return (
      <EmptyState
        title={
          tab === 'all'
            ? t('quota_management.empty_title')
            : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
        }
        description={
          tab === 'all'
            ? t('quota_management.empty_desc')
            : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
        }
        action={
          tab === 'all' ? undefined : (
            <Button variant="secondary" size="sm" onClick={() => props.onTabChange('all')}>
              {t('auth_files.filter_all')}
            </Button>
          )
        }
      />
    );
  }

  // Per-account cards sit under their provider's pool, in the paginated order.
  const renderAccountCards = (type: QuotaProviderType) => {
    const items = pageItems.filter((entry) => entry.type === type);
    if (items.length === 0) return null;
    return (
      <div className={pageStyles.grid}>
        {items.map((entry) => (
          <QuotaCard
            key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
            entry={entry}
            quota={props.getQuota(entry)}
            resolvedTheme={resolvedTheme}
            canRefresh={props.canUseActions && !entry.file.disabled}
            resetting={props.resettingQuotaName === getQuotaCacheKey(entry.file)}
            displayName={showEmails ? entry.file.email?.trim() || undefined : undefined}
            entranceDelayMs={props.cardEntranceDelay(pageItems.indexOf(entry))}
            onRefresh={() => void props.onRefresh(entry.file, QUOTA_ADAPTERS[entry.type])}
            onReset={() => props.onReset(entry.file, QUOTA_ADAPTERS[entry.type])}
          />
        ))}
      </div>
    );
  };

  return (
    <div className={styles.pools}>
      {pools.map((pool) => (
        <div key={pool.provider} className={styles.poolGroup}>
          <QuotaPoolCard
            provider={pool.provider}
            credentials={pool.credentials}
            accounts={pool.accounts}
            historyEnabled={history.enabled}
            mode={props.chartMode}
            burnWindowHours={props.burnWindowHours}
            multiplier={props.multiplier}
            rangeStartMs={props.range.startMs}
            rangeEndMs={props.range.endMs}
            now={props.now}
            resolvedTheme={resolvedTheme}
          />
          {USAGE_HISTORY_PROVIDERS.has(pool.provider) && (
            <AccountUsageSection
              provider={pool.provider}
              files={props.usageFilesByProvider.get(pool.provider) ?? NO_FILES}
              history={history}
              historyLoaded={props.historyLoaded}
              historyFailed={props.historyFailed}
              showEmails={showEmails}
              rangeDays={props.accountRangeDays}
              onRangeDaysChange={props.onAccountRangeDaysChange}
              planTypeFor={props.usagePlanTypeFor}
              planLabel={
                pool.provider === 'codex'
                  ? props.usagePlanLabels.codex
                  : props.usagePlanLabels.claude
              }
              now={props.now}
              resolvedTheme={resolvedTheme}
            />
          )}
          {showAccounts && renderAccountCards(pool.provider)}
        </div>
      ))}
      {showAccounts && props.filteredCount === 0 && (
        <EmptyState
          title={t('quota_management.search_empty_title')}
          description={t('quota_management.search_empty_desc')}
          action={
            <Button variant="secondary" size="sm" onClick={() => props.onSearchChange('')}>
              {t('quota_management.search_clear')}
            </Button>
          }
        />
      )}
    </div>
  );
}

/**
 * A div that renders only while the account cards are shown. It stands in for one of upstream's
 * divs so the markup inside keeps its indentation
 */
export function AccountsOnlyDiv({
  show,
  className,
  children,
}: {
  show: boolean;
  className?: string;
  children: ReactNode;
}) {
  return show ? <div className={className}>{children}</div> : null;
}

/**
 * The window lanes are per-credential detail (5-hour view, manual reset credits) the pools don't
 * show, so they travel with the account cards. Only the current page, to keep lanes bounded
 */
export function AccountQuotaTimeline({ show, ...props }: QuotaTimelineProps & { show: boolean }) {
  return show ? <QuotaTimeline {...props} /> : null;
}
