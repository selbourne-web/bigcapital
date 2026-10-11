import { CryptoRecordType } from '../../../CryptoExchanges.constants';
import { importParser, rawPayload, record, reject, safe } from '../csv.shared';
import { isNexoDecimal, nexoCell, parseEpochMs } from './nexo.csv.shared';

/** The reader trims the leading space of the exported `" Id"` header. */
export const NEXO_FUTURES_HEADERS = [
  'Id',
  'Timestamp',
  'Symbol',
  'Type',
  'Position',
  'Price',
  'Amount',
  'Status',
  'Asset',
  'Side',
  'DealId',
  'InternalTransactionType',
  'TradingFeeAmount',
  'TradingFeeAsset',
  'ExecutionPriceAsset',
  'ExchangeRate',
  'SourceAsset',
  'SourceAmount',
] as const;

/**
 * Single source of truth for the `Type` column (exact match). Provisional:
 * raw records only; piece 3 re-interprets them. `MARKET_OPEN`/`MARKET_CLOSE`
 * are trades only for a recognised `Status` (see MARKET_STATUSES).
 */
export const NEXO_FUTURES_TYPES: Record<string, CryptoRecordType> = {
  MARKET_OPEN: 'trade',
  MARKET_CLOSE: 'trade',
  FUNDING_FEE: 'funding',
  REALIZED_PNL: 'position',
  LIQUIDATION_FEE: 'fee',
  TRANSFER_TO_WALLET: 'transfer',
};

const MARKET_TYPES = ['MARKET_OPEN', 'MARKET_CLOSE'];
const MARKET_STATUSES = ['PLACED', 'LIQUIDATED'];

export function nexoFuturesRecordType(
  type: string,
  status: string,
): CryptoRecordType {
  if (!Object.prototype.hasOwnProperty.call(NEXO_FUTURES_TYPES, type)) {
    return 'unparsed'; // unknown Type: stored and counted, never dropped.
  }
  if (MARKET_TYPES.includes(type) && !MARKET_STATUSES.includes(status)) {
    return 'unparsed';
  }
  return NEXO_FUTURES_TYPES[type];
}

const DECIMAL_COLUMNS = [
  'Price',
  'Amount',
  'TradingFeeAmount',
  'ExchangeRate',
  'SourceAmount',
] as const;

// Reject reasons name the column only; never a cell value.
export const NEXO_FUTURES_PARSER = importParser(
  'nexo',
  'futures',
  NEXO_FUTURES_HEADERS,
  safe((row) => {
    const at = parseEpochMs(row.Timestamp);
    if (!at) return reject('Unrecognised timestamp in column Timestamp');
    if (!row.Id?.trim()) return reject('Missing value in column Id');
    for (const c of DECIMAL_COLUMNS) {
      const v = nexoCell(row[c]);
      if (v !== null && !isNexoDecimal(v)) {
        return reject(`Invalid decimal in column ${c}`);
      }
    }
    // Case is normalised for validation only; the payload keeps raw cells.
    const side = nexoCell(row.Side)?.toLowerCase() ?? null;
    if (side !== null && side !== 'long' && side !== 'short') {
      return reject('Unrecognised value in column Side');
    }
    const position = nexoCell(row.Position)?.toLowerCase() ?? null;
    if (position !== null && position !== 'open' && position !== 'close') {
      return reject('Unrecognised value in column Position');
    }
    if (row.InternalTransactionType === 'ORDER') {
      if (nexoCell(row.Symbol) === null) {
        return reject('Missing value in column Symbol');
      }
      if (nexoCell(row.Amount) === null) {
        return reject('Missing value in column Amount');
      }
    }
    return record(
      nexoFuturesRecordType(row.Type, row.Status),
      at,
      rawPayload(row),
    );
  }),
);
