/**
 * Auth file sheet fields for routing order (the credential priority) and plan size (the quota
 * weight), as preset segments instead of free-text numbers.
 */

import { useTranslation } from 'react-i18next';
import { NumberStepper } from '@/components/ui/NumberStepper';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
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

// plan size is the quota weight that pooled quota views count an account by, in units of a Claude
// Pro plan (the default of 1); Max 20x gets 10 rather than 20 because its weekly limit is only
// about twice a Max 5x's
const CLAUDE_PLAN_PRESETS: SegmentedOption[] = [
  { value: '', label: 'Pro' },
  { value: '5', label: 'Max 5x' },
  { value: '10', label: 'Max 20x' },
];
const QUOTA_WEIGHT_PRESETS: SegmentedOption[] = [
  { value: '', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

// a stored value that matches no preset keeps its own segment, so opening the sheet never changes it
const withCustomOption = (
  options: SegmentedOption[],
  value: string,
  customLabel: (value: string) => string
): SegmentedOption[] =>
  options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: customLabel(value) }];

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

/** Plan size presets: Claude plans in Pro units, other providers as plain multiples */
export function PlanSizeField({ editor, disabled, onChange }: FieldProps) {
  const { t } = useTranslation();
  // 1 is the stored default, which the presets show as their empty value
  const text = editor.quotaWeight?.trim() ?? '';
  const planSize = text === '1' ? '' : text;

  return (
    <div className="form-group">
      <label>{t('auth_files.quota_weight_label')}</label>
      <SegmentedControl
        ariaLabel={t('auth_files.quota_weight_label')}
        options={withCustomOption(
          editor.providerKey === 'claude' ? CLAUDE_PLAN_PRESETS : QUOTA_WEIGHT_PRESETS,
          planSize,
          (value) => t('auth_files.option_custom', { value: `${value}×` })
        )}
        value={planSize}
        disabled={disabled}
        onChange={(value) => onChange('quotaWeight', value)}
      />
      <div className="hint">{t('auth_files.quota_weight_hint')}</div>
    </div>
  );
}
