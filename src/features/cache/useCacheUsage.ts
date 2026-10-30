/**
 * Prompt cache report for the chosen range, re-read every 30 seconds while the
 * page is visible, as soon as a hidden tab is shown again, and whenever
 * `refreshKey` changes. A failed read keeps the last good report.
 */

import { useEffect, useRef, useState } from 'react';
import { cacheUsageApi, type CacheUsageReport } from '@/services/api/cacheUsage';
import { useAuthStore, useQuotaStore } from '@/stores';

const CACHE_POLL_MS = 30_000;

export interface CacheUsageState {
  report: CacheUsageReport | null;
  loading: boolean;
  /** The latest read failed; `report` is then the last good one, if any. */
  failed: boolean;
  /** When the shown report was read, in ms. */
  readAtMs: number | null;
}

interface SessionReport {
  // the quota store's generation changes on login and logout, so a report
  // read for one connection never shows on another
  session: number;
  report: CacheUsageReport | null;
  failed: boolean;
  readAtMs: number | null;
}

export function useCacheUsage(rangeMs: number, refreshKey: number): CacheUsageState {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [state, setState] = useState<SessionReport>({
    session: sessionGeneration,
    report: null,
    failed: false,
    readAtMs: null,
  });
  const [loading, setLoading] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const poll = () => {
      if (!document.hidden) setPollTick((tick) => tick + 1);
    };
    const timer = window.setInterval(poll, CACHE_POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [connectionStatus]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (connectionStatus !== 'connected') return;

    const isCurrent = () =>
      requestId === requestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    cacheUsageApi
      .get(Date.now() - rangeMs)
      .then((report) => {
        if (!isCurrent()) return;
        setState({ session: sessionGeneration, report, failed: false, readAtMs: Date.now() });
      })
      .catch(() => {
        if (!isCurrent()) return;
        setState((previous) =>
          previous.session === sessionGeneration
            ? { ...previous, failed: true }
            : { session: sessionGeneration, report: null, failed: true, readAtMs: null }
        );
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });

    return () => {
      requestRef.current += 1;
    };
  }, [connectionStatus, rangeMs, refreshKey, pollTick, sessionGeneration]);

  const sameSession = state.session === sessionGeneration;
  return {
    report: sameSession ? state.report : null,
    loading,
    failed: sameSession && state.failed,
    readAtMs: sameSession ? state.readAtMs : null,
  };
}
