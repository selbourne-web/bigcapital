import { readFileSync } from 'fs';
import { join } from 'path';
import { CsvImportService } from '../../CsvImport.service';
import { CsvParserRegistry } from '../../CsvParserRegistry';
import { readCsv } from '../../CsvReader';
import { CsvRowResult } from '../../csv.types';
import { NEXO_CSV_PARSERS } from './nexo.parsers';
import { NEXO_TRANSACTIONS_HEADERS } from './nexoTransactions.parser';
import {
  NEXO_FUTURES_HEADERS,
  NEXO_FUTURES_PARSER as parser,
  NEXO_FUTURES_TYPES,
  nexoFuturesRecordType,
} from './nexoFutures.parser';

const FILE = readFileSync(join(__dirname, '__fixtures__', 'futures.csv'));
const csv = readCsv(FILE);

const rec = (r: CsvRowResult) => {
  if (r.kind !== 'record') throw new Error(`expected record, got ${r.reason}`);
  return r.record;
};
// Row 0 is an ORDER (MARKET_OPEN, long, PLACED).
const withCells = (over: Record<string, string>): CsvRowResult =>
  parser.parseRow({ ...csv.rows[0].cells, ...over }, { line: 2 });
const rejectReason = (r: CsvRowResult): string => {
  if (r.kind !== 'reject') throw new Error('expected reject');
  return r.reason;
};

describe('Nexo futures CSV parser', () => {
  it('has the contract identity', () => {
    expect(parser).toMatchObject({
      id: 'nexo:futures',
      exchange: 'nexo',
      reportType: 'futures',
      disposition: 'import',
    });
    expect(NEXO_CSV_PARSERS).toContain(parser);
  });

  describe('matches', () => {
    it('matches the header read from the file (leading space trimmed)', () => {
      expect(FILE.toString('utf8').startsWith(' Id,')).toBe(true);
      expect(csv.headers[0]).toBe('Id');
      expect(parser.matches(csv.headers)).toBe(true);
    });
    it('rejects the transactions header and Pionex headers', () => {
      expect(parser.matches([...NEXO_TRANSACTIONS_HEADERS])).toBe(false);
      expect(
        parser.matches(['date(UTC+0)', 'coin', 'amount', 'tag', 'comment']),
      ).toBe(false);
    });
  });

  describe('fixture', () => {
    const results = csv.rows.map((r) =>
      parser.parseRow(r.cells, { line: r.line }),
    );
    it('parses every row to the expected record type', () => {
      expect(csv.rows).toHaveLength(13);
      expect(results.map((r) => rec(r).recordType)).toEqual([
        'trade', // MARKET_OPEN
        'trade', // MARKET_CLOSE PLACED
        'position', // REALIZED_PNL
        'trade', // MARKET_OPEN, mixed-case Short
        'trade', // MARKET_CLOSE LIQUIDATED
        'position',
        'fee', // LIQUIDATION_FEE
        'funding',
        'funding',
        'transfer', // null Symbol, empty ExecutionPriceAsset
        'position', // null Symbol/Position/Price/Side/fee
        'trade', // upper-case LONG
        'unparsed',
      ]);
    });
    it('occurredAt is the exact epoch-ms instant', () => {
      expect(rec(results[0]).occurredAt.toISOString()).toBe(
        '2025-01-01T00:00:00.000Z',
      );
      expect(rec(results[2]).occurredAt.toISOString()).toBe(
        '2025-01-01T01:00:00.001Z',
      );
    });
    it('keeps raw cells (original casing, null literals) in the payload', () => {
      expect(rec(results[3]).payload).toMatchObject({
        Id: '90000004',
        Side: 'Short',
        ExchangeRate: 'null',
        source: 'csv',
      });
    });
  });

  describe('type table', () => {
    it.each(Object.entries(NEXO_FUTURES_TYPES))('%s -> %s', (type, rt) => {
      expect(
        rec(
          withCells({
            Type: type,
            InternalTransactionType: type.startsWith('MARKET')
              ? 'ORDER'
              : 'TRANSACTION',
            Status: type.startsWith('MARKET') ? 'PLACED' : 'null',
          }),
        ).recordType,
      ).toBe(rt);
    });
    it.each(['PLACED', 'LIQUIDATED'])(
      'MARKET_CLOSE with Status %s -> trade',
      (s) => {
        expect(
          rec(withCells({ Type: 'MARKET_CLOSE', Status: s })).recordType,
        ).toBe('trade');
      },
    );
    it('a market order with an unexpected Status is unparsed', () => {
      expect(rec(withCells({ Status: 'CANCELLED' })).recordType).toBe(
        'unparsed',
      );
    });
    it('unknown Type -> unparsed, including inherited property names', () => {
      expect(rec(withCells({ Type: 'SOMETHING_NEW' })).recordType).toBe(
        'unparsed',
      );
      expect(nexoFuturesRecordType('constructor', 'PLACED')).toBe('unparsed');
    });
  });

  describe('null tokens and casing', () => {
    it('accepts null literals in Position, Status, Price, Symbol (non-ORDER)', () => {
      expect(
        rec(
          withCells({
            Type: 'REALIZED_PNL',
            InternalTransactionType: 'TRANSACTION',
            Position: 'null',
            Status: 'null',
            Price: 'null',
            Symbol: 'null',
            TradingFeeAmount: 'null',
            ExchangeRate: 'null',
            SourceAmount: 'null',
          }),
        ).recordType,
      ).toBe('position');
    });
    it('accepts empty ExecutionPriceAsset', () => {
      expect(rec(withCells({ ExecutionPriceAsset: '' }))).toBeDefined();
    });
    it.each(['long', 'LONG', 'Long', 'short', 'SHORT', 'null'])(
      'Side %s',
      (side) => {
        expect(rec(withCells({ Side: side }))).toBeDefined();
      },
    );
    it.each(['OPEN', 'Close', 'null'])('Position %s', (position) => {
      expect(rec(withCells({ Position: position }))).toBeDefined();
    });
  });

  describe('rejects name the column, never the value', () => {
    it.each([
      ['Timestamp', '1767225600', 'Timestamp'],
      ['Timestamp', 'abcdefghijklm', 'Timestamp'],
      ['Id', '', 'Id'],
      ['Price', '1,5', 'Price'],
      ['Amount', '1e5', 'Amount'],
      ['TradingFeeAmount', '0,5', 'TradingFeeAmount'],
      ['ExchangeRate', 'x1', 'ExchangeRate'],
      ['SourceAmount', '$3', 'SourceAmount'],
      ['Side', 'sideways', 'Side'],
      ['Position', 'sideways', 'Position'],
      ['Symbol', 'null', 'Symbol'],
      ['Amount', 'null', 'Amount'],
    ])('%s=%j', (column, value, needle) => {
      const reason = rejectReason(withCells({ [column]: value }));
      expect(reason).toContain(needle);
      if (value && value !== 'null') expect(reason).not.toContain(value);
    });
    it('bad timestamp reason carries no value', () => {
      expect(
        JSON.stringify(withCells({ Timestamp: '1767225600' })),
      ).not.toContain('1767225600');
    });
    it('Symbol/Amount are only required on ORDER rows', () => {
      expect(
        rec(
          withCells({
            InternalTransactionType: 'TRANSACTION',
            Type: 'FUNDING_FEE',
            Symbol: 'null',
            Amount: 'null',
          }),
        ),
      ).toBeDefined();
    });
  });

  it('is exposed with the 18-column signature', () => {
    expect(NEXO_FUTURES_HEADERS).toHaveLength(18);
  });

  it('plans through the service for a nexo connection and refuses other exchanges', () => {
    const svc = new CsvImportService(new CsvParserRegistry(NEXO_CSV_PARSERS));
    const plan = svc.plan('nexo', FILE);
    expect(plan.records).toHaveLength(13);
    expect(plan.rejected).toHaveLength(0);
    expect(() => svc.plan('pionex', FILE)).toThrow(
      expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }),
    );
  });
});
