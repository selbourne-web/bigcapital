import { Button, Callout, Icon, Intent, Tag } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React, { useState } from 'react';
import styled from 'styled-components';
import { useCategorizeTransactionBoot } from './CategorizeTransactionBoot';
import type { CategorizeTransactionFormValues } from './_utils';
import type {
  ClassificationError,
  TransactionClassificationResult,
} from '@/hooks/query/banking-ai';
import { useCategorizeTransactionTabsBoot } from '@/containers/CashFlow/CategorizeTransactionAside/CategorizeTransactionTabsBoot';
import { useClassifyBankTransaction } from '@/hooks/query/banking-ai';

const RISK_INTENT: Record<TransactionClassificationResult['risk'], Intent> = {
  LOW: Intent.SUCCESS,
  MEDIUM: Intent.WARNING,
  HIGH: Intent.DANGER,
};

const NEEDS_REVIEW_MESSAGE: Record<string, string> = {
  owner_or_related_party:
    'This looks like it may be a personal, owner or related-party transaction. Please review it and choose Owner Contribution or Owner Drawings yourself rather than accepting an automatic category.',
  transfer:
    'This looks like a transfer between your own accounts. Please use the Transfer option and pick the destination account yourself.',
  uncertain:
    "AI couldn't determine a confident category for this transaction. Please categorize it by hand.",
};

/**
 * Lets the bookkeeper ask Claude to propose a category for the transaction
 * being categorized. The proposal is never applied automatically - it is
 * only filled into the form when the person clicks Apply, and it still goes
 * through the normal categorize submit and review.
 */
export function CategorizeTransactionAISuggest() {
  const { accounts } = useCategorizeTransactionBoot();
  const { uncategorizedTransactionIds } = useCategorizeTransactionTabsBoot();
  const { setFieldValue } = useFormikContext<CategorizeTransactionFormValues>();

  const [applied, setApplied] = useState(false);
  const classify = useClassifyBankTransaction();

  const ask = () => {
    setApplied(false);
    classify.mutate({
      uncategorizedTransactionIds: uncategorizedTransactionIds ?? [],
    });
  };

  const apply = (result: TransactionClassificationResult) => {
    if (result.suggestedTransactionType) {
      setFieldValue('transactionType', result.suggestedTransactionType);
    }
    if (result.accountId != null) {
      setFieldValue('creditAccountId', String(result.accountId));
    }
    setApplied(true);
  };

  const result = classify.data;
  const accountName = (accountId: number | null) =>
    accountId != null
      ? ((accounts ?? []) as Array<{ id: number; name: string }>).find(
          (account) => Number(account.id) === accountId,
        )?.name
      : undefined;

  return (
    <Wrapper>
      <Button
        small
        minimal
        icon={<Icon icon="lightbulb" />}
        loading={classify.isPending}
        onClick={ask}
        text="Ask AI to suggest a category"
      />

      {result && !classify.isPending && (
        <Callout
          intent={
            result.accountId != null ? RISK_INTENT[result.risk] : Intent.PRIMARY
          }
          icon={null}
        >
          {result.accountId != null ? (
            <>
              <div>
                Proposed:{' '}
                <strong>
                  {accountName(result.accountId) ??
                    `Account #${result.accountId}`}
                </strong>{' '}
                <Tag minimal intent={RISK_INTENT[result.risk]}>
                  {Math.round(result.confidence * 100)}% confidence ·{' '}
                  {result.risk} risk
                </Tag>
              </div>
              <p>{result.reasoningSummary}</p>
              {result.evidence.length > 0 && (
                <ul>
                  {result.evidence.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              )}
              {applied ? (
                <Tag minimal intent={Intent.SUCCESS} icon="tick">
                  Applied — review before saving
                </Tag>
              ) : (
                <Button
                  small
                  intent={Intent.PRIMARY}
                  onClick={() => apply(result)}
                  text="Apply"
                />
              )}
            </>
          ) : (
            <p>
              {NEEDS_REVIEW_MESSAGE[result.nature] ??
                NEEDS_REVIEW_MESSAGE.uncertain}
            </p>
          )}
        </Callout>
      )}

      {classify.isError && (
        <Callout intent={Intent.DANGER} icon={<Icon icon="error" />}>
          {(classify.error as ClassificationError)?.message}
        </Callout>
      )}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  margin-bottom: 18px;

  .bp4-callout {
    margin-top: 8px;
  }
  .bp4-callout p {
    margin: 6px 0;
  }
  .bp4-callout ul {
    margin: 6px 0;
    padding-left: 18px;
    font-size: 12px;
  }
`;
