/**
 * routing.order: the criteria the ordered routing strategy ranks new sessions by.
 */

import type { ConfigFieldSearchEntry } from './searchIndex';

/** Criteria the ordered strategy ranks new sessions by, matching the backend's routing.order */
export const ROUTING_ORDER_CRITERIA = [
  'priority',
  'weekly-reset',
  'session-reset',
  'weekly-remaining',
  'session-remaining',
] as const;
export type RoutingOrderCriterion = (typeof ROUTING_ORDER_CRITERIA)[number];

export function isRoutingOrderCriterion(value: string): value is RoutingOrderCriterion {
  return (ROUTING_ORDER_CRITERIA as readonly string[]).includes(value);
}

/** Reads routing.order, keeping each entry once in its configured order, including unknown ones */
export function parseRoutingOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const order: string[] = [];
  for (const item of raw) {
    const criterion = String(item ?? '')
      .trim()
      .toLowerCase();
    if (criterion && !order.includes(criterion)) order.push(criterion);
  }
  return order;
}

/** Search entry for the routing order editor, placed right after the routing strategy */
export const ROUTING_ORDER_SEARCH_ENTRY: ConfigFieldSearchEntry = {
  fieldId: 'routingOrder',
  sectionId: 'network',
  labelKey: 'config_management.visual.sections.network.routing_order',
  hintKey: 'config_management.visual.sections.network.routing_order_hint',
  yamlKeys: ['routing', 'order'],
  keywords: ['priority', 'weekly-reset', 'session-reset', 'weekly-remaining', 'session-remaining'],
};
