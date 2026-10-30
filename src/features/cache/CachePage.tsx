/**
 * Usage and cost page: the overall cache hit ratio and API-equivalent cost,
 * each account's and model's share, and every client thread with the account
 * its latest request used.
 *
 * Reads only the backend's recorded totals (`/observability/usage/cache`);
 * it never asks a provider anything.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconCopy, IconRefreshCw, IconSearch } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { authFilesApi } from '@/services/api';
import type { CacheUsageSession, CacheUsageTotals } from '@/services/api/cacheUsage';
import { useAuthStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { formatCompactNumber } from '@/utils/format';
import { formatSpan } from '@/features/quota/poolFormat';
import { MINUTE_MS } from '@/utils/time/durations';
import {
  ACTIVE_SESSION_MS,
  CACHE_RANGES,
  CACHE_RANGE_MS,
  THREAD_SORTS,
  accountColorSlots,
  accountLabel,
  buildAccountRows,
  buildThreads,
  cacheSavings,
  clientSessionId,
  filterThreads,
  formatHitRatio,
  formatUsd,
  isUnpriced,
  shortSessionLabel,
  sortThreads,
  type CacheRange,
  type CacheThread,
  type ThreadSort,
} from './cacheModel';
import { useCacheUsage } from './useCacheUsage';
import { AccountPill } from './components/AccountPill';
import { CompositionBar, CompositionLegend, HitMeter } from './components/CacheBars';
import styles from './CachePage.module.scss';

const THREAD_PAGE_SIZE = 50;

export function CachePage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const now = useNow();

  const [range, setRange] = useState<CacheRange>('24h');
  const [refreshKey, setRefreshKey] = useState(0);
  const [authFilter, setAuthFilter] = useState('');
  const [query, setQuery] = useState('');
  const [threadSort, setThreadSort] = useState<ThreadSort>('recent');
  const [visibleCount, setVisibleCount] = useState(THREAD_PAGE_SIZE);

  const { report, loading, failed, readAtMs } = useCacheUsage(CACHE_RANGE_MS[range], refreshKey);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  useHeaderRefresh(refresh);

  // every credential name, so account colors stay put across ranges and filters
  const [knownAuthIds, setKnownAuthIds] = useState<string[]>([]);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    authFilesApi
      .list()
      .then((response) => {
        if (current) setKnownAuthIds((response?.files ?? []).map((file) => file.name));
      })
      .catch(() => {
        // colors then fall back to the accounts in the report
      });
    return () => {
      current = false;
    };
  }, [connected]);

  const credentials = useMemo(() => report?.credentials ?? [], [report]);
  const colorSlots = useMemo(
    () =>
      accountColorSlots(
        knownAuthIds,
        (report?.sessions ?? [])
          .map((session) => session.authId)
          .concat(credentials.map((credential) => credential.authId))
      ),
    [knownAuthIds, report, credentials]
  );
  const pill = (authId: string) => (
    <AccountPill label={accountLabel(authId, credentials)} slot={colorSlots.get(authId) ?? 0} />
  );
  const accounts = useMemo(() => (report ? buildAccountRows(report, now) : []), [report, now]);
  const threads = useMemo(() => buildThreads(report?.sessions ?? []), [report]);
  // a model served by more than one provider gets a row per provider, labeled by provider
  const sharedModels = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const { model } of report?.models ?? []) (seen.has(model) ? shared : seen).add(model);
    return shared;
  }, [report]);
  const shownThreads = useMemo(
    () => sortThreads(filterThreads(threads, { authId: authFilter, query }), threadSort),
    [threads, authFilter, query, threadSort]
  );

  const accountOptions = useMemo(
    () => [
      { value: '', label: t('cache_usage.all_accounts') },
      ...credentials.map((credential) => ({
        value: credential.authId,
        label: accountLabel(credential.authId, credentials),
      })),
    ],
    [credentials, t]
  );

  const copySessionId = async (session: CacheUsageSession) => {
    const copied = await copyToClipboard(clientSessionId(session.sessionId));
    showNotification(
      copied ? t('cache_usage.copied_session') : t('cache_usage.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  // the minute clock makes anything under a minute read as "just now"
  const agoText = (ms: number) =>
    ms < MINUTE_MS ? t('cache_usage.just_now') : t('cache_usage.ago', { span: formatSpan(ms, t) });

  const totals = report?.totals;
  const activeThreads = threads.filter((thread) => now - thread.lastSeenMs <= ACTIVE_SESSION_MS);
  const savings = totals ? cacheSavings(totals) : null;

  // a dash rather than $0 for totals that have no price at all
  const costText = (totals: CacheUsageTotals) =>
    isUnpriced(totals) ? '—' : formatUsd(totals.costUsd);
  const costHint = (totals: CacheUsageTotals) =>
    [
      t('cache_usage.cost_writes_hint', { tokens: formatCompactNumber(totals.cacheWriteTokens) }),
      totals.unpricedRequests > 0
        ? t('cache_usage.unpriced', { count: totals.unpricedRequests })
        : '',
    ]
      .filter(Boolean)
      .join('\n');

  const renderSessionRow = (session: CacheUsageSession, thread: CacheThread | null) => {
    const subagentCount = thread?.subagents.length ?? 0;
    const nested = thread === null;
    return (
      <TableRow key={session.sessionId} className={nested ? styles.subagentRow : undefined}>
        <TableCell>
          <div className={styles.threadCell}>
            {nested && (
              <span className={styles.nestMark} aria-hidden="true">
                ↳
              </span>
            )}
            <div className={styles.threadText}>
              {session.title ? (
                <div className={styles.threadTitle} title={session.title}>
                  {session.title}
                </div>
              ) : (
                <div className={styles.threadUntitled}>{shortSessionLabel(session.sessionId)}</div>
              )}
              <div className={styles.threadMeta}>
                {session.project && <span className={styles.project}>{session.project}</span>}
                <button
                  type="button"
                  className={styles.sessionId}
                  title={t('cache_usage.copy_session_hint', {
                    id: clientSessionId(session.sessionId),
                  })}
                  aria-label={t('cache_usage.copy_session_hint', {
                    id: clientSessionId(session.sessionId),
                  })}
                  onClick={() => void copySessionId(session)}
                >
                  {/* an untitled row already shows the short ID as its name */}
                  {session.title && shortSessionLabel(session.sessionId)}
                  <IconCopy size={12} aria-hidden="true" />
                </button>
                {subagentCount > 0 && (
                  <span className={styles.badge}>
                    {t('cache_usage.subagent_count', { count: subagentCount })}
                  </span>
                )}
                {now - session.lastSeenMs <= ACTIVE_SESSION_MS && (
                  <span className={styles.activeDot} title={t('cache_usage.active_hint')}>
                    {t('cache_usage.active')}
                  </span>
                )}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell className={styles.accountCell}>
          <div>{pill(session.authId)}</div>
          <div className={styles.modelLine}>{session.model || '—'}</div>
        </TableCell>
        <TableCell alignRight className={styles.num}>
          {session.totals.requests.toLocaleString()}
        </TableCell>
        <TableCell alignRight>
          <HitMeter ratio={session.totals.hitRatio} />
        </TableCell>
        <TableCell alignRight className={styles.num}>
          {formatHitRatio(session.lastRequest.hitRatio)}
        </TableCell>
        <TableCell alignRight className={styles.num} title={costHint(session.totals)}>
          <div>{costText(session.totals)}</div>
          {thread && subagentCount > 0 && thread.costUsd > session.totals.costUsd && (
            <div className={styles.muted}>
              {t('cache_usage.with_subagents', { amount: formatUsd(thread.costUsd) })}
            </div>
          )}
        </TableCell>
        <TableCell alignRight className={styles.muted}>
          {agoText(now - session.lastSeenMs)}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title}>{t('cache_usage.title')}</h1>
          <p className={styles.meta}>
            <span>
              {t('cache_usage.meta_requests', {
                count: totals?.requests ?? 0,
                formatted: (totals?.requests ?? 0).toLocaleString(),
              })}
            </span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{t('cache_usage.meta_threads', { count: threads.length })}</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaActive}>
              {t('cache_usage.meta_active', { count: activeThreads.length })}
            </span>
            {readAtMs !== null && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={failed ? styles.metaFailed : styles.metaMuted}>
                  {failed
                    ? t('cache_usage.read_failed')
                    : t('cache_usage.updated', { when: agoText(now - readAtMs) })}
                </span>
              </>
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <SegmentedControl
            ariaLabel={t('cache_usage.range_label')}
            options={CACHE_RANGES.map((value) => ({
              value,
              label: t(`cache_usage.range_${value}`),
            }))}
            value={range}
            onChange={(value) => {
              setRange(value as CacheRange);
              setVisibleCount(THREAD_PAGE_SIZE);
            }}
          />
          <button
            type="button"
            className={styles.primaryAction}
            onClick={refresh}
            disabled={!connected || loading}
          >
            <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />
            {t('cache_usage.refresh')}
          </button>
        </div>
      </header>

      {report && !report.available ? (
        <EmptyState
          title={t('cache_usage.unavailable_title')}
          description={t('cache_usage.unavailable_desc')}
        />
      ) : (
        <>
          <section className={`card ${styles.overview}`} aria-label={t('cache_usage.overall')}>
            <div className={styles.hero}>
              <span className={styles.heroLabel}>{t('cache_usage.overall')}</span>
              <span className={styles.heroValue}>{formatHitRatio(totals?.hitRatio ?? null)}</span>
              <span className={styles.heroSub}>
                {t('cache_usage.input_tokens', {
                  tokens: formatCompactNumber(totals?.inputTokens ?? 0),
                })}
              </span>
            </div>
            <div className={styles.hero}>
              <span className={styles.heroLabel} title={t('cache_usage.cost_hint')}>
                {t('cache_usage.cost')}
              </span>
              <span className={styles.heroValue}>{totals ? costText(totals) : '—'}</span>
              {savings && savings.share !== null && (
                <span className={styles.heroSub}>
                  {t('cache_usage.saved', {
                    amount: formatUsd(savings.savedUsd),
                    share: formatHitRatio(savings.share),
                  })}
                </span>
              )}
              {totals && totals.unpricedRequests > 0 && (
                <span className={styles.heroNote}>
                  {t('cache_usage.unpriced', { count: totals.unpricedRequests })}
                </span>
              )}
            </div>
            {totals && (
              <div className={styles.composition}>
                <CompositionBar totals={totals} />
                <CompositionLegend totals={totals} />
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{t('cache_usage.accounts')}</h2>
            {accounts.length === 0 ? (
              <EmptyState title={t('cache_usage.no_traffic')} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('cache_usage.col_account')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_hit')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_requests')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_cost')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_threads')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_input')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_write')}</TableHead>
                    <TableHead className={styles.compositionHead}>
                      {t('cache_usage.col_composition')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map(({ credential, sessionCount, activeSessionCount }) => (
                    <TableRow key={credential.authId}>
                      <TableCell>
                        <div className={styles.accountName}>{pill(credential.authId)}</div>
                        {credential.planType && (
                          <div className={styles.muted}>{credential.planType}</div>
                        )}
                      </TableCell>
                      <TableCell alignRight>
                        <HitMeter ratio={credential.totals.hitRatio} />
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {credential.totals.requests.toLocaleString()}
                      </TableCell>
                      <TableCell
                        alignRight
                        className={styles.num}
                        title={costHint(credential.totals)}
                      >
                        {costText(credential.totals)}
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {t('cache_usage.threads_active', {
                          active: activeSessionCount,
                          total: sessionCount,
                        })}
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {formatCompactNumber(credential.totals.inputTokens)}
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {formatCompactNumber(credential.totals.cacheWriteTokens)}
                      </TableCell>
                      <TableCell className={styles.compositionCell}>
                        <CompositionBar totals={credential.totals} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          {(report?.models.length ?? 0) > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('cache_usage.models')}</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('cache_usage.col_model')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_hit')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_requests')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_cost')}</TableHead>
                    <TableHead alignRight>{t('cache_usage.col_saved')}</TableHead>
                    <TableHead className={styles.compositionHead}>
                      {t('cache_usage.col_composition')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report?.models.map((model) => (
                    <TableRow key={`${model.provider}:${model.model}`}>
                      <TableCell>
                        {model.model ? (
                          <span className={styles.modelName}>{model.model}</span>
                        ) : (
                          <span className={styles.muted}>{t('cache_usage.model_unrecorded')}</span>
                        )}
                        {sharedModels.has(model.model) && (
                          <div className={styles.modelLine}>{model.provider}</div>
                        )}
                      </TableCell>
                      <TableCell alignRight>
                        <HitMeter ratio={model.totals.hitRatio} />
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {model.totals.requests.toLocaleString()}
                      </TableCell>
                      <TableCell alignRight className={styles.num} title={costHint(model.totals)}>
                        {costText(model.totals)}
                      </TableCell>
                      <TableCell alignRight className={styles.num}>
                        {isUnpriced(model.totals)
                          ? '—'
                          : formatUsd(cacheSavings(model.totals).savedUsd)}
                      </TableCell>
                      <TableCell className={styles.compositionCell}>
                        <CompositionBar totals={model.totals} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <div>
                <h2 className={styles.sectionTitle}>{t('cache_usage.threads')}</h2>
                <p className={styles.sectionHint}>{t('cache_usage.threads_hint')}</p>
              </div>
              <div className={styles.filters}>
                <SegmentedControl
                  ariaLabel={t('cache_usage.sort_label')}
                  options={THREAD_SORTS.map((value) => ({
                    value,
                    label: t(`cache_usage.sort_${value}`),
                  }))}
                  value={threadSort}
                  onChange={(value) => {
                    setThreadSort(value as ThreadSort);
                    setVisibleCount(THREAD_PAGE_SIZE);
                  }}
                />
                <div className={styles.accountFilter}>
                  <Select
                    size="sm"
                    value={authFilter}
                    options={accountOptions}
                    ariaLabel={t('cache_usage.filter_account')}
                    onChange={(value) => {
                      setAuthFilter(value);
                      setVisibleCount(THREAD_PAGE_SIZE);
                    }}
                  />
                </div>
                <label className={styles.search}>
                  <IconSearch size={14} className={styles.searchIcon} aria-hidden="true" />
                  <input
                    className={styles.searchInput}
                    value={query}
                    placeholder={t('cache_usage.search_placeholder')}
                    aria-label={t('cache_usage.search_placeholder')}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setVisibleCount(THREAD_PAGE_SIZE);
                    }}
                  />
                </label>
              </div>
            </div>
            {shownThreads.length === 0 ? (
              <EmptyState title={t('cache_usage.no_threads')} />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('cache_usage.col_thread')}</TableHead>
                      <TableHead>{t('cache_usage.col_account_model')}</TableHead>
                      <TableHead alignRight>{t('cache_usage.col_requests')}</TableHead>
                      <TableHead alignRight>{t('cache_usage.col_hit')}</TableHead>
                      <TableHead alignRight title={t('cache_usage.col_last_hit_hint')}>
                        {t('cache_usage.col_last_hit')}
                      </TableHead>
                      <TableHead alignRight>{t('cache_usage.col_cost')}</TableHead>
                      <TableHead alignRight>{t('cache_usage.col_last_active')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shownThreads.slice(0, visibleCount).map((thread) => (
                      <Fragment key={thread.session.sessionId}>
                        {renderSessionRow(thread.session, thread)}
                        {thread.subagents.map((session) => renderSessionRow(session, null))}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
                {shownThreads.length > visibleCount && (
                  <div className={styles.more}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setVisibleCount((count) => count + THREAD_PAGE_SIZE)}
                    >
                      {t('cache_usage.show_more', {
                        count: shownThreads.length - visibleCount,
                      })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
