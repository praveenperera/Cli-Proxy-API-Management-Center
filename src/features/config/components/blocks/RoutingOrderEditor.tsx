import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconChevronDown, IconChevronUp, IconPlus, IconX } from '@/components/ui/icons';
import { isRoutingOrderCriterion, ROUTING_ORDER_CRITERIA } from '../../routingOrder';
import { BlockSetting } from '../fields/FieldPrimitives';
import blockStyles from './Blocks.module.scss';
import styles from './RoutingOrderEditor.module.scss';

const criterionKey = (criterion: string) => criterion.replace(/-/g, '_');

/** Ranked list editor for routing.order: reorder, remove, and add unused criteria */
export const RoutingOrderEditor = memo(function RoutingOrderEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const copy = (key: string) => t(`config_management.visual.sections.network.${key}`);
  const unused = ROUTING_ORDER_CRITERIA.filter((criterion) => !value.includes(criterion));

  const move = (index: number, offset: number) => {
    const next = [...value];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };

  return (
    <div className={blockStyles.stringList}>
      {value.length === 0 ? (
        <p className={styles.routingOrderHint}>{copy('routing_order_default')}</p>
      ) : null}
      <ol className={styles.routingOrderList}>
        {value.map((criterion, index) => (
          <li key={criterion} className={styles.routingOrderRow}>
            <span className={styles.routingOrderRank}>{index + 1}</span>
            <span className={styles.routingOrderText}>
              <span className={styles.routingOrderLabel}>
                {isRoutingOrderCriterion(criterion)
                  ? copy(`order_${criterionKey(criterion)}`)
                  : criterion}
              </span>
              <span className={styles.routingOrderHint}>
                {isRoutingOrderCriterion(criterion)
                  ? copy(`order_${criterionKey(criterion)}_hint`)
                  : copy('routing_order_unknown')}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy('routing_order_move_up')}
              title={copy('routing_order_move_up')}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              <IconChevronUp size={16} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy('routing_order_move_down')}
              title={copy('routing_order_move_down')}
              disabled={disabled || index === value.length - 1}
              onClick={() => move(index, 1)}
            >
              <IconChevronDown size={16} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy('routing_order_remove')}
              title={copy('routing_order_remove')}
              disabled={disabled}
              onClick={() => onChange(value.filter((item) => item !== criterion))}
            >
              <IconX size={16} />
            </Button>
          </li>
        ))}
      </ol>
      {unused.length > 0 ? (
        <div className={styles.routingOrderAdd} aria-label={copy('routing_order_add')} role="group">
          {unused.map((criterion) => (
            <Button
              key={criterion}
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onChange([...value, criterion])}
            >
              <IconPlus size={14} /> {copy(`order_${criterionKey(criterion)}`)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The routing order setting row. The section passes fieldId so its JSX still names every field it
 * renders, and wide because SettingList only spans BlockSetting itself, not wrappers, across a row
 */
export function RoutingOrderSetting({
  fieldId,
  value,
  disabled,
  onChange,
}: {
  fieldId: 'routingOrder';
  wide: true;
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <BlockSetting
      fieldId={fieldId}
      label={t('config_management.visual.sections.network.routing_order')}
      description={t('config_management.visual.sections.network.routing_order_hint')}
    >
      <RoutingOrderEditor value={value} disabled={disabled} onChange={onChange} />
    </BlockSetting>
  );
}
