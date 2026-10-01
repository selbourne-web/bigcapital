import { z } from 'zod';

/** An expense account the reader may pick for a line. */
export interface ExpenseAccountOption {
  id: number;
  name: string;
}

/**
 * The JSON schema the model must answer with. Every field is required so the
 * answer has one fixed shape; what the document does not show is null.
 */
const nullable = (type: string, description: string) => ({
  anyOf: [{ type }, { type: 'null' }],
  description,
});

export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'payee',
    'date',
    'reference_no',
    'currency_code',
    'memo',
    'amounts_include_tax',
    'lines',
    'tax_total',
    'total',
  ],
  properties: {
    payee: nullable('string', 'Name of the merchant or vendor that was paid.'),
    date: nullable(
      'string',
      'Date of the receipt or bill as YYYY-MM-DD (the transaction date, not the due date).',
    ),
    reference_no: nullable(
      'string',
      'Receipt, invoice or reference number printed on the document.',
    ),
    currency_code: nullable(
      'string',
      'ISO 4217 currency code of the amounts (for example BBD or USD), only if the document shows or clearly implies it.',
    ),
    memo: nullable(
      'string',
      'One short sentence on what was bought, only if useful. Not a copy of the document.',
    ),
    amounts_include_tax: {
      type: 'boolean',
      description:
        'True when the line amounts already include tax; false when tax is shown separately on top.',
    },
    lines: {
      type: 'array',
      description: 'One entry per charged line item, in printed order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount', 'account_id'],
        properties: {
          description: { type: 'string' },
          amount: {
            type: 'number',
            description:
              'Amount of the line exactly as printed, as a plain number (no currency symbol). Negative for discounts.',
          },
          account_id: nullable(
            'integer',
            'The id of the best-fitting expense account from the provided list, or null when none fits.',
          ),
        },
      },
    },
    tax_total: nullable(
      'number',
      'Total tax (VAT/sales tax) charged, when the document shows it.',
    ),
    total: nullable('number', 'The grand total of the document.'),
  },
} as const;

/** Validates the model's answer; it is untrusted input like any other. */
export const receiptExtractionSchema = z.object({
  payee: z.string().nullable(),
  date: z.string().nullable(),
  reference_no: z.string().nullable(),
  currency_code: z.string().nullable(),
  memo: z.string().nullable(),
  amounts_include_tax: z.boolean(),
  lines: z
    .array(
      z.object({
        description: z.string(),
        amount: z.number().finite(),
        account_id: z.number().int().nullable(),
      }),
    )
    .max(100),
  tax_total: z.number().finite().nullable(),
  total: z.number().finite().nullable(),
});

export type RawReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

/** What the webapp receives, ready to put into the expense form. */
export interface ReceiptAutofill {
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
  /** Things the person should double-check before saving. */
  warnings: string[];
}
