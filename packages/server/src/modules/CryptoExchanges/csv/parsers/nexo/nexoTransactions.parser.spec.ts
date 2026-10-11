import { readFileSync } from 'fs';
import { join } from 'path';
import { CsvImportService } from '../../CsvImport.service';
import { CsvParserRegistry } from '../../CsvParserRegistry';
import { readCsv } from '../../CsvReader';
import { assignCsvRecordIds } from '../../csvRecordId';
import { CsvRowResult } from '../../csv.types';
import { NEXO_CSV_PARSERS } from './nexo.parsers';
import {
  NEXO_TRANSACTION_TYPES,
  NEXO_TRANSACTIONS_PARSER as parser,
} from './nexoTransactions.parser';

const FILE = readFileSync(join(__dirname, '__fixtures__', 'transactions.csv'));
const csv = readCsv(FILE);
const HEADER_LINE = FILE.toString('utf8').split('\n')[0];

const rec = (r: CsvRowResult) => {
  if (r.kind !== 'record') throw new Error(`expected record, got ${r.reason}`);
  return r.record;
};
const withCells = (over: Record<string, string>): CsvRowResult =>
  parser.parseRow({ ...csv.rows[0].cells, ...over }, { line: 2 });
const rejectReason = (r: CsvRowResult): string => {
  if (r.kind !== 'reject') throw new Error('expected reject');
  return r.reason;
};

describe('Nexo transactions CSV parser', () => {
  it('has the contract identity', () => {
    expect(parser).toMatchObject({
      id: 'nexo:transactions',
      exchange: 'nexo',
      reportType: 'transactions',
      disposition: 'import',
    });
    expect(NEXO_CSV_PARSERS).toContain(parser);
  });

  describe('matches', () => {
    it('matches the exact header', () => {
      expect(parser.matches(csv.headers)).toBe(true);
    });
    it('rejects the Pionex trading header and the futures header', () => {
      expect(
        parser.matches(['date(UTC+0)', 'coin', 'amount', 'tag', 'comment']),
      ).toBe(false);
      expect(
        parser.matches([
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
        ]),
      ).toBe(false);
    });
    it('matches through readCsv with a BOM and a leading space', () => {
      const bom = Buffer.concat([
        Buffer.from('﻿', 'utf8'),
        Buffer.from(HEADER_LINE.replace(/^Transaction/, ' Transaction')),
        FILE.subarray(Buffer.byteLength(HEADER_LINE)),
      ]);
      expect(parser.matches(readCsv(bom).headers)).toBe(true);
    });
  });

  describe('fixture', () => {
    const results = csv.rows.map((r) =>
      parser.parseRow(r.cells, { line: r.line }),
    );
    it('parses every row to the expected record type', () => {
      expect(csv.rows).toHaveLength(16);
      expect(results.map((r) => rec(r).recordType)).toEqual([
        'reward', // Interest +
        'adjustment', // Interest -
        'adjustment', // Interest -
        'adjustment', // Interest 0
        'trade',
        'deposit',
        'deposit',
        'withdrawal',
        'transfer',
        'transfer',
        'credit',
        'credit',
        'reward',
        'transfer',
        'reward',
        'unparsed',
      ]);
    });
    it('occurredAt is the UTC instant of the cell', () => {
      expect(rec(results[0]).occurredAt.toISOString()).toBe(
        '2024-03-05T04:05:06.000Z',
      );
    });
    it('stores every raw cell plus source csv in the payload', () => {
      const p = rec(results[10]).payload;
      expect(p).toMatchObject({
        Transaction: 'NXTtest0000000000000000A11',
        Type: 'Loan Withdrawal',
        source: 'csv',
      });
      expect(p.Details).toContain('Jane Example');
    });
  });

  describe('type table', () => {
    it.each(Object.entries(NEXO_TRANSACTION_TYPES))(
      '%s -> %s',
      (type, recordType) => {
        expect(rec(withCells({ Type: type })).recordType).toBe(recordType);
      },
    );
    it.each([
      ['5', 'reward'],
      ['0.00000001', 'reward'],
      ['-5', 'adjustment'],
      ['0', 'adjustment'],
      ['0.00', 'adjustment'],
    ])('Interest with input %s -> %s', (amount, recordType) => {
      expect(
        rec(withCells({ Type: 'Interest', 'Input Amount': amount })).recordType,
      ).toBe(recordType);
    });
    it('unknown Type -> unparsed (also inherited property names)', () => {
      expect(rec(withCells({ Type: 'Something New' })).recordType).toBe(
        'unparsed',
      );
      expect(rec(withCells({ Type: 'constructor' })).recordType).toBe(
        'unparsed',
      );
    });
  });

  describe('rejects name the column, never the value', () => {
    it.each([
      ['Date / Time (UTC)', '2024-13-45 99:00:00', 'date'],
      ['Input Amount', '1,000', 'Input Amount'],
      ['Output Amount', '1e5', 'Output Amount'],
      ['USD Equivalent', '12.50', 'USD Equivalent'],
      ['Transaction', '', 'Transaction'],
      ['Fee', '0,5', 'Fee'],
    ])('%s=%j', (column, value, needle) => {
      const reason = rejectReason(withCells({ [column]: value }));
      expect(reason).toContain(needle);
      if (value) expect(reason).not.toContain(value);
    });
    it('bad date reason is exactly Unrecognised date.', () => {
      expect(rejectReason(withCells({ 'Date / Time (UTC)': 'x' }))).toBe(
        'Unrecognised date.',
      );
    });
  });

  it('accepts - for Fee, Output Currency and Fee Currency', () => {
    expect(
      rec(withCells({ Fee: '-', 'Output Currency': '-', 'Fee Currency': '-' })),
    ).toBeDefined();
    expect(rec(withCells({ 'Output Amount': '0' }))).toBeDefined();
  });

  describe('Details privacy', () => {
    const nameRow = csv.rows.find((r) => r.cells.Details.includes('Jane'))!;
    it('is in the payload but not in any reject reason', () => {
      expect(
        rec(parser.parseRow(nameRow.cells, { line: 2 })).payload.Details,
      ).toContain('Jane Example');
      for (const col of [
        'Date / Time (UTC)',
        'Input Amount',
        'Output Amount',
        'USD Equivalent',
        'Transaction',
        'Fee',
      ]) {
        const r = parser.parseRow(
          { ...nameRow.cells, [col]: col === 'Transaction' ? '' : '?bad' },
          { line: 2 },
        );
        expect(r.kind).toBe('reject');
        expect(JSON.stringify(r)).not.toContain('Jane');
      }
    });
    it('is not in the preview summary built from the fixture', () => {
      const svc = new CsvImportService(new CsvParserRegistry(NEXO_CSV_PARSERS));
      const bad = FILE.toString('utf8').replace('2024-02-27 10:00:00', 'oops');
      const { records, ...preview } = svc.plan('nexo', Buffer.from(bad));
      expect(preview.rejected).toHaveLength(1);
      expect(records).toHaveLength(15);
      expect(JSON.stringify(preview)).not.toContain('Jane');
    });
  });

  it('gives rows identical except Transaction distinct record ids', () => {
    const a = csv.rows[0].cells;
    const b = { ...a, Transaction: 'NXTtest0000000000000000ZZZ' };
    const ids = assignCsvRecordIds(
      parser.id,
      [a, b].map((cells) => ({
        cells,
        record: rec(parser.parseRow(cells, { line: 2 })),
      })),
      csv.headers,
    ).map((x) => x.exchangeRecordId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => !/:\d+$/.test(i))).toBe(true);
  });
});
