import { UnprocessableEntityException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  DEFAULT_STRATEGY,
  SerializeInterceptor,
} from '@/common/interceptors/serialize.interceptor';
import { ServiceError } from '@/modules/Items/ServiceError';
import { CreateCryptoConnectionService } from './commands/CreateCryptoConnection.service';
import { CreateCryptoConnectionDto } from './dtos/CreateCryptoConnection.dto';
import { GetCryptoConnectionsService } from './queries/GetCryptoConnections.service';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import {
  CRYPTO_CONNECTION_ERRORS,
  CRYPTO_SYNC_QUEUES,
  CRYPTO_SYNC_QUEUE_NAMES,
  SUPPORTED_CRYPTO_EXCHANGES,
  queueNameFor,
} from './CryptoExchanges.constants';
import {
  FAKE_KEY,
  FAKE_SECRET,
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
  FakeCreateAccount,
  FakeEvents,
  FakeRepo,
  FakeUow,
  expectNoSecrets,
  fakeCls,
  makeValidators,
  makeVault,
} from './commands/testFakes';

const wire = async (value: unknown) => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ body: undefined, query: {} }),
    }),
  } as any;
  const out = await lastValueFrom(
    new SerializeInterceptor(DEFAULT_STRATEGY).intercept(context, {
      handle: () => of(value),
    }),
  );
  return JSON.parse(JSON.stringify(out));
};

const setup = (exchange: 'crypto_com' | 'crypto_com_app') => {
  const adapter = new FakeAdapter() as any;
  adapter.id = exchange;
  adapter.historyCoverage =
    exchange === 'crypto_com'
      ? { level: 'partial', note: 'Limited to the last 6 months.' }
      : { level: 'full' };
  const accounts = new FakeAccounts();
  const repo = new FakeRepo();
  const { validators } = makeValidators(adapter, accounts, repo);
  const service = new CreateCryptoConnectionService(
    repo as any,
    makeVault(),
    validators,
    new FakeUow() as any,
    new FakeCreateAccount(accounts) as any,
    new FakeAudit() as any,
    new FakeEvents() as any,
    fakeCls(),
  );
  return { adapter, repo, service, validators };
};

const dto = (exchange: string, extra: Record<string, unknown> = {}) =>
  ({
    exchange,
    label: `${exchange} label`,
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    ...extra,
  }) as any;

describe('Crypto.com connections over the wire', () => {
  it.each(['crypto_com', 'crypto_com_app'] as const)(
    '%s: create returns a snake_case view with exchange and key_expires_at, no secrets',
    async (exchange) => {
      const t = setup(exchange);
      t.adapter.inspection = {
        readOnly: true,
        permissions: ['read'],
        expiresAt: new Date('2027-01-05T00:00:00Z'),
      };
      const view = await t.service.execute(dto(exchange));
      const out = await wire(view);
      expect(out).toMatchObject({
        exchange,
        key_expires_at: '2027-01-05T00:00:00.000Z',
        status: 'active',
      });
      expectNoSecrets(out);
    },
  );

  it('list view carries history_coverage per exchange from the REAL adapters', async () => {
    const rows = [
      { id: 1, exchange: 'crypto_com', label: 'x', status: 'active' },
      { id: 2, exchange: 'crypto_com_app', label: 'y', status: 'active' },
      { id: 3, exchange: 'kraken', label: 'z', status: 'active' },
    ];
    const query: any = {
      whereNull: () => query,
      orderBy: async () => rows,
    };
    const service = new GetCryptoConnectionsService(
      (() => ({ query: () => query })) as any,
      new AdapterRegistry(),
    );
    const out = await wire(await service.execute());
    expect(out.map((c: any) => c.history_coverage.level)).toEqual([
      'partial',
      'full',
      'full',
    ]);
    expect(out[0].history_coverage.note).toMatch(/6 months/);
    expect(out[0].key_expires_at).toBeNull();
  });

  it('crypto_com: the 422 attestation body carries code, permissions and warnings', async () => {
    const t = setup('crypto_com');
    t.adapter.inspection = {
      readOnly: 'unverifiable',
      permissions: ['fiat.deposit:write'],
      warnings: ['This key may be able to withdraw.'],
    };
    const error: any = await t.service
      .execute(dto('crypto_com'))
      .catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      code: 'ATTESTATION_REQUIRED',
      permissions: ['fiat.deposit:write'],
      warnings: ['This key may be able to withdraw.'],
    });
    expectNoSecrets(error.getResponse());
    expect(t.repo.rows.size).toBe(0);

    // resent with the attestation: stored
    const view = await t.service.execute(
      dto('crypto_com', { attestReadOnly: true }),
    );
    expect(view.exchange).toBe('crypto_com');
  });
});

describe('exchanges without an adapter (nexo) are rejected cleanly', () => {
  it.each(['nexo'])(
    '%s: the DTO rejects it (400) and the service guard raises the unsupported ServiceError, never a 500',
    async (exchange) => {
      const errors = await validate(
        plainToInstance(CreateCryptoConnectionDto, dto(exchange)),
      );
      expect(errors.map((e) => e.property)).toContain('exchange');

      const t = setup('crypto_com');
      let thrown: any;
      try {
        (t.validators as any).assertSupportedExchange(exchange);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ServiceError);
      expect(thrown.errorType).toBe(
        CRYPTO_CONNECTION_ERRORS.EXCHANGE_NOT_SUPPORTED,
      );
      // service-level (DTO bypassed): same clean error, nothing stored
      await expect(t.service.execute(dto(exchange))).rejects.toMatchObject({
        errorType: CRYPTO_CONNECTION_ERRORS.EXCHANGE_NOT_SUPPORTED,
      });
      expect(t.repo.rows.size).toBe(0);
      expect(() => queueNameFor(exchange)).toThrow(exchange);
    },
  );

  it.each(['crypto_com', 'crypto_com_app', 'pionex'])(
    '%s passes the DTO exchange check',
    async (exchange) => {
      const errors = await validate(
        plainToInstance(CreateCryptoConnectionDto, dto(exchange)),
      );
      expect(errors.map((e) => e.property)).not.toContain('exchange');
    },
  );
});

describe('every supported exchange is wired to a queue and an adapter', () => {
  it('has one distinct queue per supported exchange, each in CRYPTO_SYNC_QUEUE_NAMES', () => {
    const names = SUPPORTED_CRYPTO_EXCHANGES.map(queueNameFor);
    expect(new Set(names).size).toBe(SUPPORTED_CRYPTO_EXCHANGES.length);
    expect([...CRYPTO_SYNC_QUEUE_NAMES].sort()).toEqual([...names].sort());
    expect(Object.keys(CRYPTO_SYNC_QUEUES).sort()).toEqual(
      [...SUPPORTED_CRYPTO_EXCHANGES].sort(),
    );
  });

  it('the registry resolves an adapter whose id matches for every supported exchange', () => {
    const registry = new AdapterRegistry();
    for (const exchange of SUPPORTED_CRYPTO_EXCHANGES) {
      expect(registry.get(exchange).id).toBe(exchange);
    }
  });
});
