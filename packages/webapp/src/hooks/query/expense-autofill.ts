import { useMutation } from '@tanstack/react-query';
import { useAuthOrganizationId, useAuthToken } from '../state';

/** What the server read from a receipt (mapped to camelCase). */
export interface ReceiptAutofillResult {
  payee: string | null;
  date: string | null;
  referenceNo: string | null;
  currencyCode: string | null;
  memo: string | null;
  lines: Array<{
    description: string;
    amount: number;
    accountId: number | null;
    isTax: boolean;
  }>;
  total: number | null;
  /** Total tax printed on the document, if any. */
  taxTotal: number | null;
  /** Whether the line amounts already include the tax. */
  amountsIncludeTax: boolean;
  warnings: string[];
}

/** A failure the person can act on; `type` is the server's error type. */
export class AutofillError extends Error {
  constructor(
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'AutofillError';
  }
}

export interface AutofillRequest {
  file: File;
  /** Expense accounts a line may be assigned to. */
  accounts: Array<{ id: number; name: string }>;
}

// The api answers in snake_case; the few fields used are mapped by hand.
const toResult = (data: Record<string, any>): ReceiptAutofillResult => ({
  payee: data.payee ?? null,
  date: data.date ?? null,
  referenceNo: data.reference_no ?? null,
  currencyCode: data.currency_code ?? null,
  memo: data.memo ?? null,
  lines: (data.lines ?? []).map((line: Record<string, any>) => ({
    description: line.description ?? '',
    amount: Number(line.amount),
    accountId: line.account_id ?? null,
    isTax: !!line.is_tax,
  })),
  total: data.total ?? null,
  taxTotal: data.tax_total ?? null,
  amountsIncludeTax: !!data.amounts_include_tax,
  warnings: data.warnings ?? [],
});

/**
 * Reads a receipt or bill with the server (which asks the Claude API) and
 * returns values to put into the expense form. Nothing is saved.
 */
export function useExpenseAutofill() {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();

  return useMutation<ReceiptAutofillResult, AutofillError, AutofillRequest>({
    mutationFn: async ({ file, accounts }) => {
      const body = new FormData();
      body.append('file', file);
      body.append('accounts', JSON.stringify(accounts));

      const headers: Record<string, string> = { accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (organizationId) headers['organization-id'] = String(organizationId);

      let response: Response;
      try {
        response = await fetch('/api/expense-autofill', {
          method: 'POST',
          headers,
          body,
        });
      } catch {
        throw new AutofillError(
          'AUTOFILL_FAILED',
          'The receipt could not be sent. Check your connection and try again.',
        );
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const error = payload?.errors?.[0];
        throw new AutofillError(
          error?.type ?? 'AUTOFILL_FAILED',
          error?.message ??
            (response.status === 413
              ? 'This file is too large. Use a file under 10 MB.'
              : 'Receipt reading is not available right now. Please enter the expense by hand.'),
        );
      }
      const payload = await response.json();
      return toResult(payload.data);
    },
  });
}
