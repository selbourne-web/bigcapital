import { Inject, Injectable, Logger, Scope } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { Job, UnrecoverableError } from 'bullmq';
import { ClsService, UseCls } from 'nestjs-cls';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { SystemUser } from '@/modules/System/models/SystemUser';
import {
  CRYPTO_HELD_ASSETS_KEY,
  CRYPTO_HELD_ASSETS_TTL_SECONDS,
  CRYPTO_SYNC_BINANCE_QUEUE,
  CRYPTO_SYNC_CRYPTO_COM_APP_QUEUE,
  CRYPTO_SYNC_CRYPTO_COM_QUEUE,
  CRYPTO_SYNC_KRAKEN_QUEUE,
  CRYPTO_SYNC_PIONEX_QUEUE,
  CryptoSyncKind,
  cryptoContinuationJobId,
} from '../CryptoExchanges.constants';
import {
  CRYPTO_LIVE_EMITTER,
  CryptoLiveEmitter,
  CryptoSyncJobData,
} from '../CryptoExchanges.types';
import { CryptoConnectionRepository } from '../commands/CryptoConnection.repository';
import { ExchangeError } from '../adapters/errors';
import { pricingAssets } from '../adapters/assets';
import { CryptoSyncResult, CryptoSyncService } from './CryptoSync.service';
import { CryptoSyncScheduler } from './CryptoSync.scheduler';

export type CryptoSyncJobOutcome =
  | { skipped: string }
  | { status: string; continued: boolean };

/**
 * Runs one crypto sync job: sets the tenant context, re-loads the connection
 * (jobs may outlive it), runs one bounded slice, then publishes the outcome.
 * All exchange queues are served by thin `@Processor` workers below that
 * delegate here.
 */
@Injectable()
export class CryptoSyncProcessor {
  private readonly logger = new Logger(CryptoSyncProcessor.name);

  constructor(
    private readonly clsService: ClsService,
    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
    private readonly connections: CryptoConnectionRepository,
    private readonly syncService: CryptoSyncService,
    private readonly scheduler: CryptoSyncScheduler,
    private readonly redisService: RedisService,
    @Inject(CRYPTO_LIVE_EMITTER)
    private readonly liveEmitter: CryptoLiveEmitter,
  ) {}

  /**
   * Must run inside a CLS context (`@UseCls` on the worker).
   * Throws `UnrecoverableError` for failures a retry cannot fix; every other
   * failure is rethrown so the queue's exponential backoff retries it.
   */
  async process(
    job: Pick<Job<CryptoSyncJobData>, 'data'>,
  ): Promise<CryptoSyncJobOutcome> {
    const { connectionId, organizationId, kind } = job.data;

    const tenant = await this.tenantModel.query().findOne({ organizationId });
    if (!tenant) {
      this.logger.warn(
        `Crypto sync job skipped: tenant ${organizationId} not found`,
      );
      return { skipped: 'tenant-missing' };
    }
    const user = await this.systemUserModel
      .query()
      .findOne({ tenantId: tenant.id })
      .modify('active');
    if (!user) {
      throw new UnrecoverableError(
        `No active system user for tenant ${organizationId}`,
      );
    }
    this.clsService.set('organizationId', tenant.organizationId);
    this.clsService.set('userId', user.id);

    // Load the row BEFORE the service: archived rows hold blank credentials and
    // must never reach decryption.
    const connection = await this.connections.findById(connectionId);
    const skip = this.skipReason(connection, kind);
    if (skip) {
      return { skipped: skip };
    }

    let result: CryptoSyncResult;
    try {
      result = await this.syncService.syncConnection(
        connectionId,
        kind,
        organizationId,
      );
    } catch (error) {
      if (error instanceof ExchangeError && !error.retryable) {
        // Auth / extra permissions / refused state: the service already
        // recorded it; retrying cannot help.
        throw new UnrecoverableError(error.userMessage);
      }
      throw error;
    }

    if (result.status === 'failed') {
      // The service returns (rather than throws) a failed run for credential
      // problems and has already set the connection to `error`.
      throw new UnrecoverableError(this.failureMessage(result));
    }

    const progressed =
      result.status === 'succeeded' ||
      result.continuation ||
      (result.fetchedCount ?? 0) > 0 ||
      (result.insertedCount ?? 0) > 0;
    if (!progressed) {
      // Schema-blocked / no-progress partial: not a success, never re-enqueued.
      return { status: result.status, continued: false };
    }

    if (
      kind === 'manual' &&
      connection.status === 'error' &&
      result.status === 'succeeded'
    ) {
      await this.connections.markActive(connectionId);
    }
    await this.publishHeldAssets(connectionId);
    this.notify(organizationId, connectionId, result.status);

    let continued = false;
    if (result.continuation) {
      await this.scheduler.enqueue(
        connection,
        organizationId,
        connection.initialSyncCompletedAt ? 'incremental' : 'initial',
        cryptoContinuationJobId(organizationId, connectionId, result.id),
      );
      continued = true;
    }
    return { status: result.status, continued };
  }

  private skipReason(
    connection: Awaited<ReturnType<CryptoConnectionRepository['findById']>>,
    kind: CryptoSyncKind,
  ): string | undefined {
    if (!connection) return 'connection-missing';
    if (connection.deletedAt) return 'connection-archived';
    if (connection.status === 'paused') return 'connection-paused';
    if (connection.status === 'error' && kind !== 'manual') {
      return 'connection-error';
    }
    return undefined;
  }

  private failureMessage(result: CryptoSyncResult): string {
    try {
      const errors = JSON.parse(result.errors ?? '[]') as {
        message?: string;
      }[];
      return errors[errors.length - 1]?.message ?? 'Crypto sync failed';
    } catch {
      return 'Crypto sync failed';
    }
  }

  /** Best effort: the sync already succeeded, so a Redis failure must not retry it. */
  private async publishHeldAssets(connectionId: number): Promise<void> {
    try {
      // Pricing looks through Binance Simple Earn LD<X> tokens to X (balances stay raw).
      const assets = pricingAssets(
        await this.syncService.heldAssets(connectionId),
      );
      if (!assets.length) return;
      const redis = this.redisService.getOrThrow();
      await redis.sadd(CRYPTO_HELD_ASSETS_KEY, ...assets);
      await redis.expire(
        CRYPTO_HELD_ASSETS_KEY,
        CRYPTO_HELD_ASSETS_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Could not update ${CRYPTO_HELD_ASSETS_KEY} for connection ${connectionId}: ${
          (error as Error).message
        }`,
      );
    }
  }

  /** Ids and status only: never balances, never credentials. */
  private notify(organizationId: string, connectionId: number, status: string) {
    try {
      this.liveEmitter.connectionSynced(organizationId, connectionId, status);
    } catch (error) {
      this.logger.warn(
        `Live notification failed for connection ${connectionId}: ${
          (error as Error).message
        }`,
      );
    }
  }
}

@Processor({ name: CRYPTO_SYNC_KRAKEN_QUEUE, scope: Scope.REQUEST })
export class KrakenSyncWorker extends WorkerHost {
  constructor(private readonly processor: CryptoSyncProcessor) {
    super();
  }

  @UseCls()
  async process(job: Job<CryptoSyncJobData>) {
    return this.processor.process(job);
  }
}

@Processor({ name: CRYPTO_SYNC_BINANCE_QUEUE, scope: Scope.REQUEST })
export class BinanceSyncWorker extends WorkerHost {
  constructor(private readonly processor: CryptoSyncProcessor) {
    super();
  }

  @UseCls()
  async process(job: Job<CryptoSyncJobData>) {
    return this.processor.process(job);
  }
}

@Processor({ name: CRYPTO_SYNC_CRYPTO_COM_QUEUE, scope: Scope.REQUEST })
export class CryptoComSyncWorker extends WorkerHost {
  constructor(private readonly processor: CryptoSyncProcessor) {
    super();
  }

  @UseCls()
  async process(job: Job<CryptoSyncJobData>) {
    return this.processor.process(job);
  }
}

@Processor({ name: CRYPTO_SYNC_CRYPTO_COM_APP_QUEUE, scope: Scope.REQUEST })
export class CryptoComAppSyncWorker extends WorkerHost {
  constructor(private readonly processor: CryptoSyncProcessor) {
    super();
  }

  @UseCls()
  async process(job: Job<CryptoSyncJobData>) {
    return this.processor.process(job);
  }
}

@Processor({ name: CRYPTO_SYNC_PIONEX_QUEUE, scope: Scope.REQUEST })
export class CryptoPionexSyncWorker extends WorkerHost {
  constructor(private readonly processor: CryptoSyncProcessor) {
    super();
  }

  @UseCls()
  async process(job: Job<CryptoSyncJobData>) {
    return this.processor.process(job);
  }
}
