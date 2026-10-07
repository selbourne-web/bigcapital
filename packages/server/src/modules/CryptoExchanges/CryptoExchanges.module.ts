import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Module, Provider } from '@nestjs/common';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { RegisterTenancyModel } from '../Tenancy/TenancyModels/Tenancy.module';
import { AccountsModule } from '../Accounts/Accounts.module';
import { AuditLogsModule } from '../EE/AuditLogs/AuditLogs.module';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import {
  CRYPTO_SYNC_JOB_OPTIONS,
  CRYPTO_SYNC_QUEUE_NAMES,
} from './CryptoExchanges.constants';
import { CryptoConnection } from './models/CryptoConnection';
import { CryptoRawRecord } from './models/CryptoRawRecord';
import { CryptoBalanceSnapshot } from './models/CryptoBalanceSnapshot';
import { CryptoSyncRun } from './models/CryptoSyncRun';
import { CryptoVault } from './vault/CryptoVault.service';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { RateLimiter } from './sync/RateLimiter.service';
import { CryptoSyncService } from './sync/CryptoSync.service';
import { CryptoSyncScheduler } from './sync/CryptoSync.scheduler';
import {
  BinanceSyncWorker,
  CryptoComAppSyncWorker,
  CryptoComSyncWorker,
  CryptoSyncProcessor,
  KrakenSyncWorker,
} from './sync/CryptoSync.processor';
import { CryptoSyncConnectionSubscriber } from './sync/CryptoSync.subscriber';
import { CryptoSyncRequestService } from './sync/CryptoSyncRequest.service';
import { CryptoConnectionRepository } from './commands/CryptoConnection.repository';
import { CryptoConnectionValidators } from './commands/CryptoConnectionValidators.service';
import { CreateCryptoConnectionService } from './commands/CreateCryptoConnection.service';
import { UpdateCryptoConnectionService } from './commands/UpdateCryptoConnection.service';
import { RotateCryptoCredentialsService } from './commands/RotateCryptoCredentials.service';
import { DeleteCryptoConnectionService } from './commands/DeleteCryptoConnection.service';
import { GetCryptoConnectionsService } from './queries/GetCryptoConnections.service';
import { GetCryptoBalancesService } from './queries/GetCryptoBalances.service';
import { GetCryptoSyncRunsService } from './queries/GetCryptoSyncRuns.service';

/**
 * Tenant models. Registering `CryptoConnection` is also what activates the
 * Accounts `DeleteAccount` guard (it injects `CryptoConnection.name` as an
 * optional dependency and refuses to delete a mapped account).
 */
export const cryptoExchangeModels = [
  CryptoConnection,
  CryptoRawRecord,
  CryptoBalanceSnapshot,
  CryptoSyncRun,
];
const models = cryptoExchangeModels.map((model) => RegisterTenancyModel(model));

/**
 * Each provider is declared exactly once, here. In particular `AdapterRegistry`
 * owns the one `KrakenAdapter` whose per-instance lock serialises Kraken
 * nonces: a second provider instance (or a second module declaring it) would
 * break that. Other modules must IMPORT this module, never re-declare it.
 *
 * `CryptoVault` depends on nothing request-scoped, so Nest builds it at
 * application start and its constructor throws when CRYPTO_ENCRYPTION_KEY is
 * missing or invalid: the app refuses to boot without the key.
 */
export const cryptoExchangesProviders: Provider[] = [
  CryptoVault,
  AdapterRegistry,
  RateLimiter,
  CryptoSyncService,
  CryptoSyncScheduler,
  CryptoSyncProcessor,
  KrakenSyncWorker,
  BinanceSyncWorker,
  CryptoComSyncWorker,
  CryptoComAppSyncWorker,
  CryptoSyncConnectionSubscriber,
  CryptoSyncRequestService,
  CryptoConnectionRepository,
  CryptoConnectionValidators,
  CreateCryptoConnectionService,
  UpdateCryptoConnectionService,
  RotateCryptoCredentialsService,
  DeleteCryptoConnectionService,
  GetCryptoConnectionsService,
  GetCryptoBalancesService,
  GetCryptoSyncRunsService,
  // CRYPTO_LIVE_EMITTER is provided globally by CryptoLiveModule (real Socket.IO emitter).
];

@Module({
  imports: [
    ConfigModule,
    TenancyModule,
    AccountsModule,
    AuditLogsModule,
    ...CRYPTO_SYNC_QUEUE_NAMES.map((name) =>
      BullModule.registerQueue({
        name,
        defaultJobOptions: { ...CRYPTO_SYNC_JOB_OPTIONS } as any,
      }),
    ),
    ...CRYPTO_SYNC_QUEUE_NAMES.map((name) =>
      BullBoardModule.forFeature({ name, adapter: BullMQAdapter }),
    ),
    ...models,
  ],
  controllers: [CryptoExchangesController],
  providers: cryptoExchangesProviders,
  // The vault and models are what later pieces (valuation, journals) read from.
  exports: [CryptoVault, CryptoConnectionRepository, ...models],
})
export class CryptoExchangesModule {}
