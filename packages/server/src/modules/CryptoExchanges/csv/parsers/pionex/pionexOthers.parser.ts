import {
  DATE_COL,
  dateOrReject,
  firstBadDecimal,
  importParser,
  isReject,
  rawPayload,
  record,
  reject,
  safe,
} from './pionex.csv.shared';

export const OTHERS_HEADERS = [
  DATE_COL,
  'coin',
  'amount',
  'tag',
  'comment',
] as const;

export const pionexOthersParser = importParser(
  'others',
  OTHERS_HEADERS,
  safe((row) => {
    const at = dateOrReject(row);
    if (isReject(at)) return at;
    const bad = firstBadDecimal(row, ['amount'], true);
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    if (!row.coin) return reject('Missing value in column coin');
    return record(
      row.tag === 'FundingFee' ? 'funding' : 'adjustment',
      at,
      rawPayload(row, { normalizedAsset: row.coin }),
    );
  }),
);
