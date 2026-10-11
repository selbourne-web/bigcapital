import { CsvParser } from '../../csv.types';
import { NEXO_TRANSACTIONS_PARSER } from './nexoTransactions.parser';

/** Task 3 appends the futures parser. */
export const NEXO_CSV_PARSERS: CsvParser[] = [NEXO_TRANSACTIONS_PARSER];
