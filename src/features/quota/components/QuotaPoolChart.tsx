/**
 * Pooled quota chart: recorded history, projection, resets and the empty point.
 *
 * The SVG stretches to the card (`preserveAspectRatio="none"`) and only draws
 * lines and fills, with non-scaling strokes. Everything that must keep its
 * shape — labels, dots, the Now rule — is HTML positioned by percentage on top,
 * so the chart needs no resize observer and renders identically on the server.
 */

import {
  useCallback,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { buildSmoothLinePath } from '@/features/dashboard/components/curve';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  clipSeries,
  dayTicks,
  seriesValueAt,
  type PoolChartMode,
  type PoolResetEvent,
  type PoolSample,
} from '../quotaPoolModel';
import { formatDayTick, formatPercent, formatRate, formatWhen } from '../poolFormat';
import styles from './QuotaPoolChart.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 200;
/** Labels closer than this fraction of the width would overlap; the later one is dropped. */
const LABEL_MIN_GAP = 0.035;

export interface QuotaPoolChartProps {
  mode: PoolChartMode;
  /** Provider color for the line and fill. */
  color: string;
  rangeStartMs: number;
  rangeEndMs: number;
  now: number;
  /** Pool capacity: the 100% line of the remaining chart. */
  total: number;
  recorded: PoolSample[];
  recordedJumps: { atMs: number; gain: number }[];
  projection: PoolSample[];
  projectedResets: PoolResetEvent[];
  poolEmptyAtMs: number | null;
  drain: PoolSample[];
  /** Projected demand in %/h, drawn flat from now in drain mode. */
  projectedDrain: number | null;
  ariaLabel: string;
}

/** Round an axis maximum up to a readable number. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

export function QuotaPoolChart(props: QuotaPoolChartProps) {
  const {
    mode,
    color,
    rangeStartMs,
    rangeEndMs,
    now,
    total,
    recorded,
    recordedJumps,
    projection,
    projectedResets,
    poolEmptyAtMs,
    drain,
    projectedDrain,
    ariaLabel,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const gradientId = useId();
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const span = rangeEndMs - rangeStartMs;
  const fx = useCallback((ms: number) => (ms - rangeStartMs) / span, [rangeStartMs, span]);
  const nowVisible = now >= rangeStartMs && now <= rangeEndMs;

  const geometry = useMemo(() => {
    const isDrain = mode === 'drain';
    const pastSeries = clipSeries(isDrain ? drain : recorded, rangeStartMs, rangeEndMs);
    const futureSeries = isDrain
      ? projectedDrain !== null && now < rangeEndMs
        ? [
            { atMs: Math.max(now, rangeStartMs), value: projectedDrain },
            { atMs: rangeEndMs, value: projectedDrain },
          ]
        : []
      : clipSeries(projection, rangeStartMs, rangeEndMs);

    const yMax = isDrain
      ? niceMax(Math.max(0, ...pastSeries.map((p) => p.value), projectedDrain ?? 0) * 1.1)
      : Math.max(total, 1);
    const fy = (value: number) => Math.min(1, Math.max(0, value / yMax));
    const toPoint = (sample: PoolSample) => ({
      x: fx(sample.atMs) * VIEW_WIDTH,
      y: VIEW_HEIGHT - fy(sample.value) * VIEW_HEIGHT,
    });

    const linePath = (series: PoolSample[], smooth: boolean) => {
      const points = series.map(toPoint);
      if (points.length < 2) return '';
      return smooth
        ? buildSmoothLinePath(points, 0, VIEW_HEIGHT)
        : points
            .map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(' ');
    };
    const areaPath = (series: PoolSample[], line: string) => {
      if (!line) return '';
      const first = toPoint(series[0]);
      const last = toPoint(series[series.length - 1]);
      return `${line} L${last.x.toFixed(2)} ${VIEW_HEIGHT} L${first.x.toFixed(2)} ${VIEW_HEIGHT} Z`;
    };

    // drain buckets are hourly averages, so a smoothed curve reads truer than corners
    const pastLine = linePath(pastSeries, isDrain);
    const futureLine = linePath(futureSeries, false);

    return {
      yMax,
      fy,
      pastSeries,
      futureSeries,
      pastLine,
      pastArea: areaPath(pastSeries, pastLine),
      futureLine,
      futureArea: areaPath(futureSeries, futureLine),
    };
  }, [mode, drain, recorded, projection, projectedDrain, rangeStartMs, rangeEndMs, now, total, fx]);

  const ticks = useMemo(() => dayTicks(rangeStartMs, rangeEndMs), [rangeStartMs, rangeEndMs]);

  const stepLabels = useMemo(() => {
    if (mode !== 'remaining') return [];
    const events = [
      ...recordedJumps.map((jump) => ({ ...jump, series: geometry.pastSeries })),
      ...projectedResets.map((reset) => ({ ...reset, series: geometry.futureSeries })),
    ]
      .filter((event) => event.atMs >= rangeStartMs && event.atMs <= rangeEndMs)
      .sort((a, b) => a.atMs - b.atMs);
    const out: { atMs: number; gain: number; value: number }[] = [];
    for (const event of events) {
      const value = seriesValueAt(event.series, event.atMs);
      if (value === null) continue;
      const last = out[out.length - 1];
      if (last && fx(event.atMs) - fx(last.atMs) < LABEL_MIN_GAP) continue;
      out.push({ atMs: event.atMs, gain: event.gain, value });
    }
    return out;
  }, [mode, recordedJumps, projectedResets, geometry, rangeStartMs, rangeEndMs, fx]);

  const nowValue = useMemo(() => {
    if (!nowVisible) return null;
    return (
      seriesValueAt(geometry.futureSeries, now) ?? seriesValueAt(geometry.pastSeries, now) ?? null
    );
  }, [geometry, now, nowVisible]);

  const showEmpty =
    mode === 'remaining' &&
    poolEmptyAtMs !== null &&
    poolEmptyAtMs >= rangeStartMs &&
    poolEmptyAtMs <= rangeEndMs;

  const hover = useMemo(() => {
    if (hoverMs === null) return null;
    const value =
      hoverMs <= now
        ? seriesValueAt(geometry.pastSeries, hoverMs)
        : seriesValueAt(geometry.futureSeries, hoverMs);
    if (value === null) return null;
    return { atMs: hoverMs, value, projected: hoverMs > now };
  }, [hoverMs, now, geometry]);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverMs(rangeStartMs + fraction * span);
  };

  const formatValue = (value: number) =>
    mode === 'drain' ? formatRate(value) : formatPercent(value);
  const yTicks = [1, 0.5, 0].map((fraction) => ({
    fraction,
    label: formatValue(geometry.yMax * fraction),
  }));
  const at = (x: number, y: number): CSSProperties => ({
    left: `${(x * 100).toFixed(3)}%`,
    top: `${((1 - y) * 100).toFixed(3)}%`,
  });

  return (
    <div className={styles.chart} style={{ '--pool-color': color } as CSSProperties}>
      <div className={styles.yAxis} aria-hidden="true">
        {yTicks.map((tick) => (
          <span key={tick.fraction} className={styles.yTick} style={at(0, tick.fraction)}>
            {tick.label}
          </span>
        ))}
      </div>

      <div
        className={styles.plot}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverMs(null)}
      >
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={`${gradientId}-past`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--pool-color)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--pool-color)" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`${gradientId}-future`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--pool-color)" stopOpacity="0.12" />
              <stop offset="100%" stopColor="var(--pool-color)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((tick) => (
            <line
              key={tick.fraction}
              className={tick.fraction === 0 ? styles.baseline : styles.gridline}
              x1="0"
              x2={VIEW_WIDTH}
              y1={VIEW_HEIGHT - tick.fraction * VIEW_HEIGHT}
              y2={VIEW_HEIGHT - tick.fraction * VIEW_HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {geometry.futureArea && (
            <path d={geometry.futureArea} fill={`url(#${gradientId}-future)`} stroke="none" />
          )}
          {geometry.pastArea && (
            <path d={geometry.pastArea} fill={`url(#${gradientId}-past)`} stroke="none" />
          )}
          {geometry.futureLine && (
            <path
              className={styles.projectedLine}
              d={geometry.futureLine}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {geometry.pastLine && (
            <path
              className={styles.recordedLine}
              d={geometry.pastLine}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        <div className={styles.overlay} aria-hidden="true">
          {nowVisible && (
            <>
              <span className={styles.nowRule} style={{ left: `${fx(now) * 100}%` }} />
              <span className={styles.nowLabel} style={{ left: `${fx(now) * 100}%` }}>
                {t('quota_management.pool_now')}
              </span>
              {nowValue !== null && (
                <span className={styles.nowDot} style={at(fx(now), geometry.fy(nowValue))} />
              )}
            </>
          )}
          {stepLabels.map((label) => (
            <span
              key={label.atMs}
              className={styles.stepLabel}
              style={at(fx(label.atMs), geometry.fy(label.value))}
            >
              +{formatPercent(label.gain)}
            </span>
          ))}
          {showEmpty && poolEmptyAtMs !== null && (
            <>
              <span className={styles.emptyDot} style={at(fx(poolEmptyAtMs), 0)} />
              <span
                className={`${styles.emptyLabel} ${fx(poolEmptyAtMs) > 0.8 ? styles.emptyLabelLeft : ''}`}
                style={at(fx(poolEmptyAtMs), 0)}
              >
                {t('quota_management.pool_empty_marker', {
                  time: formatWhen(poolEmptyAtMs, now, locale),
                })}
              </span>
            </>
          )}
          {hover && (
            <>
              <span className={styles.hoverRule} style={{ left: `${fx(hover.atMs) * 100}%` }} />
              <span
                className={styles.hoverDot}
                style={at(fx(hover.atMs), geometry.fy(hover.value))}
              />
              <span
                className={`${styles.tooltip} ${fx(hover.atMs) > 0.75 ? styles.tooltipLeft : ''}`}
                style={{ left: `${fx(hover.atMs) * 100}%` }}
              >
                <span className={styles.tooltipTime}>{formatWhen(hover.atMs, now, locale)}</span>
                <span className={styles.tooltipValue}>{formatValue(hover.value)}</span>
                <span className={styles.tooltipKind}>
                  {hover.projected
                    ? t('quota_management.pool_legend_projected')
                    : t('quota_management.pool_legend_recorded')}
                </span>
              </span>
            </>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {ticks.map((tick) => {
          const center = fx(tick + 12 * HOUR_MS);
          if (center < 0 || center > 1) return null;
          return (
            <span
              key={tick}
              className={`${styles.xTick} ${tick <= now && now < tick + DAY_MS ? styles.xTickToday : ''}`}
              style={{ left: `${center * 100}%` }}
            >
              {formatDayTick(tick, locale, t)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
