import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CryptoConnectionEventPayload,
  cryptoEvents,
} from '../CryptoExchanges.events';
import { CryptoSyncKind, cryptoStartJobId } from '../CryptoExchanges.constants';
import { CryptoConnectionRepository } from '../commands/CryptoConnection.repository';
import { CryptoConnection } from '../models/CryptoConnection';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';
import { CryptoSyncScheduler } from './CryptoSync.scheduler';

/**
 * Turns connection events into queue operations.
 *
 * The events are emitted with the OPEN transaction and `UnitOfWork` does not
 * await the commit, so nothing is queued directly: every action waits for
 * `trx.executionPromise` (resolves on commit, rejects on rollback; a rolled
 * back transaction does nothing). Workers re-load the connection by id, so a
 * missing, archived, paused or errored row is skipped there as well.
 *
 * Limit: a payload without a transaction (or one with no `executionPromise`)
 * runs immediately, because there is nothing to wait for.
 */
@Injectable()
export class CryptoSyncConnectionSubscriber {
  private readonly logger = new Logger(CryptoSyncConnectionSubscriber.name);

  constructor(
    private readonly scheduler: CryptoSyncScheduler,
    private readonly connections: CryptoConnectionRepository,
  ) {}

  @OnEvent(cryptoEvents.connection.created)
  async onCreated(payload: CryptoConnectionEventPayload): Promise<void> {
    this.afterCommit(payload, 'created', async (organizationId) => {
      const connection = await this.activeConnection(payload.connectionId);
      if (!connection) return;
      this.requireOrganization(organizationId);
      await this.scheduler.enqueue(
        connection,
        organizationId,
        'initial',
        cryptoStartJobId(organizationId, connection.id, 'initial'),
      );
      await this.scheduler.schedule(connection, organizationId);
    });
  }

  @OnEvent(cryptoEvents.connection.resumed)
  async onResumed(payload: CryptoConnectionEventPayload): Promise<void> {
    this.afterCommit(payload, 'resumed', async (organizationId) => {
      const connection = await this.activeConnection(payload.connectionId);
      if (!connection) return;
      this.requireOrganization(organizationId);
      await this.scheduler.schedule(connection, organizationId);
    });
  }

  /** Rotation flips paused/error to active without a `resumed` event, so it must (re)schedule. */
  @OnEvent(cryptoEvents.connection.credentialsRotated)
  async onCredentialsRotated(
    payload: CryptoConnectionEventPayload,
  ): Promise<void> {
    this.afterCommit(payload, 'credentials-rotated', async (organizationId) => {
      const connection = await this.activeConnection(payload.connectionId);
      if (!connection) return;
      this.requireOrganization(organizationId);
      await this.scheduler.schedule(connection, organizationId);
      const kind: CryptoSyncKind = connection.initialSyncCompletedAt
        ? 'incremental'
        : 'initial';
      await this.scheduler.enqueue(
        connection,
        organizationId,
        kind,
        cryptoStartJobId(organizationId, connection.id, kind),
      );
    });
  }

  @OnEvent(cryptoEvents.connection.paused)
  async onPaused(payload: CryptoConnectionEventPayload): Promise<void> {
    this.afterCommit(payload, 'paused', (organizationId) => {
      this.requireOrganization(organizationId);
      return this.scheduler.unschedule(organizationId, payload.connectionId);
    });
  }

  @OnEvent(cryptoEvents.connection.deleted)
  async onDeleted(payload: CryptoConnectionEventPayload): Promise<void> {
    this.afterCommit(payload, 'deleted', (organizationId) => {
      this.requireOrganization(organizationId);
      return this.scheduler.unschedule(organizationId, payload.connectionId);
    });
  }

  private requireOrganization(organizationId: string): void {
    if (!organizationId) throw new Error('event has no organization id');
  }

  /** The row as committed, only if it may sync (not archived, status active). */
  private async activeConnection(
    connectionId: number,
  ): Promise<CryptoConnection | undefined> {
    const connection = await this.connections.findById(connectionId);
    if (!connection || connection.deletedAt || connection.status !== 'active') {
      return undefined;
    }
    return connection;
  }

  private afterCommit(
    payload: CryptoConnectionEventPayload,
    event: string,
    action: (organizationId: string) => Promise<unknown>,
  ): void {
    const organizationId = String(payload.organizationId ?? '');
    runAfterTransaction(payload.trx, async () => {
      try {
        await action(organizationId);
      } catch (error) {
        // Never rethrow: runAfterTransaction would raise it outside any handler.
        this.logger.error(
          `Crypto connection ${payload.connectionId} "${event}" scheduling failed: ${
            (error as Error).message
          }`,
        );
      }
    });
  }
}
