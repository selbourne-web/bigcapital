import React from 'react';
import intl from 'react-intl-universal';
import styles from './InvoiceFormHeader.module.scss';
import { InvoiceFormHeaderFields } from './InvoiceFormHeaderFields';
import { useInvoiceTotalFormatted } from './utils';

/**
 * Invoice form header section: the document title with the balance due, and a
 * shaded panel holding the customer and the invoice details.
 */
export function InvoiceFormHeader() {
  return (
    <div className={styles.root}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>{intl.get('invoice')}</h2>
        <InvoiceFormBalanceDue />
      </div>
      <div className={styles.panel}>
        <InvoiceFormHeaderFields />
      </div>
    </div>
  );
}

/**
 * Balance due of the invoice, from the entries.
 * @returns {React.ReactNode}
 */
function InvoiceFormBalanceDue() {
  const totalFormatted = useInvoiceTotalFormatted();

  return (
    <div className={styles.balance} aria-live="polite">
      <span className={styles.balanceLabel}>{intl.get('due_amount')}</span>
      <span className={styles.balanceAmount}>{totalFormatted}</span>
    </div>
  );
}
