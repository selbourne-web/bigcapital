import { readFileSync } from 'fs';
import { join } from 'path';
import { CsvParserRegistry } from '../../CsvParserRegistry';
import { readCsv } from '../../CsvReader';
import { assignCsvRecordIds } from '../../csvRecordId';
import { CsvImportError, CsvParser, CsvRowResult } from '../../csv.types';
import { PIONEX_CSV_PARSERS } from './pionex.parsers';

const registry = new CsvParserRegistry(PIONEX_CSV_PARSERS);

const load = (name: string) =>
  readCsv(readFileSync(join(__dirname, '__fixtures__', name)));

const parserFor = (name: string) =>
  registry.resolve('pionex', load(name).headers);

function run(name: string): { parser: CsvParser; results: CsvRowResult[] } {
  const csv = load(name);
  const parser = registry.resolve('pionex', csv.headers);
  return {
    parser,
    results: csv.rows.map((r) => parser.parseRow(r.cells, { line: r.line })),
  };
}

const rec = (r: CsvRowResult) => {
  if (r.kind !== 'record') throw new Error(`expected record, got ${r.reason}`);
  return r.record;
};

/** Parses the first fixture row of `name` with some cells overridden. */
const withCells = (name: string, over: Record<string, string>) =>
  parserFor(name).parseRow(
    { ...load(name).rows[0].cells, ...over },
    { line: 2 },
  );

const expectReject = (r: CsvRowResult, column: string) =>
  expect(r).toEqual({
    kind: 'reject',
    reason: expect.stringContaining(column),
  });

describe('Pionex CSV parsers', () => {
  it.each([
    ['raw-trading-details.csv', 'pionex:raw-trading-details'],
    ['trading.csv', 'pionex:trading'],
    ['staking.csv', 'pionex:staking'],
    ['others.csv', 'pionex:others'],
    ['position_futures.csv', 'pionex:position-futures'],
    ['convert.csv', 'pionex:convert'],
    ['deposit-withdraw.csv', 'pionex:deposit-withdraw'],
    ['dust-collector.csv', 'pionex:dust-collector'],
    ['structured-products.csv', 'pionex:structured-products'],
  ])('resolves %s to %s', (file, id) => {
    expect(run(file).parser.id).toBe(id);
  });

  it.each(['for-cointracker.csv', 'for-cointracking.csv'])(
    'refuses derived export %s',
    (file) => {
      let err: CsvImportError | undefined;
      try {
        registry.resolve('pionex', load(file).headers);
      } catch (e) {
        err = e as CsvImportError;
      }
      expect(err?.code).toBe('CSV_DERIVED_EXPORT_REFUSED');
      expect(err?.message).toBe(
        'Derived export in a third-party format; import the original Pionex reports instead.',
      );
    },
  );

  it('rejects a Nexo-style header set as unrecognized', () => {
    expect(() =>
      registry.resolve('pionex', [
        'Transaction',
        'Type',
        'Input Currency',
        'Input Amount',
        'Output Currency',
        'Output Amount',
        'Date / Time (UTC)',
      ]),
    ).toThrow(expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }));
  });

  describe('header-only reports', () => {
    it('yield zero rows and zero rejects', () => {
      for (const f of [
        'convert.csv',
        'deposit-withdraw.csv',
        'dust-collector.csv',
        'structured-products.csv',
      ]) {
        const csv = load(f);
        expect(csv.rows).toHaveLength(0);
        expect(csv.rejected).toHaveLength(0);
      }
    });

    const headers = [
      'date(UTC+0)',
      'sell_coin',
      'sell_amount',
      'buy_coin',
      'buy_amount',
    ];
    const cells = (date: string) =>
      Object.fromEntries(
        headers.map((h, i) => [h, i === 0 ? date : String(i)]),
      );

    it('turn any data row into unparsed', () => {
      const p = parserFor('convert.csv');
      const r = rec(p.parseRow(cells('2020-02-01 00:00:00'), { line: 2 }));
      expect(r.recordType).toBe('unparsed');
      expect(r.occurredAt).toEqual(new Date('2020-02-01T00:00:00.000Z'));
    });

    it('reject a data row with an invalid date', () => {
      const p = parserFor('convert.csv');
      expectReject(p.parseRow(cells('not a date'), { line: 2 }), 'date(UTC+0)');
    });
  });

  describe('raw-trading-details', () => {
    const { results } = run('raw-trading-details.csv');

    it('maps FILLED spot to trade with all raw cells and normalized pair', () => {
      const r = rec(results[0]);
      expect(r.recordType).toBe('trade');
      expect(r.occurredAt).toEqual(new Date('2020-01-02T03:04:05.000Z'));
      expect(r.payload).toEqual({
        'date(UTC+0)': '2020-01-02 03:04:05',
        executed_qty: '2.5',
        amount: '250.625',
        price: '100.25',
        order_type: 'LIMIT',
        side: 'BUY',
        symbol: 'TEST_USDT',
        state: 'FILLED',
        fee: '0.0025',
        fee_coin: 'TEST',
        market_type: 'Spot',
        tax_id: 's_t1',
        normalizedBase: 'TEST',
        normalizedQuote: 'USDT',
        source: 'csv',
      });
    });

    it('maps CANCELED to unparsed', () => {
      expect(rec(results[1]).recordType).toBe('unparsed');
    });

    it('maps FILLED futures IOC and keeps the PERP symbol verbatim', () => {
      const r = rec(results[2]);
      expect(r.recordType).toBe('trade');
      expect(r.payload).toMatchObject({
        symbol: 'FAKE_USDT_PERP',
        order_type: 'IOC',
        normalizedBase: 'FAKE',
        normalizedQuote: 'USDT',
      });
    });

    it('treats FILLED with zero executed_qty as unparsed', () => {
      expect(
        rec(withCells('raw-trading-details.csv', { executed_qty: '0' }))
          .recordType,
      ).toBe('unparsed');
    });

    it('rejects an invalid date naming the column', () => {
      expectReject(
        withCells('raw-trading-details.csv', {
          'date(UTC+0)': '2020-13-45 99:00:00',
        }),
        'date(UTC+0)',
      );
    });

    it('rejects a non-decimal price naming the column', () => {
      expectReject(
        withCells('raw-trading-details.csv', { price: '1e5' }),
        'price',
      );
    });

    it.each(['executed_qty', 'price', 'fee'])(
      'rejects +1 and -0.5 for %s',
      (col) => {
        expectReject(
          withCells('raw-trading-details.csv', { [col]: '+1' }),
          col,
        );
        expectReject(
          withCells('raw-trading-details.csv', { [col]: '-0.5' }),
          col,
        );
      },
    );

    it.each(['TESTUSDT', '_USDT', 'TEST_', `${'A'.repeat(60)}_USDT`])(
      'rejects bad symbol %s naming the column',
      (symbol) => {
        expectReject(
          withCells('raw-trading-details.csv', { symbol }),
          'symbol',
        );
      },
    );
  });

  describe('strict date format', () => {
    it.each([
      '2020-01-02T03:04:05',
      '2020-01-02 03:04:05.123',
      ' 2020-01-02 03:04:05',
      '2020-01-02 03:04:05 ',
      '2020-02-30 00:00:00',
      '2020-01-02',
    ])('rejects %p', (date) => {
      expectReject(
        withCells('trading.csv', { 'date(UTC+0)': date }),
        'date(UTC+0)',
      );
    });

    it('accepts a leap day as the exact UTC instant', () => {
      const r = rec(
        withCells('trading.csv', { 'date(UTC+0)': '2020-02-29 23:59:59' }),
      );
      expect(r.occurredAt).toEqual(new Date('2020-02-29T23:59:59.000Z'));
    });
  });

  describe('trading', () => {
    it('maps rows to trade_summary', () => {
      const r = rec(run('trading.csv').results[1]);
      expect(r.recordType).toBe('trade_summary');
      expect(r.payload).toMatchObject({
        symbol: 'FAKE_USDT_PERP',
        normalizedBase: 'FAKE',
        normalizedQuote: 'USDT',
        source: 'csv',
      });
    });

    it('rejects a non-decimal fee naming the column', () => {
      expectReject(withCells('trading.csv', { fee: 'abc' }), 'fee');
    });

    it.each(['executed_qty', 'price', 'fee'])(
      'rejects +1 and -0.5 for %s',
      (col) => {
        expectReject(withCells('trading.csv', { [col]: '+1' }), col);
        expectReject(withCells('trading.csv', { [col]: '-0.5' }), col);
      },
    );

    it('rejects a symbol without underscore', () => {
      expectReject(withCells('trading.csv', { symbol: 'TESTUSDT' }), 'symbol');
    });
  });

  describe('staking', () => {
    const { results } = run('staking.csv');

    it('imports two identical Received rows as two reward records', () => {
      expect(rec(results[0]).recordType).toBe('reward');
      expect(rec(results[1]).recordType).toBe('reward');
      expect(rec(results[0]).payload).toMatchObject({
        'Received Quantity': '0.5',
        normalizedAsset: 'TEST',
        source: 'csv',
      });
    });

    it('gives the two identical rows distinct record ids', () => {
      const csv = load('staking.csv');
      const parser = registry.resolve('pionex', csv.headers);
      const rows = csv.rows.map((r) => ({
        cells: r.cells,
        record: rec(parser.parseRow(r.cells, { line: r.line })),
      }));
      const ids = assignCsvRecordIds(parser.id, rows, csv.headers).map(
        (x) => x.exchangeRecordId,
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[1]).toBe(`${ids[0]}:1`);
    });

    it('maps a Sent row to unparsed', () => {
      expect(rec(results[2]).recordType).toBe('unparsed');
    });
  });

  describe('others', () => {
    const { results } = run('others.csv');

    it('maps FundingFee to funding keeping the sign', () => {
      const r = rec(results[0]);
      expect(r.recordType).toBe('funding');
      expect(r.payload.amount).toBe('-0.5');
      expect(rec(results[1]).payload.amount).toBe('0.25');
    });

    it('maps RiskCoverage to adjustment', () => {
      expect(rec(results[2]).recordType).toBe('adjustment');
    });

    it('rejects an invalid amount naming the column', () => {
      expectReject(withCells('others.csv', { amount: 'abc' }), 'amount');
      expectReject(withCells('others.csv', { amount: '+1' }), 'amount');
    });
  });

  describe('position_futures', () => {
    it('maps to position with occurredAt = close_time', () => {
      const r = rec(run('position_futures.csv').results[0]);
      expect(r.recordType).toBe('position');
      expect(r.occurredAt).toEqual(new Date('2020-01-04T06:07:08.000Z'));
      expect(r.payload).toMatchObject({
        symbol: 'FAKE_USDT_PERP',
        pnl: '-2.5',
        funding_fee: '-0.0625',
        normalizedBase: 'FAKE',
        normalizedQuote: 'USDT',
      });
    });

    it('accepts negative pnl, fee and funding_fee', () => {
      const r = withCells('position_futures.csv', {
        pnl: '-0.5',
        fee: '-0.5',
        funding_fee: '-0.5',
      });
      expect(r.kind).toBe('record');
    });

    it('rejects +1 for pnl, fee and funding_fee', () => {
      for (const col of ['pnl', 'fee', 'funding_fee']) {
        expectReject(withCells('position_futures.csv', { [col]: '+1' }), col);
      }
    });

    it('rejects an invalid close_time naming the column', () => {
      expectReject(
        withCells('position_futures.csv', { close_time: 'x' }),
        'close_time',
      );
    });

    it('rejects close_time earlier than open_time', () => {
      expectReject(
        withCells('position_futures.csv', {
          close_time: '2020-01-01 00:00:00',
        }),
        'close_time',
      );
    });

    it('rejects a bad symbol', () => {
      expectReject(
        withCells('position_futures.csv', { symbol: '_X' }),
        'symbol',
      );
    });
  });

  describe('never throws', () => {
    const garbage: unknown[] = [
      {},
      undefined,
      null,
      { 'date(UTC+0)': undefined },
      { 'date(UTC+0)': '2020-01-02 03:04:05', state: 'FILLED' },
      {
        'date(UTC+0)': '2020-01-02 03:04:05',
        state: 'FILLED',
        executed_qty: undefined,
      },
      { open_time: '2020-01-02 03:04:05', close_time: undefined, symbol: 5 },
      { symbol: null, pnl: 1, fee: {} },
    ];

    it.each(PIONEX_CSV_PARSERS.filter((p) => p.disposition === 'import'))(
      '$id returns a result for malformed rows',
      (parser) => {
        for (const g of garbage) {
          expect(() => parser.parseRow(g as never, { line: 2 })).not.toThrow();
          const r = parser.parseRow(g as never, { line: 2 });
          expect(['record', 'reject']).toContain(r.kind);
        }
      },
    );
  });
});
