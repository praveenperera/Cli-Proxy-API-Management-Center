import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { isRuntimeOnlyAuthFile, type QuotaProviderType } from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';

/**
 * Providers whose quota loads when a card first shows. The proxy already polls
 * these usage endpoints every minute, so one more read per visit costs little,
 * while other providers keep loading on click
 */
const AUTO_LOAD_QUOTA_TYPES: ReadonlySet<QuotaProviderType> = new Set(['claude', 'codex']);

type QuotaMapUpdater = (
  updater: (prev: Record<string, QuotaCardState>) => Record<string, QuotaCardState>
) => void;

/**
 * Loads a Claude or Codex card's quota once when nothing is cached for it. This is the card's
 * manual refresh (refreshQuotaForFile in AuthFileQuotaSection) without the toasts; keep the two
 * in step, since the upstream callback is left untouched to avoid rebase conflicts
 */
export function useAutoLoadQuota(
  file: AuthFileItem,
  quotaType: QuotaProviderType,
  quota: QuotaCardState | undefined,
  disableControls: boolean,
  resettingQuota: boolean
) {
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[quotaType];
  const updateQuotaState = useQuotaStore(
    (state) => state[adapter.storeSetter] as unknown as QuotaMapUpdater
  );
  // a cleared cache (new session or an edited file) gets a new key, so the card loads again
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const fileGeneration = useQuotaStore((state) => state.fileGenerations[file.name] ?? 0);
  const autoLoadedKey = useRef<string | null>(null);
  const cacheKey = getQuotaCacheKey(file);

  useEffect(() => {
    if (!AUTO_LOAD_QUOTA_TYPES.has(quotaType) || quota !== undefined) return;
    if (disableControls || file.disabled || isRuntimeOnlyAuthFile(file)) return;
    const key = `${sessionGeneration}:${fileGeneration}:${cacheKey}`;
    if (autoLoadedKey.current === key) return;
    autoLoadedKey.current = key;
    if (resettingQuota) return;

    const cacheGeneration = captureQuotaCacheGeneration(file.name);
    updateQuotaState((prev) => ({ ...prev, [cacheKey]: adapter.buildLoadingState() }));
    void (async () => {
      try {
        const data = await adapter.fetchQuota(file, t);
        commitIfQuotaCacheCurrent(cacheGeneration, () => {
          updateQuotaState((prev) => ({ ...prev, [cacheKey]: adapter.buildSuccessState(data) }));
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        commitIfQuotaCacheCurrent(cacheGeneration, () => {
          updateQuotaState((prev) => ({
            ...prev,
            [cacheKey]: adapter.buildErrorState(message, status),
          }));
        });
      }
    })();
  }, [
    adapter,
    cacheKey,
    disableControls,
    file,
    fileGeneration,
    quota,
    quotaType,
    resettingQuota,
    sessionGeneration,
    t,
    updateQuotaState,
  ]);
}
