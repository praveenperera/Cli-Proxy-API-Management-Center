import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { parseRoutingOrder } from '../src/features/config/routingOrder';
import { parseRoutingStrategy } from '../src/hooks/useVisualConfig';
import { runVisualConfig } from './helpers/visualConfig';

describe('ordered routing strategy', () => {
  test('reads the ordered strategy and keeps known criteria once in order', () => {
    expect(parseRoutingStrategy('ordered')).toBe('ordered');
    // unknown criteria, such as ones from a newer backend, survive so saving never drops them
    expect(
      parseRoutingOrder(['Session-Remaining', 'future-criterion', 'priority', 'priority'])
    ).toEqual(['session-remaining', 'future-criterion', 'priority']);
    expect(parseRoutingOrder('priority')).toEqual([]);
  });

  test('writes the ordered strategy with its order and removes an emptied order', () => {
    const yaml = 'routing:\n  strategy: round-robin\n  order: [priority]\n';
    const render = (order: string[]) =>
      parseYaml(
        runVisualConfig(yaml, [
          { routingStrategy: 'ordered', routingOrder: order },
        ]).applyVisualChangesToYaml(yaml)
      );

    expect(render(['weekly-reset', 'session-remaining'])).toEqual({
      routing: { strategy: 'ordered', order: ['weekly-reset', 'session-remaining'] },
    });
    expect(render([])).toEqual({ routing: { strategy: 'ordered' } });
  });

  test('null routing accepts a routing order without losing other edits', () => {
    const nullRouting = 'config-version: 8\nserver: {port: 8317}\nrouting: null\n';
    const config = runVisualConfig(nullRouting, [
      { port: '9000', routingOrder: ['priority', 'weekly-reset'] },
    ]);
    expect(parseYaml(config.applyVisualChangesToYaml(nullRouting))).toEqual({
      'config-version': 8,
      server: { port: 9000 },
      routing: { order: ['priority', 'weekly-reset'] },
    });
  });
});
