import { Global, Module } from '@nestjs/common';
import { PriceCache } from './PriceCache.service';
import { PriceFeedManager } from './PriceFeedManager.service';

/**
 * Global, tenant-agnostic price service: public exchange tickers only, no tenant data
 * and no tenant models. It only reads the Redis set `crypto:held-assets` (asset symbols).
 * Task 11's gateway consumes `PriceFeedManager.onQuote` and `PriceCache`.
 */
@Global()
@Module({
  providers: [PriceCache, PriceFeedManager],
  exports: [PriceCache, PriceFeedManager],
})
export class CryptoPricesModule {}
