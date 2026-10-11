import { CSV_LIMITS } from '../CryptoExchanges.constants';
import { readCsv } from './CsvReader';

const plain = 'a,b,c\n1,"x,\ny",3\n4,5,6\n';
const bomCrlf = '﻿' + plain.replace(/\n/g, '\r\n');

describe('readCsv', () => {
  it('parses BOM + CRLF + quoted comma/newline equal to the plain file (modulo CRLF inside the cell)', () => {
    const a = readCsv(Buffer.from(plain));
    const b = readCsv(Buffer.from(bomCrlf));
    expect(b.headers).toEqual(['a', 'b', 'c']);
    expect(b.rows.map((r) => r.line)).toEqual(a.rows.map((r) => r.line));
    expect(a.rows[0].cells).toEqual({ a: '1', b: 'x,\ny', c: '3' });
    expect(b.rows[0].cells).toEqual({ a: '1', b: 'x,\r\ny', c: '3' });
    expect(b.rows[1].cells).toEqual(a.rows[1].cells);
    expect(a.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it('trims header cells but not data cells', () => {
    const r = readCsv(Buffer.from(' a , b\n 1 ,=2\n'));
    expect(r.headers).toEqual(['a', 'b']);
    expect(r.rows[0].cells).toEqual({ a: ' 1 ', b: '=2' });
  });

  it('rejects short rows with 1-based physical line numbers', () => {
    const r = readCsv(Buffer.from('a,b\n1,2\n\n3\n"p\nq",4\n5\n'));
    expect(r.rows.map((x) => x.line)).toEqual([2, 5]);
    expect(r.rejected.map((x) => x.line)).toEqual([4, 7]);
  });

  it('handles a last line without trailing newline', () => {
    const r = readCsv(Buffer.from('a,b\n1,2\n3'));
    expect(r.rejected).toEqual([
      { line: 3, reason: expect.stringContaining('columns') },
    ]);
  });

  it('returns header-only files with zero rows', () => {
    const r = readCsv(Buffer.from('a,b\n'));
    expect(r.rows).toEqual([]);
  });

  it('throws CSV_TOO_LARGE above the row cap', () => {
    const body = 'a\n' + '1\n'.repeat(CSV_LIMITS.maxRows + 1);
    expect(() => readCsv(Buffer.from(body))).toThrow(
      expect.objectContaining({ code: 'CSV_TOO_LARGE' }),
    );
    const ok = 'a\n' + '1\n'.repeat(CSV_LIMITS.maxRows);
    expect(readCsv(Buffer.from(ok)).rows).toHaveLength(CSV_LIMITS.maxRows);
  });

  it('throws CSV_TOO_LARGE above the byte cap', () => {
    expect(() => readCsv(Buffer.alloc(CSV_LIMITS.maxBytes + 1, 0x61))).toThrow(
      expect.objectContaining({ code: 'CSV_TOO_LARGE' }),
    );
  });

  it('throws CSV_MALFORMED for an oversized cell', () => {
    const big = 'x'.repeat(CSV_LIMITS.maxCellChars + 1);
    expect(() => readCsv(Buffer.from(`a\n${big}\n`))).toThrow(
      expect.objectContaining({ code: 'CSV_MALFORMED' }),
    );
    const edge = 'x'.repeat(CSV_LIMITS.maxCellChars);
    expect(readCsv(Buffer.from(`a\n${edge}\n`)).rows).toHaveLength(1);
  });

  it('throws CSV_MALFORMED for an unterminated quote, empty file, duplicate headers', () => {
    for (const s of ['a,b\n1,"oops\n2,3\n', '', 'a,a\n1,2\n']) {
      expect(() => readCsv(Buffer.from(s))).toThrow(
        expect.objectContaining({ code: 'CSV_MALFORMED' }),
      );
    }
  });

  it('refuses UTF-16 input and lone-CR line endings, keeps CRLF/LF', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a,b\n1,2\n', 'utf16le'),
    ]);
    expect(() => readCsv(utf16)).toThrow(
      expect.objectContaining({ code: 'CSV_MALFORMED' }),
    );
    expect(() => readCsv(Buffer.from('a,b\r1,2\r'))).toThrow(
      expect.objectContaining({ code: 'CSV_MALFORMED' }),
    );
    expect(readCsv(Buffer.from('a,b\r\n1,2\r\n')).rows[0].line).toBe(2);
    expect(readCsv(Buffer.from('a,b\n1,2\n')).rows[0].line).toBe(2);
  });

  describe('pathological input limits', () => {
    const expectMalformed = (buffer: Buffer) => {
      let error: any;
      try {
        readCsv(buffer);
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'CSV_MALFORMED' });
      return error.message as string;
    };

    it('refuses 10 MB of commas quickly without echoing content', () => {
      const started = Date.now();
      expectMalformed(Buffer.from(','.repeat(10 * 1024 * 1024 - 1) + '\n'));
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('refuses a record larger than the record cap', () => {
      const message = expectMalformed(
        Buffer.from(`a,b\n${'x'.repeat(CSV_LIMITS.maxRecordBytes + 10)},2\n`),
      );
      expect(message).not.toContain('xxxx');
    });

    it('refuses a header, and a data record, with more than the column cap', () => {
      const wide = Array.from(
        { length: CSV_LIMITS.maxColumns + 1 },
        (_, i) => `c${i}`,
      );
      expect(expectMalformed(Buffer.from(wide.join(',') + '\n1\n'))).toContain(
        'columns',
      );
      expectMalformed(Buffer.from(`a,b\n${wide.map(() => 'Z').join(',')}\n`));
    });

    it('accepts exactly the column cap', () => {
      const names = Array.from(
        { length: CSV_LIMITS.maxColumns },
        (_, i) => `c${i}`,
      );
      expect(readCsv(Buffer.from(names.join(',') + '\n')).headers).toHaveLength(
        CSV_LIMITS.maxColumns,
      );
    });
  });

  describe('4-byte characters (tenant schema is utf8)', () => {
    const run = (text: string) => {
      try {
        readCsv(Buffer.from(text));
      } catch (e: any) {
        return e;
      }
      return undefined;
    };

    it('refuses an emoji in a stored cell naming the line, never echoing the cell', () => {
      const e = run('a,b\n1,2\n3,note \u{1F600} secret\n');
      expect(e).toMatchObject({ code: 'CSV_MALFORMED' });
      expect(e.message).toContain('line 3');
      expect(e.message).not.toContain('secret');
      expect(e.message).not.toContain('\u{1F600}');
    });

    it('uses the physical line after a multi-line quoted cell, and covers the header', () => {
      expect(run('a,b\n"x\ny",2\n3,\u{20000}\n').message).toContain('line 4');
      expect(run('a,\u{1F600}\n1,2\n').message).toContain('line 1');
    });

    it('accepts BMP text (accents, CJK, symbols)', () => {
      const r = readCsv(Buffer.from('a,b\né中,€☃\n'));
      expect(r.rows[0].cells.b).toBe('€☃');
    });
  });

  it('rejects reserved header names such as __proto__', () => {
    expect(() => readCsv(Buffer.from('__proto__,1,b\nx,y,z\n'))).toThrow(
      expect.objectContaining({ code: 'CSV_MALFORMED' }),
    );
  });
});
