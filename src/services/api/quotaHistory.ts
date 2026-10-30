/**
 * Recorded quota history (`GET /quota/history`).
 *
 * The backend samples Claude and Codex quota windows while its affinity
 * profile is on. Everything here degrades to "nothing recorded": a backend
 * without the endpoint (404) or with recording off yields an empty, disabled
 * history rather than an error, so the quota page can still project from live
 * data alone.
 */

import { normalizeRecentRequestAuthIndex } from '@/utils/recentRequests';
import { getStatusFromError } from '@/utils/quota/formatters';
import { apiClient } from './client';

/** One sample of a quota window. */
export interface QuotaHistoryPoint {
  atMs: number;
  /** Remaining percent, 0..100. */
  remaining: number;
  /** Null when the sample carried no reset instant. */
  resetAtMs: number | null;
}

/** One recorded window (for example Claude `seven_day`, Codex `secondary`). */
export interface QuotaHistoryWindow {
  id: string;
  /** Null when the backend did not know the window length. */
  periodMs: number | null;
  /** Sorted ascending by `atMs`. */
  points: QuotaHistoryPoint[];
}

export interface QuotaHistoryCredential {
  authId: string;
  authIndex: string | null;
  provider: string;
  /** Size against other accounts of the provider; null when the backend sent none. */
  quotaWeight: number | null;
  /** Account email and plan; null when the backend omits them (older backends always do). */
  email: string | null;
  planType: string | null;
  windows: QuotaHistoryWindow[];
}

export interface QuotaHistory {
  enabled: boolean;
  retentionMs: number | null;
  credentials: QuotaHistoryCredential[];
}

export const EMPTY_QUOTA_HISTORY: QuotaHistory = {
  enabled: false,
  retentionMs: null,
  credentials: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const positiveNumber = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Seconds → ms, with 0 and negatives meaning "unknown" per the contract. */
const positiveSecondsToMs = (value: unknown): number | null => {
  const seconds = positiveNumber(value);
  return seconds !== null ? seconds * 1000 : null;
};

function normalizePoint(value: unknown): QuotaHistoryPoint | null {
  if (!isRecord(value)) return null;
  const atMs = positiveSecondsToMs(value.t);
  const remaining = finiteNumber(value.remaining);
  if (atMs === null || remaining === null) return null;
  return {
    atMs,
    remaining: Math.min(100, Math.max(0, remaining)),
    resetAtMs: positiveSecondsToMs(value.reset_at),
  };
}

function normalizeWindow(value: unknown): QuotaHistoryWindow | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  const points = (Array.isArray(value.points) ? value.points : [])
    .map(normalizePoint)
    .filter((point): point is QuotaHistoryPoint => point !== null)
    .sort((a, b) => a.atMs - b.atMs);
  return { id, periodMs: positiveSecondsToMs(value.period_seconds), points };
}

function normalizeCredential(value: unknown): QuotaHistoryCredential | null {
  if (!isRecord(value)) return null;
  const authIndex = normalizeRecentRequestAuthIndex(value.auth_index);
  const authId = typeof value.auth_id === 'string' ? value.auth_id : '';
  // auth_index is the only key the credentials list shares with this payload
  if (!authIndex) return null;
  return {
    authId,
    authIndex,
    provider: typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : '',
    quotaWeight: positiveNumber(value.quota_weight),
    email: nonEmptyString(value.email),
    planType: nonEmptyString(value.plan_type)?.toLowerCase() ?? null,
    windows: (Array.isArray(value.windows) ? value.windows : [])
      .map(normalizeWindow)
      .filter((window): window is QuotaHistoryWindow => window !== null),
  };
}

/** Normalize a raw `/quota/history` body. Malformed entries are dropped, not fatal. */
export function normalizeQuotaHistory(raw: unknown): QuotaHistory {
  if (!isRecord(raw)) return EMPTY_QUOTA_HISTORY;
  const enabled = raw.enabled === true;
  return {
    enabled,
    retentionMs: positiveSecondsToMs(raw.retention_seconds),
    credentials: enabled
      ? (Array.isArray(raw.credentials) ? raw.credentials : [])
          .map(normalizeCredential)
          .filter((credential): credential is QuotaHistoryCredential => credential !== null)
      : [],
  };
}

/**
 * Combine histories read over separate spans, merging each credential's
 * windows by id and their points by time.
 */
export function mergeQuotaHistories(parts: readonly QuotaHistory[]): QuotaHistory {
  if (parts.length === 1) return parts[0];
  const credentials = new Map<string, QuotaHistoryCredential>();
  parts.forEach((part) =>
    part.credentials.forEach((credential) => {
      const key = credential.authIndex ?? credential.authId;
      const merged = credentials.get(key) ?? { ...credential, windows: [] };
      credentials.set(key, merged);
      credential.windows.forEach((window) => {
        const target = merged.windows.find((candidate) => candidate.id === window.id);
        if (!target) {
          merged.windows.push({ ...window, points: [...window.points] });
          return;
        }
        target.periodMs ??= window.periodMs;
        target.points.push(...window.points);
      });
    })
  );
  credentials.forEach((credential) =>
    credential.windows.forEach((window) => {
      // a sample on a span boundary can come back from both reads
      window.points = window.points
        .sort((a, b) => a.atMs - b.atMs)
        .filter((point, index, points) => index === 0 || point.atMs !== points[index - 1].atMs);
    })
  );
  return {
    enabled: parts.some((part) => part.enabled),
    retentionMs: parts.find((part) => part.retentionMs !== null)?.retentionMs ?? null,
    credentials: [...credentials.values()],
  };
}

export const quotaHistoryApi = {
  /**
   * Recorded samples between two instants (ms). A backend that predates the
   * endpoint answers 404, which is reported as disabled history.
   */
  async get(sinceMs: number, untilMs: number): Promise<QuotaHistory> {
    try {
      const raw = await apiClient.get('/quota/history', {
        params: { since: Math.floor(sinceMs / 1000), until: Math.ceil(untilMs / 1000) },
      });
      return normalizeQuotaHistory(raw);
    } catch (err: unknown) {
      if (getStatusFromError(err) === 404) return EMPTY_QUOTA_HISTORY;
      throw err;
    }
  },
};
