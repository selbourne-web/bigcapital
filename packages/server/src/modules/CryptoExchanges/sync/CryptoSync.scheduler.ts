import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CRYPTO_SYNC_BINANCE_QUEUE,
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
    private readonly configService: ConfigService,
  ) {
    this.queues = {
      [CRYPTO_SYNC_KRAKEN_QUEUE]: krakenQueue,
      [CRYPTO_SYNC_BINANCE_QUEUE]: binanceQueue,
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
   * Registers (or updates) the repeatable `incremental` job of a connection:
   * scheduler id `crypto-sync:<id>`, every `crypto.syncIntervalMs`.
   */
  async schedule(
    connection: ConnectionRef,
    organizationId: string,
  ): Promise<void> {
    const data: CryptoSyncJobData = {
      connectionId: connection.id,
      organizationId,
      kind: 'incremental',
    };
    await this.queueFor(connection.exchange).upsertJobScheduler(
      cryptoScheduleId(connection.id),
      { every: this.intervalMs() },
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
   * The exchange is unknown here (the row may be archived), so both queues are
   * tried. A job that is running or locked is left; the processor skips it
   * because the connection is paused or archived by then.
   */
  async unschedule(connectionId: number): Promise<void> {
    for (const queue of Object.values(this.queues)) {
      await queue.removeJobScheduler(cryptoScheduleId(connectionId));
      const pending = await queue.getJobs(
        ['waiting', 'delayed', 'prioritized'],
        0,
        PENDING_SCAN_LIMIT - 1,
      );
      for (const pendingJob of pending) {
        if (pendingJob?.data?.connectionId !== connectionId) continue;
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
