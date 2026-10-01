import { computeExpenseTax } from '@bigcapital/utils';
import { Button, Icon, Intent, Spinner } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React, { useEffect, useRef, useState } from 'react';
import { useExpenseFormContext } from './ExpenseFormPageProvider';
import styles from './ExpenseReceiptAutofill.module.scss';
import { useAttachMarkedUpCopy } from './ExpenseReceiptPreview';
import type { ExpenseFormValues } from './types';
import type {
  AutofillError,
  ReceiptAutofillResult,
} from '@/hooks/query/expense-autofill';
import { AppToaster } from '@/components';
import { ReceiptViewer } from '@/components/Attachments/ReceiptViewer/ReceiptViewer';
import { useUploadAttachments } from '@/hooks/query/attachments';
import { useExpenseAutofill } from '@/hooks/query/expense-autofill';
import { TaxType } from '@/interfaces/TaxRates';

const ACCEPTED_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
const MAX_BYTES = 10 * 1024 * 1024;

type Account = Record<string, any>;

/**
 * Only expense accounts are offered for a line, as {id, name}. The list comes
 * from the form's accounts, which may use camelCase or snake_case keys.
 */
export const toExpenseAccountOptions = (
  accounts: Account[] | undefined,
): Array<{ id: number; name: string }> =>
  (accounts ?? [])
    .filter((account) => {
      const rootType = account.accountRootType ?? account.account_root_type;
      const type = account.accountType ?? account.account_type;
      return (
        rootType === 'expense' ||
        ['expense', 'other-expense', 'cost-of-goods-sold'].includes(type)
      );
    })
    .map((account) => ({ id: Number(account.id), name: String(account.name) }));

/**
 * The form values a receipt fills in. Lines become category lines; anything the
 * receipt did not show is left as it was.
 * @returns The changes to apply and the notes to show the person.
 */
export const receiptToFormValues = (
  result: ReceiptAutofillResult,
  currencies: Account[] | undefined,
  current: Pick<ExpenseFormValues, 'currencyCode'>,
  vendors: Account[] = [],
  taxRates: Account[] = [],
): { values: Partial<ExpenseFormValues>; notes: string[] } => {
  const values: Partial<ExpenseFormValues> = {};
  const notes = [...result.warnings];

  if (result.date) values.paymentDate = result.date;
  if (result.referenceNo) values.referenceNo = result.referenceNo;

  const description = [result.payee, result.memo].filter(Boolean).join(' — ');
  if (description) values.description = description;
  if (result.payee) {
    values.beneficiary = result.payee;

    // Pick the vendor only when the name matches one exactly (ignoring case and
    // spacing); a near match could book the expense to the wrong vendor.
    const normalize = (name: string) =>
      name.toLowerCase().replace(/\s+/g, ' ').trim();
    const payee = normalize(result.payee);
    const matches = vendors.filter(
      (vendor) => normalize(String(vendor.displayName ?? '')) === payee,
    );
    if (matches.length === 1) {
      values.payeeId = matches[0].id;
    } else {
      notes.push(
        `No vendor named "${result.payee}" was found. Choose or create the vendor.`,
      );
    }
  }

  if (result.currencyCode && result.currencyCode !== current.currencyCode) {
    const available = (currencies ?? []).some(
      (currency) =>
        (currency.currencyCode ?? currency.currency_code) ===
        result.currencyCode,
    );
    if (available) {
      values.currencyCode = result.currencyCode;
    } else {
      notes.push(
        `The receipt is in ${result.currencyCode}, which is not set up as a currency here, so the currency was left as it is.`,
      );
    }
  }
  if (result.lines.length) {
    // Put the receipt's tax on the lines as a tax rate, when one of the
    // organisation's rates reproduces the printed tax; otherwise keep it as
    // its own line so the expense still adds up to the receipt.
    const itemLines = result.lines.filter((line) => !line.isTax);
    const taxRate = matchReceiptTaxRate(
      itemLines.map((line) => line.amount),
      result.taxTotal,
      result.amountsIncludeTax,
      taxRates,
    );
    const lines = taxRate ? itemLines : result.lines;

    if (taxRate) {
      values.inclusiveExclusiveTax = result.amountsIncludeTax
        ? TaxType.Inclusive
        : TaxType.Exclusive;
    } else if (result.taxTotal) {
      notes.push(
        `The receipt shows ${result.taxTotal.toFixed(2)} tax, but none of your tax rates matches it, so it was added as its own line. Set up the rate under Tax Rates to have it worked out on the lines.`,
      );
    }
    values.categories = lines.map((line, index) => ({
      index: index + 1,
      amount: line.amount,
      expenseAccountId: line.accountId ?? '',
      description: line.description,
      landedCost: 0,
      isTax: line.isTax ? 1 : 0,
      taxRateId: taxRate ? taxRate.id : '',
    }));
    if (lines.some((line) => line.accountId == null)) {
      notes.push('Choose an account for the lines that have none.');
    }
  }
  return { values, notes };
};

/**
 * The tax rate whose tax on these amounts comes to the printed tax (within a
 * cent either way of rounding), or null when none or more than one does.
 */
export const matchReceiptTaxRate = (
  amounts: number[],
  taxTotal: number | null,
  amountsIncludeTax: boolean,
  taxRates: Account[],
): Account | null => {
  if (!taxTotal || taxTotal <= 0 || !amounts.length) return null;

  const matches = taxRates.filter((rate) => {
    if (!(Number(rate.rate) > 0) || rate.active === false) return false;
    const { taxTotal: worked } = computeExpenseTax(
      amounts.map((amount) => ({
        amount,
        taxRateId: Number(rate.id),
        taxRate: Number(rate.rate),
      })),
      amountsIncludeTax,
    );
    return Math.abs(worked - taxTotal) <= 0.01;
  });
  return matches.length === 1 ? matches[0] : null;
};

interface ExpenseReceiptAutofillProps {
  accounts: Account[] | undefined;
  currencies: Account[] | undefined;
  vendors?: Account[];
}

/**
 * Panel beside the expense form: drop or choose a receipt or bill and the form
 * is filled in from it, ready to review. The receipt is also attached to the
 * expense. Nothing is saved until the person saves the expense.
 */
export function ExpenseReceiptAutofill({
  accounts,
  currencies,
  vendors,
}: ExpenseReceiptAutofillProps) {
  const { values, setFieldValue } = useFormikContext<ExpenseFormValues>();
  const { taxRates } = useExpenseFormContext();
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [filled, setFilled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attachCopy = useAttachMarkedUpCopy();

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const autofill = useExpenseAutofill();
  const { mutateAsync: uploadAttachment } = useUploadAttachments();

  // Release the preview's object url when it is replaced or the panel goes.
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const attachReceipt = async (receipt: File) => {
    const form = new FormData();
    form.append('file', receipt);
    form.append('internalKey', Date.now().toString());
    try {
      const uploaded = await uploadAttachment(form);
      setFieldValue('attachments', [
        ...(valuesRef.current.attachments ?? []),
        {
          key: uploaded.key,
          originName: receipt.name,
          size: receipt.size,
          mimeType: receipt.type,
        },
      ]);
    } catch {
      // The form is still filled in; only the attachment is missing.
      setNotes((previous) => [
        ...previous,
        'The receipt could not be attached to the expense. You can attach it below.',
      ]);
    }
  };

  const read = (receipt: File) => {
    setError(null);
    setNotes([]);
    setFilled(null);

    autofill.mutate(
      { file: receipt, accounts: toExpenseAccountOptions(accounts) },
      {
        onSuccess: (result) => {
          const { values: changes, notes: resultNotes } = receiptToFormValues(
            result,
            currencies,
            valuesRef.current,
            vendors,
            taxRates,
          );
          Object.entries(changes).forEach(([field, value]) =>
            setFieldValue(field, value),
          );
          setNotes(resultNotes);
          setFilled(
            [
              result.payee,
              result.lines.length
                ? `${result.lines.length} line${result.lines.length === 1 ? '' : 's'}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Nothing could be read',
          );
          attachReceipt(receipt);
        },
        onError: (failure: AutofillError) => {
          setError(failure.message);
          AppToaster.show({ message: failure.message, intent: Intent.DANGER });
        },
      },
    );
  };

  const choose = (chosen: File | undefined | null) => {
    if (!chosen) return;

    if (!ACCEPTED_TYPES.includes(chosen.type)) {
      setError(
        'Use a PDF, PNG or JPEG. Photos in HEIC format need to be saved as JPEG first.',
      );
      return;
    }
    if (chosen.size > MAX_BYTES) {
      setError('This file is too large. Use a file under 10 MB.');
      return;
    }
    setFile(chosen);
    setPreviewUrl(URL.createObjectURL(chosen));
    read(chosen);
  };

  const clear = () => {
    setFile(null);
    setPreviewUrl(null);
    setNotes([]);
    setFilled(null);
    setError(null);
    autofill.reset();
  };

  if (!open) {
    return (
      <aside className={`${styles.panel} ${styles.panelCollapsed}`}>
        <Button
          minimal
          icon="chevron-right"
          title="Open receipt autofill"
          aria-label="Open receipt autofill"
          onClick={() => setOpen(true)}
        />
      </aside>
    );
  }

  const isReading = autofill.isPending;

  return (
    <aside className={styles.panel} aria-label="Autofill from a receipt">
      <div className={styles.header}>
        <h2 className={styles.title}>
          <Icon icon="lightbulb" /> Autofill from a receipt
        </h2>
        <Button
          minimal
          icon="chevron-left"
          title="Close receipt autofill"
          aria-label="Close receipt autofill"
          onClick={() => setOpen(false)}
        />
      </div>

      <div className={styles.body}>
        {!file && (
          <div
            className={`${styles.dropzone} ${dragging ? styles.dragging : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              choose(event.dataTransfer.files?.[0]);
            }}
          >
            <span>
              Drop a receipt or bill here, or choose one, and the form fills
              itself in.
            </span>
            <span>Supported formats: PDF, PNG, JPEG.</span>
            <div className={styles.actions}>
              <Button
                icon="upload"
                onClick={() => fileInput.current?.click()}
                text="Select file"
              />
              <Button
                icon="camera"
                onClick={() => cameraInput.current?.click()}
                text="Snap photo"
              />
            </div>
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          className={styles.hiddenInput}
          data-testid="receipt-file-input"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          className={styles.hiddenInput}
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        {file && previewUrl && (
          <ReceiptViewer
            name={file.name}
            url={previewUrl}
            kind={file.type === 'application/pdf' ? 'pdf' : 'image'}
            onClose={clear}
            onSaveCopy={attachCopy}
          />
        )}

        {isReading && (
          <div className={styles.status} role="status">
            <Spinner size={18} /> Reading the receipt…
          </div>
        )}
        {filled && !isReading && (
          <div className={styles.status} role="status">
            <Icon icon="tick-circle" intent={Intent.SUCCESS} /> Filled in:{' '}
            {filled}
          </div>
        )}
        {error && (
          <div className={styles.status} role="alert">
            <Icon icon="error" intent={Intent.DANGER} /> {error}
          </div>
        )}
        {notes.length > 0 && (
          <ul className={styles.warnings}>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        {file && (
          <div className={styles.actions}>
            <Button
              small
              icon="refresh"
              disabled={isReading}
              onClick={() => read(file)}
              text="Read again"
            />
            <Button small minimal icon="cross" onClick={clear} text="Clear" />
          </div>
        )}

        <p className={styles.note}>
          Review before you save. The receipt is read by Claude (Anthropic) to
          fill in the form, and nothing is saved until you save the expense.
        </p>
      </div>
    </aside>
  );
}
