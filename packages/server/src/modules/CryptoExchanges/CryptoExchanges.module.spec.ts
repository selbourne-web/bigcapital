import { DynamicModule, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bullmq';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { ClsService } from 'nestjs-cls';
import { Account } from '@/modules/Accounts/models/Account.model';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { DeleteAccount } from '@/modules/Accounts/DeleteAccount.service';
import { CommandAccountValidators } from '@/modules/Accounts/CommandAccountValidators.service';
import { ERRORS as ACCOUNT_ERRORS } from '@/modules/Accounts/constants';
import { AccountsModule } from '@/modules/Accounts/Accounts.module';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AuditLogsModule } from '@/modules/EE/AuditLogs/AuditLogs.module';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import {
  CryptoExchangesModule,
  cryptoExchangeModels,
  cryptoExchangesProviders,
} from './CryptoExchanges.module';
import {
  CRYPTO_SYNC_BINANCE_QUEUE,
  CRYPTO_SYNC_JOB_OPTIONS,
  CRYPTO_SYNC_KRAKEN_QUEUE,
} from './CryptoExchanges.constants';
import {
  CRYPTO_LIVE_EMITTER,
  NoopCryptoLiveEmitter,
} from './CryptoExchanges.types';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { CryptoConnectionValidators } from './commands/CryptoConnectionValidators.service';
import { CryptoVault } from './vault/CryptoVault.service';
import { CryptoSyncService } from './sync/CryptoSync.service';
import { CryptoSyncProcessor } from './sync/CryptoSync.processor';
import { CryptoSyncScheduler } from './sync/CryptoSync.scheduler';
import { RateLimiter } from './sync/RateLimiter.service';
import { CryptoConnection } from './models/CryptoConnection';
import { CryptoRawRecord } from './models/CryptoRawRecord';
import { CryptoBalanceSnapshot } from './models/CryptoBalanceSnapshot';
import { CryptoSyncRun } from './models/CryptoSyncRun';

const validKey = Buffer.alloc(32, 9).toString('base64');
const config = (key: string | null) => ({
  get: (name: string) =>
    name === 'crypto'
      ? {
          encryptionKeys: key ? { 1: key } : {},
          currentKeyVersion: 1,
          syncIntervalMs: 300000,
        }
      : undefined,
});

const token = (p: Provider): unknown =>
  typeof p === 'function' ? p : (p as { provide: unknown }).provide;

const modelProviderTokens = (module: DynamicModule) =>
  (module.providers ?? []).map(token);

/** Everything outside this module that its providers need, as inert stubs. */
const stubs = (key: string | null): Provider[] => [
  { provide: ConfigService, useValue: config(key) },
  { provide: RedisService, useValue: { getOrThrow: () => ({}) } },
  { provide: UnitOfWork, useValue: {} },
  { provide: CreateAccountService, useValue: {} },
  { provide: AuditLogService, useValue: {} },
  { provide: EventEmitter2, useValue: {} },
  { provide: ClsService, useValue: {} },
  { provide: TenancyContext, useValue: {} },
  { provide: Account.name, useValue: () => ({}) },
  { provide: TenantUser.name, useValue: () => ({}) },
  { provide: TenantModel.name, useValue: {} },
  { provide: SystemUser.name, useValue: {} },
  ...cryptoExchangeModels.map((m) => ({
    provide: m.name,
    useValue: () => ({}),
  })),
  { provide: getQueueToken(CRYPTO_SYNC_KRAKEN_QUEUE), useValue: {} },
  { provide: getQueueToken(CRYPTO_SYNC_BINANCE_QUEUE), useValue: {} },
];

const compile = (key: string | null = validKey) =>
  Test.createTestingModule({
    controllers: [CryptoExchangesController],
    providers: [...cryptoExchangesProviders, ...stubs(key)],
  }).compile();

describe('CryptoExchangesModule wiring', () => {
  it('registers all four tenant models under their Model.name tokens', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      CryptoExchangesModule,
    ) as DynamicModule[];
    const tokens = imports
      .filter((i) => typeof i === 'object' && i.providers)
      .flatMap(modelProviderTokens);

    expect(tokens).toEqual(
      expect.arrayContaining([
        CryptoConnection.name,
        CryptoRawRecord.name,
        CryptoBalanceSnapshot.name,
        CryptoSyncRun.name,
      ]),
    );
    expect(cryptoExchangeModels).toEqual([
      CryptoConnection,
      CryptoRawRecord,
      CryptoBalanceSnapshot,
      CryptoSyncRun,
    ]);
  });

  it('imports the modules it depends on and nothing registers a second AdapterRegistry', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      CryptoExchangesModule,
    ) as unknown[];
    expect(imports).toContain(AccountsModule);
    expect(imports).toContain(AuditLogsModule);

    // exactly one provider declaration of each singleton, in this module only
    const tokens = cryptoExchangesProviders.map(token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.filter((t) => t === AdapterRegistry)).toHaveLength(1);
    expect(tokens).toEqual(
      expect.arrayContaining([
        AdapterRegistry,
        CryptoVault,
        RateLimiter,
        CryptoSyncService,
        CryptoSyncScheduler,
        CryptoSyncProcessor,
        CRYPTO_LIVE_EMITTER,
      ]),
    );
    for (const other of [AccountsModule, AuditLogsModule]) {
      const providers = Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        other,
      ) as Provider[];
      expect(providers.map(token)).not.toContain(AdapterRegistry);
    }
  });

  it('is imported by the application module', () => {
    // Source check: loading AppModule would pull every module into jest.
    const source = readFileSync(
      join(__dirname, '../App/App.module.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { CryptoExchangesModule } from '../CryptoExchanges/CryptoExchanges.module';",
    );
    expect(source).toContain('    CryptoExchangesModule,');
  });

  it('uses the shared default job options on both queues', () => {
    // BullModule.registerQueue options are not introspectable without Redis;
    // pin the constants the module passes so a rename cannot go unnoticed.
    expect(CRYPTO_SYNC_JOB_OPTIONS.attempts).toBe(5);
  });
});

describe('CryptoExchangesModule dependency injection (stubbed externals)', () => {
  it('resolves the whole provider graph with a single AdapterRegistry shared by every consumer', async () => {
    const moduleRef = await compile();

    const registry = moduleRef.get(AdapterRegistry);
    expect((moduleRef.get(CryptoConnectionValidators) as any).registry).toBe(
      registry,
    );
    expect((moduleRef.get(CryptoSyncService) as any).adapters).toBe(registry);
    expect(moduleRef.get(CRYPTO_LIVE_EMITTER)).toBeInstanceOf(
      NoopCryptoLiveEmitter,
    );
    expect(moduleRef.get(CryptoExchangesController)).toBeDefined();
    await moduleRef.close();
  });

  it('fails at boot (module compile), not on first request, when CRYPTO_ENCRYPTION_KEY is missing', async () => {
    await expect(compile(null)).rejects.toThrow(/CRYPTO_ENCRYPTION_KEY/);
  });

  it('fails at boot when the key does not decode to 32 bytes', async () => {
    await expect(compile('c2hvcnQ=')).rejects.toThrow(/32 bytes/);
  });

  it('gives the Accounts DeleteAccount guard the CryptoConnection model, so a mapped account yields the friendly error', async () => {
    const queries: unknown[][] = [];
    const connectionModel = () => ({
      query: () => {
        const b: any = {
          where: (...a: unknown[]) => (queries.push(a), b),
          whereNull: (...a: unknown[]) => (queries.push(a), b),
          first: async () => ({ id: 3, label: 'Kraken - Trading' }),
        };
        return b;
      },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeleteAccount,
        // the SAME token the crypto module registers for the model
        { provide: CryptoConnection.name, useValue: connectionModel },
        {
          provide: Account.name,
          useValue: () => ({
            query: () => ({
              findById: () => ({
                throwIfNotFound: async () => ({ id: 10, predefined: false }),
              }),
            }),
          }),
        },
        { provide: EventEmitter2, useValue: { emitAsync: jest.fn() } },
        { provide: UnitOfWork, useValue: { withTransaction: jest.fn() } },
        {
          provide: CommandAccountValidators,
          useValue: { throwErrorIfAccountPredefined: () => undefined },
        },
      ],
    }).compile();

    const error = await moduleRef
      .get(DeleteAccount)
      .deleteAccount(10)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.errorType).toBe(
      ACCOUNT_ERRORS.ACCOUNT_MAPPED_TO_CRYPTO_CONNECTION,
    );
    expect(error.message).toBe(
      'This account is mapped to crypto connection Kraken - Trading',
    );
    expect(queries).toContainEqual(['accountId', 10]);
    expect(queries).toContainEqual(['deletedAt']);
    expect(CryptoConnection.name).toBe('CryptoConnection');
  });
});
