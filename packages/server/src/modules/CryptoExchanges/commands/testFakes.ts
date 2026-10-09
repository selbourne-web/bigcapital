/**
 * In-memory fakes shared by the command specs. Not production code.
 */
import { CryptoVault } from '../vault/CryptoVault.service';
import { CryptoConnection } from '../models/CryptoConnection';
import { KeyInspection } from '../adapters/ExchangeAdapter';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoConnectionRepository } from './CryptoConnection.repository';

/** Distinctive fake secrets: assertions search every output for them. */
export const FAKE_KEY = 'AKIA-DISTINCTIVE-KEY-7731';
export const FAKE_SECRET = 'SECRET-DISTINCTIVE-9482-zq';
export const FAKE_PASSPHRASE = 'PASS-DISTINCTIVE-5520';

export const makeVault = () =>
  new CryptoVault({
    get: () => ({
      encryptionKeys: { 1: Buffer.alloc(32, 7).toString('base64') },
      currentKeyVersion: 1,
    }),
  } as any);

export type FakeTrx = { id: string; committed: boolean; rolledBack: boolean };

export class FakeUow {
  trxs: FakeTrx[] = [];
  withTransaction = async <T>(
    work: (trx: any) => Promise<T> | T,
    existing?: any,
  ): Promise<T> => {
    if (existing) return work(existing);
    const trx: FakeTrx = {
      id: `trx${this.trxs.length + 1}`,
      committed: false,
      rolledBack: false,
    };
    this.trxs.push(trx);
    try {
      const result = await work(trx);
      trx.committed = true;
      return result;
    } catch (error) {
      trx.rolledBack = true;
      throw error;
    }
  };
}

export class FakeAudit {
  rows: any[] = [];
  failWith?: Error;
  record = async (params: any) => {
    if (this.failWith) throw this.failWith;
    this.rows.push(params);
  };
}

export class FakeEvents {
  emitted: { name: string; payload: any }[] = [];
  emitAsync = async (name: string, payload: any) => {
    this.emitted.push({ name, payload });
    return [];
  };
}

export const fakeCls = (organizationId = 7) =>
  ({
    get: (key: string) => (key === 'organizationId' ? organizationId : null),
  }) as any;

export class FakeRepo {
  rows = new Map<number, any>();
  seq = 0;
  calls: string[] = [];
  insertFails?: Error;

  seed(values: Partial<CryptoConnection>): any {
    const row = {
      id: ++this.seq,
      exchange: 'kraken',
      label: 'Kraken - Trading',
      apiKeyEncrypted: 'enc-key',
      apiSecretEncrypted: 'enc-secret',
      passphraseEncrypted: null,
      keyVersion: 1,
      keyHint: '7731',
      status: 'active',
      lastSyncAt: null,
      lastError: null,
      accountId: null,
      deletedAt: null,
      createdAt: new Date('2026-10-04T00:00:00Z'),
      ...values,
    };
    this.rows.set(row.id, row);
    return row;
  }

  findById = async (id: number) => {
    const row = this.rows.get(id);
    return row && !row.deletedAt ? { ...row } : undefined;
  };
  findByAccountId = async (accountId: number) => {
    const row = [...this.rows.values()].find(
      (r) => r.accountId === accountId && !r.deletedAt,
    );
    return row ? { ...row } : undefined;
  };
  insert = async (values: any, trx: any) => {
    this.calls.push(`insert@${trx?.id}`);
    if (this.insertFails) throw this.insertFails;
    return { ...this.seed(values) };
  };
  patch = async (id: number, values: any, trx: any) => {
    this.calls.push(`patch@${trx?.id}`);
    const row = { ...this.rows.get(id), ...values };
    this.rows.set(id, row);
    return { ...row };
  };
  archive = async (id: number, trx: any) => {
    this.calls.push(`archive@${trx?.id}`);
    Object.assign(this.rows.get(id), {
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      passphraseEncrypted: null,
      accountId: null,
      status: 'paused',
      deletedAt: new Date(),
    });
  };
  hardDelete = async (id: number, trx: any) => {
    this.calls.push(`hardDelete@${trx?.id}`);
    this.rows.delete(id);
  };
}

export type FakeAccount = {
  id: number;
  name?: string;
  accountType: string;
  accountRootType: string;
  currencyCode: string;
  active: boolean;
};

export class FakeAccounts {
  accounts = new Map<number, FakeAccount>();
  add(a: Partial<FakeAccount> & { id: number }) {
    this.accounts.set(a.id, {
      accountType: 'bank',
      accountRootType: 'asset',
      currencyCode: 'BBD',
      active: true,
      ...a,
    });
  }
  model = () => ({
    query: () => ({
      findById: async (id: number) => this.accounts.get(id),
    }),
  });
}

export class FakeCreateAccount {
  calls: { dto: any; trx: any }[] = [];
  failWith?: Error;
  constructor(private readonly accounts: FakeAccounts) {}
  createAccount = async (dto: any, trx: any) => {
    this.calls.push({ dto, trx });
    if (this.failWith) throw this.failWith;
    const id = 500 + this.calls.length;
    this.accounts.add({
      id,
      name: dto.name,
      accountType: dto.accountType,
      accountRootType: 'asset',
      currencyCode: dto.currencyCode ?? 'BBD',
    });
    return { id, ...dto };
  };
}

export class FakeAdapter {
  id = 'kraken' as const;
  historyCoverage = { level: 'full' as const };
  rateLimit = { capacity: 15, refillPerSec: 1 };
  inspected: any[] = [];
  inspection: KeyInspection | Error = {
    readOnly: true,
    permissions: ['query'],
  };
  inspectKey = async (creds: any) => {
    this.inspected.push(creds);
    if (this.inspection instanceof Error) throw this.inspection;
    return this.inspection;
  };
}

export const makeValidators = (
  adapter: FakeAdapter,
  accounts: FakeAccounts,
  repo: FakeRepo,
  limiter = { acquire: jest.fn(async () => undefined) },
  baseCurrency = 'BBD',
) => {
  const registry = { get: () => adapter } as any;
  const tenancy = {
    getTenant: async () => ({ metadata: { baseCurrency } }),
  } as any;
  const validators = new CryptoConnectionValidators(
    registry,
    limiter as any,
    accounts.model as any,
    repo as unknown as CryptoConnectionRepository,
    tenancy,
  );
  return { validators, limiter };
};

/** Fails the test if any secret appears in the JSON form of any value. */
export const expectNoSecrets = (...values: unknown[]) => {
  const text = values
    .map((v) =>
      v instanceof Error
        ? `${v.message} ${JSON.stringify(v)} ${v.stack}`
        : JSON.stringify(v),
    )
    .join('\n');
  for (const secret of [FAKE_KEY, FAKE_SECRET, FAKE_PASSPHRASE]) {
    expect(text).not.toContain(secret);
  }
};

/**
 * In-memory stand-in for CryptoCsvImportRepository: a unique key on
 * (connection, type, id) and a snapshot/restore transaction.
 */
export class FakeCsvImportRepo {
  imports = new Map<number, any>();
  raw: any[] = [];
  private importSeq = 0;
  private rawSeq = 0;
  /** 1-based insert call that throws (inside the transaction). */
  failOnInsertCall?: number;
  insertBatches: number[] = [];
  transactions = 0;

  seedRaw(row: Partial<any>) {
    this.raw.push({
      id: ++this.rawSeq,
      source: 'api',
      importId: null,
      payloadHash: 'h',
      ...row,
    });
  }

  inTransaction = async <T>(work: (trx: any) => Promise<T>): Promise<T> => {
    this.transactions += 1;
    const rawSnapshot = this.raw.map((r) => ({ ...r }));
    const importSnapshot = new Map(
      [...this.imports].map(([k, v]) => [k, { ...v }]),
    );
    try {
      return await work({ fake: true });
    } catch (error) {
      this.raw = rawSnapshot;
      this.imports = importSnapshot;
      throw error;
    }
  };

  lockConnection = async () => true;
  findDependentImports = async (imp: any) => {
    if (!imp.dateFrom || !imp.dateTo || !imp.committedAt) return [];
    return [...this.imports.values()]
      .filter(
        (r) =>
          r.connectionId === imp.connectionId &&
          r.status === 'committed' &&
          r.id !== imp.id &&
          r.rowsSkippedDuplicate > 0 &&
          (r.committedAt > imp.committedAt ||
            (r.committedAt.getTime() === imp.committedAt.getTime() &&
              r.id > imp.id)) &&
          r.dateFrom &&
          r.dateTo &&
          r.dateFrom <= imp.dateTo &&
          r.dateTo >= imp.dateFrom,
      )
      .map((r) => ({ ...r }));
  };

  findImport = async (id: number) => {
    const row = this.imports.get(id);
    return row ? { ...row } : undefined;
  };
  insertImport = async (values: any) => {
    const row = {
      id: ++this.importSeq,
      rowsImported: 0,
      rowsSkippedDuplicate: 0,
      committedAt: null,
      error: null,
      ...values,
    };
    this.imports.set(row.id, row);
    return { ...row };
  };
  patchImport = async (id: number, values: any) => {
    this.imports.set(id, { ...this.imports.get(id), ...values });
  };
  markFailed = async (id: number, error: string) => {
    const row = this.imports.get(id);
    if (row?.status === 'previewed')
      Object.assign(row, { status: 'failed', error });
  };
  listImports = async (connectionId: number, limit: number) =>
    [...this.imports.values()]
      .filter((r) => r.connectionId === connectionId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  findCommittedByHash = async (
    connectionId: number,
    sha: string,
    _trx?: any,
    excludeId?: number,
  ) =>
    [...this.imports.values()].find(
      (r) =>
        r.connectionId === connectionId &&
        r.fileSha256 === sha &&
        r.status === 'committed' &&
        r.id !== excludeId,
    );
  deleteStalePreviews = async (connectionId: number, before: Date) => {
    for (const [id, r] of this.imports) {
      if (
        r.connectionId === connectionId &&
        r.status === 'previewed' &&
        r.createdAt < before
      ) {
        this.imports.delete(id);
      }
    }
  };
  findExistingIds = async (
    connectionId: number,
    recordType: string,
    ids: string[],
  ) => {
    const wanted = new Set(ids);
    return new Set(
      this.raw
        .filter(
          (r) =>
            r.connectionId === connectionId &&
            r.recordType === recordType &&
            wanted.has(r.exchangeRecordId),
        )
        .map((r) => r.exchangeRecordId),
    );
  };
  countApiTrades = async (connectionId: number, from: Date, to: Date) =>
    this.raw.filter(
      (r) =>
        r.connectionId === connectionId &&
        r.source === 'api' &&
        r.recordType === 'trade' &&
        r.occurredAt >= from &&
        r.occurredAt <= to,
    ).length;
  insertIgnoringDuplicates = async (rows: any[]) => {
    this.insertBatches.push(rows.length);
    if (this.failOnInsertCall === this.insertBatches.length) {
      throw new Error('forced insert failure');
    }
    let inserted = 0;
    for (const row of rows) {
      const exists = this.raw.some(
        (r) =>
          r.connectionId === row.connectionId &&
          r.recordType === row.recordType &&
          r.exchangeRecordId === row.exchangeRecordId,
      );
      if (!exists) {
        this.raw.push({ id: ++this.rawSeq, ...row });
        inserted += 1;
      }
    }
    return inserted;
  };
  countByImport = async (importId: number) =>
    this.raw.filter((r) => r.importId === importId && r.source === 'csv')
      .length;
  countPresent = async (
    connectionId: number,
    recordType: string,
    ids: string[],
  ) => (await this.findExistingIds(connectionId, recordType, ids)).size;
  deleteRawByImport = async (importId: number) => {
    const before = this.raw.length;
    this.raw = this.raw.filter(
      (r) => !(r.importId === importId && r.source === 'csv'),
    );
    return before - this.raw.length;
  };
}
