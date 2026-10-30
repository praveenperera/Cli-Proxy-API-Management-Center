import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { QuotaPoolCard } from '../src/features/quota/components/QuotaPoolCard';
import { QuotaPoolToolbar } from '../src/features/quota/components/QuotaPoolToolbar';
import { collectPoolAccounts } from '../src/features/quota/quotaPoolAccounts';
import {
  buildRecordedPool,
  POOL_RANGE_MAX_OFFSET,
  poolRange,
} from '../src/features/quota/quotaPoolModel';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import { apiClient } from '../src/services/api/client';
import { EMPTY_QUOTA_HISTORY, quotaHistoryApi } from '../src/services/api/quotaHistory';
import { DAY_MS, HOUR_MS } from '../src/utils/time/durations';

const NOW = new Date(2026, 9, 26, 12, 0).getTime();
// other suites share this i18n instance and expect its default language
const DEFAULT_LANGUAGE = i18n.language;
afterEach(() => i18n.changeLanguage(DEFAULT_LANGUAGE));

const claudeQuota = (used: number) => ({
  status: 'success',
  windows: [
    { id: 'seven-day', usedPercent: used, resetAtMs: NOW + 30 * HOUR_MS, periodHours: 168 },
  ],
});

const entries: QuotaFileEntry[] = [
  {
    file: {
      name: 'claude-a.json',
      type: 'claude',
      authIndex: 4,
      email: 'a@example.com',
      account: 'sk-ant-secret',
    },
    type: 'claude',
  },
  { file: { name: 'claude-b.json', type: 'claude', authIndex: '5' }, type: 'claude' },
  { file: { name: 'claude-c.json', type: 'claude', authIndex: '6' }, type: 'claude' },
];

const history = {
  enabled: true,
  retentionMs: null,
  credentials: [
    {
      authId: 'a',
      authIndex: '4',
      provider: 'claude',
      windows: [
        {
          id: 'five_hour',
          periodMs: 5 * HOUR_MS,
          points: [{ atMs: NOW - 4 * HOUR_MS, remaining: 5, resetAtMs: null }],
        },
        {
          id: 'seven_day',
          periodMs: 168 * HOUR_MS,
          points: [
            { atMs: NOW - 4 * HOUR_MS, remaining: 82, resetAtMs: null },
            { atMs: NOW - 2 * HOUR_MS, remaining: 76, resetAtMs: null },
          ],
        },
      ],
    },
  ],
};

const quotaFor = (entry: QuotaFileEntry) =>
  entry.file.name === 'claude-a.json'
    ? claudeQuota(30)
    : entry.file.name === 'claude-b.json'
      ? claudeQuota(10)
      : undefined;

describe('pool accounts', () => {
  test('joins weekly history by auth index and leaves unloaded credentials out', () => {
    const [pool] = collectPoolAccounts({ entries, quotaFor, history, showEmails: false, now: NOW });
    expect(pool.credentials).toBe(3);
    expect(pool.accounts.map((account) => account.name)).toEqual(['claude-a', 'claude-b']);
    expect(pool.accounts[0].history.map((sample) => sample.value)).toEqual([82, 76]);
    expect(pool.accounts[1].history).toEqual([]);
  });

  test('uses the newest recorded window until live quota loads', () => {
    const [pool] = collectPoolAccounts({
      entries,
      quotaFor: () => undefined,
      history,
      showEmails: false,
      now: NOW,
    });
    expect(pool.credentials).toBe(3);
    expect(pool.accounts.map((account) => [account.name, account.remaining])).toEqual([
      ['claude-a', 76],
    ]);
  });

  describe('the fresher of live quota and history is the current value', () => {
    // live read an hour ago at 80; the backend kept recording and saw 60 five minutes ago
    const recorded = (points: [number, number][]) => ({
      enabled: true,
      retentionMs: null,
      credentials: [
        {
          authId: 'a',
          authIndex: '4',
          provider: 'claude',
          windows: [
            {
              id: 'seven_day',
              periodMs: 168 * HOUR_MS,
              points: points.map(([atMs, remaining]) => ({ atMs, remaining, resetAtMs: null })),
            },
          ],
        },
      ],
    });
    const liveAt = (observedAtMs: number, used: number) => () => ({
      ...claudeQuota(used),
      observedAt: new Date(observedAtMs).toISOString(),
    });
    const collect = (quotaFor: () => unknown, points: [number, number][]) =>
      collectPoolAccounts({
        entries: entries.slice(0, 1),
        quotaFor: quotaFor as never,
        history: recorded(points),
        showEmails: false,
        now: NOW,
      })[0].accounts[0];

    test('newer history wins, so a stale live read draws no fake reset', () => {
      const account = collect(liveAt(NOW - HOUR_MS, 20), [
        [NOW - 3 * HOUR_MS, 85],
        [NOW - 2 * HOUR_MS, 70],
        [NOW - 5 * 60_000, 60],
      ]);
      expect([account.remaining, account.observedAtMs]).toEqual([60, NOW - 5 * 60_000]);
      // the history point carried no reset; the live one is still ahead, so it stays
      expect(account.resetAtMs).toBe(NOW + 30 * HOUR_MS);
      const pool = buildRecordedPool([account], NOW - DAY_MS, NOW, NOW);
      expect(pool.jumps).toEqual([]);
      expect(pool.points.at(-1)).toEqual({ atMs: NOW, value: 60 });
    });

    test('a newer live read wins over older history', () => {
      const account = collect(liveAt(NOW - 60_000, 45), [
        [NOW - 2 * HOUR_MS, 70],
        [NOW - 30 * 60_000, 60],
      ]);
      expect([account.remaining, account.observedAtMs]).toEqual([55, NOW - 60_000]);
      expect(account.history.map((sample) => sample.value)).toEqual([70, 60]);
    });
  });

  test('shows the email when asked, never the account field', () => {
    const [pool] = collectPoolAccounts({ entries, quotaFor, history, showEmails: true, now: NOW });
    expect(pool.accounts.map((account) => account.name)).toEqual(['a@example.com', 'claude-b']);
    expect(JSON.stringify(pool)).not.toContain('sk-ant-secret');
  });
});

describe('quota history API', () => {
  test('a backend without the endpoint reads as disabled history', async () => {
    const get = spyOn(apiClient, 'get').mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404 })
    );
    try {
      await expect(quotaHistoryApi.get(0, 1000_000)).resolves.toEqual(EMPTY_QUOTA_HISTORY);
      expect(get).toHaveBeenCalledWith('/quota/history', { params: { since: 0, until: 1000 } });
    } finally {
      get.mockRestore();
    }
  });

  test('other failures still surface', async () => {
    const get = spyOn(apiClient, 'get').mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    );
    try {
      await expect(quotaHistoryApi.get(0, 1000)).rejects.toThrow('boom');
    } finally {
      get.mockRestore();
    }
  });
});

describe('QuotaPoolCard rendering', () => {
  test('renders the pool headline, stats and chart markers', async () => {
    await i18n.changeLanguage('en');
    const [pool] = collectPoolAccounts({ entries, quotaFor, history, showEmails: false, now: NOW });
    const range = poolRange(0, NOW);
    const markup = renderToStaticMarkup(
      createElement(QuotaPoolCard, {
        provider: 'claude',
        credentials: pool.credentials,
        accounts: pool.accounts,
        historyEnabled: true,
        mode: 'remaining',
        burnWindowHours: 3,
        multiplier: 1,
        rangeStartMs: range.startMs,
        rangeEndMs: range.endMs,
        now: NOW,
        resolvedTheme: 'dark',
      })
    );
    expect(markup).toContain('160%');
    expect(markup).toContain('of 200%');
    expect(markup).toContain('2 accounts');
    expect(markup).toContain('1 not loaded');
    expect(markup).toContain('Pool empty');
    // claude-a fell 82 → 76 → 70 across the 3h lookback; claude-b has no history
    expect(markup).toContain('4.0%/h');
    // claude-a takes all demand until it empties, then claude-b; both refill at the reset
    expect(markup).toContain('claude-a</span> in 17h 30m');
    expect(markup).toContain('Now');
    expect(markup).toContain('Fri 23');
    expect(markup).toContain('+160%');
    expect(markup).toContain('Empty Thu 8:00 PM');
  });

  test('says why there is no recorded line', async () => {
    await i18n.changeLanguage('en');
    const [pool] = collectPoolAccounts({
      entries,
      quotaFor,
      history: EMPTY_QUOTA_HISTORY,
      showEmails: false,
      now: NOW,
    });
    const range = poolRange(0, NOW);
    const markup = renderToStaticMarkup(
      createElement(QuotaPoolCard, {
        provider: 'claude',
        credentials: pool.credentials,
        accounts: pool.accounts,
        historyEnabled: false,
        mode: 'remaining',
        burnWindowHours: 3,
        multiplier: 1,
        rangeStartMs: range.startMs,
        rangeEndMs: range.endMs,
        now: NOW,
        resolvedTheme: 'light',
      })
    );
    expect(markup).toContain('History recording is off');
    expect(markup).not.toContain('%/h');
  });
});

describe('QuotaPoolToolbar', () => {
  test('stops paging forward at the furthest page', async () => {
    await i18n.changeLanguage('en');
    const render = (rangeOffset: number) => {
      const range = poolRange(rangeOffset, NOW);
      const markup = renderToStaticMarkup(
        createElement(QuotaPoolToolbar, {
          chartMode: 'remaining',
          burnWindowHours: 3,
          futureUsage: 'same',
          showAccounts: false,
          rangeStartMs: range.startMs,
          rangeEndMs: range.endMs,
          rangeOffset,
          onChartModeChange: () => {},
          onBurnWindowChange: () => {},
          onFutureUsageChange: () => {},
          onShowAccountsChange: () => {},
          onRangeOffsetChange: () => {},
        })
      );
      const next = markup.match(/<button[^>]*aria-label="Next[^"]*"[^>]*>/)?.[0] ?? '';
      expect(next).not.toBe('');
      return next;
    };
    expect(render(POOL_RANGE_MAX_OFFSET - 1)).not.toContain('disabled');
    expect(render(POOL_RANGE_MAX_OFFSET)).toContain('disabled');
  });
});
