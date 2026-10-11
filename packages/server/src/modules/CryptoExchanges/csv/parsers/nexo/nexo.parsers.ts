import { CsvParser } from '../../csv.types';
import { NEXO_FUTURES_PARSER } from './nexoFutures.parser';
import { NEXO_TRANSACTIONS_PARSER } from './nexoTransactions.parser';

export const NEXO_CSV_PARSERS: CsvParser[] = [
  NEXO_TRANSACTIONS_PARSER,
  NEXO_FUTURES_PARSER,
];
