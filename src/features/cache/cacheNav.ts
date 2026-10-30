import { createElement } from 'react';
import { IconSidebarCache } from '@/components/ui/forkIcons';

/** Sidebar entry for the Usage & Cost page, listed after Quotas in the observe group */
export const cacheNavItem = {
  path: '/cache',
  labelKey: 'nav.cache_usage',
  metaKey: 'nav_meta.cache_usage',
  icon: createElement(IconSidebarCache, { size: 18 }),
};
