import { describe, expect, test } from 'bun:test';
import {
  accountBurnRate,
  buildDrainSeries,
  buildPoolAccount,
  buildRecordedPool,
  dayTicks,
  livePoolWindow,
  pickHistoryWindow,
  poolHistorySpans,
  poolRange,
  projectPool,
  summarizePool,
  type PoolAccount,
  type PoolSample,
} from '../src/features/quota/quotaPoolModel';
import { mergeQuotaHistories, normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import { DAY_MS, HOUR_MS } from '../src/utils/time/durations';

const NOW = new Date(2026, 9, 26, 12, 0).getTime();
const WEEK_MS = 7 * DAY_MS;

const account = (overrides: Partial<PoolAccount> & { id: string }): PoolAccount => ({
  name: overrides.id,
  remaining: 100,
  observedAtMs: NOW,
  resetAtMs: null,
  periodMs: WEEK_MS,
  history: [],
  ...overrides,
});

/** Samples every 10 minutes falling from `start` at `perHour` %/h, ending just before now. */
const linearHistory = (hours: number, start: number, perHour: number): PoolSample[] =>
  Array.from({ length: hours * 6 }, (_, index) => ({
    atMs: NOW - hours * HOUR_MS + index * 10 * 60_000,
    value: start - (perHour * index) / 6,
  }));

/** The live value ten minutes after the last sample, continuing the same burn. */
const nextValue = (history: PoolSample[], perHour: number) =>
  history[history.length - 1].value - perHour / 6;

describe('live pool window', () => {
  test('uses the account-wide Claude week even when it has never been touched', () => {
    // An untouched Claude week reports no reset instant: available, not unknown.
    const window = livePoolWindow('claude', {
      status: 'success',
      windows: [
        { id: 'five-hour', usedPercent: 40, resetAtMs: NOW + HOUR_MS, periodHours: 5 },
        { id: 'seven-day', usedPercent: 0, resetAtMs: null, periodHours: 168 },
        { id: 'seven-day-opus', usedPercent: 90, resetAtMs: NOW + DAY_MS, periodHours: 168 },
      ],
    } as never);
    expect(window).toEqual({
      remaining: 100,
      resetAtMs: null,
      periodMs: WEEK_MS,
      observedAtMs: null,
    });
  });

  test('prefers the Codex account week over a model-scoped week', () => {
    const window = livePoolWindow('codex', {
      status: 'success',
      observedAtMs: NOW - 60_000,
      windows: [
        { id: 'five-hour', usedPercent: 10, resetAtMs: NOW + HOUR_MS, periodHours: 5 },
        { id: 'code-review-weekly', usedPercent: 80, resetAtMs: NOW + HOUR_MS, periodHours: 168 },
        { id: 'weekly', usedPercent: 25, resetAtMs: NOW + 2 * DAY_MS, periodHours: 168 },
      ],
    } as never);
    expect(window).toEqual({
      remaining: 75,
      resetAtMs: NOW + 2 * DAY_MS,
      periodMs: WEEK_MS,
      observedAtMs: NOW - 60_000,
    });
  });

  test('reuses the timeline selection for other providers and skips unloaded state', () => {
    const xai = livePoolWindow('xai', {
      status: 'success',
      billing: { periodType: 'weekly', usagePercent: 30, resetAtMs: NOW + DAY_MS },
    } as never);
    expect(xai).toEqual({
      remaining: 70,
      resetAtMs: NOW + DAY_MS,
      periodMs: WEEK_MS,
      observedAtMs: null,
    });
    expect(livePoolWindow('claude', { status: 'loading' })).toBeNull();
    expect(livePoolWindow('claude', undefined)).toBeNull();
  });

  test('a reset that passed since the snapshot refills the account and rolls forward', () => {
    const built = buildPoolAccount({
      id: 'a',
      name: 'a',
      live: {
        remaining: 12,
        resetAtMs: NOW - 2 * HOUR_MS,
        periodMs: WEEK_MS,
        observedAtMs: NOW - 3 * HOUR_MS,
      },
      history: [],
      now: NOW,
    });
    expect(built.remaining).toBe(100);
    expect(built.resetAtMs).toBe(NOW - 2 * HOUR_MS + WEEK_MS);
    // 100 is known from the reset on, not from the stale read
    expect(built.observedAtMs).toBe(NOW - 2 * HOUR_MS);
  });
});

describe('history contract', () => {
  test('normalizes seconds to ms and drops entries it cannot join', () => {
    const history = normalizeQuotaHistory({
      enabled: true,
      retention_seconds: 2592000,
      credentials: [
        {
          auth_id: 'x',
          auth_index: 7,
          provider: 'Claude',
          windows: [
            {
              id: 'seven_day',
              period_seconds: 604800,
              points: [
                { t: 1761400100, remaining: 80, reset_at: 0 },
                { t: 1761400000, remaining: 120, reset_at: 1761900000 },
                { t: 'bad', remaining: 1 },
              ],
            },
          ],
        },
        { auth_id: 'no-index', windows: [] },
      ],
    });
    expect(history.retentionMs).toBe(2592000 * 1000);
    expect(history.credentials).toHaveLength(1);
    const [credential] = history.credentials;
    expect(credential.authIndex).toBe('7');
    expect(credential.provider).toBe('claude');
    expect(credential.windows[0].points).toEqual([
      { atMs: 1761400000_000, remaining: 100, resetAtMs: 1761900000_000 },
      { atMs: 1761400100_000, remaining: 80, resetAtMs: null },
    ]);
  });

  test('disabled recording yields no credentials', () => {
    expect(normalizeQuotaHistory({ enabled: false, credentials: [{ auth_index: '1' }] })).toEqual({
      enabled: false,
      retentionMs: null,
      credentials: [],
    });
    expect(normalizeQuotaHistory(null).enabled).toBe(false);
  });

  test('picks the weekly window over the five-hour one', () => {
    const windows = [
      { id: 'five_hour', periodMs: 5 * HOUR_MS },
      { id: 'seven_day', periodMs: WEEK_MS },
    ];
    expect(pickHistoryWindow(windows)?.id).toBe('seven_day');
    // unknown periods fall back to the weekly ids
    expect(
      pickHistoryWindow([
        { id: 'primary', periodMs: null },
        { id: 'secondary', periodMs: null },
      ])?.id
    ).toBe('secondary');
  });
});

describe('history spans', () => {
  const LOOKBACK_START = NOW - 6 * HOUR_MS - 15 * 60_000;

  test('reads the current range and the burn lookback as one span ending now', () => {
    const range = poolRange(0, NOW);
    expect(poolHistorySpans(range.startMs, range.endMs, NOW)).toEqual([
      { fromMs: range.startMs, toMs: NOW },
    ]);
    // a future range only needs the lookback
    const future = poolRange(1, NOW);
    expect(poolHistorySpans(future.startMs, future.endMs, NOW)).toEqual([
      { fromMs: LOOKBACK_START, toMs: NOW },
    ]);
  });

  test('a past range stops at its end and reads the lookback separately', () => {
    const past = poolRange(-3, NOW);
    expect(past.endMs).toBeLessThan(NOW);
    expect(poolHistorySpans(past.startMs, past.endMs, NOW)).toEqual([
      { fromMs: past.startMs, toMs: past.endMs },
      { fromMs: LOOKBACK_START, toMs: NOW },
    ]);
  });

  test('merges histories read over separate spans', () => {
    const read = (points: [number, number][], periodSeconds?: number) =>
      normalizeQuotaHistory({
        enabled: true,
        credentials: [
          {
            auth_id: 'x',
            auth_index: '1',
            windows: [
              {
                id: 'seven_day',
                period_seconds: periodSeconds,
                points: points.map(([t, remaining]) => ({ t, remaining })),
              },
            ],
          },
        ],
      });
    const merged = mergeQuotaHistories([
      read([[300, 40]]),
      read(
        [
          [100, 90],
          [300, 40],
        ],
        604800
      ),
    ]);
    expect(merged.enabled).toBe(true);
    expect(merged.credentials).toHaveLength(1);
    const [window] = merged.credentials[0].windows;
    expect(window.periodMs).toBe(WEEK_MS);
    expect(window.points.map((point) => [point.atMs, point.remaining])).toEqual([
      [100_000, 90],
      [300_000, 40],
    ]);
  });
});

describe('stale snapshot', () => {
  /** Samples every 10 minutes from 4h ago, falling 2%/h, read last an hour ago. */
  const readAnHourAgo = () => {
    const history = Array.from({ length: 18 }, (_, index) => ({
      atMs: NOW - 4 * HOUR_MS + index * 10 * 60_000,
      value: 90 - (2 * index) / 6,
    }));
    return buildPoolAccount({
      id: 'a',
      name: 'a',
      live: { remaining: 84, resetAtMs: null, periodMs: WEEK_MS, observedAtMs: NOW - HOUR_MS },
      history,
      now: NOW,
    });
  };

  test('burn is unknown, not zero, when nothing was read during the lookback', () => {
    const a = readAnHourAgo();
    expect(accountBurnRate(a, NOW, HOUR_MS)).toBeNull();
    // the 3h lookback measures the two hours it actually covers
    expect(accountBurnRate(a, NOW, 3 * HOUR_MS)).toBeCloseTo(2, 5);
  });

  test('the recorded line and the projection start from the last read value', () => {
    const a = readAnHourAgo();
    const recorded = buildRecordedPool([a], NOW - DAY_MS, NOW + DAY_MS, NOW);
    expect(recorded.points.find((point) => point.atMs === NOW - HOUR_MS)?.value).toBe(84);
    expect(recorded.points.at(-1)).toEqual({ atMs: NOW, value: 84 });
    const summary = summarizePool({
      accounts: [a],
      now: NOW,
      untilMs: NOW + DAY_MS,
      burnWindowHours: 3,
      multiplier: 1,
    });
    expect(summary.remaining).toBe(84);
    expect(summary.projection.points[0]).toEqual({ atMs: NOW, value: 84 });
  });
});

describe('burn rate', () => {
  test('measures only the drops and ignores the reset jump', () => {
    // 2%/h for three hours, but a reset to 100 in the middle
    const history = linearHistory(3, 60, 2).map((sample) =>
      sample.atMs >= NOW - 1.5 * HOUR_MS ? { ...sample, value: sample.value + 40 } : sample
    );
    const a = account({ id: 'a', remaining: nextValue(history, 2), history });
    // the 10 minutes containing the reset hide their usage: 17 of 18 intervals count
    expect(accountBurnRate(a, NOW, 3 * HOUR_MS)).toBeCloseTo((2 * 17) / 18, 5);
  });

  test('is unknown without enough recorded history', () => {
    expect(accountBurnRate(account({ id: 'a' }), NOW, 3 * HOUR_MS)).toBeNull();
    const recent = account({
      id: 'b',
      remaining: 50,
      history: [{ atMs: NOW - 10 * 60_000, value: 60 }],
    });
    expect(accountBurnRate(recent, NOW, 3 * HOUR_MS)).toBeNull();
  });

  test('pool burn sums the accounts that have history', () => {
    const aHistory = linearHistory(3, 53, 1);
    const bHistory = linearHistory(3, 99, 3);
    const summary = summarizePool({
      accounts: [
        account({ id: 'a', remaining: nextValue(aHistory, 1), history: aHistory }),
        account({ id: 'b', remaining: nextValue(bHistory, 3), history: bHistory }),
        account({ id: 'c', remaining: 100 }),
      ],
      now: NOW,
      untilMs: NOW + DAY_MS,
      burnWindowHours: 3,
      multiplier: 1,
    });
    expect(summary.burnPerHour).toBeCloseTo(4, 5);
    expect(summary.total).toBe(300);
  });
});

describe('recorded series', () => {
  test('step-holds each account and labels the reset jump', () => {
    const a = account({
      id: 'a',
      remaining: 95,
      history: [
        { atMs: NOW - 4 * HOUR_MS, value: 30 },
        { atMs: NOW - 2 * HOUR_MS, value: 100 },
      ],
    });
    const b = account({
      id: 'b',
      remaining: 40,
      history: [{ atMs: NOW - 3 * HOUR_MS, value: 50 }],
    });
    const recorded = buildRecordedPool([a, b], NOW - DAY_MS, NOW + DAY_MS, NOW);
    expect(recorded.points).toEqual([
      { atMs: NOW - 4 * HOUR_MS, value: 80 },
      { atMs: NOW - 3 * HOUR_MS, value: 80 },
      { atMs: NOW - 2 * HOUR_MS, value: 150 },
      { atMs: NOW, value: 135 },
    ]);
    expect(recorded.jumps).toEqual([{ atMs: NOW - 2 * HOUR_MS, gain: 70 }]);
  });

  test('is empty with no history or for a future range', () => {
    const live = account({ id: 'a', remaining: 50 });
    expect(buildRecordedPool([live], NOW - DAY_MS, NOW + DAY_MS, NOW).points).toEqual([]);
    const withHistory = account({ id: 'b', history: [{ atMs: NOW - HOUR_MS, value: 90 }] });
    expect(buildRecordedPool([withHistory], NOW + HOUR_MS, NOW + DAY_MS, NOW).points).toEqual([]);
  });

  test('drain buckets count drops per hour and skip resets', () => {
    const a = account({
      id: 'a',
      remaining: 97,
      history: [
        { atMs: NOW - 2 * HOUR_MS, value: 20 },
        { atMs: NOW - 1.5 * HOUR_MS, value: 15 },
        { atMs: NOW - 0.5 * HOUR_MS, value: 100 },
      ],
    });
    const drain = buildDrainSeries([a], NOW - 3 * HOUR_MS, NOW, NOW);
    expect(drain.map((sample) => sample.value)).toEqual([5, 3]);
  });
});

describe('projection', () => {
  test('zero burn stays flat and only steps up at resets', () => {
    const a = account({ id: 'a', remaining: 40, resetAtMs: NOW + DAY_MS });
    const projection = projectPool({
      accounts: [a],
      now: NOW,
      untilMs: NOW + 10 * DAY_MS,
      burnPerHour: 0,
      multiplier: 1,
    });
    expect(projection.poolEmptyAtMs).toBeNull();
    expect(projection.firstEmpty).toBeNull();
    // first reset refills 60; the next one, a week later, has nothing to add
    expect(projection.resets).toEqual([{ atMs: NOW + DAY_MS, gain: 60 }]);
    expect(projection.nextReset).toEqual({ atMs: NOW + DAY_MS, gain: 60 });
    expect(projection.points.at(-1)).toEqual({ atMs: NOW + 10 * DAY_MS, value: 100 });
  });

  test('an emptied account hands its share to the others', () => {
    const a = account({ id: 'a', name: 'alpha', remaining: 10 });
    const b = account({ id: 'b', name: 'beta', remaining: 100 });
    const projection = projectPool({
      accounts: [a, b],
      now: NOW,
      untilMs: NOW + 10 * DAY_MS,
      burnPerHour: 10,
      multiplier: 1,
      accountBurn: new Map([
        ['a', 5],
        ['b', 5],
      ]),
    });
    // alpha burns 5%/h → empty after 2h; beta then takes the whole 10%/h
    expect(projection.firstEmpty).toEqual({ id: 'a', name: 'alpha', atMs: NOW + 2 * HOUR_MS });
    // beta: 90 left at 2h, then 9h more at 10%/h
    expect(projection.poolEmptyAtMs).toBeCloseTo(NOW + 11 * HOUR_MS, -3);
  });

  test('the multiplier scales demand, and None never empties', () => {
    const a = account({ id: 'a', remaining: 50 });
    const run = (multiplier: number) =>
      projectPool({
        accounts: [a],
        now: NOW,
        untilMs: NOW + 5 * DAY_MS,
        burnPerHour: 1,
        multiplier,
      }).poolEmptyAtMs;
    expect(run(1)).toBeCloseTo(NOW + 50 * HOUR_MS, -3);
    expect(run(2)).toBeCloseTo(NOW + 25 * HOUR_MS, -3);
    expect(run(0)).toBeNull();
  });

  test('a reset after the pool empties brings it back and recurs every period', () => {
    const a = account({ id: 'a', remaining: 20, resetAtMs: NOW + DAY_MS });
    const projection = projectPool({
      accounts: [a],
      now: NOW,
      untilMs: NOW + 9 * DAY_MS,
      burnPerHour: 2,
      multiplier: 1,
    });
    expect(projection.poolEmptyAtMs).toBeCloseTo(NOW + 10 * HOUR_MS, -3);
    // refills from empty, then empties again 50h later, refills again a week on
    expect(projection.resets).toEqual([
      { atMs: NOW + DAY_MS, gain: 100 },
      { atMs: NOW + 8 * DAY_MS, gain: 100 },
    ]);
    const atReset = projection.points.filter((point) => point.atMs === NOW + DAY_MS);
    expect(atReset.map((point) => point.value)).toEqual([0, 100]);
  });

  test('accounts resetting together are labeled as one step', () => {
    const projection = projectPool({
      accounts: [
        account({ id: 'a', remaining: 70, resetAtMs: NOW + DAY_MS }),
        account({ id: 'b', remaining: 40, resetAtMs: NOW + DAY_MS }),
      ],
      now: NOW,
      untilMs: NOW + 2 * DAY_MS,
      burnPerHour: null,
      multiplier: 1,
    });
    expect(projection.nextReset).toEqual({ atMs: NOW + DAY_MS, gain: 90 });
  });

  test('an account already at zero is the first empty, right now', () => {
    const projection = projectPool({
      accounts: [account({ id: 'a', remaining: 0 }), account({ id: 'b', remaining: 60 })],
      now: NOW,
      untilMs: NOW + DAY_MS,
      burnPerHour: null,
      multiplier: 1,
    });
    expect(projection.firstEmpty?.atMs).toBe(NOW);
    expect(projection.poolEmptyAtMs).toBeNull();
  });
});

describe('range', () => {
  test('starts three days before today and pages by a week', () => {
    const today = new Date(2026, 9, 26).getTime();
    expect(poolRange(0, NOW).startMs).toBe(new Date(2026, 9, 23).getTime());
    expect(poolRange(0, NOW).endMs).toBe(new Date(2026, 10, 6).getTime());
    expect(poolRange(1, NOW).startMs).toBe(new Date(2026, 9, 30).getTime());
    expect(poolRange(-1, NOW).startMs).toBe(new Date(2026, 9, 16).getTime());
    expect(dayTicks(poolRange(0, NOW).startMs, poolRange(0, NOW).endMs)).toHaveLength(14);
    expect(dayTicks(today, today + 2 * DAY_MS)[1]).toBe(new Date(2026, 9, 27).getTime());
  });
});

/* Naive reference: rescans every series from the start at every instant. */
const naiveSeries = (account: PoolAccount): PoolSample[] => [
  ...account.history.filter((sample) => sample.atMs < account.observedAtMs),
  { atMs: account.observedAtMs, value: account.remaining },
];
const naiveValueAt = (series: PoolSample[], atMs: number) => {
  let value = series[0]?.value ?? 0;
  for (const sample of series) {
    if (sample.atMs > atMs) break;
    value = sample.value;
  }
  return value;
};
const naiveDrops = (series: PoolSample[], fromMs: number, toMs: number) => {
  let previous = naiveValueAt(series, fromMs);
  let total = 0;
  for (const sample of series) {
    if (sample.atMs <= fromMs) continue;
    if (sample.atMs > toMs) break;
    if (sample.value < previous) total += previous - sample.value;
    previous = sample.value;
  }
  return total;
};
const naiveRecordedPoints = (accounts: PoolAccount[], fromMs: number, toMs: number) => {
  const series = accounts.map(naiveSeries);
  const earliest = Math.min(...accounts.map((account) => account.history[0].atMs));
  const startMs = Math.max(fromMs, earliest);
  const endMs = Math.min(toMs, NOW);
  const times = new Set([startMs, endMs]);
  series.flat().forEach((sample) => {
    if (sample.atMs > startMs && sample.atMs < endMs) times.add(sample.atMs);
  });
  return [...times]
    .sort((a, b) => a - b)
    .map((atMs) => ({
      atMs,
      value: series.reduce((sum, samples) => sum + naiveValueAt(samples, atMs), 0),
    }));
};
const naiveDrain = (accounts: PoolAccount[], fromMs: number, toMs: number) => {
  const series = accounts.map(naiveSeries);
  const earliest = Math.min(...accounts.map((account) => account.history[0].atMs));
  const endMs = Math.min(toMs, NOW);
  const out: PoolSample[] = [];
  for (let start = fromMs; start < endMs; start += HOUR_MS) {
    const end = Math.min(start + HOUR_MS, endMs);
    if (end <= earliest || end - start < HOUR_MS / 4) continue;
    const total = series.reduce((sum, samples) => sum + naiveDrops(samples, start, end), 0);
    out.push({ atMs: (start + end) / 2, value: total / ((end - start) / HOUR_MS) });
  }
  return out;
};

/** Deterministic accounts: irregular sample times, fractional drops, occasional resets. */
const randomAccounts = (count: number, samples: number, spanMs: number) => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, (_, index) => {
    let value = 100;
    let atMs = NOW - spanMs + Math.floor(random() * 30 * 60_000);
    const history: PoolSample[] = [];
    for (let sample = 0; sample < samples && atMs < NOW; sample += 1) {
      history.push({ atMs, value });
      value = random() < 0.01 ? 100 : Math.max(0, value - random() * 0.7);
      atMs += Math.max(1, Math.floor((random() * 2 * spanMs) / samples));
    }
    const observedAtMs = Math.min(NOW, atMs);
    return account({ id: `acct-${index}`, remaining: value, observedAtMs, history });
  });
};

describe('recorded series sweep', () => {
  test('matches the naive per-instant rescan exactly', () => {
    const accounts = randomAccounts(5, 120, 2 * DAY_MS);
    const fromMs = NOW - 3 * DAY_MS;
    expect(buildRecordedPool(accounts, fromMs, NOW + DAY_MS, NOW).points).toEqual(
      naiveRecordedPoints(accounts, fromMs, NOW + DAY_MS)
    );
    expect(buildDrainSeries(accounts, fromMs, NOW + DAY_MS, NOW)).toEqual(
      naiveDrain(accounts, fromMs, NOW + DAY_MS)
    );
    // a range starting mid-history reads the value held at its start
    const midMs = NOW - DAY_MS + 17 * 60_000;
    expect(buildRecordedPool(accounts, midMs, NOW, NOW).points).toEqual(
      naiveRecordedPoints(accounts, midMs, NOW)
    );
    expect(buildDrainSeries(accounts, midMs, NOW, NOW)).toEqual(naiveDrain(accounts, midMs, NOW));
  });

  test('twenty accounts of two thousand samples stay fast', () => {
    const accounts = randomAccounts(20, 2000, 14 * DAY_MS);
    const started = performance.now();
    const recorded = buildRecordedPool(accounts, NOW - 14 * DAY_MS, NOW, NOW);
    const drain = buildDrainSeries(accounts, NOW - 14 * DAY_MS, NOW, NOW);
    const elapsedMs = performance.now() - started;
    expect(recorded.points.length).toBeGreaterThan(30_000);
    expect(drain.length).toBeGreaterThan(300);
    // the per-instant rescan took ~600ms on a laptop and the sweep ~12ms; the
    // bound leaves the sweep wide headroom on a slow runner but still catches a rescan
    expect(elapsedMs).toBeLessThan(250);
  });
});
