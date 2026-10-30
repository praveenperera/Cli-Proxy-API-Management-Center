import styles from './NumberStepper.module.scss';

export type NumberStepperProps = {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  decrementLabel: string;
  incrementLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

/** A − value + control for picking an exact integer without typing */
export function NumberStepper({
  value,
  min,
  max,
  ariaLabel,
  decrementLabel,
  incrementLabel,
  disabled = false,
  onChange,
}: NumberStepperProps) {
  return (
    <div className={styles.stepper} role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={styles.step}
        aria-label={decrementLabel}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <output className={styles.value} aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className={styles.step}
        aria-label={incrementLabel}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}
