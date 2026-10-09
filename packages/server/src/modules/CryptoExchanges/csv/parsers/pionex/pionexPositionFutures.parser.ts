import {
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

export const POSITION_FUTURES_HEADERS = [
  'position_id',
  'symbol',
  'position_side',
  'open_time',
  'close_time',
  'pnl',
  'fee',
  'funding_fee',
] as const;

export const pionexPositionFuturesParser = importParser(
  'position-futures',
  POSITION_FUTURES_HEADERS,
  safe((row) => {
    const opened = dateOrReject(row, 'open_time');
    if (isReject(opened)) return opened;
    const closed = dateOrReject(row, 'close_time');
    if (isReject(closed)) return closed;
    const bad = firstBadDecimal(row, ['pnl', 'fee', 'funding_fee'], true);
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    if (closed.getTime() < opened.getTime()) {
      return reject(
        'close_time is earlier than open_time in column close_time',
      );
    }
    const sym = splitSymbol(row.symbol);
    if (isSymbolReject(sym)) return sym;
    return record('position', closed, rawPayload(row, sym));
  }),
);
