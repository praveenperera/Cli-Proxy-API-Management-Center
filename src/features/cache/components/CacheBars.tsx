import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { CacheUsageTotals } from '@/services/api/cacheUsage';
import { formatCompactNumber } from '@/utils/format';
import { formatHitRatio, tokenShare } from '../cacheModel';
import styles from './CacheBars.module.scss';

/** Hit ratio as a number with a thin bar beneath it. */
export function HitMeter({ ratio }: { ratio: number | null }) {
  return (
    <span className={styles.meter}>
      <span className={styles.meterValue}>{formatHitRatio(ratio)}</span>
      <span className={styles.meterTrack} aria-hidden="true">
        {ratio !== null && (
          <span className={styles.meterFill} style={{ width: `${ratio * 100}%` }} />
        )}
      </span>
    </span>
  );
}

const shareLabel = (share: number) => `${Math.round(share * 1000) / 10}%`;

function compositionSegments(totals: CacheUsageTotals, t: TFunction) {
  const share = tokenShare(totals);
  return [
    {
      key: 'read',
      className: styles.read,
      label: t('cache_usage.cache_read'),
      tokens: totals.cacheReadTokens,
      value: share.read,
    },
    {
      key: 'write',
      className: styles.write,
      label: t('cache_usage.cache_write'),
      tokens: totals.cacheWriteTokens,
      value: share.write,
    },
    {
      key: 'uncached',
      className: styles.uncached,
      label: t('cache_usage.uncached'),
      tokens: totals.uncachedTokens,
      value: share.uncached,
    },
  ];
}

/**
 * Input tokens split into cache read, cache write, and uncached. Each segment
 * names its share on hover; the legend carries the same numbers as text
 */
export function CompositionBar({ totals }: { totals: CacheUsageTotals }) {
  const { t } = useTranslation();
  return (
    <div className={styles.bar} role="img" aria-label={t('cache_usage.composition_label')}>
      {compositionSegments(totals, t)
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.key}
            className={`${styles.segment} ${segment.className}`}
            style={{ flexGrow: segment.value }}
            title={`${segment.label}: ${formatCompactNumber(segment.tokens)} (${shareLabel(segment.value)})`}
          />
        ))}
    </div>
  );
}

/** Legend for the composition bar, with token counts and shares. */
export function CompositionLegend({ totals }: { totals: CacheUsageTotals }) {
  const { t } = useTranslation();
  return (
    <ul className={styles.legend}>
      {compositionSegments(totals, t).map((item) => (
        <li key={item.key} className={styles.legendItem}>
          <span className={`${styles.swatch} ${item.className}`} aria-hidden="true" />
          <span className={styles.legendLabel}>{item.label}</span>
          <span className={styles.legendValue}>
            {formatCompactNumber(item.tokens)}
            <span className={styles.legendShare}>{shareLabel(item.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
