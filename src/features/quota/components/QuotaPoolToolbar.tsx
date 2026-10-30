/**
 * Pool view controls: chart mode, burn lookback, future usage, the per-account
 * toggle, and the 14-day range pager.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft } from '@/components/ui/icons';
import { IconChevronRight } from '@/components/ui/forkIcons';
import { Select } from '@/components/ui/Select';
import { DAY_MS } from '@/utils/time/durations';
import {
  BURN_WINDOWS_HOURS,
  FUTURE_USAGE_MODES,
  POOL_CHART_MODES,
  POOL_RANGE_MAX_OFFSET,
  type BurnWindowHours,
  type FutureUsageMode,
  type PoolChartMode,
} from '../quotaPoolModel';
import { formatMonthDay } from '../poolFormat';
import styles from './QuotaPoolToolbar.module.scss';

export interface QuotaPoolToolbarProps {
  chartMode: PoolChartMode;
  burnWindowHours: BurnWindowHours;
  futureUsage: FutureUsageMode;
  showAccounts: boolean;
  rangeStartMs: number;
  rangeEndMs: number;
  rangeOffset: number;
  onChartModeChange: (mode: PoolChartMode) => void;
  onBurnWindowChange: (hours: BurnWindowHours) => void;
  onFutureUsageChange: (mode: FutureUsageMode) => void;
  onShowAccountsChange: (show: boolean) => void;
  onRangeOffsetChange: (offset: number) => void;
}

interface SegmentedProps<T extends string | number> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Radio-like button group; each button reports its pressed state. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${option.value === value ? styles.segmentActive : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function QuotaPoolToolbar(props: QuotaPoolToolbarProps) {
  const {
    chartMode,
    burnWindowHours,
    futureUsage,
    showAccounts,
    rangeStartMs,
    rangeEndMs,
    rangeOffset,
    onChartModeChange,
    onBurnWindowChange,
    onFutureUsageChange,
    onShowAccountsChange,
    onRangeOffsetChange,
  } = props;
  const { t, i18n } = useTranslation();

  const futureOptions = useMemo(
    () =>
      FUTURE_USAGE_MODES.map((mode) => ({
        value: mode,
        label: t(`quota_management.pool_future_${mode}`),
      })),
    [t]
  );

  // the range end is exclusive; the label names the last day shown
  const rangeLabel = t('quota_management.pool_range', {
    start: formatMonthDay(rangeStartMs, i18n.language),
    end: formatMonthDay(rangeEndMs - DAY_MS / 2, i18n.language),
  });

  return (
    <div className={styles.toolbar}>
      <div className={styles.group}>
        <Segmented
          label={t('quota_management.pool_chart_mode')}
          value={chartMode}
          onChange={onChartModeChange}
          options={POOL_CHART_MODES.map((mode) => ({
            value: mode,
            label: t(`quota_management.pool_mode_${mode}`),
          }))}
        />

        <span className={styles.label}>{t('quota_management.pool_burn_rate')}</span>
        <Segmented
          label={t('quota_management.pool_burn_rate')}
          value={burnWindowHours}
          onChange={onBurnWindowChange}
          options={BURN_WINDOWS_HOURS.map((hours) => ({
            value: hours,
            label: t('quota_management.pool_hours', { hours }),
          }))}
        />

        <span className={styles.label}>{t('quota_management.pool_future_usage')}</span>
        <div className={styles.select}>
          <Select
            value={futureUsage}
            options={futureOptions}
            onChange={(value) => onFutureUsageChange(value as FutureUsageMode)}
            ariaLabel={t('quota_management.pool_future_usage')}
            size="sm"
          />
        </div>

        <button
          type="button"
          className={`${styles.toggle} ${showAccounts ? styles.toggleActive : ''}`}
          aria-pressed={showAccounts}
          onClick={() => onShowAccountsChange(!showAccounts)}
        >
          {t('quota_management.pool_accounts_toggle')}
        </button>
      </div>

      <div className={styles.pager}>
        <span className={styles.range} aria-live="polite">
          {rangeLabel}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onRangeOffsetChange(rangeOffset - 1)}
          aria-label={t('quota_management.windows_prev')}
          title={t('quota_management.windows_prev')}
        >
          <IconChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${styles.today} ${rangeOffset === 0 ? styles.todayActive : ''}`}
          onClick={() => onRangeOffsetChange(0)}
          aria-pressed={rangeOffset === 0}
        >
          {t('quota_management.windows_today')}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onRangeOffsetChange(rangeOffset + 1)}
          disabled={rangeOffset >= POOL_RANGE_MAX_OFFSET}
          aria-label={t('quota_management.windows_next')}
          title={t('quota_management.windows_next')}
        >
          <IconChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
