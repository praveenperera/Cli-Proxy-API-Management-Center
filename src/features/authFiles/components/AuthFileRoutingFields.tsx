/**
 * Auth file sheet field for routing order (the credential priority), as preset segments instead
 * of a free-text number.
 */

import { useTranslation } from 'react-i18next';
import { NumberStepper } from '@/components/ui/NumberStepper';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type {
  PrefixProxyEditorField,
  PrefixProxyEditorFieldValue,
  PrefixProxyEditorState,
} from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import styles from './AuthFileRoutingFields.module.scss';

type FieldProps = {
  editor: PrefixProxyEditorState;
  disabled: boolean;
  onChange: (field: PrefixProxyEditorField, value: PrefixProxyEditorFieldValue) => void;
};

// routing order is the credential priority: a higher value is tried first and 0 is the default
const ROUTING_ORDER_PRESETS = [
  { value: '1', labelKey: 'auth_files.routing_first' },
  { value: '', labelKey: 'auth_files.routing_normal' },
  { value: '-1', labelKey: 'auth_files.routing_last' },
] as const;
// the stepper sets any exact order; this range is far more than a handful of accounts needs
const ROUTING_ORDER_LIMIT = 99;

/** Use first / Normal / Use last presets plus a stepper for an exact priority */
export function RoutingOrderField({ editor, disabled, onChange }: FieldProps) {
  const { t } = useTranslation();
  // 0 is the stored default, which the presets show as their empty value
  const text = editor.priority.trim();
  const routingOrder = text === '0' ? '' : text;

  return (
    <div className="form-group">
      <label>{t('auth_files.priority_label')}</label>
      <div className={styles.choiceRow}>
        <SegmentedControl
          ariaLabel={t('auth_files.priority_label')}
          options={ROUTING_ORDER_PRESETS.map((preset) => ({
            value: preset.value,
            label: t(preset.labelKey),
          }))}
          value={routingOrder}
          disabled={disabled}
          onChange={(value) => onChange('priority', value)}
        />
        <NumberStepper
          ariaLabel={t('auth_files.priority_exact')}
          decrementLabel={t('auth_files.priority_decrease')}
          incrementLabel={t('auth_files.priority_increase')}
          value={Number(routingOrder || 0)}
          min={-ROUTING_ORDER_LIMIT}
          max={ROUTING_ORDER_LIMIT}
          disabled={disabled}
          onChange={(value) => onChange('priority', value === 0 ? '' : String(value))}
        />
      </div>
      <div className="hint">{t('auth_files.priority_hint')}</div>
    </div>
  );
}
