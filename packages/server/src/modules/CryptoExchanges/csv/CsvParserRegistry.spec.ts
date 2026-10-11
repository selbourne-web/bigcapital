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
