import { CsvParserRegistry } from './CsvParserRegistry';
import { CsvParser } from './csv.types';
import { NEXO_CSV_PARSERS } from './parsers/nexo/nexo.parsers';
import { NEXO_FUTURES_HEADERS } from './parsers/nexo/nexoFutures.parser';
import { NEXO_TRANSACTIONS_HEADERS } from './parsers/nexo/nexoTransactions.parser';
import { OTHERS_HEADERS } from './parsers/pionex/pionexOthers.parser';
import { PIONEX_CSV_PARSERS } from './parsers/pionex/pionex.parsers';

const mk = (over: Partial<CsvParser>): CsvParser => ({
  id: 'pionex:x',
  exchange: 'pionex',
  reportType: 'x',
  disposition: 'import',
  matches: (h) => h.join(',') === 'a,b',
  parseRow: () => ({ kind: 'reject', reason: 'n/a' }),
  ...over,
});

describe('CsvParserRegistry', () => {
  it('resolves by exact signature', () => {
    const p = mk({});
    expect(new CsvParserRegistry([p]).resolve('pionex', ['a', 'b'])).toBe(p);
  });

  it('rejects headers of another exchange / signature', () => {
    const reg = new CsvParserRegistry([mk({})]);
    expect(() => reg.resolve('nexo', ['a', 'b'])).toThrow(
      expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }),
    );
    const many = Array.from({ length: 30 }, (_, i) => `h${i}`);
    let message = '';
    try {
      reg.resolve('pionex', many);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('h19');
    expect(message).not.toContain('h20');
  });

  it('truncates each echoed header to 100 characters', () => {
    const reg = new CsvParserRegistry([mk({})]);
    const long = 'x'.repeat(5000);
    try {
      reg.resolve('pionex', [long, 'b']);
      throw new Error('expected a throw');
    } catch (e: any) {
      expect(e.code).toBe('CSV_FORMAT_UNRECOGNIZED');
      expect(e.message).toContain('x'.repeat(100) + '...');
      expect(e.message).not.toContain('x'.repeat(101));
      expect(e.message.length).toBeLessThan(400);
    }
  });

  it('refuses derived exports with the refuse reason', () => {
    const reg = new CsvParserRegistry([
      mk({ disposition: 'refuse', refuseReason: 'derived export' }),
    ]);
    expect(() => reg.resolve('pionex', ['a', 'b'])).toThrow(
      expect.objectContaining({
        code: 'CSV_DERIVED_EXPORT_REFUSED',
        message: 'derived export',
      }),
    );
  });
});

describe('CsvParserRegistry with Pionex and Nexo parsers', () => {
  const reg = new CsvParserRegistry([
    ...PIONEX_CSV_PARSERS,
    ...NEXO_CSV_PARSERS,
  ]);

  it('resolves the Nexo transactions header for nexo', () => {
    expect(reg.resolve('nexo', [...NEXO_TRANSACTIONS_HEADERS]).id).toBe(
      'nexo:transactions',
    );
  });
  it('resolves the Nexo futures header for nexo', () => {
    expect(reg.resolve('nexo', [...NEXO_FUTURES_HEADERS]).id).toBe(
      'nexo:futures',
    );
  });
  it('refuses a Nexo file on a pionex connection', () => {
    for (const h of [NEXO_TRANSACTIONS_HEADERS, NEXO_FUTURES_HEADERS]) {
      expect(() => reg.resolve('pionex', [...h])).toThrow(
        expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }),
      );
    }
  });
  it('refuses a Pionex file on the nexo connection', () => {
    expect(() => reg.resolve('nexo', [...OTHERS_HEADERS])).toThrow(
      expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }),
    );
  });
});
