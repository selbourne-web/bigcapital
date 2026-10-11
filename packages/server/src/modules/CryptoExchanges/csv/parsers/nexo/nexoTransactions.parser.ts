import { CryptoRecordType } from '../../../CryptoExchanges.constants';
import { importParser, rawPayload, record, reject, safe } from '../csv.shared';
import {
  isNexoDecimal,
  isNexoUsd,
  nexoCell,
  parseNexoUtc,
} from './nexo.csv.shared';

export const NEXO_TRANSACTIONS_HEADERS = [
  'Transaction',
  'Type',
  'Credit Line',
  'Input Currency',
  'Input Amount',
  'Output Currency',
  'Output Amount',
  'USD Equivalent',
  'Fee',
  'Fee Currency',
  'Details',
  'Date / Time (UTC)',
] as const;

/**
 * Single source of truth for the `Type` column (exact match). `Interest` is
 * not listed: its record type depends on the sign of `Input Amount`.
 * Provisional: raw records only; piece 3 re-interprets them.
 */
export const NEXO_TRANSACTION_TYPES: Record<string, CryptoRecordType> = {
  'Fixed Term Interest': 'reward',
  Dividend: 'reward',
  'Exchange Cashback': 'reward',
  'Earn Adjustment': 'adjustment',
  Exchange: 'trade',
  'Exchange Credit': 'trade',
  'Exchange Booster': 'trade',
  'Exchange Deposited On': 'trade',
  'Deposit To Exchange': 'deposit',
  'Top up Crypto': 'deposit',
  Withdrawal: 'withdrawal',
  // Internal moves between a venue's own wallets (not P&L).
  'Transfer In': 'transfer',
  'Transfer Out': 'transfer',
  'Transfer To Pro Wallet': 'transfer',
  'Transfer From Pro Wallet': 'transfer',
  'Locking Term Deposit': 'transfer',
  'Unlocking Term Deposit': 'transfer',
  'Transfer To Advanced': 'transfer',
  'Transfer To Advanced Trading Bonus': 'transfer',
  'Transfer From Advanced Trading Bonus': 'transfer',
  'Advanced Trading Add Bonus Funds': 'transfer',
  'Advanced Trading Reduce Bonus Funds': 'transfer',
  // Loan / credit-line activity.
  'Loan Withdrawal': 'credit',
  'Manual Repayment': 'credit',
  'Manual Sell Order': 'credit',
  'Exchange Liquidation': 'credit',
  'Deposit Over Repayment': 'credit',
};

/** Interest: positive input is earned (reward); negative or zero is `adjustment`. */
export function interestRecordType(inputAmount: string): CryptoRecordType {
  return /^0*[1-9]|^0*\.0*[1-9]/.test(inputAmount) ? 'reward' : 'adjustment';
}

export function nexoTransactionRecordType(
  type: string,
  inputAmount: string,
): CryptoRecordType {
  if (type === 'Interest') return interestRecordType(inputAmount);
  return Object.prototype.hasOwnProperty.call(NEXO_TRANSACTION_TYPES, type)
    ? NEXO_TRANSACTION_TYPES[type]
    : 'unparsed'; // unknown Type: stored and counted, never dropped.
}

// Reject reasons name the column only; never a cell value (Details may hold a name).
export const NEXO_TRANSACTIONS_PARSER = importParser(
  'nexo',
  'transactions',
  NEXO_TRANSACTIONS_HEADERS,
  safe((row) => {
    const at = parseNexoUtc(row['Date / Time (UTC)']);
    if (!at) return reject('Unrecognised date.');
    if (!row.Transaction?.trim()) {
      return reject('Missing value in column Transaction');
    }
    const bad = ['Input Amount', 'Output Amount'].find(
      (c) => !isNexoDecimal(row[c]),
    );
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    if (!isNexoUsd(row['USD Equivalent'])) {
      return reject('Invalid USD amount in column USD Equivalent');
    }
    const fee = nexoCell(row.Fee);
    if (fee !== null && !isNexoDecimal(fee)) {
      return reject('Invalid decimal in column Fee');
    }
    return record(
      nexoTransactionRecordType(row.Type, row['Input Amount']),
      at,
      rawPayload(row),
    );
  }),
);
