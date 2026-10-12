import { HttpStatus } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { CRYPTO_CONNECTION_ERRORS as ERRORS } from '../CryptoExchanges.constants';
import { CryptoConnection } from '../models/CryptoConnection';

/**
 * Guard of every API-only action (manual sync, pause/resume, credential
 * rotation / reconnect): a `csv_only` connection has no adapter, credentials or
 * sync queue, so the action is refused with 409 CRYPTO_CONNECTION_CSV_ONLY.
 * Rows without a mode (written before the column existed) are API rows.
 */
export const assertApiMode = (
  connection: Pick<CryptoConnection, 'mode'>,
): void => {
  if (connection.mode === 'csv_only') {
    throw new ServiceError(
      ERRORS.CONNECTION_CSV_ONLY,
      'This connection is fed by CSV imports only and has no API key, so it cannot be synced, paused, resumed or reconnected.',
      undefined,
      HttpStatus.CONFLICT,
    );
  }
};

/** True for a connection that is fed by CSV imports only. */
export const isCsvOnly = (connection: { mode?: string | null }): boolean =>
  connection.mode === 'csv_only';
