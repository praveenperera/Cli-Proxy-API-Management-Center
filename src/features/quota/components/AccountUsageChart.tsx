/**
 * One window's recorded used percent: step line and area, steady pace, resets,
 * spans with no reading, and a hover readout.
 *
 * Same construction as the pool chart: the SVG stretches to the plot
 * (`preserveAspectRatio="none"`) and only draws lines and fills with
 * non-scaling strokes, while labels, dots and rules are HTML positioned by
 * percentage on top, so no resize observer is needed.
 */

import { useMemo, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DAY_MS } from '@/utils/time/durations';
import { usageAxisTicks, usageStepAt, paceAt, type UsageWindowView } from '../accountUsageModel';
import { formatPercentTenth, formatWhen, paceText } from '../poolFormat';
import styles from './AccountUsageChart.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
/** Reset labels closer than this fraction of the width would overlap; the earlier one is dropped. */
const LABEL_MIN_GAP = 0.22;
/** Windows at least this long get their ends labeled; shorter ones only get the line. */
const LABELED_END_MIN_PERIOD_MS = DAY_MS;

/** Range fraction and view-box coordinates for one chart's range. */
function chartScale(startMs: number, span: number) {
  const fx = (ms: number) => Math.min(1, Math.max(0, (ms - startMs) / span));
  const fy = (used: number) => Math.min(1, Math.max(0, used / 100));
  return {
    fx,
    fy,
    x: (ms: number) => (fx(ms) * VIEW_WIDTH).toFixed(2),
    y: (used: number) => (VIEW_HEIGHT - fy(used) * VIEW_HEIGHT).toFixed(2),
  };
}

export interface AccountUsageChartProps {
  view: UsageWindowView;
  startMs: number;
  now: number;
  /** Provider color for the used line and area. */
  color: string;
  ariaLabel: string;
}

export function AccountUsageChart({
  view,
  startMs,
  now,
  color,
  ariaLabel,
}: AccountUsageChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const span = Math.max(1, now - startMs);
  const { fx, fy, x: px } = chartScale(startMs, span);

  // memoized apart from the hover state: a 30-day range can hold thousands of steps
  const paths = useMemo(() => {
    const { x, y } = chartScale(startMs, span);

    // contiguous steps make one path, so a change draws as a jump at the reading that saw it
    const runs: (typeof view.steps)[] = [];
    view.steps.forEach((step) => {
      const run = runs[runs.length - 1];
      if (run && run[run.length - 1].t1 === step.t0) run.push(step);
      else runs.push([step]);
    });
    const used = runs.map((run) => {
      const line = run
        .map(
          (step, index) =>
            `${index === 0 ? 'M' : 'L'}${x(step.t0)} ${y(step.used)} L${x(step.t1)} ${y(step.used)}`
        )
        .join(' ');
      const area = `${line} L${x(run[run.length - 1].t1)} ${VIEW_HEIGHT} L${x(run[0].t0)} ${VIEW_HEIGHT} Z`;
      return { line, area };
    });
    const pace = view.pace.map((points) =>
      points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.atMs)} ${y(point.value)}`)
        .join(' ')
    );
    return { used, pace };
  }, [view, startMs, span]);

  const ticks = usageAxisTicks(startMs, now);

  // newest first, so the latest window end keeps its label when two crowd
  const endLabels: typeof view.ends = [];
  if (view.periodMs >= LABELED_END_MIN_PERIOD_MS) {
    [...view.ends].reverse().forEach((end) => {
      const last = endLabels[endLabels.length - 1];
      if (!last || fx(last.atMs) - fx(end.atMs) >= LABEL_MIN_GAP) endLabels.push(end);
    });
  }

  const hover = useMemo(() => {
    if (hoverMs === null) return null;
    const step = usageStepAt(view.steps, hoverMs);
    const pace =
      step && view.detailed && !step.afterReset && step.resetAtMs !== null
        ? paceAt(view.periodMs, step.resetAtMs, hoverMs)
        : null;
    return { atMs: hoverMs, step, pace };
  }, [hoverMs, view]);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverMs(startMs + fraction * span);
  };

  const at = (x: number, y: number): CSSProperties => ({
    left: `${(x * 100).toFixed(3)}%`,
    top: `${((1 - y) * 100).toFixed(3)}%`,
  });
  const formatTick = (atMs: number, day: boolean) =>
    new Date(atMs).toLocaleString(
      locale,
      day ? { month: 'short', day: 'numeric' } : { hour: 'numeric' }
    );
  const hoverTime = (atMs: number) =>
    new Date(atMs).toLocaleString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  return (
    <div className={styles.chart} style={{ '--pool-color': color } as CSSProperties}>
      <div className={styles.yAxis} aria-hidden="true">
        {[1, 0.5, 0].map((fraction) => (
          <span key={fraction} className={styles.yTick} style={at(0, fraction)}>
            {fraction * 100}%
          </span>
        ))}
      </div>

      <div
        className={styles.plot}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerMove}
        onPointerLeave={() => setHoverMs(null)}
      >
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {view.gaps.map((gap) => (
            <rect
              key={gap.fromMs}
              className={styles.gap}
              x={px(gap.fromMs)}
              y="0"
              width={Math.max(0, (fx(gap.toMs) - fx(gap.fromMs)) * VIEW_WIDTH).toFixed(2)}
              height={VIEW_HEIGHT}
            />
          ))}
          {[1, 0.5].map((fraction) => (
            <line
              key={fraction}
              className={styles.gridline}
              x1="0"
              x2={VIEW_WIDTH}
              y1={VIEW_HEIGHT - fraction * VIEW_HEIGHT}
              y2={VIEW_HEIGHT - fraction * VIEW_HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            className={styles.baseline}
            x1="0"
            x2={VIEW_WIDTH}
            y1={VIEW_HEIGHT}
            y2={VIEW_HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
          {view.ends.map((end) => (
            <line
              key={end.atMs}
              className={styles.reset}
              x1={px(end.atMs)}
              x2={px(end.atMs)}
              y1="0"
              y2={VIEW_HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {paths.used.map((run) => (
            <path key={`area-${run.area}`} className={styles.area} d={run.area} />
          ))}
          {paths.pace.map((d) => (
            <path key={d} className={styles.pace} d={d} vectorEffect="non-scaling-stroke" />
          ))}
          {paths.used.map((run) => (
            <path
              key={`line-${run.line}`}
              className={styles.used}
              d={run.line}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        <div className={styles.overlay} aria-hidden="true">
          {endLabels.map((end) => (
            <span
              key={end.atMs}
              className={`${styles.endLabel} ${fx(end.atMs) < 0.25 ? styles.endLabelRight : ''}`}
              style={{ left: `${fx(end.atMs) * 100}%` }}
            >
              {t('quota_management.usage_window_ended', {
                percent: formatPercentTenth(end.peakUsed),
              })}
            </span>
          ))}
          {hover && (
            <>
              <span className={styles.hoverRule} style={{ left: `${fx(hover.atMs) * 100}%` }} />
              {hover.step && (
                <span className={styles.hoverDot} style={at(fx(hover.atMs), fy(hover.step.used))} />
              )}
              <span
                className={`${styles.tooltip} ${fx(hover.atMs) > 0.6 ? styles.tooltipLeft : ''}`}
                style={{ left: `${fx(hover.atMs) * 100}%` }}
              >
                <span className={styles.tooltipTime}>{hoverTime(hover.atMs)}</span>
                {hover.step ? (
                  <>
                    <span className={styles.tooltipValue}>
                      {t('quota_management.usage_tip_used', {
                        percent: formatPercentTenth(hover.step.used),
                      })}
                    </span>
                    {hover.pace !== null && (
                      <span className={styles.tooltipNote}>
                        {paceText(hover.step.used, hover.pace, t)}
                      </span>
                    )}
                    {hover.step.afterReset ? (
                      <span className={styles.tooltipNote}>
                        {t('quota_management.usage_tip_after_reset')}
                      </span>
                    ) : (
                      hover.step.resetAtMs !== null && (
                        <span className={styles.tooltipNote}>
                          {t('quota_management.usage_tip_resets', {
                            when: formatWhen(hover.step.resetAtMs, now, locale),
                          })}
                        </span>
                      )
                    )}
                  </>
                ) : (
                  <span className={styles.tooltipValue}>
                    {t('quota_management.usage_tip_no_readings')}
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.atMs}
            className={`${styles.xTick} ${tick.day ? styles.xTickDay : ''}`}
            style={{ left: `${fx(tick.atMs) * 100}%` }}
          >
            {formatTick(tick.atMs, tick.day)}
          </span>
        ))}
      </div>
    </div>
  );
}
