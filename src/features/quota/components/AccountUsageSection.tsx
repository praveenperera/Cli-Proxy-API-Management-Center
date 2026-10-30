/**
 * Per-account usage for one provider, drawn only from the recorded quota
 * history: each account's windows with used percent, pace, reset countdown,
 * freshness and a history chart.
 *
 * It never asks a provider for quota. The backend polls every account once a
 * minute and the page re-reads the history on the same cadence, so this
 * section stays current with no clicks and adds no upstream traffic.
 */

import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/Skeleton';
import { getTypeColor } from '@/features/authFiles/constants';
import type { QuotaHistory } from '@/services/api/quotaHistory';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { MINUTE_MS, DAY_MS } from '@/utils/time/durations';
import {
  ACCOUNT_RANGE_DAYS,
  collectUsageAccounts,
  type AccountRangeDays,
  type UsageAccount,
  type UsageWindowView,
} from '../accountUsageModel';
import { formatPercentTenth, formatSpan, formatWhen, paceText } from '../poolFormat';
import type { QuotaProviderType } from '../providers/types';
import { AccountUsageChart } from './AccountUsageChart';
import { Segmented } from './QuotaPoolToolbar';
import styles from './AccountUsageSection.module.scss';

export interface AccountUsageSectionProps {
  provider: QuotaProviderType;
  files: readonly AuthFileItem[];
  history: QuotaHistory;
  historyLoaded: boolean;
  /** The latest history read failed; shown data, if any, is from the last good read. */
  historyFailed: boolean;
  showEmails: boolean;
  rangeDays: AccountRangeDays;
  onRangeDaysChange: (days: AccountRangeDays) => void;
  /** Plan known without asking the provider, for when the history carries none. */
  planTypeFor: (file: AuthFileItem) => string | null;
  /** Display name for a plan type of this provider. */
  planLabel: (planType: string) => string | null;
  now: number;
  resolvedTheme: ResolvedTheme;
}

type T = ReturnType<typeof useTranslation>['t'];

const formatAgo = (ms: number, t: T) =>
  ms < MINUTE_MS
    ? t('quota_management.usage_updated_now')
    : t('quota_management.usage_updated_ago', { span: formatSpan(ms, t) });

function windowTitle(view: UsageWindowView, t: T) {
  if (view.kind === 'five_hour') return t('quota_management.usage_window_five_hour');
  if (view.kind === 'weekly') return t('quota_management.usage_window_weekly');
  return t('quota_management.usage_window_other', { span: formatSpan(view.periodMs, t) });
}

/** Fill tone by what is left, matching the live quota meters. */
const toneClass = (used: number) =>
  used <= 30 ? styles.toneHigh : used <= 70 ? styles.toneMedium : styles.toneLow;

interface WindowPanelProps {
  account: UsageAccount;
  view: UsageWindowView;
  startMs: number;
  now: number;
  color: string;
}

function WindowPanel({ account, view, startMs, now, color }: WindowPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const title = windowTitle(view, t);
  const current = view.current;

  if (!current) {
    return (
      <div className={styles.window}>
        <div className={styles.windowHead}>
          <h4 className={styles.windowTitle}>{title}</h4>
        </div>
        <p className={styles.empty}>{t('quota_management.usage_no_readings_window')}</p>
      </div>
    );
  }

  const used = current.used;
  const meterLabel =
    current.paceUsed === null
      ? t('quota_management.usage_tip_used', { percent: formatPercentTenth(used) })
      : t('quota_management.usage_meter_label', {
          used: formatPercentTenth(used),
          pace: `${Math.round(current.paceUsed)}%`,
        });

  const resetText =
    current.resetPassedAtMs !== null
      ? t('quota_management.usage_reset_passed', {
          when: formatWhen(current.resetPassedAtMs, now, locale),
        })
      : current.resetAtMs !== null
        ? t('quota_management.usage_resets_in', {
            span: formatSpan(current.resetAtMs - now, t),
            when: formatWhen(current.resetAtMs, now, locale),
          })
        : used === 0
          ? t('quota_management.usage_not_started')
          : null;

  return (
    <div className={styles.window}>
      <div className={styles.windowHead}>
        <h4 className={styles.windowTitle}>{title}</h4>
        <span
          className={`${styles.freshness} ${current.stale ? styles.freshnessStale : ''}`}
          title={new Date(current.observedAtMs).toLocaleString(locale)}
        >
          {formatAgo(now - current.observedAtMs, t)}
        </span>
      </div>

      <p className={styles.figure}>
        <span className={styles.percent}>{formatPercentTenth(used)}</span>
        <span className={styles.figureNote}>
          {t('quota_management.usage_used_left', { percent: formatPercentTenth(100 - used) })}
        </span>
      </p>

      <div className={styles.meter} role="img" aria-label={meterLabel}>
        <span className={`${styles.fill} ${toneClass(used)}`} style={{ width: `${used}%` }} />
        {current.paceUsed !== null && (
          <span className={styles.ideal} style={{ left: `${current.paceUsed}%` }} />
        )}
      </div>

      <p className={styles.meta}>
        {current.paceUsed !== null && (
          <span className={styles.pace}>{paceText(used, current.paceUsed, t)}</span>
        )}
        {resetText && <span>{resetText}</span>}
      </p>

      <AccountUsageChart
        view={view}
        startMs={startMs}
        now={now}
        color={color}
        ariaLabel={t('quota_management.usage_chart_label', {
          account: account.name,
          window: title,
          percent: formatPercentTenth(used),
        })}
      />
    </div>
  );
}

function AccountCard({
  account,
  planLabel,
  startMs,
  now,
  color,
}: {
  account: UsageAccount;
  planLabel: (planType: string) => string | null;
  startMs: number;
  now: number;
  color: string;
}) {
  const { t } = useTranslation();
  const plan = account.planType ? planLabel(account.planType) : null;
  const hasReadings = account.latestAtMs !== null;

  return (
    <article className={styles.card} aria-label={account.name}>
      <header className={styles.cardHead}>
        <h3 className={styles.name} title={account.name}>
          {account.name}
        </h3>
        {plan && <span className={styles.pill}>{plan}</span>}
        {account.quotaWeight !== null && account.quotaWeight !== 1 && (
          <span className={styles.pill} title={t('auth_files.quota_weight_label')}>
            {t('quota_management.usage_weight', { weight: account.quotaWeight })}
          </span>
        )}
        {account.disabled && (
          <span className={`${styles.pill} ${styles.pillMuted}`}>
            {t('quota_management.usage_disabled')}
          </span>
        )}
      </header>

      {account.stale && account.latestAtMs !== null && (
        <p className={styles.staleNote} role="status">
          {t('quota_management.usage_stale', { span: formatSpan(now - account.latestAtMs, t) })}
        </p>
      )}

      {!hasReadings ? (
        <p className={styles.empty}>{t('quota_management.usage_no_readings')}</p>
      ) : (
        <div className={styles.windows}>
          {account.windows.map((view) => (
            <WindowPanel
              key={view.id}
              account={account}
              view={view}
              startMs={startMs}
              now={now}
              color={color}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function AccountUsageSection(props: AccountUsageSectionProps) {
  const {
    provider,
    files,
    history,
    historyLoaded,
    historyFailed,
    showEmails,
    rangeDays,
    onRangeDaysChange,
    planTypeFor,
    planLabel,
    now,
    resolvedTheme,
  } = props;
  const { t } = useTranslation();
  const color = getTypeColor(provider, resolvedTheme).text;
  const startMs = now - rangeDays * DAY_MS;

  const accounts = useMemo(
    () =>
      collectUsageAccounts({
        provider,
        files,
        history,
        showEmails,
        filePlanType: planTypeFor,
        startMs,
        now,
      }),
    [provider, files, history, showEmails, planTypeFor, startMs, now]
  );

  const rangeOptions = ACCOUNT_RANGE_DAYS.map((days) => ({
    value: days,
    label: t('quota_management.usage_range_option', { days }),
  }));

  return (
    <section
      className={styles.section}
      aria-label={t('quota_management.usage_title')}
      style={{ '--pool-color': color } as CSSProperties}
    >
      <div className={styles.head}>
        <div className={styles.heading}>
          <h3 className={styles.title}>{t('quota_management.usage_title')}</h3>
          <span className={styles.subtitle}>{t('quota_management.usage_subtitle')}</span>
        </div>
        <div className={styles.controls}>
          <ul className={styles.legend} aria-hidden="true">
            <li>
              <span className={styles.swatchUsed} />
              {t('quota_management.usage_legend_used')}
            </li>
            <li>
              <span className={styles.swatchPace} />
              {t('quota_management.usage_legend_pace')}
            </li>
            <li>
              <span className={styles.swatchReset} />
              {t('quota_management.usage_legend_reset')}
            </li>
            <li>
              <span className={styles.swatchGap} />
              {t('quota_management.usage_legend_gap')}
            </li>
          </ul>
          <Segmented
            label={t('quota_management.usage_range')}
            value={rangeDays}
            onChange={onRangeDaysChange}
            options={rangeOptions}
          />
        </div>
      </div>

      {historyFailed && (
        <p className={styles.notice} role="status">
          {historyLoaded
            ? t('quota_management.usage_read_failed_stale')
            : t('quota_management.usage_read_failed')}
        </p>
      )}
      {!historyLoaded ? (
        !historyFailed && <Skeleton height={220} rounded={14} />
      ) : !history.enabled ? (
        <p className={styles.notice}>{t('quota_management.usage_history_off')}</p>
      ) : (
        <div className={styles.cards}>
          {accounts.map((account) => (
            <AccountCard
              key={account.key}
              account={account}
              planLabel={planLabel}
              startMs={startMs}
              now={now}
              color={color}
            />
          ))}
        </div>
      )}
    </section>
  );
}
