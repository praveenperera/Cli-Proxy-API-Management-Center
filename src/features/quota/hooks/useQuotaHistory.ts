/**
 * Recorded quota history for the pool's visible range and the account charts.
 *
 * One read covers both: the pool's range plus the last `recentDays` days the
 * account charts show. Fetches once per range, again whenever `refreshKey`
 * changes (the page bumps it after "Refresh all" lands), every minute while
 * the page is visible, and as soon as a hidden tab is shown again. The
 * backend polls each account once a minute, so this keeps the page as fresh
 * as the server without the page ever asking a provider itself. A failed read
 * keeps the last good history: recorded samples are context, not something
 * worth an error banner over.
 */

import { useEffect, useRef, useState } from 'react';
import {
  EMPTY_QUOTA_HISTORY,
  mergeQuotaHistories,
  quotaHistoryApi,
  type QuotaHistory,
} from '@/services/api/quotaHistory';
import { useAuthStore, useQuotaStore } from '@/stores';
import { historySpansWithRecent } from '../accountUsageModel';
import { poolHistorySpans } from '../quotaPoolModel';

/** Matches the backend's own poll, so each read can bring at most one new reading. */
const HISTORY_POLL_MS = 60_000;

export interface QuotaHistoryState {
  history: QuotaHistory;
  /** False until the first read of this session lands, so "off" never flashes before it. */
  loaded: boolean;
  /** The latest read failed; `history` is then the last good one, if any. */
  failed: boolean;
}

interface SessionHistory {
  session: number;
  value: QuotaHistory | null;
  failed: boolean;
}

export function useQuotaHistory(
  rangeStartMs: number,
  rangeEndMs: number,
  recentDays: number,
  refreshKey: number
): QuotaHistoryState {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [history, setHistory] = useState<SessionHistory>({
    session: sessionGeneration,
    value: null,
    failed: false,
  });
  const [pollTick, setPollTick] = useState(0);
  const requestRef = useRef(0);

  // a hidden tab skips its ticks and catches up as soon as it is shown again
  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const poll = () => {
      if (!document.hidden) setPollTick((tick) => tick + 1);
    };
    const timer = window.setInterval(poll, HISTORY_POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [connectionStatus]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (connectionStatus !== 'connected') return;

    const now = Date.now();
    const spans = historySpansWithRecent(
      poolHistorySpans(rangeStartMs, rangeEndMs, now),
      recentDays,
      now
    );
    const isCurrent = () =>
      requestId === requestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    Promise.all(spans.map((span) => quotaHistoryApi.get(span.fromMs, span.toMs)))
      .then((parts) => {
        if (!isCurrent()) return;
        setHistory({
          session: sessionGeneration,
          value: mergeQuotaHistories(parts),
          failed: false,
        });
      })
      .catch(() => {
        if (!isCurrent()) return;
        // keep the previous history; the projection still works from live data
        setHistory((previous) =>
          previous.session === sessionGeneration
            ? { ...previous, failed: true }
            : { session: sessionGeneration, value: null, failed: true }
        );
      });

    return () => {
      requestRef.current += 1;
    };
  }, [
    connectionStatus,
    rangeStartMs,
    rangeEndMs,
    recentDays,
    refreshKey,
    pollTick,
    sessionGeneration,
  ]);

  // history from a previous connection must never leak into a new one
  const sameSession = history.session === sessionGeneration;
  const current = sameSession ? history.value : null;
  return {
    history: current ?? EMPTY_QUOTA_HISTORY,
    loaded: current !== null,
    failed: sameSession && history.failed,
  };
}
