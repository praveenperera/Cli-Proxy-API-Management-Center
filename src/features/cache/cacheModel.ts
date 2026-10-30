/**
 * Pure shaping of the usage report for the usage and cost page: threads with
 * their subagents nested, per-account session counts, token composition, and
 * API-equivalent cost.
 */

import type {
  CacheUsageCredential,
  CacheUsageReport,
  CacheUsageSession,
  CacheUsageTotals,
} from '@/services/api/cacheUsage';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

export const CACHE_RANGES = ['24h', '7d', '30d'] as const;
export type CacheRange = (typeof CACHE_RANGES)[number];

export const CACHE_RANGE_MS: Record<CacheRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

/**
 * A session counts as active while its last request is within this window;
 * it matches the default session-affinity TTL, so an active session is most
 * likely still bound to its account
 */
export const ACTIVE_SESSION_MS = HOUR_MS;

/** A Claude Code conversation (or other client session) and the subagents it spawned. */
export interface CacheThread {
  session: CacheUsageSession;
  /** Most recent first. */
  subagents: CacheUsageSession[];
  /** Latest activity across the thread and its subagents. */
  lastSeenMs: number;
  /** API-equivalent cost of the thread and its subagents together. */
  costUsd: number;
}

export interface CacheAccountRow {
  credential: CacheUsageCredential;
  /** Sessions whose latest request used this account. */
  sessionCount: number;
  activeSessionCount: number;
}

export interface TokenShare {
  read: number;
  write: number;
  uncached: number;
}

/** "95.8%", or a dash when there was no input to measure. */
export const formatHitRatio = (ratio: number | null) =>
  ratio === null ? '—' : `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;

const usd = (fractionDigits: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
const USD_CENTS = usd(2);
const USD_WHOLE = usd(0);

/** "$1,234", "$12.34", or "<$0.01" for a cost too small to show in cents. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01';
  return value >= 1000 ? USD_WHOLE.format(value) : USD_CENTS.format(value);
}

/** Whether totals have no price at all, so a cost would read as a misleading $0. */
export const isUnpriced = (totals: CacheUsageTotals) =>
  totals.requests > 0 && totals.unpricedRequests >= totals.requests;

/** What caching saved against paying the base input price for every input token. */
export function cacheSavings(totals: CacheUsageTotals): { savedUsd: number; share: number | null } {
  const savedUsd = Math.max(0, totals.noCacheCostUsd - totals.costUsd);
  return {
    savedUsd,
    share: totals.noCacheCostUsd > 0 ? savedUsd / totals.noCacheCostUsd : null,
  };
}

/** Fractions of input tokens that were cache reads, cache writes, and uncached. */
export function tokenShare(totals: CacheUsageTotals): TokenShare {
  const total = totals.cacheReadTokens + totals.cacheWriteTokens + totals.uncachedTokens;
  if (total <= 0) return { read: 0, write: 0, uncached: 0 };
  return {
    read: totals.cacheReadTokens / total,
    write: totals.cacheWriteTokens / total,
    uncached: totals.uncachedTokens / total,
  };
}

/** "claude:8108c23f-d63c-..." → "8108c23f"; subagents → "agent a3989e39". */
export function shortSessionLabel(sessionId: string): string {
  const agentMarker = sessionId.lastIndexOf(':agent:');
  if (agentMarker >= 0) return `agent ${sessionId.slice(agentMarker + 7, agentMarker + 15)}`;
  const id = sessionId.includes(':') ? sessionId.slice(sessionId.indexOf(':') + 1) : sessionId;
  return id.slice(0, 8);
}

/** The id a client resumes by, such as the Claude Code session UUID. */
export function clientSessionId(sessionId: string): string {
  const agentMarker = sessionId.lastIndexOf(':agent:');
  const base = agentMarker >= 0 ? sessionId.slice(0, agentMarker) : sessionId;
  return base.includes(':') ? base.slice(base.indexOf(':') + 1) : base;
}

/**
 * Nest subagents under their top-level thread, so a subagent of a subagent
 * sits under the conversation that started the chain. A subagent whose
 * ancestors are not in the report (they were last active before the range)
 * stands as its own thread so it is never hidden
 */
export function buildThreads(sessions: readonly CacheUsageSession[]): CacheThread[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const rootOf = (session: CacheUsageSession): string => {
    const seen = new Set([session.sessionId]);
    let current = session;
    for (;;) {
      const parent = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
      if (!parent) return current.sessionId;
      // a parent cycle has no top-level thread, so the session stands alone
      if (seen.has(parent.sessionId)) return session.sessionId;
      seen.add(parent.sessionId);
      current = parent;
    }
  };

  const roots = new Map(sessions.map((session) => [session.sessionId, rootOf(session)]));
  const threads = new Map<string, CacheThread>();
  sessions.forEach((session) => {
    if (roots.get(session.sessionId) === session.sessionId) {
      threads.set(session.sessionId, {
        session,
        subagents: [],
        lastSeenMs: session.lastSeenMs,
        costUsd: session.totals.costUsd,
      });
    }
  });
  sessions.forEach((session) => {
    const thread = threads.get(roots.get(session.sessionId) ?? '');
    if (!thread || thread.session === session) return;
    thread.subagents.push(session);
    thread.lastSeenMs = Math.max(thread.lastSeenMs, session.lastSeenMs);
    thread.costUsd += session.totals.costUsd;
  });

  const ordered = [...threads.values()];
  ordered.forEach((thread) => thread.subagents.sort((a, b) => b.lastSeenMs - a.lastSeenMs));
  return ordered.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

export const THREAD_SORTS = ['recent', 'cost'] as const;
export type ThreadSort = (typeof THREAD_SORTS)[number];

/** Threads by latest activity, as built, or by cost with subagents included. */
export function sortThreads(threads: readonly CacheThread[], sort: ThreadSort): CacheThread[] {
  if (sort === 'recent') return [...threads];
  return [...threads].sort((a, b) => b.costUsd - a.costUsd || b.lastSeenMs - a.lastSeenMs);
}

export interface ThreadFilter {
  /** Empty for every account. */
  authId: string;
  query: string;
}

const sessionMatches = (session: CacheUsageSession, filter: ThreadFilter, query: string) =>
  (!filter.authId || session.authId === filter.authId) &&
  (!query ||
    [session.sessionId, session.model, session.title ?? '', session.project ?? ''].some((field) =>
      field.toLowerCase().includes(query)
    ));

/** A thread narrowed to some of its subagents, with its cost and recency recounted. */
const withSubagents = (thread: CacheThread, subagents: CacheUsageSession[]): CacheThread =>
  subagents === thread.subagents
    ? thread
    : {
        ...thread,
        subagents,
        lastSeenMs: Math.max(thread.session.lastSeenMs, ...subagents.map((s) => s.lastSeenMs)),
        costUsd: subagents.reduce(
          (sum, s) => sum + s.totals.costUsd,
          thread.session.totals.costUsd
        ),
      };

/**
 * Keep threads where the thread or any subagent matches, and within a kept
 * thread only the matching subagents, unless the thread itself matched
 */
export function filterThreads(
  threads: readonly CacheThread[],
  filter: ThreadFilter
): CacheThread[] {
  const query = filter.query.trim().toLowerCase();
  if (!filter.authId && !query) return [...threads];
  return threads.flatMap((thread) => {
    const subagents = thread.subagents.filter((session) => sessionMatches(session, filter, query));
    if (sessionMatches(thread.session, filter, query)) {
      return [withSubagents(thread, filter.authId ? subagents : thread.subagents)];
    }
    return subagents.length ? [withSubagents(thread, subagents)] : [];
  });
}

/** Accounts with traffic in the range, busiest first, with their session counts. */
export function buildAccountRows(report: CacheUsageReport, nowMs: number): CacheAccountRow[] {
  return report.credentials
    .map((credential) => {
      const sessions = report.sessions.filter((session) => session.authId === credential.authId);
      return {
        credential,
        sessionCount: sessions.length,
        activeSessionCount: sessions.filter(
          (session) => nowMs - session.lastSeenMs <= ACTIVE_SESSION_MS
        ).length,
      };
    })
    .sort((a, b) => b.credential.totals.requests - a.credential.totals.requests);
}

/** Readable account name: the email when known, else the credential file name. */
export function accountLabel(authId: string, credentials: readonly CacheUsageCredential[]): string {
  const email = credentials.find((credential) => credential.authId === authId)?.email;
  return email ?? authId.replace(/\.json$/i, '');
}

/** Distinct account hues; a fourth account and beyond share the neutral pill */
export const ACCOUNT_COLOR_SLOTS = 3;

/**
 * Color slot (1-based) per account, or 0 for the neutral pill. Slots follow the
 * sorted credential list rather than traffic, so an account keeps its color
 * when the range or filter changes which accounts appear
 */
export function accountColorSlots(
  knownAuthIds: readonly string[],
  reportAuthIds: readonly string[]
): Map<string, number> {
  const ordered = [...new Set([...knownAuthIds, ...reportAuthIds])].sort();
  return new Map(
    ordered.map((authId, index) => [authId, index < ACCOUNT_COLOR_SLOTS ? index + 1 : 0])
  );
}
