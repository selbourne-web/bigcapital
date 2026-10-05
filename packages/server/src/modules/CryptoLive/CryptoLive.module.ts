import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CRYPTO_LIVE_EMITTER } from '../CryptoExchanges/CryptoExchanges.types';
import { CryptoLiveAuth } from './CryptoLiveAuth.service';
import { CryptoLiveGateway } from './CryptoLive.gateway';
import { CryptoLiveEmitterService } from './CryptoLiveEmitter.service';

/**
 * The token and its interface stay in `CryptoExchanges.types.ts`, a leaf file that
 * imports only constants. This module imports that file (not the `CryptoExchanges`
 * module) and provides the real emitter globally, so `CryptoExchanges` injects it
 * without either module importing the other: no module cycle.
 */
export { CRYPTO_LIVE_EMITTER };

export const cryptoLiveProviders: Provider[] = [
  CryptoLiveAuth,
  CryptoLiveGateway,
  CryptoLiveEmitterService,
  { provide: CRYPTO_LIVE_EMITTER, useExisting: CryptoLiveEmitterService },
];

/**
 * Authenticated live channel (`/crypto` namespace): throttled price ticks and
 * connection-synced notices. Relies on the global `SystemModelsModule` (system
 * models) and `CryptoPricesModule` (`PriceFeedManager`).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: cryptoLiveProviders,
  exports: [CRYPTO_LIVE_EMITTER],
})
export class CryptoLiveModule {}
