import {
  CryptoCsvImportRepository,
  isTransientDbError,
} from './CryptoCsvImport.repository';

const makeRepo = (transaction: (work: any) => Promise<any>) =>
  new CryptoCsvImportRepository(
    (() => ({})) as any,
    (() => ({
      tableName: 'crypto_raw_records',
      knex: () => ({ transaction }),
    })) as any,
  );

/** A trx stub: only the calls insertIgnoringDuplicates makes. */
const makeTrx = (answers: {
  affected: number;
  total: number;
  warnings: number[];
}) => {
  const log: string[] = [];
  const trx: any = () => ({
    insert: () => ({
      onConflict: () => ({
        ignore: () => ({
          toSQL: () => ({
            toNative: () => ({ sql: 'INSERT-SQL', bindings: [] }),
          }),
        }),
      }),
    }),
  });
  trx.raw = async (sql: string) => {
    log.push(sql);
    if (sql === 'INSERT-SQL') return [{ affectedRows: answers.affected }];
    if (/warning_count/.test(sql)) return [[{ c: answers.total }]];
    if (sql === 'SHOW WARNINGS') {
      return [answers.warnings.map((Code) => ({ Level: 'Note', Code }))];
    }
    return [];
  };
  return { trx, log };
};

const row = (n: number) => ({ id: n }) as any;

describe('CryptoCsvImportRepository (unit)', () => {
  describe('transient database errors', () => {
    it.each([
      [{ code: 'ER_LOCK_WAIT_TIMEOUT' }],
      [{ code: 'ER_LOCK_DEADLOCK' }],
      [{ errno: 1205 }],
      [{ nativeError: { errno: 1213 } }],
      [{ nativeError: { code: 'ER_LOCK_DEADLOCK' } }],
    ])('%j is transient', (error) => {
      expect(isTransientDbError(error)).toBe(true);
    });

    it('other errors are not', () => {
      expect(isTransientDbError(new Error('x'))).toBe(false);
      expect(isTransientDbError({ code: 'ER_DUP_ENTRY', errno: 1062 })).toBe(
        false,
      );
    });

    it('inTransaction maps them to a retryable CSV_BUSY and passes the rest through', async () => {
      const busy = makeRepo(async () => {
        throw Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT',
          errno: 1205,
        });
      });
      await expect(busy.inTransaction(async () => 1)).rejects.toMatchObject({
        code: 'CSV_BUSY',
      });
      const other = makeRepo(async () => {
        throw new Error('boom');
      });
      await expect(other.inTransaction(async () => 1)).rejects.toThrow('boom');
    });
  });

  describe('insertIgnoringDuplicates warning accounting', () => {
    const repo = makeRepo(async () => undefined);

    it('accepts duplicate-key warnings that account for every skipped row', async () => {
      const { trx, log } = makeTrx({
        affected: 1,
        total: 2,
        warnings: [1062, 1062],
      });
      await expect(
        repo.insertIgnoringDuplicates([row(1), row(2), row(3)] as any, trx),
      ).resolves.toBe(1);
      expect(log[0]).toMatch(/max_error_count/);
    });

    it('a failed insert rethrows only code and errno, never the SQL or row data', async () => {
      const { trx } = makeTrx({ affected: 0, total: 0, warnings: [] });
      const original = trx.raw;
      trx.raw = async (sql: string, bindings?: unknown[]) => {
        if (sql === 'INSERT-SQL') {
          throw Object.assign(
            new Error(
              "insert into `crypto_raw_records` values ('SECRET-PAYLOAD') - Got a packet bigger than 'max_allowed_packet' bytes",
            ),
            { code: 'ER_NET_PACKET_TOO_LARGE', errno: 1153, sql: 'SECRET-SQL' },
          );
        }
        return original(sql, bindings);
      };
      const error: any = await repo
        .insertIgnoringDuplicates([row(1)] as any, trx)
        .then(
          () => undefined,
          (e) => e,
        );
      expect(error.message).toContain('ER_NET_PACKET_TOO_LARGE');
      expect(JSON.stringify(error) + error.message + error.stack).not.toMatch(
        /SECRET|insert into/,
      );
      expect(error).toMatchObject({
        code: 'ER_NET_PACKET_TOO_LARGE',
        errno: 1153,
      });
    });

    it('a transient insert failure still maps to CSV_BUSY with a clean message', async () => {
      const { trx } = makeTrx({ affected: 0, total: 0, warnings: [] });
      trx.raw = async () => {
        throw Object.assign(new Error('insert ... SECRET-PAYLOAD'), {
          code: 'ER_LOCK_DEADLOCK',
          errno: 1213,
        });
      };
      const busy = makeRepo(async () => {
        await repo.insertIgnoringDuplicates([row(1)] as any, trx);
      });
      await expect(busy.inTransaction(async () => 1)).rejects.toMatchObject({
        code: 'CSV_BUSY',
        message:
          'The database was busy. Nothing was changed; please try again.',
      });
    });

    it('aborts when the warning list is shorter than the warning count (truncated)', async () => {
      const { trx } = makeTrx({ affected: 1, total: 3, warnings: [1062] });
      await expect(
        repo.insertIgnoringDuplicates(
          [row(1), row(2), row(3), row(4)] as any,
          trx,
        ),
      ).rejects.toThrow(/incomplete \(1 of 3\)/);
    });

    it('aborts when the count cannot be read', async () => {
      const { trx } = makeTrx({
        affected: 1,
        total: undefined as any,
        warnings: [],
      });
      await expect(
        repo.insertIgnoringDuplicates([row(1)] as any, trx),
      ).rejects.toThrow(/incomplete/);
    });

    it('aborts on a non-duplicate warning', async () => {
      const { trx } = makeTrx({ affected: 1, total: 1, warnings: [1265] });
      await expect(
        repo.insertIgnoringDuplicates([row(1)] as any, trx),
      ).rejects.toThrow(/unexpected warnings \(codes 1265/);
    });

    it('aborts when setting max_error_count fails', async () => {
      const { trx } = makeTrx({ affected: 1, total: 0, warnings: [] });
      const original = trx.raw;
      trx.raw = async (sql: string) => {
        if (/max_error_count/.test(sql)) throw new Error('SET denied');
        return original(sql);
      };
      await expect(
        repo.insertIgnoringDuplicates([row(1)] as any, trx),
      ).rejects.toThrow('SET denied');
    });
  });
});
