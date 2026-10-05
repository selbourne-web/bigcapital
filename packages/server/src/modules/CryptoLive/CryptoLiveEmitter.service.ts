import { Injectable, Logger } from '@nestjs/common';
import { CryptoLiveEmitter } from '../CryptoExchanges/CryptoExchanges.types';
import { CryptoLiveGateway } from './CryptoLive.gateway';

/**
 * The real `CryptoLiveEmitter` (token `CRYPTO_LIVE_EMITTER`): relays "connection synced"
 * to the owning tenant's room through the gateway. Ids and status only.
 */
@Injectable()
export class CryptoLiveEmitterService implements CryptoLiveEmitter {
  private readonly logger = new Logger(CryptoLiveEmitterService.name);

  constructor(private readonly gateway: CryptoLiveGateway) {}

  connectionSynced(
    organizationId: string,
    connectionId: number,
    status: string,
  ): void {
    try {
      this.gateway.emitConnectionSynced(organizationId, connectionId, status);
    } catch {
      // A broadcast failure must never fail a sync; do not log the error object.
      this.logger.warn('Live emit failed');
    }
  }
}
