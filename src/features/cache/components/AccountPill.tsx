import styles from './AccountPill.module.scss';

/** Account email in a pill tinted with the account's color slot (0 is neutral). */
export function AccountPill({ label, slot }: { label: string; slot: number }) {
  return (
    <span className={`${styles.pill} ${styles[`slot${slot}`] ?? ''}`}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
