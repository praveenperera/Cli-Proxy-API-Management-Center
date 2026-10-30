/**
 * Per-account usage history, built only from the recorded quota history.
 *
 * The backend polls every Claude and Codex account once a minute and records
 * a point on the first reading, on a change of at least 0.1 points, on a new
 * reset, or after a heartbeat with no change. This model turns those points
 * into what one account card draws: each window's used-percent steps, its
 * steady pace, where it reset, where nothing was recorded, and how fresh the
 * latest reading is.
 *
 * Pure functions: no React, no store, no clock of its own (`now` is always
 * passed in), so every case is directly testable.
 */

import type {
  QuotaHistory,
  QuotaHistoryCredential,
  QuotaHistoryPoint,
  QuotaHistoryWindow,
} from '@/services/api/quotaHistory';
import type { AuthFileItem } from '@/types';
import { normalizeRecentRequestAuthIndex } from '@/utils/recentRequests';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from './providers/types';
import { poolAccountName } from './quotaPoolAccounts';

/** Providers whose usage the backend records. */
export const USAGE_HISTORY_PROVIDERS: ReadonlySet<QuotaProviderType> = new Set(['claude', 'codex']);

/** History ranges the account charts offer, in days back from now. */
export const ACCOUNT_RANGE_DAYS = [1, 2, 7, 30] as const;
export type AccountRangeDays = (typeof ACCOUNT_RANGE_DAYS)[number];
export const DEFAULT_ACCOUNT_RANGE_DAYS: AccountRangeDays = 7;

/** How often the backend reads each account. */
const POLL_MS = MINUTE_MS;
/**
 * Longer than this between two points means the backend recorded nothing in
 * between. Live points carry a 15-minute heartbeat and imported ones a
 * 30-minute one that drifted to 35 minutes, so an idle stretch of either stays
 * a plain line.
 */
export const READING_GAP_MS = 40 * MINUTE_MS;
/**
 * The latest point is current while it is younger than this: an unchanged
 * value is only re-recorded every 15 minutes, so an older point can still be
 * today's value, but past this the backend has stopped recording it.
 */
export const STALE_AFTER_MS = 20 * MINUTE_MS;
/**
 * Two readings belong to the same window when their resets are this close:
 * reset instants wobble between readings, and an unused window's slides along
 * with the clock.
 */
const SAME_WINDOW_MS = HOUR_MS;

const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type UsageWindowKind = 'five_hour' | 'weekly' | 'other';

/** One stretch over which a recorded used percent held. */
export interface UsageStep {
  t0: number;
  t1: number;
  /** Used percent, 0..100. */
  used: number;
  /** The reset the reading reported; null when unknown or after it passed. */
  resetAtMs: number | null;
  /** The window reset before the next reading; used is assumed 0 until one arrives. */
  afterReset: boolean;
}

/** One window that ended inside the history, with the most it used. */
export interface UsageWindowEnd {
  atMs: number;
  peakUsed: number;
}

export interface UsageCurrent {
  used: number;
  /** Upcoming reset; null when unknown or when it already passed. */
  resetAtMs: number | null;
  /** The reset that passed since the latest reading, so the window is full again. */
  resetPassedAtMs: number | null;
  /** Where steady use would be by now; null without a known reset and period. */
  paceUsed: number | null;
  observedAtMs: number;
  stale: boolean;
}

export interface UsageWindowView {
  id: string;
  periodMs: number;
  kind: UsageWindowKind;
  /** Steps touching the range, in order; drawn as a step line. */
  steps: UsageStep[];
  /** Spans of the range with no reading. */
  gaps: { fromMs: number; toMs: number }[];
  /** Window ends inside the range; empty when the view is not detailed. */
  ends: UsageWindowEnd[];
  /** Pace polylines; empty when the view is not detailed. */
  pace: { atMs: number; value: number }[][];
  /**
   * Whether pace and resets are drawn. A week of 5-hour windows holds dozens
   * of them, whose lines would bury the usage itself.
   */
  detailed: boolean;
  current: UsageCurrent | null;
}

export interface UsageAccount {
  /** Stable React key. */
  key: string;
  name: string;
  planType: string | null;
  quotaWeight: number | null;
  disabled: boolean;
  /** Windows with a known period, shortest first. */
  windows: UsageWindowView[];
  /** Newest reading across windows; null when nothing was recorded. */
  latestAtMs: number | null;
  /** Every window's latest reading is stale. */
  stale: boolean;
}

/* ------------------------------------------------------------------ fetch */

/**
 * The spans to read so one request covers both the pool and the account
 * charts: the pool's spans plus the last `recentDays` days, merged wherever
 * they overlap.
 */
export function historySpansWithRecent(
  spans: readonly { fromMs: number; toMs: number }[],
  recentDays: number,
  now: number
): { fromMs: number; toMs: number }[] {
  const all = [...spans, { fromMs: now - recentDays * DAY_MS, toMs: now }].sort(
    (a, b) => a.fromMs - b.fromMs
  );
  const merged: { fromMs: number; toMs: number }[] = [];
  all.forEach((span) => {
    const last = merged[merged.length - 1];
    if (last && span.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, span.toMs);
    else merged.push({ ...span });
  });
  return merged;
}

/* ------------------------------------------------------------------ model */

/** Classified by length alone: Codex's `primary` can be a weekly window. */
export function usageWindowKind(periodMs: number): UsageWindowKind {
  if (Math.abs(periodMs - FIVE_HOUR_MS) < MINUTE_MS) return 'five_hour';
  if (Math.abs(periodMs - WEEK_MS) < MINUTE_MS) return 'weekly';
  return 'other';
}

/**
 * Used percent steady use would have reached at `atMs`: the share of the
 * window that has elapsed.
 */
export function paceAt(periodMs: number, resetAtMs: number, atMs: number): number {
  const elapsed = periodMs - (resetAtMs - atMs);
  return Math.min(100, Math.max(0, (elapsed / periodMs) * 100));
}

const usedOf = (point: QuotaHistoryPoint) => Math.min(100, Math.max(0, 100 - point.remaining));

const sameWindow = (a: number | null, b: number | null) =>
  a !== null && b !== null ? Math.abs(a - b) <= SAME_WINDOW_MS : a === b;

/**
 * Each point's value holds until the next point, until its reset passes, or,
 * across a gap, for one poll. The newest point holds until now while it is
 * current.
 */
export function buildUsageSteps(points: readonly QuotaHistoryPoint[], now: number): UsageStep[] {
  const steps: UsageStep[] = [];
  points.forEach((point, index) => {
    const t0 = point.atMs;
    const next = points[index + 1];
    let t1: number;
    if (next) t1 = next.atMs - t0 > READING_GAP_MS ? t0 + POLL_MS : next.atMs;
    else t1 = now - t0 <= STALE_AFTER_MS ? Math.max(now, t0 + POLL_MS) : t0 + POLL_MS;
    // two readings in the same second say nothing about the time between them
    if (t1 <= t0) return;

    const used = usedOf(point);
    const reset = point.resetAtMs;
    // a reading taken after its own reset already describes the next window
    if (reset !== null && reset <= t0) {
      steps.push({ t0, t1, used: 0, resetAtMs: null, afterReset: true });
      return;
    }
    if (reset !== null && reset > t0 && reset < t1) {
      steps.push({ t0, t1: reset, used, resetAtMs: reset, afterReset: false });
      steps.push({ t0: reset, t1, used: 0, resetAtMs: null, afterReset: true });
      return;
    }
    steps.push({ t0, t1, used, resetAtMs: reset, afterReset: false });
  });
  return steps;
}

/**
 * Windows that ended within the points: a reading whose reset had passed by
 * the next one, or whose reset moved by more than wobble. A window that never
 * used anything is skipped, since an unused window's reset only slides.
 */
export function usageWindowEnds(
  points: readonly QuotaHistoryPoint[],
  now: number
): UsageWindowEnd[] {
  const ends: UsageWindowEnd[] = [];
  let peak = 0;
  points.forEach((point, index) => {
    const before = points[index - 1];
    const reset = before?.resetAtMs ?? null;
    if (before && reset !== null) {
      const passed = reset <= point.atMs;
      const moved = point.resetAtMs !== null && !sameWindow(reset, point.resetAtMs);
      if (passed || moved) {
        if (peak > 0) ends.push({ atMs: Math.min(reset, point.atMs), peakUsed: peak });
        peak = 0;
      }
    }
    peak = Math.max(peak, usedOf(point));
  });

  const last = points[points.length - 1];
  if (last?.resetAtMs != null && last.resetAtMs <= now && peak > 0) {
    ends.push({ atMs: last.resetAtMs, peakUsed: peak });
  }
  return ends;
}

/** The step covering `atMs`, if any reading does; the newest step includes its end (now). */
export function usageStepAt(steps: readonly UsageStep[], atMs: number): UsageStep | null {
  const last = steps[steps.length - 1];
  if (last && atMs === last.t1) return last;
  return steps.find((step) => step.t0 <= atMs && atMs < step.t1) ?? null;
}

/** Pace lines across the steps, broken at resets, gaps and unknown resets. */
function buildPaceLines(steps: readonly UsageStep[], periodMs: number) {
  const lines: { atMs: number; value: number }[][] = [];
  let previous: UsageStep | null = null;
  for (const step of steps) {
    const reset = step.resetAtMs;
    if (reset !== null && !step.afterReset) {
      const continues =
        previous !== null &&
        !previous.afterReset &&
        previous.t1 === step.t0 &&
        sameWindow(previous.resetAtMs, reset);
      if (!continues || lines.length === 0) lines.push([]);
      const line = lines[lines.length - 1];
      const at = (atMs: number) => ({ atMs, value: paceAt(periodMs, reset, atMs) });
      // pace sits at 0 before the window started, so the line bends where it did
      const start = reset - periodMs;
      line.push(at(step.t0));
      if (start > step.t0 && start < step.t1) line.push(at(start));
      line.push(at(step.t1));
    }
    previous = step;
  }
  return lines.filter((points) => points.length >= 2);
}

/** Where the range has no reading: before the first, between runs, and after the last. */
function buildGaps(steps: readonly UsageStep[], startMs: number, endMs: number) {
  const gaps: { fromMs: number; toMs: number }[] = [];
  const add = (fromMs: number, toMs: number) => {
    const from = Math.max(startMs, fromMs);
    const to = Math.min(endMs, toMs);
    if (to - from > POLL_MS) gaps.push({ fromMs: from, toMs: to });
  };
  if (steps.length === 0) {
    add(startMs, endMs);
    return gaps;
  }
  add(startMs, steps[0].t0);
  for (let index = 1; index < steps.length; index += 1) {
    add(steps[index - 1].t1, steps[index].t0);
  }
  add(steps[steps.length - 1].t1, endMs);
  return gaps;
}

/**
 * The window as it stands now. A reset that passed after the newest reading
 * has refilled the window even though nothing recorded it yet.
 */
export function usageCurrent(
  window: QuotaHistoryWindow & { periodMs: number },
  now: number
): UsageCurrent | null {
  const last = window.points[window.points.length - 1];
  if (!last) return null;
  const passed = last.resetAtMs !== null && last.resetAtMs <= now;
  const resetAtMs = passed ? null : last.resetAtMs;
  return {
    used: passed ? 0 : usedOf(last),
    resetAtMs,
    resetPassedAtMs: passed ? last.resetAtMs : null,
    paceUsed: resetAtMs === null ? null : paceAt(window.periodMs, resetAtMs, now),
    observedAtMs: last.atMs,
    stale: now - last.atMs > STALE_AFTER_MS,
  };
}

/**
 * Everything one window's chart and summary need over [startMs, now].
 * Windows without a known period are placeholders and yield null.
 */
export function buildUsageWindow(
  window: QuotaHistoryWindow,
  startMs: number,
  now: number
): UsageWindowView | null {
  const periodMs = window.periodMs;
  if (periodMs === null) return null;
  const withPeriod = { ...window, periodMs };

  const allSteps = buildUsageSteps(window.points, now);
  // a step that began before the range starts at its edge, so pace is read where it is drawn
  const steps = allSteps
    .filter((step) => step.t1 > startMs)
    .map((step) => (step.t0 < startMs ? { ...step, t0: startMs } : step));
  const detailed = periodMs >= DAY_MS || now - startMs <= 2 * DAY_MS + HOUR_MS;
  return {
    id: window.id,
    periodMs,
    kind: usageWindowKind(periodMs),
    steps,
    gaps: buildGaps(steps, startMs, now),
    ends: detailed
      ? usageWindowEnds(window.points, now).filter((end) => end.atMs > startMs && end.atMs <= now)
      : [],
    pace: detailed ? buildPaceLines(steps, periodMs) : [],
    detailed,
    current: usageCurrent(withPeriod, now),
  };
}

/**
 * Account label. Prefer the email the history reports, then the auth file's,
 * only when emails are shown; otherwise the masked file name the rest of the
 * page uses.
 */
function usageAccountName(
  file: AuthFileItem | null,
  credential: QuotaHistoryCredential | null,
  showEmails: boolean
): string {
  const email = credential?.email ?? (typeof file?.email === 'string' ? file.email.trim() : '');
  const label = typeof file?.label === 'string' ? file.label.trim() : '';
  if (showEmails && (email || label)) return email || label;
  if (file) return poolAccountName(file, false);
  return (credential?.authId ?? '').replace(/\.json$/i, '');
}

/**
 * One account per auth file of the provider, in file order, then any account
 * the history knows that the file list does not. Joined on auth_index, the
 * only key both payloads share.
 */
export function collectUsageAccounts(input: {
  provider: string;
  files: readonly AuthFileItem[];
  history: QuotaHistory;
  showEmails: boolean;
  /** Plan known from the auth file, for when the history carries none. */
  filePlanType?: (file: AuthFileItem) => string | null;
  startMs: number;
  now: number;
}): UsageAccount[] {
  const { provider, files, history, showEmails, filePlanType, startMs, now } = input;
  const byIndex = new Map<string, QuotaHistoryCredential>();
  history.credentials.forEach((credential) => {
    if (credential.provider === provider && credential.authIndex) {
      byIndex.set(credential.authIndex, credential);
    }
  });

  const build = (
    key: string,
    file: AuthFileItem | null,
    credential: QuotaHistoryCredential | null
  ): UsageAccount => {
    const windows = (credential?.windows ?? [])
      .map((window) => buildUsageWindow(window, startMs, now))
      .filter((window): window is UsageWindowView => window !== null)
      .sort((a, b) => a.periodMs - b.periodMs);
    const latest = windows
      .map((window) => window.current?.observedAtMs ?? null)
      .filter((atMs): atMs is number => atMs !== null);
    const latestAtMs = latest.length > 0 ? Math.max(...latest) : null;
    return {
      key,
      name: usageAccountName(file, credential, showEmails),
      planType: credential?.planType ?? (file && filePlanType ? filePlanType(file) : null),
      quotaWeight: credential?.quotaWeight ?? null,
      disabled: file?.disabled === true,
      windows,
      latestAtMs,
      stale: latestAtMs !== null && now - latestAtMs > STALE_AFTER_MS,
    };
  };

  const seen = new Set<string>();
  const accounts = files.map((file) => {
    const authIndex = normalizeRecentRequestAuthIndex(file.authIndex);
    const credential = authIndex ? (byIndex.get(authIndex) ?? null) : null;
    if (authIndex) seen.add(authIndex);
    return build(authIndex ?? file.name, file, credential);
  });
  byIndex.forEach((credential, authIndex) => {
    if (!seen.has(authIndex)) accounts.push(build(authIndex, null, credential));
  });
  return accounts;
}

/* ------------------------------------------------------------------- axis */

export interface UsageAxisTick {
  atMs: number;
  /** A local midnight, labeled with the day rather than the hour. */
  day: boolean;
}

/**
 * Ticks for [startMs, endMs]: every 3 or 6 hours up to two days, then
 * midnights, every day up to a week and every fifth beyond it, counted back
 * from the newest so today keeps its label as the range slides.
 */
export function usageAxisTicks(startMs: number, endMs: number): UsageAxisTick[] {
  const span = endMs - startMs;
  const ticks: UsageAxisTick[] = [];
  if (span <= 2 * DAY_MS) {
    const every = span <= DAY_MS ? 3 : 6;
    const cursor = new Date(startMs);
    cursor.setMinutes(0, 0, 0);
    if (cursor.getTime() < startMs) cursor.setHours(cursor.getHours() + 1);
    while (cursor.getTime() <= endMs) {
      const hour = cursor.getHours();
      if (hour % every === 0) ticks.push({ atMs: cursor.getTime(), day: hour === 0 });
      cursor.setHours(cursor.getHours() + 1);
    }
    return ticks;
  }

  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < startMs) cursor.setDate(cursor.getDate() + 1);
  const midnights: number[] = [];
  while (cursor.getTime() <= endMs) {
    midnights.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  const every = span <= 8 * DAY_MS ? 1 : 5;
  return midnights
    .filter((_, index) => (midnights.length - 1 - index) % every === 0)
    .map((atMs) => ({ atMs, day: true }));
}
