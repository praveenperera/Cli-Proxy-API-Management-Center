/**
 * Prompt cache usage (`GET /observability/usage/cache`).
 *
 * The backend totals cache read, cache write, and uncached input tokens per
 * credential, per hour, per served model, and per client session, and prices
 * them at Anthropic's API list prices. A backend without the endpoint (404)
 * yields an empty, unavailable report rather than an error.
 */

import { getStatusFromError } from '@/utils/quota/formatters';
import { apiClient } from './client';

/** Token totals over some set of requests. */
export interface CacheUsageTotals {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Part of cacheWriteTokens written to the 1-hour cache, which costs more. */
  cacheWrite1hTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  /** Cache read over input, 0..1; null when there was no input. */
  hitRatio: number | null;
  /**
   * USD at API list prices, which is what the traffic would cost on the API,
   * not what a subscription bills. Leaves out unpricedRequests.
   */
  costUsd: number;
  /** The same requests with every input token at the base input price. */
  noCacheCostUsd: number;
  /** Requests on models without a known price or recorded before cost tracking. */
  unpricedRequests: number;
}

export interface CacheUsageCredential {
  authId: string;
  authIndex: string | null;
  provider: string;
  email: string | null;
  planType: string | null;
  totals: CacheUsageTotals;
}

/** One served model's usage; an empty model holds requests recorded before per-model tracking. */
export interface CacheUsageModel {
  model: string;
  provider: string;
  totals: CacheUsageTotals;
}

/** One client session, such as a Claude Code conversation or one of its subagents. */
export interface CacheUsageSession {
  sessionId: string;
  /** Set for subagents; the session that spawned this one. */
  parentSessionId: string | null;
  /** Credential of the session's latest request, which changes on failover. */
  authId: string;
  provider: string;
  model: string;
  /** Start of the session's first user prompt; null when the proxy did not capture one. */
  title: string | null;
  /** Last element of the client's working directory, such as the repository name. */
  project: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
  totals: CacheUsageTotals;
  lastRequest: CacheUsageTotals;
}

export interface CacheUsageReport {
  /** False when the backend predates the endpoint. */
  available: boolean;
  sinceMs: number;
  untilMs: number;
  retentionMs: number | null;
  totals: CacheUsageTotals;
  credentials: CacheUsageCredential[];
  /** Busiest first. */
  models: CacheUsageModel[];
  /** Most recent first. */
  sessions: CacheUsageSession[];
}

export const EMPTY_CACHE_USAGE_TOTALS: CacheUsageTotals = {
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  uncachedTokens: 0,
  outputTokens: 0,
  hitRatio: null,
  costUsd: 0,
  noCacheCostUsd: 0,
  unpricedRequests: 0,
};

export const EMPTY_CACHE_USAGE: CacheUsageReport = {
  available: false,
  sinceMs: 0,
  untilMs: 0,
  retentionMs: null,
  totals: EMPTY_CACHE_USAGE_TOTALS,
  credentials: [],
  models: [],
  sessions: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const secondsToMs = (value: unknown): number => count(value) * 1000;

function normalizeTotals(value: unknown, costTracked: boolean): CacheUsageTotals {
  if (!isRecord(value)) return EMPTY_CACHE_USAGE_TOTALS;
  const ratio = value.hit_ratio;
  const requests = count(value.requests);
  return {
    requests,
    inputTokens: count(value.input_tokens),
    cacheReadTokens: count(value.cache_read_tokens),
    cacheWriteTokens: count(value.cache_write_tokens),
    cacheWrite1hTokens: count(value.cache_write_1h_tokens),
    uncachedTokens: count(value.uncached_tokens),
    outputTokens: count(value.output_tokens),
    hitRatio:
      typeof ratio === 'number' && Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null,
    costUsd: count(value.cost_usd),
    noCacheCostUsd: count(value.no_cache_cost_usd),
    // a backend without cost tracking prices nothing, rather than every request at $0
    unpricedRequests: costTracked ? count(value.unpriced_requests) : requests,
  };
}

function normalizeCredential(value: unknown, costTracked: boolean): CacheUsageCredential | null {
  if (!isRecord(value)) return null;
  const authId = trimmed(value.auth_id);
  if (!authId) return null;
  return {
    authId,
    authIndex: trimmed(value.auth_index) || null,
    provider: trimmed(value.provider).toLowerCase(),
    email: trimmed(value.email) || null,
    planType: trimmed(value.plan_type).toLowerCase() || null,
    totals: normalizeTotals(value.totals, costTracked),
  };
}

function normalizeModel(value: unknown): CacheUsageModel | null {
  if (!isRecord(value)) return null;
  return {
    model: trimmed(value.model),
    provider: trimmed(value.provider).toLowerCase(),
    totals: normalizeTotals(value.totals, true),
  };
}

function normalizeSession(value: unknown, costTracked: boolean): CacheUsageSession | null {
  if (!isRecord(value)) return null;
  const sessionId = trimmed(value.session_id);
  if (!sessionId) return null;
  return {
    sessionId,
    parentSessionId: trimmed(value.parent_session_id) || null,
    authId: trimmed(value.auth_id),
    provider: trimmed(value.provider).toLowerCase(),
    model: trimmed(value.model),
    title: trimmed(value.title) || null,
    project: trimmed(value.project) || null,
    firstSeenMs: secondsToMs(value.first_seen),
    lastSeenMs: secondsToMs(value.last_seen),
    totals: normalizeTotals(value.totals, costTracked),
    lastRequest: normalizeTotals(value.last_request, costTracked),
  };
}

const present = <T>(value: T | null): value is T => value !== null;

/** Normalize a raw report body. Malformed entries are dropped, not fatal. */
export function normalizeCacheUsage(raw: unknown): CacheUsageReport {
  if (!isRecord(raw)) return EMPTY_CACHE_USAGE;
  // backends with cost tracking always send the models list; costs are omitted when zero, so
  // their absence alone does not tell an older backend apart
  const costTracked = Array.isArray(raw.models);
  return {
    available: true,
    sinceMs: secondsToMs(raw.since),
    untilMs: secondsToMs(raw.until),
    retentionMs: secondsToMs(raw.retention_seconds) || null,
    totals: normalizeTotals(raw.totals, costTracked),
    credentials: (Array.isArray(raw.credentials) ? raw.credentials : [])
      .map((credential) => normalizeCredential(credential, costTracked))
      .filter(present),
    models: (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel).filter(present),
    sessions: (Array.isArray(raw.sessions) ? raw.sessions : [])
      .map((session) => normalizeSession(session, costTracked))
      .filter(present)
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs),
  };
}

export const cacheUsageApi = {
  /** Usage for requests since an instant (ms) up to now. */
  async get(sinceMs: number): Promise<CacheUsageReport> {
    try {
      const raw = await apiClient.get('/observability/usage/cache', {
        params: { since: Math.floor(sinceMs / 1000) },
      });
      return normalizeCacheUsage(raw);
    } catch (err: unknown) {
      if (getStatusFromError(err) === 404) return EMPTY_CACHE_USAGE;
      throw err;
    }
  },
};
