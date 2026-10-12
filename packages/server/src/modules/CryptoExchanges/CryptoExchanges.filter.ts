import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { ServiceError } from '@/modules/Items/ServiceError';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CRYPTO_CSV_IMPORT_ERRORS,
} from './CryptoExchanges.constants';
import {
  ExchangeAuthError,
  ExchangeError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
  KeyHasExtraPermissionsError,
} from './adapters/errors';
import { CsvErrorCode, CsvImportError } from './csv/csv.types';
import { CryptoManualSyncThrottledException } from './sync/CryptoSyncRequest.service';

/** Conflicts with the connection's current state (the commands raise them as plain 400s). */
const CONFLICT_ERRORS: ReadonlySet<string> = new Set([
  ERRORS.ACCOUNT_ALREADY_MAPPED,
  ERRORS.ACCOUNT_MAPPING_CONFLICT,
  ERRORS.IN_ERROR,
  ERRORS.CONNECTION_PAUSED,
  ERRORS.CONNECTION_CSV_ONLY,
]);

/** HTTP status of every CSV import error code (exhaustive: a new code fails to compile). */
export const CSV_ERROR_STATUS: Record<CsvErrorCode, number> = {
  CSV_FORMAT_UNRECOGNIZED: HttpStatus.UNPROCESSABLE_ENTITY,
  CSV_DERIVED_EXPORT_REFUSED: HttpStatus.UNPROCESSABLE_ENTITY,
  CSV_MALFORMED: HttpStatus.UNPROCESSABLE_ENTITY,
  CSV_DUPLICATE_FILE: HttpStatus.CONFLICT,
  CSV_FILE_CHANGED: HttpStatus.CONFLICT,
  CSV_NOT_ROLLBACKABLE: HttpStatus.CONFLICT,
  CSV_NOT_COMMITTABLE: HttpStatus.CONFLICT,
  CSV_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  CSV_BUSY: HttpStatus.SERVICE_UNAVAILABLE,
};
const CSV_BUSY_RETRY_AFTER_SECONDS = 5;

/** A missing import is a 404 like the other NOT_FOUND ServiceErrors. */
const NOT_FOUND_ERRORS: ReadonlySet<string> = new Set([
  CRYPTO_CSV_IMPORT_ERRORS.NOT_FOUND,
]);

/**
 * Error mapping of the crypto REST API.
 *
 *  - `ServiceError`: same body as the app-wide ServiceErrorFilter
 *    (`{ errors: [{ statusCode, type, message, payload }] }`, `type` is the
 *    machine-readable code), with state conflicts answered as 409.
 *  - Exchange failures: flat `{ code, message }` like the existing 422
 *    `{ code: 'ATTESTATION_REQUIRED' }`. `message` is always the adapter's
 *    `userMessage`; the raw exchange text never leaves the server.
 *  - Manual sync throttle: 429 + `Retry-After`.
 */
@Catch(
  ExchangeError,
  ServiceError,
  CryptoManualSyncThrottledException,
  CsvImportError,
)
export class CryptoExchangeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof CryptoManualSyncThrottledException) {
      response
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .setHeader('Retry-After', String(exception.retryAfterSeconds))
        .json({
          code: 'CRYPTO_SYNC_THROTTLED',
          message: 'A sync was requested a moment ago. Try again shortly.',
          retryAfterSeconds: exception.retryAfterSeconds,
        });
      return;
    }

    if (exception instanceof CsvImportError) {
      // `{ code, message }` only (plus the ids blocking a rollback): never
      // row contents, a stack, or the raw file name.
      const status =
        CSV_ERROR_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
      const body: Record<string, unknown> = {
        code: exception.code,
        message: exception.message,
      };
      const dependents = exception.details?.dependentImportIds;
      if (
        exception.code === 'CSV_NOT_ROLLBACKABLE' &&
        Array.isArray(dependents)
      ) {
        body.dependentImportIds = dependents
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id));
      }
      if (exception.code === 'CSV_BUSY') {
        response.setHeader('Retry-After', String(CSV_BUSY_RETRY_AFTER_SECONDS));
      }
      response.status(status).json(body);
      return;
    }

    if (exception instanceof ServiceError) {
      const status = NOT_FOUND_ERRORS.has(exception.errorType)
        ? HttpStatus.NOT_FOUND
        : CONFLICT_ERRORS.has(exception.errorType)
          ? HttpStatus.CONFLICT
          : exception.getStatus();
      response.status(status).json({
        errors: [
          {
            statusCode: status,
            type: exception.errorType,
            message: exception.message,
            payload: exception.payload,
          },
        ],
      });
      return;
    }

    const error = exception as ExchangeError;
    if (error instanceof KeyHasExtraPermissionsError) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        code: 'KEY_HAS_EXTRA_PERMISSIONS',
        permissions: error.permissions,
        message: error.userMessage,
      });
      return;
    }

    let status = HttpStatus.BAD_GATEWAY;
    let code = 'EXCHANGE_ERROR';
    if (error instanceof ExchangeAuthError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      code = 'EXCHANGE_AUTH_FAILED';
    } else if (error instanceof ExchangeRateLimitError) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      code = 'EXCHANGE_RATE_LIMITED';
      if (error.retryAfterMs) {
        response.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
        );
      }
    } else if (error instanceof ExchangeNetworkError) {
      code = 'EXCHANGE_UNREACHABLE';
    } else if (error instanceof ExchangeSchemaError) {
      code = 'EXCHANGE_UNEXPECTED_RESPONSE';
    }
    response.status(status).json({ code, message: error.userMessage });
  }
}
