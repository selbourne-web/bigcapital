import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoCsvImport } from '../models/CryptoCsvImport';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoConnection } from '../models/CryptoConnection';
import { CSV_DELETE_CHUNK, CSV_LOOKUP_CHUNK } from '../csv/csvImport.types';
import { CsvImportError } from '../csv/csv.types';

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

/** ER_LOCK_WAIT_TIMEOUT (1205) and ER_LOCK_DEADLOCK (1213): retrying is safe. */
export function isTransientDbError(error: unknown): boolean {
  const e = error as {
    code?: string;
    errno?: number;
    nativeError?: { code?: string; errno?: number };
  };
  const codes = [e?.code, e?.nativeError?.code];
  const errnos = [e?.errno, e?.nativeError?.errno];
  return (
    codes.some(
      (c) => c === 'ER_LOCK_WAIT_TIMEOUT' || c === 'ER_LOCK_DEADLOCK',
    ) || errnos.some((n) => n === 1205 || n === 1213)
  );
}

/** Transient DB errors become a retryable CSV_BUSY; everything else is untouched. */
export function mapTransientDbError(error: unknown): unknown {
  return isTransientDbError(error)
    ? new CsvImportError(
        'CSV_BUSY',
        'The database was busy. Nothing was changed; please try again.',
      )
    : error;
}

/** A fresh error carrying only the driver's code/errno: no SQL, bindings or row data. */
export function sanitizedDbError(error: unknown): Error {
  const e = error as {
    code?: unknown;
    errno?: unknown;
    nativeError?: { code?: unknown; errno?: unknown };
  };
  const code = e?.code ?? e?.nativeError?.code;
  const errno = e?.errno ?? e?.nativeError?.errno;
  const safeCode = typeof code === 'string' ? code.slice(0, 64) : undefined;
  const safeErrno = typeof errno === 'number' ? errno : undefined;
  const out = new Error(
    `CSV import aborted: the database rejected the insert (${
      safeCode ?? 'unknown code'
    }${safeErrno !== undefined ? `, errno ${safeErrno}` : ''})`,
  );
  if (safeCode !== undefined) (out as any).code = safeCode;
  if (safeErrno !== undefined) (out as any).errno = safeErrno;
  return out;
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
    // Compared in SQL against the stored DATETIME(6): a JS Date would truncate
    // to milliseconds.
    const mine = () =>
      this.importModel().query(trx).select('committedAt').findById(imp.id);
    return this.importModel()
      .query(trx)
      .where({ connectionId: imp.connectionId, status: 'committed' })
      .whereNot('id', imp.id)
      .where('rowsSkippedDuplicate', '>', 0)
      .where((b) =>
        b
          .where('committedAt', '>', mine())
          .orWhere((c) =>
            c.where('committedAt', '=', mine()).where('id', '>', imp.id),
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
  async inTransaction<T>(
    work: (trx: Knex.Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.rawModel().knex().transaction(work);
    } catch (error) {
      throw mapTransientDbError(error);
    }
  }

  /** Application clock (overridable in tests). */
  protected now = (): Date => new Date();

  /**
   * Marks the import committed. `committed_at` is written from the application
   * clock, never the database clock: a JS Date round-trips the mysql driver
   * whatever the DB session and node timezones are (NOW() is read back as
   * local time, so a UTC DB session and a non-UTC node shifted it by the
   * offset). It is max(now, newest committed_at of this connection + 1ms),
   * computed inside the connection-locked transaction, so commits of one
   * connection are strictly increasing even within one millisecond or after a
   * clock step back.
   */
  async markCommitted(
    id: number,
    values: Partial<CryptoCsvImport>,
    trx: Knex.Transaction,
  ): Promise<void> {
    const own: any = await this.importModel()
      .query(trx)
      .select('connectionId')
      .findById(id);
    const newest: any = own
      ? await this.importModel()
          .query(trx)
          .where('connectionId', own.connectionId)
          .max('committedAt as newest')
          .first()
      : undefined;
    const clock = this.now();
    const last = newest?.newest ? new Date(newest.newest) : null;
    const committedAt =
      last && !Number.isNaN(last.getTime()) && last.getTime() >= clock.getTime()
        ? new Date(last.getTime() + 1)
        : clock;
    await this.importModel()
      .query(trx)
      .findById(id)
      .patch({
        ...values,
        status: 'committed',
        committedAt,
        error: null,
      });
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
    let result: any;
    try {
      result = await trx.raw(native.sql, native.bindings as any[]);
    } catch (error) {
      // knex puts the interpolated SQL, bindings (row payloads) in err.message.
      // Rethrow a generic error that keeps only the code and errno (the
      // transient 1205/1213 -> CSV_BUSY mapping reads those).
      throw sanitizedDbError(error);
    }
    const header = Array.isArray(result) ? result[0] : result;
    const inserted = Number(header?.affectedRows ?? header?.affected_rows ?? 0);

    // @@warning_count and SHOW WARNINGS do not reset the diagnostics area.
    const counted: any = await trx.raw('SELECT @@warning_count AS c');
    const countRow = (Array.isArray(counted) ? counted[0] : counted)?.[0];
    const total = Number(countRow?.c ?? countRow?.C ?? Number.NaN);
    const warned: any = await trx.raw('SHOW WARNINGS');
    const list: any[] = (Array.isArray(warned) ? warned[0] : warned) ?? [];
    if (!Number.isFinite(total) || total !== list.length) {
      throw new Error(
        `CSV import aborted: the database warning list is incomplete (${list.length} of ${total})`,
      );
    }
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
