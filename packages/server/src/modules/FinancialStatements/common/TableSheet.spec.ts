import * as XLSX from 'xlsx';
import { TableSheet } from './TableSheet';

/**
 * Covers the financial-report export path (TableSheet -> SheetJS write).
 */
const table: any = {
  columns: [{ label: 'Account' }, { label: 'Total' }],
  rows: [
    { cells: [{ value: 'Cash' }, { value: '100.00' }] },
    { cells: [{ value: 'Bank' }, { value: '250.50' }] },
  ],
};

describe('TableSheet (SheetJS export path)', () => {
  it('converts the table to CSV with the column labels as the header row', () => {
    const csv = new TableSheet(table).convertToCSV();

    expect(csv.split('\n')).toEqual([
      'Account,Total',
      'Cash,100.00',
      'Bank,250.50',
    ]);
  });

  it('writes an XLSX buffer that round-trips through SheetJS read', () => {
    const sheet = new TableSheet(table);
    const buffer = sheet.convertToBuffer(sheet.convertToXLSX(), 'xlsx');

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // XLSX files are ZIP containers.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Sheet1'], {
      header: 1,
    });
    expect(rows).toEqual([
      ['Account', 'Total'],
      ['Cash', '100.00'],
      ['Bank', '250.50'],
    ]);
  });

  it('writes a CSV buffer', () => {
    const sheet = new TableSheet(table);
    const buffer = sheet.convertToBuffer(sheet.convertToXLSX(), 'csv');

    expect(buffer.toString('utf8')).toContain('Account,Total');
    expect(buffer.toString('utf8')).toContain('Cash,100.00');
  });
});
