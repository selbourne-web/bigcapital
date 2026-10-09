import { CsvParserRegistry } from './CsvParserRegistry';
import { CsvParser } from './csv.types';

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
