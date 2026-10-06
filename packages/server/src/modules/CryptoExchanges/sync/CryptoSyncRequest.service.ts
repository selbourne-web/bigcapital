import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  cryptoManualJobId,
} from '../CryptoExchanges.constants';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoConnectionRepository } from '../commands/CryptoConnection.repository';
import { CryptoSyncScheduler } from './CryptoSync.scheduler';

/** One manual sync per connection per minute. */
export const CRYPTO_MANUAL_SYNC_COOLDOWN_MS = 60_000;

const throttleKey = (organizationId: string, connectionId: number) =>
  `crypto:manual-sync:${organizationId}:${connectionId}`;

/** 429; the controller's filter turns `retryAfterSeconds` into the Retry-After header. */
export class CryptoManualSyncThrottledException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('Manual sync is rate limited.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

type ConnectionRef = Pick<CryptoConnection, 'id' | 'exchange' | 'status'>;

/**
 * What the REST API asks of the sync machinery on behalf of a user: a manual
 * sync request and the best-effort re-registration of repeatable jobs.
 */
@Injectable()
export class CryptoSyncRequestService {
  private readonly logger = new Logger(CryptoSyncRequestService.name);

  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly scheduler: CryptoSyncScheduler,
    private readonly redisService: RedisService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Lazy self-heal: re-registers the repeatable incremental job of every active
   * connection (an idempotent upsert), so jobs lost to a Redis flush come back
   * the next time someone opens the connections list. There is no boot-time
   * reconciler (each tenant has its own database), so Redis MUST persist its
   * data (AOF or RDB) in production; this only repairs an accidental loss.
   * Never rejects: a Redis failure must not fail the user's request.
   */
  async selfHeal(connections: ConnectionRef[]): Promise<void> {
    const organizationId = this.cls.get<string>('organizationId');
    if (!organizationId) return;
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      try {
        await this.scheduler.schedule(connection, String(organizationId));
      } catch (error) {
        // Ids and the error message only: nothing here can hold credentials.
        this.logger.warn(
          `Could not re-register the sync schedule of crypto connection ${connection.id}: ${
            (error as Error)?.message
          }`,
        );
      }
    }
  }

  /**
   * Queues a `manual` sync of one connection and returns immediately; the sync
   * itself runs on the queue worker. Limited to one request per connection per
   * 60 s with a Redis key (`SET NX PX`), the same Redis the queues use: the
   * app's `@Throttle` decorator limits per client and route, not per tenant
   * connection, so it cannot express this.
   * Paused and archived connections are refused; an `error` connection may be
   * synced manually (a successful run reactivates it).
   */
  async requestManualSync(connectionId: number): Promise<void> {
    const connection = await this.connections.findById(connectionId);
    if (!connection) {
      throw new ServiceError(
        ERRORS.NOT_FOUND,
        'Crypto connection not found.',
        undefined,
        HttpStatus.NOT_FOUND,
      );
    }
    if (connection.status === 'paused') {
      throw new ServiceError(
        ERRORS.CONNECTION_PAUSED,
        'This connection is paused. Resume it to sync.',
        undefined,
        HttpStatus.CONFLICT,
      );
    }

    const organizationId = this.cls.get<string>('organizationId');
    if (!organizationId) {
      throw new Error('Crypto manual sync requires a tenant context.');
    }
    const key = throttleKey(organizationId, connection.id);
    const redis = this.redisService.getOrThrow();
    const acquired = await redis.set(
      key,
      '1',
      'PX',
      CRYPTO_MANUAL_SYNC_COOLDOWN_MS,
      'NX',
    );
    if (acquired !== 'OK') {
      const remainingMs = await redis.pttl(key);
      throw new CryptoManualSyncThrottledException(
        remainingMs > 0
          ? Math.ceil(remainingMs / 1000)
          : CRYPTO_MANUAL_SYNC_COOLDOWN_MS / 1000,
      );
    }

    try {
      await this.selfHeal([connection]);
      await this.scheduler.enqueue(
        connection,
        String(organizationId),
        'manual',
        cryptoManualJobId(String(organizationId), connection.id, randomUUID()),
      );
    } catch (error) {
      // Nothing was queued: do not make the user wait out the cooldown.
      await redis.del(key).catch(() => undefined);
      throw error;
    }
  }
}
