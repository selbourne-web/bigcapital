import { refuseParser } from './pionex.csv.shared';

export const pionexForCointrackerParser = refuseParser('for-cointracker', [
  'Date',
  'Received Quantity',
  'Received Currency',
  'Sent Quantity',
  'Sent Currency',
  'Fee Amount',
  'Fee Currency',
  'Tag',
]);
export const pionexForCointrackingParser = refuseParser('for-cointracking', [
  'Type',
  'Buy Amount',
  'Buy Currency',
  'Sell Amount',
  'Sell Currency',
  'Fee',
  'Fee Currency',
  'Exchange',
  'Trade-Group',
  'Comment',
  'Date',
  'Tx-ID',
]);
