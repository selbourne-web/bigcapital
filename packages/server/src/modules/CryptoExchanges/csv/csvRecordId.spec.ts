import { assignCsvRecordIds } from './csvRecordId';
import { readCsv } from './CsvReader';
import { CsvRecordInput } from './csv.types';

const rec: CsvRecordInput = {
  recordType: 'trade',
  occurredAt: new Date(0),
  payload: {},
};
const row = (cells: Record<string, string>) => ({ cells, record: rec });

describe('assignCsvRecordIds', () => {
  it('gives identical rows X and X:1', () => {
    const ids = assignCsvRecordIds('p:1', [
      row({ a: '1' }),
      row({ a: '1' }),
      row({ a: '1' }),
    ]).map((r) => r.exchangeRecordId);
    expect(ids[0]).toMatch(/^csv:[0-9a-f]{64}$/);
    expect(ids[1]).toBe(`${ids[0]}:1`);
    expect(ids[2]).toBe(`${ids[0]}:2`);
  });

  it('is independent of file order', () => {
    const rows = [row({ a: '1' }), row({ a: '2' }), row({ a: '1' })];
    const fwd = assignCsvRecordIds('p:1', rows).map((r) => r.exchangeRecordId);
    const rev = assignCsvRecordIds('p:1', [...rows].reverse()).map(
      (r) => r.exchangeRecordId,
    );
    expect([...fwd].sort()).toEqual([...rev].sort());
  });

  it('depends on parserId and content; ids <= 191 chars', () => {
    const [a] = assignCsvRecordIds('p:1', [row({ a: '1' })]);
    const [b] = assignCsvRecordIds('p:2', [row({ a: '1' })]);
    const [c] = assignCsvRecordIds('p:1', [row({ a: '2' })]);
    expect(a.exchangeRecordId).not.toBe(b.exchangeRecordId);
    expect(a.exchangeRecordId).not.toBe(c.exchangeRecordId);
    const many = assignCsvRecordIds(
      'p:1',
      Array.from({ length: 1000 }, () => row({ a: 'x'.repeat(2000) })),
    );
    expect(
      Math.max(...many.map((r) => r.exchangeRecordId.length)),
    ).toBeLessThanOrEqual(191);
  });

  it('hashes in header order even for integer-like headers', () => {
    const read = readCsv(Buffer.from('b,1\nx,y\n'));
    const [fromReader] = assignCsvRecordIds('p:1', [
      { cells: read.rows[0].cells, record: rec },
    ]);
    const [explicit] = assignCsvRecordIds(
      'p:1',
      [{ cells: { ...read.rows[0].cells }, record: rec }],
      read.headers,
    );
    const [reordered] = assignCsvRecordIds('p:1', [
      { cells: { '1': 'y', b: 'x' }, record: rec },
    ]);
    expect(fromReader.exchangeRecordId).toBe(explicit.exchangeRecordId);
    expect(fromReader.exchangeRecordId).not.toBe(reordered.exchangeRecordId);
  });
});
