import { useTranslation } from 'react-i18next';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import styles from './QuotaEmailToggle.module.scss';

export type QuotaEmailToggleProps = {
  showEmails: boolean;
  onShowEmailsChange: (show: boolean) => void;
};

/** Header toggle that labels accounts by email instead of by auth file name */
export function QuotaEmailToggle({ showEmails, onShowEmailsChange }: QuotaEmailToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={showEmails}
      onClick={() => onShowEmailsChange(!showEmails)}
    >
      {showEmails ? (
        <IconEyeOff size={14} aria-hidden="true" />
      ) : (
        <IconEye size={14} aria-hidden="true" />
      )}
      {showEmails ? t('quota_management.hide_emails') : t('quota_management.show_emails')}
    </button>
  );
}
