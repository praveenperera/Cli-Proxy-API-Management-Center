import { describe, expect, test } from 'bun:test';
import { normalizeCacheUsage } from '../src/services/api/cacheUsage';
import {
  buildAccountRows,
  accountColorSlots,
  buildThreads,
  cacheSavings,
  clientSessionId,
  filterThreads,
  formatUsd,
  isUnpriced,
  shortSessionLabel,
  sortThreads,
  tokenShare,
} from '../src/features/cache/cacheModel';

const NOW_S = 1_793_200_000;

const totals = (requests: number, read: number, write: number, uncached: number) => ({
  requests,
  input_tokens: read + write + uncached,
  cache_read_tokens: read,
  cache_write_tokens: write,
  uncached_tokens: uncached,
  output_tokens: 10,
  hit_ratio: read / (read + write + uncached),
});

const GMAIL = 'claude-c528407e-user@gmail.com.json';
const WORK = 'claude-a93f2c35-user@work.com.json';
const PARENT = 'claude:66f959f7-e949-478f-998d-7d74ae31c952';

const raw = {
  since: NOW_S - 86_400,
  until: NOW_S,
  retention_seconds: 2_592_000,
  totals: totals(40, 900, 80, 20),
  models: [],
  credentials: [
    { auth_id: WORK, provider: 'claude', email: 'user@work.com', totals: totals(10, 90, 8, 2) },
    {
      auth_id: GMAIL,
      provider: 'Claude',
      email: 'user@gmail.com',
      totals: totals(30, 810, 72, 18),
    },
    { provider: 'claude' },
  ],
  sessions: [
    {
      session_id: `${PARENT}:agent:a3989e39f1de2d108`,
      parent_session_id: PARENT,
      auth_id: WORK,
      model: 'claude-sonnet-5-5',
      first_seen: NOW_S - 600,
      last_seen: NOW_S - 60,
      totals: totals(5, 40, 5, 1),
      last_request: totals(1, 9, 1, 0),
    },
    {
      session_id: PARENT,
      auth_id: GMAIL,
      title: 'Fix traffic priority routing',
      project: 'CLIProxyAPI',
      model: 'claude-opus-5-5',
      first_seen: NOW_S - 7200,
      last_seen: NOW_S - 300,
      totals: totals(20, 700, 50, 10),
      last_request: totals(1, 99, 1, 0),
    },
    {
      // parent fell outside the range, so this subagent must stand alone
      session_id: 'claude:0049eea6-2851-4c1a-9f00-000000000000:agent:ffffffff00000000',
      parent_session_id: 'claude:0049eea6-2851-4c1a-9f00-000000000000',
      auth_id: GMAIL,
      model: 'claude-haiku-5-5',
      first_seen: NOW_S - 10_000,
      last_seen: NOW_S - 9000,
      totals: totals(2, 10, 5, 5),
      last_request: totals(1, 5, 0, 5),
    },
    { auth_id: GMAIL },
  ],
};

describe('cache usage report', () => {
  const report = normalizeCacheUsage(raw);

  test('normalizes seconds to ms and drops entries without ids', () => {
    expect(report.available).toBe(true);
    expect(report.sinceMs).toBe((NOW_S - 86_400) * 1000);
    expect(report.credentials.map((c) => c.authId)).toEqual([WORK, GMAIL]);
    expect(report.credentials[1].provider).toBe('claude');
    expect(report.sessions).toHaveLength(3);
    expect(report.sessions[0].lastSeenMs).toBe((NOW_S - 60) * 1000);
    expect(report.totals.hitRatio).toBeCloseTo(0.9);
  });

  test('a body that is not an object reads as unavailable', () => {
    expect(normalizeCacheUsage('not found').available).toBe(false);
  });

  test('nests subagents under a parent in range and keeps orphans as threads', () => {
    const threads = buildThreads(report.sessions);
    expect(threads.map((thread) => thread.session.sessionId)).toEqual([
      PARENT,
      'claude:0049eea6-2851-4c1a-9f00-000000000000:agent:ffffffff00000000',
    ]);
    expect(threads[0].subagents.map((s) => s.authId)).toEqual([WORK]);
    // the thread is as recent as its latest subagent
    expect(threads[0].lastSeenMs).toBe((NOW_S - 60) * 1000);
  });

  test('a subagent of a subagent nests under the top-level thread', () => {
    const session = (id: string, parent: string, lastSeen: number) => ({
      session_id: id,
      parent_session_id: parent,
      auth_id: GMAIL,
      last_seen: lastSeen,
    });
    const chain = normalizeCacheUsage({
      sessions: [
        session('claude:s', '', NOW_S - 300),
        session('claude:s:agent:a', 'claude:s', NOW_S - 200),
        session('claude:s:agent:b', 'claude:s:agent:a', NOW_S - 100),
        // a cycle has no top-level thread, so each session stands alone
        session('claude:x', 'claude:y', NOW_S - 400),
        session('claude:y', 'claude:x', NOW_S - 500),
      ],
    });
    const threads = buildThreads(chain.sessions);
    expect(threads.map((thread) => thread.session.sessionId)).toEqual([
      'claude:s',
      'claude:x',
      'claude:y',
    ]);
    expect(threads[0].subagents.map((s) => s.sessionId)).toEqual([
      'claude:s:agent:b',
      'claude:s:agent:a',
    ]);
  });

  test('an account filter keeps a thread for its matching subagent only', () => {
    const threads = buildThreads(report.sessions);
    const work = filterThreads(threads, { authId: WORK, query: '' });
    expect(work).toHaveLength(1);
    expect(work[0].session.sessionId).toBe(PARENT);
    expect(work[0].subagents).toHaveLength(1);

    const gmail = filterThreads(threads, { authId: GMAIL, query: '' });
    expect(gmail.map((thread) => thread.subagents.length)).toEqual([0, 0]);

    expect(filterThreads(threads, { authId: '', query: 'haiku' })).toHaveLength(1);
    // captured titles and projects are searchable
    expect(filterThreads(threads, { authId: '', query: 'priority' })[0].session.title).toBe(
      'Fix traffic priority routing'
    );
    expect(filterThreads(threads, { authId: '', query: 'cliproxy' })).toHaveLength(1);
  });

  test('counts each account’s sessions and the ones active in the last hour', () => {
    const rows = buildAccountRows(report, NOW_S * 1000);
    expect(
      rows.map((row) => [row.credential.authId, row.sessionCount, row.activeSessionCount])
    ).toEqual([
      [GMAIL, 2, 1],
      [WORK, 1, 1],
    ]);
  });

  test('labels and resumable ids', () => {
    expect(shortSessionLabel(PARENT)).toBe('66f959f7');
    expect(shortSessionLabel(`${PARENT}:agent:a3989e39f1de2d108`)).toBe('agent a3989e39');
    expect(clientSessionId(`${PARENT}:agent:a3989e39f1de2d108`)).toBe(
      '66f959f7-e949-478f-998d-7d74ae31c952'
    );
  });

  test('token share splits input into read, write, and uncached', () => {
    const share = tokenShare(report.totals);
    expect(share.read).toBeCloseTo(0.9);
    expect(share.write).toBeCloseTo(0.08);
    expect(share.uncached).toBeCloseTo(0.02);
  });

  test('account colors follow the credential list, not which accounts have traffic', () => {
    const known = ['codex-x.json', WORK, GMAIL];
    const all = accountColorSlots(known, [GMAIL, WORK]);
    const gmailOnly = accountColorSlots(known, [GMAIL]);
    expect(all.get(GMAIL)).toBe(gmailOnly.get(GMAIL));
    expect(new Set([all.get(GMAIL), all.get(WORK)]).size).toBe(2);
    // past the distinct hues, accounts share the neutral slot
    const many = accountColorSlots(['a', 'b', 'c', 'd', 'e', 'f'], []);
    expect(many.get('f')).toBe(0);
  });

  test('thread cost includes subagents and drives the cost sort', () => {
    const session = (id: string, parent: string, lastSeen: number, cost: number) => ({
      session_id: id,
      parent_session_id: parent,
      auth_id: GMAIL,
      last_seen: lastSeen,
      totals: { requests: 1, cost_usd: cost, no_cache_cost_usd: cost * 4 },
    });
    const costly = normalizeCacheUsage({
      sessions: [
        session('claude:recent', '', NOW_S - 10, 1),
        session('claude:big', '', NOW_S - 500, 2),
        session('claude:big:agent:a', 'claude:big', NOW_S - 400, 0.5),
      ],
    });
    const threads = buildThreads(costly.sessions);
    expect(threads.map((thread) => thread.session.sessionId)).toEqual([
      'claude:recent',
      'claude:big',
    ]);
    expect(threads[1].costUsd).toBe(2.5);
    expect(sortThreads(threads, 'cost').map((thread) => thread.session.sessionId)).toEqual([
      'claude:big',
      'claude:recent',
    ]);
    expect(cacheSavings(threads[1].session.totals)).toEqual({ savedUsd: 6, share: 0.75 });
    // an account filter that hides the subagent drops its cost from the thread
    const otherAccount = normalizeCacheUsage({
      sessions: [
        session('claude:big', '', NOW_S - 500, 2),
        { ...session('claude:big:agent:a', 'claude:big', NOW_S - 400, 0.5), auth_id: WORK },
      ],
    });
    const [filtered] = filterThreads(buildThreads(otherAccount.sessions), {
      authId: GMAIL,
      query: '',
    });
    expect([filtered.subagents.length, filtered.costUsd]).toEqual([0, 2]);
  });

  test('cost reads as a dash only when nothing in the totals has a price', () => {
    const totals = (raw: Record<string, number>) =>
      normalizeCacheUsage({ totals: raw, models: [] }).totals;
    expect(isUnpriced(totals({ requests: 2, unpriced_requests: 2 }))).toBe(true);
    expect(isUnpriced(totals({ requests: 2, unpriced_requests: 1, cost_usd: 3 }))).toBe(false);
    expect(isUnpriced(totals({}))).toBe(false);
    // a backend from before cost tracking sends no models list and no cost fields
    expect(isUnpriced(normalizeCacheUsage({ totals: { requests: 2 } }).totals)).toBe(true);
    expect([formatUsd(0), formatUsd(0.001), formatUsd(12.345), formatUsd(4321.6)]).toEqual([
      '$0.00',
      '<$0.01',
      '$12.35',
      '$4,322',
    ]);
  });
});
