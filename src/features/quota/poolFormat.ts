/**
 * Display formatting for the pooled quota cards. Times are browser-local and
 * formatted with the UI language rather than the browser default, so labels
 * read in the same language as the rest of the page.
 */

import type { TFunction } from 'i18next';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

/**
 * "Fri 23" — x-axis day ticks. Intl orders these two parts inconsistently
 * ("23 Fri" in English), so the order comes from the translation instead.
 */
export const formatDayTick = (ms: number, locale: string, t: TFunction) => {
  const date = new Date(ms);
  return t('quota_management.pool_day_tick', {
    weekday: date.toLocaleDateString(locale, { weekday: 'short' }),
    day: date.getDate(),
  });
};

/** "Oct 23" — range label ends and far-off dates. */
export const formatMonthDay = (ms: number, locale: string) =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/**
 * "Sun 4:40 PM" while the weekday is unambiguous (under a week out),
 * "Nov 9, 4:40 PM" beyond it
 */
export function formatWhen(ms: number, now: number, locale: string): string {
  const withinWeek = ms - now < 7 * DAY_MS - HOUR_MS && ms >= now - DAY_MS;
  return new Date(ms).toLocaleString(
    locale,
    withinWeek
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  );
}

/** "15h 49m", "2d 18h", "12m" — two most significant units. */
export function formatSpan(ms: number, t: TFunction): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor((minutes * MINUTE_MS) / DAY_MS);
  const hours = Math.floor(((minutes * MINUTE_MS) % DAY_MS) / HOUR_MS);
  const rest = minutes % 60;
  if (days > 0) return t('quota_management.pool_span_dh', { d: days, h: hours });
  if (hours > 0) return t('quota_management.pool_span_hm', { h: hours, m: rest });
  return t('quota_management.pool_span_m', { m: rest });
}

/** Whole percent for pool sizes; one decimal for rates. */
export const formatPercent = (value: number) => `${Math.round(value)}%`;

export const formatRate = (value: number) =>
  `${value >= 10 ? Math.round(value) : value.toFixed(1)}%/h`;

/** Recorded percents to a tenth, dropping a trailing ".0": "44%", "62.5%". */
export const formatPercentTenth = (value: number) => `${Math.round(value * 10) / 10}%`;

/** "12% ahead of pace", "3% under pace", "On pace". */
export function paceText(used: number, pace: number, t: TFunction): string {
  const delta = Math.round(used - pace);
  if (delta > 0) return t('quota_management.usage_pace_ahead', { percent: `${delta}%` });
  if (delta < 0) return t('quota_management.usage_pace_under', { percent: `${-delta}%` });
  return t('quota_management.usage_pace_on');
}
