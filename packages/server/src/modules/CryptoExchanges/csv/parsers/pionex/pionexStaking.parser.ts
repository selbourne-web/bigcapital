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

export const STAKING_HEADERS = [
  DATE_COL,
  'Received Quantity',
  'Received Currency',
  'Sent Quantity',
  'Sent Currency',
  'tag',
] as const;

export const pionexStakingParser = importParser(
  'staking',
  STAKING_HEADERS,
  safe((row) => {
    const at = dateOrReject(row);
    if (isReject(at)) return at;
    if (row['Sent Quantity'] !== '' || row['Received Quantity'] === '') {
      return record('unparsed', at, rawPayload(row));
    }
    const bad = firstBadDecimal(row, ['Received Quantity']);
    if (bad) return reject(`Invalid decimal in column ${bad}`);
    if (!row['Received Currency']) {
      return reject('Missing value in column Received Currency');
    }
    return record(
      'reward',
      at,
      rawPayload(row, { normalizedAsset: row['Received Currency'] }),
    );
  }),
);
