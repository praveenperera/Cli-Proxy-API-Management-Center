import styles from './SegmentedControl.module.scss';

/** One choice in a segmented control */
export type SegmentedOption = {
  value: string;
  label: string;
};

export type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** A row of pill buttons for picking one of a few named choices */
export function SegmentedControl({
  options,
  value,
  ariaLabel,
  disabled = false,
  onChange,
}: SegmentedControlProps) {
  return (
    <div className={styles.segmented} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`${styles.segment} ${active ? styles.segmentActive : ''}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
