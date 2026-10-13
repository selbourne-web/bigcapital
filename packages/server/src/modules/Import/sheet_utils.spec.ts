import * as XLSX from 'xlsx';
import { parseSheetData } from './sheet_utils';

/**
 * Covers the real upload parse path (ImportFileUpload / ImportFileProcess ->
 * parseSheetData) against the installed SheetJS build.
 */
const buildXlsxBuffer = (rows: unknown[][]): Buffer => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const versionTuple = (version: string): number[] =>
  version.split('.').map((part) => parseInt(part, 10));

describe('sheet_utils (SheetJS parse path)', () => {
  afterEach(() => {
    // Defensive cleanup so a failed pollution probe cannot leak into other specs.
    delete (Object.prototype as any).polluted;
  });

  it('uses a SheetJS build with the prototype-pollution and ReDoS fixes (>= 0.20.2)', () => {
    // GHSA-4r6h-8v6p-xvw6 fixed in 0.19.3, GHSA-5pgg-2g8v-p4x9 fixed in 0.20.2.
    const [major, minor, patch] = versionTuple(XLSX.version);
    const atLeast = (a: number, b: number, c: number) =>
      major > a || (major === a && (minor > b || (minor === b && patch >= c)));

    expect(atLeast(0, 20, 2)).toBe(true);
  });

  it('parses an uploaded CSV buffer into columns and keyed rows', () => {
    const csv =
      'Name,Amount,Date\nCash,100,2024-01-01\nBank,250.5,2024-02-03\n';
    const [data, columns] = parseSheetData(Buffer.from(csv, 'utf8'));

    expect(columns).toEqual(['Name', 'Amount', 'Date']);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ Name: 'Cash', Amount: '100' });
    expect(data[1]).toMatchObject({ Name: 'Bank', Amount: '250.5' });
  });

  it('parses an uploaded XLSX buffer into columns and keyed rows', () => {
    const buffer = buildXlsxBuffer([
      ['Name', 'Amount'],
      ['Cash', 100],
      ['Bank', 250.5],
    ]);
    const [data, columns] = parseSheetData(buffer);

    expect(columns).toEqual(['Name', 'Amount']);
    expect(data).toEqual([
      { Name: 'Cash', Amount: 100 },
      { Name: 'Bank', Amount: 250.5 },
    ]);
  });

  it('drops empty header cells from the columns list', () => {
    const csv = 'Name,,Amount\nCash,x,1\n';
    const [, columns] = parseSheetData(Buffer.from(csv, 'utf8'));

    expect(columns).toEqual(['Name', 'Amount']);
  });

  it('does not pollute Object.prototype from __proto__ / constructor headers (CSV)', () => {
    const csv =
      '__proto__,constructor,prototype,Name\n' +
      '{"polluted":"yes"},x,y,Cash\n';
    parseSheetData(Buffer.from(csv, 'utf8'));

    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
  });

  it('does not pollute Object.prototype from __proto__ headers (XLSX)', () => {
    const buffer = buildXlsxBuffer([
      ['__proto__', 'constructor', 'Name'],
      ['{"polluted":"yes"}', 'x', 'Cash'],
    ]);
    const [data] = parseSheetData(buffer);

    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
    expect(Object.getPrototypeOf(data[0])).toBe(Object.prototype);
  });
});
