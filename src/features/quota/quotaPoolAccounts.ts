/**
 * Join credentials, their live quota, and recorded history into pool accounts.
 * React-free so the grouping rules are testable on their own.
 */

import type { QuotaHistory } from '@/services/api/quotaHistory';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { normalizeRecentRequestAuthIndex } from '@/utils/recentRequests';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import {
  buildPoolAccount,
  livePoolWindow,
  type LivePoolWindow,
  newerPoolWindow,
  pickHistoryWindow,
  type PoolAccount,
  type PoolSample,
} from './quotaPoolModel';

/**
 * Account label: the filename without its `.json` suffix, or the email when
 * asked and known. Never `account`/`account_type` — those can hold an API key.
 */
export function poolAccountName(file: AuthFileItem, showEmails: boolean): string {
  const email = typeof file.email === 'string' ? file.email.trim() : '';
  if (showEmails && email) return email;
  return file.name.replace(/\.json$/i, '');
}

export interface ProviderPoolAccounts {
  provider: QuotaProviderType;
  /** Credentials in this provider, loaded or not. */
  credentials: number;
  accounts: PoolAccount[];
}

interface RecordedAccount {
  samples: PoolSample[];
  /** Newest recorded window; the current value when newer than live quota or without it. */
  latest: LivePoolWindow | null;
}

/** Recorded samples per auth index, from the window matching the pool window. */
export function historyByAuthIndex(history: QuotaHistory): Map<string, RecordedAccount> {
  const out = new Map<string, RecordedAccount>();
  history.credentials.forEach((credential) => {
    const window = pickHistoryWindow(credential.windows);
    if (!credential.authIndex || !window) return;
    const last = window.points[window.points.length - 1];
    out.set(credential.authIndex, {
      samples: window.points.map((point) => ({ atMs: point.atMs, value: point.remaining })),
      latest: last
        ? {
            remaining: last.remaining,
            resetAtMs: last.resetAtMs,
            periodMs: window.periodMs,
            observedAtMs: last.atMs,
          }
        : null,
    });
  });
  return out;
}

/**
 * Group entries by provider, in entry order. Each account's current value is
 * the fresher of its live quota and its newest recorded window, since the
 * backend keeps polling after the page fetched; without live quota the
 * recorded window stands in. With neither a credential still counts toward
 * `credentials` but contributes no account.
 */
export function collectPoolAccounts(input: {
  entries: readonly QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  history: QuotaHistory;
  showEmails: boolean;
  now: number;
}): ProviderPoolAccounts[] {
  const { entries, quotaFor, showEmails, now } = input;
  const recorded = historyByAuthIndex(input.history);
  const groups = new Map<QuotaProviderType, ProviderPoolAccounts>();

  entries.forEach((entry) => {
    const group = groups.get(entry.type) ?? {
      provider: entry.type,
      credentials: 0,
      accounts: [],
    };
    groups.set(entry.type, group);
    group.credentials += 1;

    const authIndex = normalizeRecentRequestAuthIndex(entry.file.authIndex);
    const record = authIndex ? recorded.get(authIndex) : undefined;
    const live = newerPoolWindow(
      livePoolWindow(entry.type, quotaFor(entry) as { status?: string } | undefined),
      record?.latest ?? null
    );
    if (!live) return;
    group.accounts.push(
      buildPoolAccount({
        id: getQuotaCacheKey(entry.file),
        name: poolAccountName(entry.file, showEmails),
        live,
        history: record?.samples ?? [],
        now,
      })
    );
  });

  return [...groups.values()];
}
