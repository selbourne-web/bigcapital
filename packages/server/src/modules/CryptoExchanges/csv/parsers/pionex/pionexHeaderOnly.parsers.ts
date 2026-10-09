import {
  DATE_COL,
  dateOrReject,
  importParser,
  isReject,
  rawPayload,
  record,
  safe,
} from './pionex.csv.shared';
import { CsvParser } from '../../csv.types';

/**
 * Report types seen only as headers (no data rows in the sample exports).
 * Row semantics are unproven, so any data row is kept as `unparsed`.
 */
const unparsedRow: CsvParser['parseRow'] = safe((row) => {
  const at = dateOrReject(row);
  if (isReject(at)) return at;
  return record('unparsed', at, rawPayload(row));
});

export const pionexConvertParser = importParser(
  'convert',
  [DATE_COL, 'sell_coin', 'sell_amount', 'buy_coin', 'buy_amount'],
  unparsedRow,
);
export const pionexDepositWithdrawParser = importParser(
  'deposit-withdraw',
  [DATE_COL, 'tx_type', 'amount', 'coin', 'network', 'txid', 'fee'],
  unparsedRow,
);
export const pionexDustCollectorParser = importParser(
  'dust-collector',
  [DATE_COL, 'amount', 'coin', 'price', 'swap_value'],
  unparsedRow,
);
export const pionexStructuredProductsParser = importParser(
  'structured-products',
  [
    DATE_COL,
    'Received Quantity',
    'Received Currency',
    'Sent Quantity',
    'Sent Currency',
  ],
  unparsedRow,
);
