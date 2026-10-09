import { Knex } from 'knex';

/**
 * Domain events for crypto connections. Task 8 subscribes to schedule and
 * unschedule syncing. Emitted inside the unit of work with its `trx`, like
 * the other modules' events, so listeners that need the committed row should
 * defer work until the transaction completes.
 */
export const cryptoEvents = {
  connection: {
    created: 'crypto.connection.created',
    paused: 'crypto.connection.paused',
    resumed: 'crypto.connection.resumed',
    deleted: 'crypto.connection.deleted',
    credentialsRotated: 'crypto.connection.credentials-rotated',
  },
  /** CSV import lifecycle (no listener schedules anything from these). */
  csvImport: {
    committed: 'crypto.csv-import.committed',
    rolledBack: 'crypto.csv-import.rolled-back',
  },
} as const;

export interface CryptoConnectionEventPayload {
  connectionId: number;
  organizationId?: number;
  trx?: Knex.Transaction;
}
