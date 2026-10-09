import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoCsvImport } from '../models/CryptoCsvImport';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoConnection } from '../models/CryptoConnection';
import { CSV_DELETE_CHUNK, CSV_LOOKUP_CHUNK } from '../csv/csvImport.types';

export interface CsvRawRow {
  connectionId: number;
  recordType: string;
  exchangeRecordId: string;
  occurredAt: Date;
  /** Already serialized JSON text: knex does not serialize JSON columns for us. */
  payload: string;
  payloadHash: string;
  source: 'csv';
  importId: number;
}

const chunked = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * Persistence for CSV imports and the raw records they write. Everything that
 * must be atomic takes the caller's transaction.
 */
@Injectable()
export class CryptoCsvImportRepository {
  constructor(
    @Inject(CryptoCsvImport.name)
    private readonly importModel: TenantModelProxy<typeof CryptoCsvImport>,
    @Inject(CryptoRawRecord.name)
    private readonly rawModel: TenantModelProxy<typeof CryptoRawRecord>,
  ) {}

  /** Rows removed per DELETE on rollback (overridable in tests). */
  protected deleteChunk = CSV_DELETE_CHUNK;

  /**
   * Row-locks the connection. Must be the FIRST statement of a commit or
   * rollback transaction: imports of one connection are then serialised and
   * every later (consistent) read sees the earlier import's commit. Returns
   * false when the connection row does not exist.
   */
  async lockConnection(
    connectionId: number,
    trx: Knex.Transaction,
  ): Promise<boolean> {
    const rows = await trx(CryptoConnection.tableName)
      .select('id')
      .where('id', connectionId)
      .forUpdate();
    return rows.length > 0;
  }

  /**
   * Committed imports of the connection that committed after `imp`, skipped
   * rows as duplicates and cover an overlapping date range. They may rely on
   * rows `imp` wrote, so `imp` must not be rolled back before them.
   */
  async findDependentImports(
    imp: CryptoCsvImport,
    trx: Knex.Transaction,
  ): Promise<CryptoCsvImport[]> {
    if (!imp.dateFrom || !imp.dateTo || !imp.committedAt) return [];
    return this.importModel()
      .query(trx)
      .where({ connectionId: imp.connectionId, status: 'committed' })
      .whereNot('id', imp.id)
      .where('rowsSkippedDuplicate', '>', 0)
      .where((b) =>
        b
          .where('committedAt', '>', imp.committedAt)
          .orWhere((c) =>
            c.where('committedAt', imp.committedAt).where('id', '>', imp.id),
          ),
      )
      .whereNotNull('dateFrom')
      .whereNotNull('dateTo')
      .where('dateFrom', '<=', imp.dateTo)
      .where('dateTo', '>=', imp.dateFrom)
      .orderBy('id') as unknown as Promise<CryptoCsvImport[]>;
  }

  /**
   * Runs `work` in a transaction that is awaited to commit or roll back (the
   * shared UnitOfWork does not await either), so callers can rely on the
   * outcome being final when this resolves.
   */
  inTransaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.rawModel().knex().transaction(work);
  }

  /** `lock` takes a row lock; only meaningful inside a transaction. */
  findImport(
    id: number,
    trx?: Knex.Transaction,
    lock = false,
  ): Promise<CryptoCsvImport | undefined> {
    const query = this.importModel().query(trx).findById(id);
    if (lock) query.forUpdate();
    return query as unknown as Promise<CryptoCsvImport | undefined>;
  }

  async insertImport(
    values: Partial<CryptoCsvImport>,
    trx?: Knex.Transaction,
  ): Promise<CryptoCsvImport> {
    return this.importModel().query(trx).insertAndFetch(values);
  }

  async patchImport(
    id: number,
    values: Partial<CryptoCsvImport>,
    trx?: Knex.Transaction,
  ): Promise<void> {
    await this.importModel().query(trx).findById(id).patch(values);
  }

  /** Marks a still-`previewed` import failed (never touches a committed one). */
  async markFailed(id: number, error: string): Promise<void> {
    await this.importModel()
      .query()
      .findById(id)
      .where('status', 'previewed')
      .patch({ status: 'failed', error });
  }

  /** Newest first. */
  listImports(connectionId: number, limit: number): Promise<CryptoCsvImport[]> {
    return this.importModel()
      .query()
      .where('connectionId', connectionId)
      .orderBy('id', 'desc')
      .limit(limit) as unknown as Promise<CryptoCsvImport[]>;
  }

  /** A committed import of the same bytes (a rolled-back one does not count). */
  async findCommittedByHash(
    connectionId: number,
    fileSha256: string,
    trx?: Knex.Transaction,
    excludeId?: number,
  ): Promise<CryptoCsvImport | undefined> {
    const query = this.importModel()
      .query(trx)
      .where({ connectionId, fileSha256, status: 'committed' });
    if (excludeId != null) query.whereNot('id', excludeId);
    return (await query.first()) as CryptoCsvImport | undefined;
  }

  /** Removes this connection's abandoned previews. */
  async deleteStalePreviews(connectionId: number, before: Date): Promise<void> {
    await this.importModel()
      .query()
      .where({ connectionId, status: 'previewed' })
      .where('createdAt', '<', before)
      .delete();
  }

  /** Which of `ids` (one record type) already exist for the connection. */
  async findExistingIds(
    connectionId: number,
    recordType: string,
    ids: string[],
    trx?: Knex.Transaction,
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunked(ids, CSV_LOOKUP_CHUNK)) {
      const rows = await this.rawModel()
        .query(trx)
        .select('exchangeRecordId')
        .where({ connectionId, recordType })
        .whereIn('exchangeRecordId', chunk);
      for (const row of rows) found.add(row.exchangeRecordId);
    }
    return found;
  }

  /** `source = 'api'` trade records inside the inclusive range. */
  async countApiTrades(
    connectionId: number,
    from: Date,
    to: Date,
  ): Promise<number> {
    return this.rawModel()
      .query()
      .where({ connectionId, source: 'api', recordType: 'trade' })
      .whereBetween('occurredAt', [from, to])
      .resultSize();
  }

  /**
   * Multi-row `INSERT IGNORE`: rows whose (connection, type, id) key exists
   * are skipped by the database. Returns the rows actually inserted
   * (`affectedRows`).
   *
   * INSERT IGNORE downgrades every row error (truncation, invalid characters,
   * out-of-range values) to a warning, which would store altered data under
   * the original payload hash. So the statement's warnings are read on the same
   * connection: only duplicate-key (1062) warnings are allowed, and they must
   * account for exactly the rows that were not inserted. Anything else throws
   * (the caller's transaction then rolls back). Messages carry codes only,
   * never row data.
   */
  async insertIgnoringDuplicates(
    rows: CsvRawRow[],
    trx: Knex.Transaction,
  ): Promise<number> {
    if (!rows.length) return 0;
    const native = trx(this.rawModel().tableName)
      .insert(rows)
      .onConflict()
      .ignore()
      .toSQL()
      .toNative();
    // Warnings are capped by max_error_count; a batch is at most a few
    // hundred rows, so lift the cap for this session.
    await trx.raw('SET SESSION max_error_count = 65535');
    const result: any = await trx.raw(native.sql, native.bindings as any[]);
    const header = Array.isArray(result) ? result[0] : result;
    const inserted = Number(header?.affectedRows ?? header?.affected_rows ?? 0);

    const warned: any = await trx.raw('SHOW WARNINGS');
    const list: any[] = (Array.isArray(warned) ? warned[0] : warned) ?? [];
    const codes = list.map((w) => Number(w.Code ?? w.code));
    const other = [...new Set(codes.filter((c) => c !== 1062))];
    const duplicates = codes.filter((c) => c === 1062).length;
    if (other.length || inserted + duplicates !== rows.length) {
      throw new Error(
        `CSV import aborted: the database reported unexpected warnings (codes ${
          other.join(',') || 'none'
        }; inserted ${inserted}, duplicates ${duplicates}, expected ${rows.length})`,
      );
    }
    return inserted;
  }

  countByImport(importId: number, trx: Knex.Transaction): Promise<number> {
    return this.rawModel()
      .query(trx)
      .where({ importId, source: 'csv' })
      .resultSize();
  }

  /** How many of `ids` (one record type) are stored for the connection. */
  async countPresent(
    connectionId: number,
    recordType: string,
    ids: string[],
    trx: Knex.Transaction,
  ): Promise<number> {
    let total = 0;
    for (const chunk of chunked(ids, CSV_LOOKUP_CHUNK)) {
      total += await this.rawModel()
        .query(trx)
        .where({ connectionId, recordType })
        .whereIn('exchangeRecordId', chunk)
        .resultSize();
    }
    return total;
  }

  /** Deletes exactly this import's CSV rows, in chunks. Returns the count. */
  async deleteRawByImport(
    importId: number,
    trx: Knex.Transaction,
  ): Promise<number> {
    let deleted = 0;
    for (;;) {
      const ids = (
        await this.rawModel()
          .query(trx)
          .select('id')
          .where({ importId, source: 'csv' })
          .limit(this.deleteChunk)
      ).map((r) => r.id);
      if (!ids.length) return deleted;
      deleted += await this.rawModel()
        .query(trx)
        .whereIn('id', ids)
        .where({ importId, source: 'csv' })
        .delete();
    }
  }
}
