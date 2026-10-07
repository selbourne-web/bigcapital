import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CRYPTO_SYNC_BINANCE_QUEUE,
  CRYPTO_SYNC_CRYPTO_COM_APP_QUEUE,
  CRYPTO_SYNC_CRYPTO_COM_QUEUE,
  CRYPTO_SYNC_JOB,
  CRYPTO_SYNC_JOB_OPTIONS,
  CRYPTO_SYNC_KRAKEN_QUEUE,
  CryptoSyncKind,
  cryptoScheduleId,
  queueNameFor,
} from '../CryptoExchanges.constants';
import { CryptoSyncJobData } from '../CryptoExchanges.types';
import { CryptoConnection } from '../models/CryptoConnection';

const DEFAULT_SYNC_INTERVAL_MS = 300000;
/** Waiting/delayed jobs scanned when unscheduling (bounded; processors skip stale jobs anyway). */
const PENDING_SCAN_LIMIT = 1000;

type ConnectionRef = Pick<CryptoConnection, 'id' | 'exchange'>;

/**
 * Owns the crypto sync queues' producer side: the repeatable incremental job
 * of each connection and one-off runs. Every operation is idempotent.
 */
@Injectable()
export class CryptoSyncScheduler {
  private readonly logger = new Logger(CryptoSyncScheduler.name);
  private readonly queues: Record<string, Queue>;

  constructor(
    @InjectQueue(CRYPTO_SYNC_KRAKEN_QUEUE) krakenQueue: Queue,
    @InjectQueue(CRYPTO_SYNC_BINANCE_QUEUE) binanceQueue: Queue,
    @InjectQueue(CRYPTO_SYNC_CRYPTO_COM_QUEUE) cryptoComQueue: Queue,
    @InjectQueue(CRYPTO_SYNC_CRYPTO_COM_APP_QUEUE) cryptoComAppQueue: Queue,
    private readonly configService: ConfigService,
  ) {
    this.queues = {
      [CRYPTO_SYNC_KRAKEN_QUEUE]: krakenQueue,
      [CRYPTO_SYNC_BINANCE_QUEUE]: binanceQueue,
      [CRYPTO_SYNC_CRYPTO_COM_QUEUE]: cryptoComQueue,
      [CRYPTO_SYNC_CRYPTO_COM_APP_QUEUE]: cryptoComAppQueue,
    };
  }

  private queueFor(exchange: string): Queue {
    return this.queues[queueNameFor(exchange)];
  }

  private intervalMs(): number {
    const configured = this.configService.get<{ syncIntervalMs?: number }>(
      'crypto',
    )?.syncIntervalMs;
    return configured && configured > 0 ? configured : DEFAULT_SYNC_INTERVAL_MS;
  }

  /**
   * Registers the repeatable `incremental` job of a connection: scheduler id
   * `crypto-sync:<organization>:<id>`, every `crypto.syncIntervalMs`.
   *
   * Idempotent and safe on read paths: an existing scheduler with the same
   * interval is left untouched. BullMQ 5.25.6's `upsertJobScheduler` always
   * overrides and, without `prevMillis`, schedules the next run for NOW and
   * resets the cadence, so re-upserting on every call would trigger an
   * immediate sync each time (and chain duplicate delayed jobs). A missing
   * scheduler, or one whose interval changed, is (re)created; that first run
   * is immediate, which is the intended "start syncing now" behaviour.
   */
  async schedule(
    connection: ConnectionRef,
    organizationId: string,
  ): Promise<void> {
    const queue = this.queueFor(connection.exchange);
    const schedulerId = cryptoScheduleId(organizationId, connection.id);
    const every = this.intervalMs();
    // `getJobScheduler` resolves an empty object (not undefined) when the
    // scheduler does not exist, so test for its fields.
    const existing = await queue.getJobScheduler(schedulerId);
    if (existing?.name && Number(existing.every) === every) return;
    const data: CryptoSyncJobData = {
      connectionId: connection.id,
      organizationId,
      kind: 'incremental',
    };
    await queue.upsertJobScheduler(
      schedulerId,
      { every },
      {
        name: CRYPTO_SYNC_JOB,
        data,
        opts: { ...CRYPTO_SYNC_JOB_OPTIONS },
      },
    );
  }

  /**
   * Adds a one-off sync job. A repeated `jobId` is ignored by BullMQ while the
   * job still exists, which is what keeps repeated triggers from flooding.
   */
  async enqueue(
    connection: ConnectionRef,
    organizationId: string,
    kind: CryptoSyncKind,
    jobId: string,
  ): Promise<void> {
    const data: CryptoSyncJobData = {
      connectionId: connection.id,
      organizationId,
      kind,
    };
    const queue = this.queueFor(connection.exchange);
    // BullMQ ignores add() while a job with this id still exists, and finished
    // jobs are kept for a while: drop a finished one so this run really happens
    // (e.g. a rotation after an auth failure). Pending/running jobs are the
    // intended dedupe and stay.
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      try {
        await existing.remove();
      } catch (error) {
        // Just became active/locked: the running job covers this request.
        this.logger.debug(
          `Crypto sync job ${jobId} could not be replaced: ${(error as Error).message}`,
        );
        return;
      }
    }
    await queue.add(CRYPTO_SYNC_JOB, data, {
      ...CRYPTO_SYNC_JOB_OPTIONS,
      jobId,
    });
  }

  /**
   * Removes the repeatable job and any waiting/delayed job of the connection.
   * The exchange is unknown here (the row may be archived), so all queues are
   * tried. A job that is running or locked is left; the processor skips it
   * because the connection is paused or archived by then.
   */
  async unschedule(
    organizationId: string,
    connectionId: number,
  ): Promise<void> {
    for (const queue of Object.values(this.queues)) {
      await queue.removeJobScheduler(
        cryptoScheduleId(organizationId, connectionId),
      );
      const pending = await queue.getJobs(
        ['waiting', 'delayed', 'prioritized'],
        0,
        PENDING_SCAN_LIMIT - 1,
      );
      for (const pendingJob of pending) {
        // The queues are shared by all tenants, whose connection ids collide.
        if (
          pendingJob?.data?.connectionId !== connectionId ||
          String(pendingJob?.data?.organizationId) !== String(organizationId)
        ) {
          continue;
        }
        try {
          await pendingJob.remove();
        } catch (error) {
          this.logger.debug(
            `Crypto sync job ${pendingJob.id} could not be removed: ${
              (error as Error).message
            }`,
          );
        }
      }
    }
  }
}
