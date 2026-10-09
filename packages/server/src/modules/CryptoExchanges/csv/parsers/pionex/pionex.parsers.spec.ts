import { readFileSync } from 'fs';
import { join } from 'path';
import { CsvParserRegistry } from '../../CsvParserRegistry';
import { readCsv } from '../../CsvReader';
import { CsvImportError, CsvParser, CsvRowResult } from '../../csv.types';
import { PIONEX_CSV_PARSERS } from './pionex.parsers';

const registry = new CsvParserRegistry(PIONEX_CSV_PARSERS);

const load = (name: string) =>
  readCsv(readFileSync(join(__dirname, '__fixtures__', name)));

function run(name: string): {
  parser: CsvParser;
  results: CsvRowResult[];
} {
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

const row = (
  parser: CsvParser,
  headers: string[],
  values: string[],
): CsvRowResult =>
  parser.parseRow(Object.fromEntries(headers.map((h, i) => [h, values[i]])), {
    line: 2,
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

  it('header-only files yield zero rows and zero rejects', () => {
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

  it('header-only parsers turn any data row into unparsed', () => {
    const p = registry.resolve('pionex', load('convert.csv').headers);
    const r = row(
      p,
      ['date(UTC+0)', 'sell_coin', 'sell_amount', 'buy_coin', 'buy_amount'],
      ['2026-02-01 00:00:00', 'A', '1', 'B', '2'],
    );
    expect(rec(r).recordType).toBe('unparsed');
  });

  describe('raw-trading-details', () => {
    const { results } = run('raw-trading-details.csv');

    it('maps FILLED spot to trade with all raw cells and normalized pair', () => {
      const r = rec(results[0]);
      expect(r.recordType).toBe('trade');
      expect(r.occurredAt).toEqual(new Date('2026-01-02T03:39:19.000Z'));
      expect(r.payload).toMatchObject({
        'date(UTC+0)': '2026-01-02 03:39:19',
        executed_qty: '0.13',
        amount: '0.385',
        price: '2.967',
        order_type: 'LIMIT',
        side: 'BUY',
        symbol: 'METH_USDT',
        state: 'FILLED',
        fee: '0.000065',
        fee_coin: 'METH',
        market_type: 'Spot',
        tax_id: 's_1',
        normalizedBase: 'METH',
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
        symbol: 'ZEC_USDT_PERP',
        order_type: 'IOC',
        normalizedBase: 'ZEC',
        normalizedQuote: 'USDT',
      });
    });

    it('treats FILLED with zero executed_qty as unparsed', () => {
      const p = registry.resolve(
        'pionex',
        load('raw-trading-details.csv').headers,
      );
      const cells = {
        ...load('raw-trading-details.csv').rows[0].cells,
        executed_qty: '0',
      };
      expect(rec(p.parseRow(cells, { line: 2 })).recordType).toBe('unparsed');
    });

    it('rejects an invalid date naming the column', () => {
      const p = registry.resolve(
        'pionex',
        load('raw-trading-details.csv').headers,
      );
      const cells = {
        ...load('raw-trading-details.csv').rows[0].cells,
        'date(UTC+0)': '2026-13-45 99:00:00',
      };
      const r = p.parseRow(cells, { line: 2 });
      expect(r).toEqual({
        kind: 'reject',
        reason: expect.stringContaining('date(UTC+0)'),
      });
    });

    it('rejects a non-decimal price naming the column', () => {
      const p = registry.resolve(
        'pionex',
        load('raw-trading-details.csv').headers,
      );
      const cells = {
        ...load('raw-trading-details.csv').rows[0].cells,
        price: '1e5',
      };
      const r = p.parseRow(cells, { line: 2 });
      expect(r).toEqual({
        kind: 'reject',
        reason: expect.stringContaining('price'),
      });
    });

    it('never throws on garbage rows', () => {
      const p = registry.resolve(
        'pionex',
        load('raw-trading-details.csv').headers,
      );
      expect(() => p.parseRow({} as never, { line: 1 })).not.toThrow();
    });
  });

  describe('trading', () => {
    it('maps rows to trade_summary', () => {
      const { results } = run('trading.csv');
      const r = rec(results[1]);
      expect(r.recordType).toBe('trade_summary');
      expect(r.payload).toMatchObject({
        symbol: 'ZEC_USDT_PERP',
        normalizedBase: 'ZEC',
        normalizedQuote: 'USDT',
        source: 'csv',
      });
    });

    it('rejects a non-decimal fee naming the column', () => {
      const { parser } = run('trading.csv');
      const cells = { ...load('trading.csv').rows[0].cells, fee: 'abc' };
      expect(parser.parseRow(cells, { line: 2 })).toEqual({
        kind: 'reject',
        reason: expect.stringContaining('fee'),
      });
    });
  });

  describe('staking', () => {
    const { results } = run('staking.csv');

    it('imports two identical Received rows as two reward records', () => {
      expect(rec(results[0]).recordType).toBe('reward');
      expect(rec(results[1]).recordType).toBe('reward');
      expect(rec(results[0]).payload).toMatchObject({
        'Received Quantity': '0.001',
        normalizedAsset: 'SOL',
        source: 'csv',
      });
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
      expect(r.payload.amount).toBe('-0.0123');
      expect(rec(results[1]).payload.amount).toBe('0.0045');
    });

    it('maps RiskCoverage to adjustment', () => {
      expect(rec(results[2]).recordType).toBe('adjustment');
    });
  });

  describe('position_futures', () => {
    it('maps to position with occurredAt = close_time', () => {
      const r = rec(run('position_futures.csv').results[0]);
      expect(r.recordType).toBe('position');
      expect(r.occurredAt).toEqual(new Date('2026-01-04T06:07:08.000Z'));
      expect(r.payload).toMatchObject({
        symbol: 'ZEC_USDT_PERP',
        pnl: '-1.5',
        funding_fee: '-0.01',
        normalizedBase: 'ZEC',
        normalizedQuote: 'USDT',
      });
    });

    it('rejects an invalid close_time naming the column', () => {
      const { parser } = run('position_futures.csv');
      const cells = {
        ...load('position_futures.csv').rows[0].cells,
        close_time: 'x',
      };
      expect(parser.parseRow(cells, { line: 2 })).toEqual({
        kind: 'reject',
        reason: expect.stringContaining('close_time'),
      });
    });
  });
});
