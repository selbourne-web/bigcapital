import { Injectable } from '@nestjs/common';
import { CryptoExchangeId } from '../CryptoExchanges.constants';
import { ExchangeAdapter } from './ExchangeAdapter';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';

/** Maps an exchange id to its adapter. Piece 1 supports Kraken and Binance only. */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<CryptoExchangeId, ExchangeAdapter>();

  constructor() {
    for (const adapter of [new KrakenAdapter(), new BinanceAdapter()]) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(exchange: CryptoExchangeId): ExchangeAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) {
      throw new Error(`Unsupported exchange: ${exchange}`);
    }
    return adapter;
  }
}
