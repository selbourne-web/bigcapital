import { CsvParser } from '../../csv.types';
import { pionexRawTradingParser } from './pionexRawTrading.parser';
import { pionexTradingParser } from './pionexTrading.parser';
import { pionexStakingParser } from './pionexStaking.parser';
import { pionexOthersParser } from './pionexOthers.parser';
import { pionexPositionFuturesParser } from './pionexPositionFutures.parser';
import {
  pionexConvertParser,
  pionexDepositWithdrawParser,
  pionexDustCollectorParser,
  pionexStructuredProductsParser,
} from './pionexHeaderOnly.parsers';
import {
  pionexForCointrackerParser,
  pionexForCointrackingParser,
} from './pionexDerived.parsers';

export const PIONEX_CSV_PARSERS: CsvParser[] = [
  pionexRawTradingParser,
  pionexTradingParser,
  pionexStakingParser,
  pionexOthersParser,
  pionexPositionFuturesParser,
  pionexConvertParser,
  pionexDepositWithdrawParser,
  pionexDustCollectorParser,
  pionexStructuredProductsParser,
  pionexForCointrackerParser,
  pionexForCointrackingParser,
];
