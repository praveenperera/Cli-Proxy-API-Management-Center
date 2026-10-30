/**
 * Pooled quota model: one capacity curve per provider.
 *
 * Every account contributes the remaining percent of its longest (normally
 * weekly) window, so a provider with six accounts has a 600% pool. The model
 * stitches recorded history into a pool series, measures the recent burn, and
 * projects the pool forward with each account emptying and resetting on its
 * own schedule.
 *
 * Pure functions: no React, no store, no clock of its own (`now` is always
 * passed in), so every case is directly testable.
 */

import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { buildTimelineLane, startOfDay } from './quotaTimelineModel';
import type { QuotaProviderType } from './providers/types';

/** Visible range length and how far before today it starts by default. */
export const POOL_RANGE_DAYS = 14;
export const POOL_RANGE_LEAD_DAYS = 3;
/** One pager step. */
export const POOL_RANGE_STEP_DAYS = 7;
/**
 * Furthest forward page. Projecting further out mostly repeats resets, and
 * many short-period accounts would otherwise hit the projection's event cap
 * before the visible range ends.
 */
export const POOL_RANGE_MAX_OFFSET = 8;
/** Stats look this far ahead even when the visible range ends sooner. */
export const POOL_STATS_HORIZON_MS = 14 * DAY_MS;

export const BURN_WINDOWS_HOURS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS_HOURS)[number];

export const FUTURE_USAGE_MODES = ['same', 'half', 'double', 'none'] as const;
export type FutureUsageMode = (typeof FUTURE_USAGE_MODES)[number];

export const FUTURE_USAGE_MULTIPLIER: Record<FutureUsageMode, number> = {
  same: 1,
  half: 0.5,
  double: 2,
  none: 0,
};

export const POOL_CHART_MODES = ['remaining', 'drain'] as const;
export type PoolChartMode = (typeof POOL_CHART_MODES)[number];

/** A recorded upward step smaller than this is sampling noise, not a reset. */
const JUMP_LABEL_MIN = 5;
/** Remaining below this counts as empty; avoids float dust keeping an account alive. */
const EMPTY_EPSILON = 1e-6;
/** Resets this close together are labeled as one step. */
const RESET_MERGE_MS = 60_000;
/** Hard stop for the event loop against a pathological period. */
const MAX_PROJECTION_EVENTS = 20_000;

export interface PoolSample {
  atMs: number;
  /** Remaining percent, 0..100 (or the pool sum). */
  value: number;
}

/** One account as the pool sees it. */
export interface PoolAccount {
  id: string;
  name: string;
  /** Remaining percent of the pool window, 0..100, as last observed. */
  remaining: number;
  /** When `remaining` was observed, at or before `now`; the series ends here. */
  observedAtMs: number;
  /** Next reset after `now`, or null when unknown. */
  resetAtMs: number | null;
  /** Window length, or null when unknown (the window then resets only once). */
  periodMs: number | null;
  /** Recorded samples before `observedAtMs`, sorted ascending. */
  history: PoolSample[];
}

/** A pool window read from the latest quota snapshot or the newest recorded sample. */
export interface LivePoolWindow {
  remaining: number;
  resetAtMs: number | null;
  periodMs: number | null;
  /** When the window was read; null when the source carries no timestamp. */
  observedAtMs: number | null;
}

/* ------------------------------------------------------------------ range */

/**
 * Visible 14-day range. Offset 0 starts three days before today so recent
 * history and the coming week share the view; each step moves a week. Uses
 * date arithmetic so a DST change inside the range doesn't shift every day.
 */
export function poolRange(offset: number, now: number): { startMs: number; endMs: number } {
  const start = new Date(startOfDay(now));
  start.setDate(start.getDate() - POOL_RANGE_LEAD_DAYS + offset * POOL_RANGE_STEP_DAYS);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + POOL_RANGE_DAYS);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Local midnights inside [startMs, endMs). */
export function dayTicks(startMs: number, endMs: number): number[] {
  const ticks: number[] = [];
  const cursor = new Date(startOfDay(startMs));
  if (cursor.getTime() < startMs) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() < endMs && ticks.length <= 62) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

/**
 * The backend stores an unchanged value at least this often, so reading one
 * interval before the burn lookback also gets the value held at its start.
 */
const HISTORY_HEARTBEAT_MS = 15 * 60_000;

/**
 * Recorded spans the pool needs at `now`: the visible range up to now, and
 * the longest burn lookback before now (the stats always describe now). They
 * are read as one span when they touch, so only a range far in the past costs
 * a second read instead of everything between it and now.
 */
export function poolHistorySpans(
  rangeStartMs: number,
  rangeEndMs: number,
  now: number
): { fromMs: number; toMs: number }[] {
  const lookbackFromMs = now - Math.max(...BURN_WINDOWS_HOURS) * HOUR_MS - HISTORY_HEARTBEAT_MS;
  const rangeToMs = Math.min(rangeEndMs, now);
  if (rangeStartMs >= rangeToMs || rangeToMs >= lookbackFromMs) {
    return [{ fromMs: Math.min(rangeStartMs, lookbackFromMs), toMs: now }];
  }
  return [
    { fromMs: rangeStartMs, toMs: rangeToMs },
    { fromMs: lookbackFromMs, toMs: now },
  ];
}

/* ----------------------------------------------------------- live window */

interface UsedWindowLike {
  id?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Account-wide weekly window ids; model-scoped windows share the period but not the pool. */
const PREFERRED_WINDOW_ID: Partial<Record<QuotaProviderType, string>> = {
  claude: 'seven-day',
  codex: 'weekly',
};

/**
 * The window an account contributes to its pool: the longest-period one.
 *
 * Claude and Codex are read directly because the timeline lane drops windows
 * without a reset instant, and an untouched Claude week reports none — that
 * account is 100% available, not unknown. Every other provider reuses the
 * timeline's weekly selection.
 */
export function livePoolWindow(
  provider: QuotaProviderType,
  quota: { status?: string; observedAt?: unknown; observedAtMs?: unknown } | undefined
): LivePoolWindow | null {
  if (!quota || quota.status !== 'success') return null;

  if (provider === 'claude' || provider === 'codex') {
    // Claude stamps an ISO string, Codex epoch ms
    const observedAtMs =
      typeof quota.observedAtMs === 'number'
        ? quota.observedAtMs
        : typeof quota.observedAt === 'string'
          ? Date.parse(quota.observedAt)
          : NaN;
    const windows = ((quota as { windows?: UsedWindowLike[] }).windows ?? []).filter(
      (window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
    );
    const periodOf = (window: UsedWindowLike) =>
      typeof window.periodHours === 'number' && window.periodHours > 0 ? window.periodHours : 0;
    const chosen =
      windows.find((window) => window.id === PREFERRED_WINDOW_ID[provider]) ??
      windows.reduce<UsedWindowLike | null>(
        (best, window) => (best === null || periodOf(window) > periodOf(best) ? window : best),
        null
      );
    if (!chosen) return null;
    const resetAtMs =
      typeof chosen.resetAtMs === 'number' && Number.isFinite(chosen.resetAtMs)
        ? chosen.resetAtMs
        : null;
    const periodHours = periodOf(chosen);
    return {
      remaining: clampPercent(100 - (chosen.usedPercent as number)),
      resetAtMs,
      periodMs: periodHours > 0 ? periodHours * HOUR_MS : null,
      observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
    };
  }

  const lane = buildTimelineLane({
    name: '',
    displayName: '',
    provider,
    quota,
    maxPeriodHours: POOL_RANGE_DAYS * 24,
  });
  if (lane.remaining === null) return null;
  return {
    remaining: lane.remaining,
    resetAtMs: lane.anchorMs,
    periodMs: lane.periodHours ? lane.periodHours * HOUR_MS : null,
    // nothing records these providers, so there is no newer source to lose to
    observedAtMs: null,
  };
}

/**
 * Pick the recorded window matching the pool window: the longest known
 * period, falling back to the account-wide weekly ids when periods are unknown.
 */
export function pickHistoryWindow<T extends { id: string; periodMs: number | null }>(
  windows: readonly T[]
): T | null {
  const weeklyIds = new Set(['seven_day', 'secondary']);
  return windows.reduce<T | null>((best, window) => {
    if (best === null) return window;
    const byPeriod = (window.periodMs ?? 0) - (best.periodMs ?? 0);
    if (byPeriod !== 0) return byPeriod > 0 ? window : best;
    return weeklyIds.has(window.id) && !weeklyIds.has(best.id) ? window : best;
  }, null);
}

/**
 * The fresher of the live window and the newest recorded one.
 *
 * The backend keeps polling after the page fetched live quota, so a newer
 * recorded sample wins; without it a stale live value would sit above newer
 * history and draw a fake reset. A live window without a timestamp counts as
 * fresh.
 */
export function newerPoolWindow(
  live: LivePoolWindow | null,
  recorded: LivePoolWindow | null
): LivePoolWindow | null {
  if (!live || !recorded || recorded.observedAtMs === null) return live ?? recorded;
  if (live.observedAtMs === null || live.observedAtMs >= recorded.observedAtMs) return live;
  // an untouched Claude week records no reset; keep the live one if it is still ahead
  const liveReset =
    live.resetAtMs !== null && live.resetAtMs > recorded.observedAtMs ? live.resetAtMs : null;
  return {
    ...recorded,
    resetAtMs: recorded.resetAtMs ?? liveReset,
    periodMs: recorded.periodMs ?? live.periodMs,
  };
}

/**
 * Assemble an account from its current window and recorded samples.
 *
 * Windows report their next reset, so a reset at or before `now` passed after
 * the window was read: it has refilled. The account then counts as 100 from
 * that reset on, and the reset rolls forward by whole periods so the
 * projection starts from the next real one.
 */
export function buildPoolAccount(input: {
  id: string;
  name: string;
  live: LivePoolWindow;
  history: readonly PoolSample[];
  now: number;
}): PoolAccount {
  const { id, name, live, now } = input;
  let remaining = live.remaining;
  let resetAtMs = live.resetAtMs;
  let observedAtMs = Math.min(live.observedAtMs ?? now, now);
  if (resetAtMs !== null && resetAtMs <= now) {
    remaining = 100;
    let lastResetMs = resetAtMs;
    if (live.periodMs) {
      lastResetMs += Math.floor((now - resetAtMs) / live.periodMs) * live.periodMs;
      resetAtMs = lastResetMs + live.periodMs;
    } else {
      resetAtMs = null;
    }
    observedAtMs = Math.max(observedAtMs, lastResetMs);
  }
  const history = input.history
    .filter((sample) => sample.atMs < observedAtMs && Number.isFinite(sample.value))
    .map((sample) => ({ atMs: sample.atMs, value: clampPercent(sample.value) }))
    .sort((a, b) => a.atMs - b.atMs);
  return {
    id,
    name,
    remaining: clampPercent(remaining),
    observedAtMs,
    resetAtMs,
    periodMs: live.periodMs,
    history,
  };
}

/* --------------------------------------------------------------- recorded */

/**
 * History plus the current value at its observation time, which is always the
 * newest sample. Nothing is known after it: the series is not extended to now.
 */
function accountSeries(account: PoolAccount): PoolSample[] {
  return [
    ...account.history.filter((sample) => sample.atMs < account.observedAtMs),
    { atMs: account.observedAtMs, value: account.remaining },
  ];
}

/**
 * Step-held reader for instants queried in non-decreasing order; before the
 * first sample it reads that sample's value. One forward cursor per series
 * keeps a sweep over many instants linear instead of rescanning from the start.
 */
function stepReader(series: readonly PoolSample[]): (atMs: number) => number {
  let index = 0;
  let value = series[0]?.value ?? 0;
  return (atMs) => {
    while (index < series.length && series[index].atMs <= atMs) {
      value = series[index].value;
      index += 1;
    }
    return value;
  };
}

interface Span {
  fromMs: number;
  toMs: number;
}

/**
 * Sum of downward steps in each (fromMs, toMs], for spans sorted ascending and
 * not overlapping. Upward steps are resets and ignored.
 */
function dropsPerSpan(series: readonly PoolSample[], spans: readonly Span[]): number[] {
  let index = 0;
  let held = series[0]?.value ?? 0;
  return spans.map(({ fromMs, toMs }) => {
    while (index < series.length && series[index].atMs <= fromMs) {
      held = series[index].value;
      index += 1;
    }
    let previous = held;
    let total = 0;
    for (let cursor = index; cursor < series.length && series[cursor].atMs <= toMs; cursor += 1) {
      const { value } = series[cursor];
      if (value < previous) total += previous - value;
      previous = value;
    }
    return total;
  });
}

/**
 * An account's recent burn in %/h, or null without enough data.
 *
 * Data covers the first sample through the observation; the stretch after it
 * is unknown, not idle, so it never counts as zero burn. At least half the
 * lookback must be covered: one sample from ten minutes ago against the
 * current value would otherwise extrapolate a single request into an hourly
 * rate, and a snapshot an hour old would read as an hour without usage.
 */
export function accountBurnRate(account: PoolAccount, now: number, lookbackMs: number) {
  const first = account.history[0];
  if (!first || !(lookbackMs > 0)) return null;
  const fromMs = Math.max(now - lookbackMs, first.atMs);
  const toMs = Math.min(now, account.observedAtMs);
  const coveredMs = toMs - fromMs;
  if (coveredMs < lookbackMs / 2) return null;
  const [dropped] = dropsPerSpan(accountSeries(account), [{ fromMs, toMs }]);
  return dropped / (coveredMs / HOUR_MS);
}

/** Pool burn in %/h: the sum of each known account's burn, or null if none is known. */
export function poolBurnRate(
  accounts: readonly PoolAccount[],
  now: number,
  lookbackMs: number
): number | null {
  let total: number | null = null;
  for (const account of accounts) {
    const rate = accountBurnRate(account, now, lookbackMs);
    if (rate !== null) total = (total ?? 0) + rate;
  }
  return total;
}

export interface RecordedPool {
  points: PoolSample[];
  /** Upward steps worth labeling, with the pool gain in percent. */
  jumps: { atMs: number; gain: number }[];
}

/**
 * Recorded pool series within [fromMs, min(toMs, now)].
 *
 * Empty unless at least one account has history — the live snapshot alone is
 * the "Now" dot, not a line.
 */
export function buildRecordedPool(
  accounts: readonly PoolAccount[],
  fromMs: number,
  toMs: number,
  now: number
): RecordedPool {
  const endMs = Math.min(toMs, now);
  const withHistory = accounts.filter((account) => account.history.length > 0);
  if (withHistory.length === 0 || endMs <= fromMs) return { points: [], jumps: [] };

  const series = accounts.map(accountSeries);
  const earliest = Math.min(...withHistory.map((account) => account.history[0].atMs));
  const startMs = Math.max(fromMs, earliest);
  if (startMs > endMs) return { points: [], jumps: [] };

  const times = new Set<number>([startMs, endMs]);
  series.forEach((samples) =>
    samples.forEach((sample) => {
      if (sample.atMs > startMs && sample.atMs < endMs) times.add(sample.atMs);
    })
  );

  const readers = series.map(stepReader);
  const points = [...times]
    .sort((a, b) => a - b)
    .map((atMs) => ({ atMs, value: readers.reduce((sum, read) => sum + read(atMs), 0) }));

  const jumps: RecordedPool['jumps'] = [];
  for (let index = 1; index < points.length; index += 1) {
    const gain = points[index].value - points[index - 1].value;
    if (gain >= JUMP_LABEL_MIN) jumps.push({ atMs: points[index].atMs, gain });
  }
  return { points, jumps };
}

/**
 * Recorded drain in %/h per hour bucket across [fromMs, min(toMs, now)].
 * Resets are excluded; buckets before any account has history are omitted.
 */
export function buildDrainSeries(
  accounts: readonly PoolAccount[],
  fromMs: number,
  toMs: number,
  now: number,
  bucketMs = HOUR_MS
): PoolSample[] {
  const withHistory = accounts.filter((account) => account.history.length > 0);
  if (withHistory.length === 0) return [];

  const earliest = Math.min(...withHistory.map((account) => account.history[0].atMs));
  const endMs = Math.min(toMs, now);
  const buckets: Span[] = [];
  for (let start = fromMs; start < endMs; start += bucketMs) {
    const end = Math.min(start + bucketMs, endMs);
    if (end <= earliest) continue;
    // a sliver of a bucket at "now" turns one request into a spike or a cliff
    if (end - start < bucketMs / 4) continue;
    buckets.push({ fromMs: start, toMs: end });
  }

  const perAccount = accounts.map((account) => dropsPerSpan(accountSeries(account), buckets));
  return buckets.map(({ fromMs: start, toMs: end }, index) => {
    const total = perAccount.reduce((sum, drops) => sum + drops[index], 0);
    return { atMs: (start + end) / 2, value: total / ((end - start) / HOUR_MS) };
  });
}

/* ------------------------------------------------------------- projection */

export interface PoolResetEvent {
  atMs: number;
  /** Pool percent restored, summed over accounts resetting together. */
  gain: number;
}

export interface PoolProjection {
  points: PoolSample[];
  resets: PoolResetEvent[];
  /** First instant the whole pool reaches 0, or null within the horizon. */
  poolEmptyAtMs: number | null;
  /** First account to reach 0; `atMs === now` when one already is. */
  firstEmpty: { id: string; name: string; atMs: number } | null;
  nextReset: PoolResetEvent | null;
}

export interface ProjectPoolInput {
  accounts: readonly PoolAccount[];
  now: number;
  untilMs: number;
  /** Total pool demand in %/h; null when unknown (no recorded burn). */
  burnPerHour: number | null;
  multiplier: number;
  /** Per-account recent burn, keyed by account id; drives the demand split. */
  accountBurn?: ReadonlyMap<string, number>;
}

/**
 * Simulate the pool from `now` to `untilMs`.
 *
 * Demand is constant between events, so the simulation is event-driven and
 * exact: it jumps straight to the next reset or the next account emptying
 * rather than stepping a fixed interval. Demand splits across non-empty
 * accounts in proportion to each one's recent burn (equally when none is
 * known); an account that empties hands its share to the rest. At each reset
 * the account refills to 100 and, with a known period, keeps recurring.
 */
export function projectPool(input: ProjectPoolInput): PoolProjection {
  const { accounts, now, untilMs } = input;
  const demand = Math.max(0, (input.burnPerHour ?? 0) * input.multiplier);
  const state = accounts.map((account) => ({
    account,
    remaining: account.remaining,
    nextResetMs: account.resetAtMs !== null && account.resetAtMs > now ? account.resetAtMs : null,
    weight: Math.max(0, input.accountBurn?.get(account.id) ?? 0),
  }));
  const pool = () => state.reduce((sum, entry) => sum + entry.remaining, 0);

  const points: PoolSample[] = [{ atMs: now, value: pool() }];
  const resets: PoolResetEvent[] = [];
  let poolEmptyAtMs: number | null = pool() <= EMPTY_EPSILON && state.length > 0 ? now : null;
  const alreadyEmpty = state.find((entry) => entry.remaining <= EMPTY_EPSILON);
  let firstEmpty: PoolProjection['firstEmpty'] = alreadyEmpty
    ? { id: alreadyEmpty.account.id, name: alreadyEmpty.account.name, atMs: now }
    : null;

  const ratesFor = () => {
    const active = state.filter((entry) => entry.remaining > EMPTY_EPSILON);
    const weightSum = active.reduce((sum, entry) => sum + entry.weight, 0);
    return state.map((entry) => {
      if (entry.remaining <= EMPTY_EPSILON || demand === 0) return 0;
      const share = weightSum > 0 ? entry.weight / weightSum : 1 / active.length;
      return (demand * share) / HOUR_MS;
    });
  };

  let t = now;
  for (let guard = 0; t < untilMs && guard < MAX_PROJECTION_EVENTS; guard += 1) {
    const rates = ratesFor();
    let next = untilMs;
    state.forEach((entry, index) => {
      if (entry.nextResetMs !== null && entry.nextResetMs < next) next = entry.nextResetMs;
      if (rates[index] > 0) next = Math.min(next, t + entry.remaining / rates[index]);
    });
    next = Math.max(next, t);

    const dt = next - t;
    state.forEach((entry, index) => {
      if (rates[index] === 0) return;
      entry.remaining = Math.max(0, entry.remaining - rates[index] * dt);
      if (entry.remaining <= EMPTY_EPSILON) {
        entry.remaining = 0;
        if (firstEmpty === null) {
          firstEmpty = { id: entry.account.id, name: entry.account.name, atMs: next };
        }
      }
    });
    t = next;
    points.push({ atMs: t, value: pool() });
    if (poolEmptyAtMs === null && state.length > 0 && pool() <= EMPTY_EPSILON) poolEmptyAtMs = t;

    let gain = 0;
    state.forEach((entry) => {
      if (entry.nextResetMs === null || entry.nextResetMs > t) return;
      gain += 100 - entry.remaining;
      entry.remaining = 100;
      entry.nextResetMs = entry.account.periodMs
        ? entry.nextResetMs + entry.account.periodMs
        : null;
    });
    if (gain > 0) {
      points.push({ atMs: t, value: pool() });
      const last = resets[resets.length - 1];
      if (last && t - last.atMs <= RESET_MERGE_MS) last.gain += gain;
      else resets.push({ atMs: t, gain });
    }
  }

  return {
    points: simplifyCollinear(points),
    resets,
    poolEmptyAtMs,
    firstEmpty,
    nextReset: resets[0] ?? null,
  };
}

/** Drop interior points lying on the straight line between their neighbors. */
export function simplifyCollinear(points: readonly PoolSample[]): PoolSample[] {
  if (points.length <= 2) return [...points];
  const out: PoolSample[] = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = out[out.length - 1];
    const b = points[index];
    const c = points[index + 1];
    if (b.atMs === a.atMs && b.value === a.value) continue;
    const spanMs = c.atMs - a.atMs;
    const expected =
      spanMs === 0 ? a.value : a.value + ((c.value - a.value) * (b.atMs - a.atMs)) / spanMs;
    // a vertical segment (reset) has b and c at the same instant: keep it
    if (b.atMs === c.atMs || b.atMs === a.atMs || Math.abs(expected - b.value) > 1e-6) {
      out.push(b);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/* ---------------------------------------------------------------- summary */

export interface PoolSummary {
  accounts: number;
  /** End of the simulated span; "not empty by" refers to this instant. */
  horizonMs: number;
  remaining: number;
  total: number;
  burnPerHour: number | null;
  projection: PoolProjection;
}

/** Everything a pooled card shows, for one provider. */
export function summarizePool(input: {
  accounts: readonly PoolAccount[];
  now: number;
  untilMs: number;
  burnWindowHours: number;
  multiplier: number;
}): PoolSummary {
  const { accounts, now, burnWindowHours, multiplier } = input;
  const lookbackMs = burnWindowHours * HOUR_MS;
  const accountBurn = new Map<string, number>();
  accounts.forEach((account) => {
    const rate = accountBurnRate(account, now, lookbackMs);
    if (rate !== null) accountBurn.set(account.id, rate);
  });
  const burnPerHour = poolBurnRate(accounts, now, lookbackMs);
  const horizonMs = Math.max(input.untilMs, now + POOL_STATS_HORIZON_MS);
  return {
    accounts: accounts.length,
    horizonMs,
    remaining: accounts.reduce((sum, account) => sum + account.remaining, 0),
    total: accounts.length * 100,
    burnPerHour,
    projection: projectPool({
      accounts,
      now,
      untilMs: horizonMs,
      burnPerHour,
      multiplier,
      accountBurn,
    }),
  };
}

/* ------------------------------------------------------------------ chart */

/**
 * Clip a piecewise-linear series to [fromMs, toMs], interpolating the edges so
 * a line crossing the range boundary starts and ends exactly on it.
 */
export function clipSeries(points: readonly PoolSample[], fromMs: number, toMs: number) {
  const out: PoolSample[] = [];
  const lerp = (a: PoolSample, b: PoolSample, atMs: number) => ({
    atMs,
    value: a.value + ((b.value - a.value) * (atMs - a.atMs)) / (b.atMs - a.atMs),
  });
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    if (previous && previous.atMs < fromMs && point.atMs > fromMs) {
      out.push(lerp(previous, point, fromMs));
    }
    if (previous && previous.atMs < toMs && point.atMs > toMs) {
      out.push(lerp(previous, point, toMs));
      break;
    }
    if (point.atMs >= fromMs && point.atMs <= toMs) out.push(point);
    if (point.atMs > toMs) break;
  }
  return out;
}

/** Value of a piecewise-linear series at `atMs`, or null outside it. */
export function seriesValueAt(points: readonly PoolSample[], atMs: number): number | null {
  if (points.length === 0 || atMs < points[0].atMs || atMs > points[points.length - 1].atMs) {
    return null;
  }
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point.atMs > atMs) continue;
    const next = points[index + 1];
    if (!next || next.atMs === point.atMs) return point.value;
    return (
      point.value + ((next.value - point.value) * (atMs - point.atMs)) / (next.atMs - point.atMs)
    );
  }
  return null;
}
