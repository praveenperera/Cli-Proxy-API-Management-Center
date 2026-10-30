/**
 * One provider's pooled quota: headline remaining, the four outlook stats,
 * and the recorded + projected chart.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeColor,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import {
  buildDrainSeries,
  buildRecordedPool,
  summarizePool,
  type PoolAccount,
  type PoolChartMode,
} from '../quotaPoolModel';
import { formatMonthDay, formatPercent, formatRate, formatSpan, formatWhen } from '../poolFormat';
import { QuotaPoolChart } from './QuotaPoolChart';
import styles from './QuotaPoolCard.module.scss';

/** Providers the backend records history for; the rest only ever project. */
const RECORDED_PROVIDERS = new Set<QuotaProviderType>(['claude', 'codex']);

export interface QuotaPoolCardProps {
  provider: QuotaProviderType;
  credentials: number;
  accounts: PoolAccount[];
  historyEnabled: boolean;
  mode: PoolChartMode;
  burnWindowHours: number;
  multiplier: number;
  rangeStartMs: number;
  rangeEndMs: number;
  now: number;
  resolvedTheme: ResolvedTheme;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{children}</dd>
    </div>
  );
}

export function QuotaPoolCard(props: QuotaPoolCardProps) {
  const {
    provider,
    credentials,
    accounts,
    historyEnabled,
    mode,
    burnWindowHours,
    multiplier,
    rangeStartMs,
    rangeEndMs,
    now,
    resolvedTheme,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const summary = useMemo(
    () => summarizePool({ accounts, now, untilMs: rangeEndMs, burnWindowHours, multiplier }),
    [accounts, now, rangeEndMs, burnWindowHours, multiplier]
  );
  const recorded = useMemo(
    () => buildRecordedPool(accounts, rangeStartMs, rangeEndMs, now),
    [accounts, rangeStartMs, rangeEndMs, now]
  );
  const drain = useMemo(
    () => (mode === 'drain' ? buildDrainSeries(accounts, rangeStartMs, rangeEndMs, now) : []),
    [mode, accounts, rangeStartMs, rangeEndMs, now]
  );

  const label = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const color = getTypeColor(provider, resolvedTheme).text;
  const notLoaded = credentials - accounts.length;
  const { projection, burnPerHour } = summary;
  const dash = t('quota_management.pool_unknown');

  const poolEmpty =
    burnPerHour === null
      ? dash
      : projection.poolEmptyAtMs === null
        ? t('quota_management.pool_not_by', { date: formatMonthDay(summary.horizonMs, locale) })
        : projection.poolEmptyAtMs <= now
          ? t('quota_management.pool_empty_now')
          : formatWhen(projection.poolEmptyAtMs, now, locale);

  const firstEmpty = projection.firstEmpty ? (
    <>
      <span className={styles.accountName}>{projection.firstEmpty.name}</span>{' '}
      {projection.firstEmpty.atMs <= now
        ? t('quota_management.pool_first_empty_now')
        : t('quota_management.pool_in', { span: formatSpan(projection.firstEmpty.atMs - now, t) })}
    </>
  ) : burnPerHour === null ? (
    dash
  ) : (
    t('quota_management.pool_not_by', { date: formatMonthDay(summary.horizonMs, locale) })
  );

  const nextReset = projection.nextReset ? (
    <>
      <strong>+{formatPercent(projection.nextReset.gain)}</strong>{' '}
      <span className={styles.statMuted}>{formatWhen(projection.nextReset.atMs, now, locale)}</span>
    </>
  ) : (
    dash
  );

  const historyNote =
    recorded.points.length > 0
      ? null
      : !RECORDED_PROVIDERS.has(provider)
        ? t('quota_management.pool_history_unsupported')
        : historyEnabled
          ? t('quota_management.pool_history_none')
          : t('quota_management.pool_history_off');

  const chartLabel = t('quota_management.pool_chart_label', {
    provider: label,
    remaining: formatPercent(summary.remaining),
    total: formatPercent(summary.total),
    empty: poolEmpty,
  });

  return (
    <article className={styles.card} aria-label={label}>
      <div className={styles.top}>
        <div className={styles.identity}>
          <div className={styles.title}>
            <span
              className={styles.iconWrap}
              style={
                isThemeSurfaceIconProvider(provider)
                  ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                  : undefined
              }
            >
              {iconSrc ? (
                <img src={iconSrc} alt="" className={styles.icon} />
              ) : (
                <span className={styles.iconFallback}>{label.slice(0, 1).toUpperCase()}</span>
              )}
            </span>
            <h2 className={styles.name}>{label}</h2>
            <span className={styles.count}>
              {t('quota_management.pool_accounts', { count: accounts.length })}
              {notLoaded > 0 && (
                <> · {t('quota_management.pool_not_loaded', { count: notLoaded })}</>
              )}
            </span>
          </div>
          {accounts.length > 0 && (
            <p className={styles.headline}>
              <span className={styles.remaining}>{formatPercent(summary.remaining)}</span>
              <span className={styles.total}>
                {t('quota_management.pool_of_total', { total: formatPercent(summary.total) })}
              </span>
            </p>
          )}
        </div>

        {accounts.length > 0 && (
          <dl className={styles.stats}>
            <Stat label={t('quota_management.pool_stat_empty')}>{poolEmpty}</Stat>
            <Stat label={t('quota_management.pool_stat_first_empty')}>{firstEmpty}</Stat>
            <Stat label={t('quota_management.pool_stat_next_reset')}>{nextReset}</Stat>
            <Stat label={t('quota_management.pool_stat_burn', { hours: burnWindowHours })}>
              {burnPerHour === null ? dash : formatRate(burnPerHour)}
            </Stat>
          </dl>
        )}
      </div>

      {accounts.length === 0 ? (
        <p className={styles.emptyNote}>{t('quota_management.pool_no_accounts')}</p>
      ) : (
        <>
          <QuotaPoolChart
            mode={mode}
            color={color}
            rangeStartMs={rangeStartMs}
            rangeEndMs={rangeEndMs}
            now={now}
            total={summary.total}
            recorded={recorded.points}
            recordedJumps={recorded.jumps}
            projection={projection.points}
            projectedResets={projection.resets}
            poolEmptyAtMs={projection.poolEmptyAtMs}
            drain={drain}
            projectedDrain={burnPerHour === null ? null : burnPerHour * multiplier}
            ariaLabel={chartLabel}
          />
          <div className={styles.legend} style={{ '--pool-color': color } as CSSProperties}>
            <span className={styles.legendTitle}>
              {mode === 'drain'
                ? t('quota_management.pool_legend_drain')
                : t('quota_management.pool_legend_pool')}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendSolid} aria-hidden="true" />
              {t('quota_management.pool_legend_recorded')}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendDashed} aria-hidden="true" />
              {t('quota_management.pool_legend_projected')}
            </span>
            {historyNote && <span className={styles.legendNote}>{historyNote}</span>}
          </div>
        </>
      )}
    </article>
  );
}
