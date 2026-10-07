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
