import { z } from 'zod';

/** An account the model may propose for a routine income/expense line. */
export interface ClassificationAccountOption {
  id: number;
  name: string;
  type: 'expense' | 'income';
}

/** Facts about the bank transaction being classified. */
export interface ClassificationTransactionInput {
  date: string;
  amount: number;
  isDeposit: boolean;
  currencyCode: string;
  description: string | null;
  payee: string | null;
}

const nullable = (type: string, description: string) => ({
  anyOf: [{ type }, { type: 'null' }],
  description,
});

/**
 * The JSON schema the model must answer with. Mirrors the accounting-skill's
 * confidence model (HIGH/MEDIUM/LOW -> AUTO_POST/PROPOSE_FOR_REVIEW/REVIEW_REQUIRED)
 * and its rule that owner/related-party and transfer transactions must never be
 * silently classified as ordinary business income or expense.
 */
export const TRANSACTION_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'nature',
    'account_id',
    'confidence',
    'risk',
    'reasoning_summary',
    'evidence',
  ],
  properties: {
    nature: {
      type: 'string',
      enum: [
        'income',
        'expense',
        'owner_or_related_party',
        'transfer',
        'uncertain',
      ],
      description:
        'What kind of transaction this is. Use "owner_or_related_party" for anything that looks like a personal, owner, shareholder, director or related-party movement rather than an ordinary business income/expense - never classify these as ordinary business activity. Use "transfer" when it looks like money moving between the business\'s own accounts. Use "uncertain" when nothing fits confidently.',
    },
    account_id: nullable(
      'integer',
      'The id of the best-fitting account from the provided list. Only set this when "nature" is "income" or "expense" and an account clearly fits; otherwise null.',
    ),
    confidence: {
      type: 'number',
      description: 'How confident this recommendation is, from 0 to 1.',
    },
    risk: {
      type: 'string',
      enum: ['LOW', 'MEDIUM', 'HIGH'],
      description:
        'Risk of accepting this proposal without further human review.',
    },
    reasoning_summary: {
      type: 'string',
      description:
        'One or two plain-language sentences explaining the recommendation.',
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Short bullet points citing what supports the recommendation (description text, amount pattern, etc). Empty array if none.',
    },
  },
} as const;

/** Validates the model's answer; it is untrusted input like any other. */
export const transactionClassificationSchema = z.object({
  nature: z.enum([
    'income',
    'expense',
    'owner_or_related_party',
    'transfer',
    'uncertain',
  ]),
  account_id: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reasoning_summary: z.string(),
  evidence: z.array(z.string()).max(10),
});

export type RawTransactionClassification = z.infer<
  typeof transactionClassificationSchema
>;

/** What the webapp receives. Nothing is posted or saved on the server side. */
export interface TransactionClassificationResult {
  nature: RawTransactionClassification['nature'];
  accountId: number | null;
  confidence: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoningSummary: string;
  evidence: string[];
  /** The categorize-form transaction type this maps to, or null when the
   *  transaction needs a human to pick the right form (owner/transfer/uncertain). */
  suggestedTransactionType: 'other_income' | 'other_expense' | null;
}
