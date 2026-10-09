import {
  DATE_COL,
  dateOrReject,
  firstBadDecimal,
  importParser,
  isPositiveDecimal,
  isReject,
  isSymbolReject,
  rawPayload,
  record,
  reject,
  safe,
  splitSymbol,
} from './pionex.csv.shared';

export const RAW_TRADING_HEADERS = [
  DATE_COL,
  'executed_qty',
  'amount',
  'price',
  'order_type',
  'side',
  'symbol',
  'state',
  'fee',
  'fee_coin',
  'market_type',
  'tax_id',
] as const;

export const pionexRawTradingParser = importParser(
  'raw-trading-details',
  RAW_TRADING_HEADERS,
  safe((row) => {
    const at = dateOrReject(row);
    if (isReject(at)) return at;
    if (row.state !== 'FILLED') {
      return record('unparsed', at, rawPayload(row));
    }
    const badQty = firstBadDecimal(row, ['executed_qty']);
    if (badQty) return reject(`Invalid decimal in column ${badQty}`);
    if (!isPositiveDecimal(row.executed_qty)) {
      return record('unparsed', at, rawPayload(row));
    }
    const bad = firstBadDecimal(row, ['amount', 'price', 'fee']);
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    const sym = splitSymbol(row.symbol);
    if (isSymbolReject(sym)) return sym;
    return record('trade', at, rawPayload(row, sym));
  }),
);
