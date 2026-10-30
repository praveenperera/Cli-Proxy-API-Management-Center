import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { AccountUsageSection } from '../src/features/quota/components/AccountUsageSection';
import {
  buildUsageWindow,
  collectUsageAccounts,
  historySpansWithRecent,
} from '../src/features/quota/accountUsageModel';
import { poolHistorySpans, poolRange } from '../src/features/quota/quotaPoolModel';
import {
  normalizeQuotaHistory,
  EMPTY_QUOTA_HISTORY,
  type QuotaHistory,
  type QuotaHistoryPoint,
  type QuotaHistoryWindow,
} from '../src/services/api/quotaHistory';
import type { AuthFileItem } from '../src/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/utils/time/durations';

const NOW = new Date(2026, 9, 26, 12, 0).getTime();
const FIVE_HOURS = 5 * HOUR_MS;
const WEEK = 7 * DAY_MS;

const point = (
  minutesAgo: number,
  remaining: number,
  resetAtMs: number | null
): QuotaHistoryPoint => ({
  atMs: NOW - minutesAgo * MINUTE_MS,
  remaining,
  resetAtMs,
});

const window = (
  id: string,
  periodMs: number | null,
  points: QuotaHistoryPoint[]
): QuotaHistoryWindow => ({
  id,
  periodMs,
  points,
});

describe('account usage window', () => {
  test('steps hold until the next reading, split at a reset, and break across gaps', () => {
    const firstReset = NOW - 240 * MINUTE_MS;
    const secondReset = NOW + HOUR_MS;
    const view = buildUsageWindow(
      window('five_hour', FIVE_HOURS, [
        point(300, 90, firstReset),
        point(270, 40, firstReset),
        // the window resets between these two readings
        point(250, 30, firstReset),
        point(220, 95, secondReset),
        // nothing for 120 minutes
        point(100, 95, secondReset),
        // a 30-minute heartbeat while idle is not a gap
        point(70, 80, secondReset),
        point(40, 78, secondReset),
        point(10, 75, secondReset),
      ]),
      NOW - DAY_MS,
      NOW
    );
    expect(view).not.toBeNull();
    if (!view) return;

    const ago = (minutes: number) => NOW - minutes * MINUTE_MS;
    expect(view.kind).toBe('five_hour');
    expect(view.steps.map((step) => [step.t0, step.t1, step.used, step.afterReset])).toEqual([
      [ago(300), ago(270), 10, false],
      [ago(270), ago(250), 60, false],
      [ago(250), firstReset, 70, false],
      [firstReset, ago(220), 0, true],
      // across the gap the value holds for one poll only
      [ago(220), ago(219), 5, false],
      [ago(100), ago(70), 5, false],
      [ago(70), ago(40), 20, false],
      [ago(40), ago(10), 22, false],
      // the newest reading is current, so it holds until now
      [ago(10), NOW, 25, false],
    ]);

    expect(view.gaps).toEqual([
      { fromMs: NOW - DAY_MS, toMs: ago(300) },
      { fromMs: ago(219), toMs: ago(100) },
    ]);
    expect(view.ends).toEqual([{ atMs: firstReset, peakUsed: 70 }]);

    // pace restarts after the reset and the gap, and reaches the current pace at now
    expect(view.pace.map((line) => [line[0].atMs, line[line.length - 1].atMs])).toEqual([
      [ago(300), firstReset],
      [ago(220), ago(219)],
      [ago(100), NOW],
    ]);
    expect(view.pace[2].at(-1)?.value).toBe(80);

    expect(view.current).toMatchObject({
      used: 25,
      resetAtMs: secondReset,
      resetPassedAtMs: null,
      paceUsed: 80,
      stale: false,
    });
  });

  test('a reset after the newest reading refills the window, and an old reading is stale', () => {
    const reset = NOW - 30 * MINUTE_MS;
    const view = buildUsageWindow(
      window('seven_day', WEEK, [point(3 * 60, 50, reset), point(2 * 60, 45, reset)]),
      NOW - 2 * DAY_MS,
      NOW
    );
    expect(view?.kind).toBe('weekly');
    expect(view?.current).toMatchObject({
      used: 0,
      resetAtMs: null,
      resetPassedAtMs: reset,
      paceUsed: null,
      stale: true,
    });
    expect(view?.ends).toEqual([{ atMs: reset, peakUsed: 55 }]);
    // a stale reading is not stretched to now; the rest of the range is a gap
    expect(view?.gaps.at(-1)).toEqual({ fromMs: NOW - 2 * HOUR_MS + MINUTE_MS, toMs: NOW });
  });

  test('a reading taken after its own reset draws as the next, empty window', () => {
    const reset = NOW - 60 * MINUTE_MS;
    const view = buildUsageWindow(
      // imported heartbeats drift past 30 minutes and are still not a gap
      window('seven_day', WEEK, [point(90, 20, reset), point(52, 20, reset)]),
      NOW - 2 * HOUR_MS,
      NOW
    );
    expect(view?.steps.map((step) => [step.t0, step.t1, step.used, step.afterReset])).toEqual([
      [NOW - 90 * MINUTE_MS, reset, 80, false],
      [reset, NOW - 52 * MINUTE_MS, 0, true],
      [NOW - 52 * MINUTE_MS, NOW - 51 * MINUTE_MS, 0, true],
    ]);
  });
});

describe('account usage accounts', () => {
  test('joins history to auth files, hides placeholder windows, and masks emails', () => {
    const history = normalizeQuotaHistory({
      enabled: true,
      retention_seconds: 2592000,
      credentials: [
        {
          auth_id: 'codex-a.json',
          auth_index: 'idx-codex',
          provider: 'codex',
          quota_weight: 1,
          windows: [
            // Codex `primary` can be the weekly window; length decides, not id
            {
              id: 'primary',
              period_seconds: 604800,
              points: [
                { t: (NOW - 5 * MINUTE_MS) / 1000, remaining: 97, reset_at: (NOW + DAY_MS) / 1000 },
              ],
            },
            {
              id: 'secondary',
              period_seconds: 0,
              points: [
                {
                  t: (NOW - 5 * MINUTE_MS) / 1000,
                  remaining: 100,
                  reset_at: (NOW - 5 * MINUTE_MS) / 1000,
                },
              ],
            },
          ],
        },
        {
          auth_id: 'codex-orphan.json',
          auth_index: 'idx-orphan',
          provider: 'codex',
          quota_weight: 2,
          email: 'orphan@example.com',
          plan_type: 'Plus',
          windows: [],
        },
        { auth_id: 'claude.json', auth_index: 'idx-claude', provider: 'claude', windows: [] },
      ],
    });
    const files: AuthFileItem[] = [
      {
        name: 'codex-never-polled.json',
        type: 'codex',
        email: 'never@example.com',
        authIndex: 'idx-none',
      },
      { name: 'codex-a.json', type: 'codex', email: 'a@example.com', authIndex: 'idx-codex' },
    ];
    const collect = (showEmails: boolean) =>
      collectUsageAccounts({
        provider: 'codex',
        files,
        history,
        showEmails,
        filePlanType: (file) => (file.name === 'codex-a.json' ? 'prolite' : null),
        startMs: NOW - DAY_MS,
        now: NOW,
      });

    const masked = collect(false);
    expect(masked.map((account) => [account.key, account.name])).toEqual([
      ['idx-none', 'codex-never-polled'],
      ['idx-codex', 'codex-a'],
      ['idx-orphan', 'codex-orphan'],
    ]);
    expect(masked[0]).toMatchObject({ windows: [], latestAtMs: null, stale: false });
    expect(masked[1].windows.map((view) => [view.id, view.kind])).toEqual([['primary', 'weekly']]);
    expect(masked[1]).toMatchObject({ planType: 'prolite', quotaWeight: 1 });
    expect(masked[2]).toMatchObject({ planType: 'plus', quotaWeight: 2 });

    expect(collect(true).map((account) => account.name)).toEqual([
      'never@example.com',
      'a@example.com',
      'orphan@example.com',
    ]);
  });
});

describe('account usage history reads', () => {
  test('one read covers the pool and the account range', () => {
    const range = poolRange(0, NOW);
    const pool = poolHistorySpans(range.startMs, range.endMs, NOW);
    // the pool already reads three days back, so a short account range adds nothing
    expect(historySpansWithRecent(pool, 2, NOW)).toEqual(pool);
    expect(historySpansWithRecent(pool, 30, NOW)).toEqual([
      { fromMs: NOW - 30 * DAY_MS, toMs: NOW },
    ]);
  });
});

describe('account usage section', () => {
  // other suites share this i18n instance and expect its default language
  const defaultLanguage = i18n.language;
  beforeAll(() => i18n.changeLanguage('en'));
  afterAll(() => i18n.changeLanguage(defaultLanguage));

  const files: AuthFileItem[] = [
    { name: 'claude-fresh.json', type: 'claude', email: 'fresh@example.com', authIndex: 'fresh' },
    { name: 'claude-stale.json', type: 'claude', authIndex: 'stale' },
    { name: 'claude-new.json', type: 'claude', authIndex: 'new' },
  ];
  const render = (history: QuotaHistory, loaded = true, failed = false) =>
    renderToStaticMarkup(
      createElement(AccountUsageSection, {
        provider: 'claude',
        files,
        history,
        historyLoaded: loaded,
        historyFailed: failed,
        showEmails: true,
        rangeDays: 1,
        onRangeDaysChange: () => {},
        planTypeFor: () => null,
        planLabel: (planType: string) => planType,
        now: NOW,
        resolvedTheme: 'light',
      })
    );

  test('shows each account, and says when one is stale or has no readings', () => {
    const credential = (authIndex: string, points: QuotaHistoryPoint[]) => ({
      authId: `claude-${authIndex}.json`,
      authIndex,
      provider: 'claude',
      quotaWeight: authIndex === 'fresh' ? 10 : 1,
      email: null,
      planType: null,
      windows: [window('five_hour', FIVE_HOURS, points)],
    });
    const html = render({
      enabled: true,
      retentionMs: 30 * DAY_MS,
      credentials: [
        credential('fresh', [point(3, 60, NOW + 2 * HOUR_MS)]),
        credential('stale', [point(3 * 60, 90, NOW + HOUR_MS)]),
      ],
    });

    expect(html).toContain('fresh@example.com');
    expect(html).toContain('Plan size 10');
    expect(html).toContain('40%');
    expect(html).toContain('Updated 3m ago');
    expect(html).toContain('No new readings for 3h 0m');
    expect(html).toContain('No readings yet. The server records');
    // the masked name of a file without an email
    expect(html).toContain('claude-new');
  });

  test('says when history is off or unreadable instead of drawing empty cards', () => {
    expect(render({ ...EMPTY_QUOTA_HISTORY })).toContain('Usage history is off');
    const failed = render(EMPTY_QUOTA_HISTORY, false, true);
    expect(failed).toContain('Couldn&#x27;t read usage history');
    expect(failed).not.toContain('claude-new');
  });
});
