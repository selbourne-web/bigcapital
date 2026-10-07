import { Injectable } from '@nestjs/common';
import { CryptoExchangeId } from '../CryptoExchanges.constants';
import { ExchangeAdapter } from './ExchangeAdapter';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';
import { CryptoComAdapter } from './cryptocom/CryptoComAdapter';
import { CryptoComAppAdapter } from './cryptocomapp/CryptoComAppAdapter';
import { PionexAdapter } from './pionex/PionexAdapter';

/**
 * Maps an exchange id to its adapter. Add a new adapter to `buildAdapters`
 * (the Crypto.com Exchange and App adapters register here).
 */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<CryptoExchangeId, ExchangeAdapter>();

  constructor() {
    for (const adapter of AdapterRegistry.buildAdapters()) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  private static buildAdapters(): ExchangeAdapter[] {
    return [
      new KrakenAdapter(),
      new BinanceAdapter(),
      new CryptoComAdapter(),
      new CryptoComAppAdapter(),
      new PionexAdapter(),
    ];
  }

  get(exchange: CryptoExchangeId): ExchangeAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) {
      throw new Error(`Unsupported exchange: ${exchange}`);
    }
    return adapter;
  }
}
