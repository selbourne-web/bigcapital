import { useMutation } from '@tanstack/react-query';
import { useAuthOrganizationId, useAuthToken } from '../state';

/** What Claude proposed for an uncategorized bank transaction (mapped to camelCase). */
export interface TransactionClassificationResult {
  nature:
    | 'income'
    | 'expense'
    | 'owner_or_related_party'
    | 'transfer'
    | 'uncertain';
  accountId: number | null;
  confidence: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoningSummary: string;
  evidence: string[];
  suggestedTransactionType: 'other_income' | 'other_expense' | null;
}

/** A failure the person can act on; `type` is the server's error type. */
export class ClassificationError extends Error {
  constructor(
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClassificationError';
  }
}

export interface ClassifyBankTransactionRequest {
  uncategorizedTransactionIds: number[];
}

// The api answers in snake_case; the few fields used are mapped by hand.
const toResult = (
  data: Record<string, any>,
): TransactionClassificationResult => ({
  nature: data.nature,
  accountId: data.account_id ?? null,
  confidence: Number(data.confidence),
  risk: data.risk,
  reasoningSummary: data.reasoning_summary ?? '',
  evidence: data.evidence ?? [],
  suggestedTransactionType: data.suggested_transaction_type ?? null,
});

/**
 * Asks the server (which asks the Claude API) to propose a category for an
 * uncategorized bank transaction. Nothing is saved; the bookkeeper reviews
 * the proposal before categorizing.
 */
export function useClassifyBankTransaction() {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();

  return useMutation<
    TransactionClassificationResult,
    ClassificationError,
    ClassifyBankTransactionRequest
  >({
    mutationFn: async ({ uncategorizedTransactionIds }) => {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (organizationId) headers['organization-id'] = String(organizationId);

      let response: Response;
      try {
        response = await fetch('/api/banking-ai/classify', {
          method: 'POST',
          headers,
          body: JSON.stringify({ uncategorizedTransactionIds }),
        });
      } catch {
        throw new ClassificationError(
          'CLASSIFY_FAILED',
          'The request could not be sent. Check your connection and try again.',
        );
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const error = payload?.errors?.[0];
        throw new ClassificationError(
          error?.type ?? 'CLASSIFY_FAILED',
          error?.message ??
            'AI categorization is not available right now. Please categorize it by hand.',
        );
      }
      const payload = await response.json();
      return toResult(payload.data);
    },
  });
}
