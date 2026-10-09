import { createHash } from 'crypto';
import { CsvRecordInput } from './csv.types';

/**
 * `csv:` + sha256(parserId + '\n' + canonical JSON of [header, value] pairs in
 * header order). The n-th identical row (n >= 1) in one file gets `:n`.
 * Ids depend on row content only, never on file position.
 */
export function assignCsvRecordIds(
  parserId: string,
  rows: Array<{ cells: Record<string, string>; record: CsvRecordInput }>,
): Array<{ exchangeRecordId: string; record: CsvRecordInput }> {
  const seen = new Map<string, number>();
  return rows.map(({ cells, record }) => {
    const canonical = JSON.stringify(Object.entries(cells));
    const digest = createHash('sha256')
      .update(`${parserId}\n${canonical}`)
      .digest('hex');
    const base = `csv:${digest}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { exchangeRecordId: n === 0 ? base : `${base}:${n}`, record };
  });
}
