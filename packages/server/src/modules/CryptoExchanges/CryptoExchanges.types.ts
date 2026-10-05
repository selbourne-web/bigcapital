import { CryptoSyncKind } from './CryptoExchanges.constants';

/** Payload of every job on the crypto sync queues. Ids only, never credentials. */
export interface CryptoSyncJobData {
  connectionId: number;
  organizationId: string;
  kind: CryptoSyncKind;
}

/**
 * Tells connected browsers that a connection finished a sync. Carries ids and
 * status only: never balances, never credentials. Implemented by
 * `CryptoLiveEmitterService` (CryptoLive module), which provides this token globally.
 * The token and interface live here, in a leaf file, so neither module imports the other.
 */
export interface CryptoLiveEmitter {
  connectionSynced(
    organizationId: string,
    connectionId: number,
    status: string,
  ): void;
}

export const CRYPTO_LIVE_EMITTER = 'CRYPTO_LIVE_EMITTER';
