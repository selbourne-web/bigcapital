import {
  DATE_COL,
  dateOrReject,
  firstBadDecimal,
  importParser,
  isReject,
  isSymbolReject,
  rawPayload,
  record,
  reject,
  safe,
  splitSymbol,
} from './pionex.csv.shared';

export const TRADING_HEADERS = [
  DATE_COL,
  'executed_qty',
  'amount',
  'price',
  'side',
  'symbol',
  'fee',
  'fee_coin',
  'market_type',
  'tax_id',
] as const;

export const pionexTradingParser = importParser(
  'trading',
  TRADING_HEADERS,
  safe((row) => {
    const at = dateOrReject(row);
    if (isReject(at)) return at;
    const bad = firstBadDecimal(row, [
      'executed_qty',
      'amount',
      'price',
      'fee',
    ]);
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    const sym = splitSymbol(row.symbol);
    if (isSymbolReject(sym)) return sym;
    return record('trade_summary', at, rawPayload(row, sym));
  }),
);
