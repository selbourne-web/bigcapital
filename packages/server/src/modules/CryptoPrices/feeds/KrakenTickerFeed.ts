import { normalizeAsset } from '../../CryptoExchanges/adapters/assets';
import {
  ParseResult,
  WsTickerFeed,
  toFiniteNumber,
  toPrice,
} from './PriceFeed';

/**
 * Kraken WebSocket API v2, public `ticker` channel (no credentials).
 * Docs: https://docs.kraken.com/api/docs/websocket-v2/ticker
 *
 * Subscribe: {"method":"subscribe","params":{"channel":"ticker","symbol":["BTC/USD"]}}
 * Data: {"channel":"ticker","type":"snapshot"|"update","data":[{"symbol":"BTC/USD","last":..,"change_pct":..}]}
 * Acks ({"method":"subscribe",...}), status and heartbeat ({"channel":"heartbeat"}) are ignored.
 * Kraken lists real USD pairs, so ticks are marked quote 'USD'.
 */
export class KrakenTickerFeed extends WsTickerFeed {
  readonly source = 'kraken' as const;
  protected readonly url = 'wss://ws.kraken.com/v2';

  /** The single place that maps a held asset to Kraken v2 naming (`BTC/USD`, not `XBT`). */
  protected pairFor(asset: string): string {
    return `${asset}/USD`;
  }

  protected subscribeMessages(pairs: string[]): unknown[] {
    return [
      {
        method: 'subscribe',
        params: { channel: 'ticker', symbol: pairs },
      },
    ];
  }

  protected unsubscribeMessages(pairs: string[]): unknown[] {
    return [
      {
        method: 'unsubscribe',
        params: { channel: 'ticker', symbol: pairs },
      },
    ];
  }

  protected parse(msg: any, now: number): ParseResult {
    if (msg.channel !== 'ticker' || !Array.isArray(msg.data)) {
      return { ticks: [] };
    }
    const ticks: ParseResult['ticks'] = [];
    for (const item of msg.data) {
      if (!item || typeof item.symbol !== 'string') continue;
      const [base, quote, extra] = item.symbol.split('/');
      if (quote !== 'USD' || !base || extra !== undefined) continue;
      const usd = toPrice(item.last);
      if (usd === undefined) continue;
      const tick: ParseResult['ticks'][number] = {
        asset: normalizeAsset('kraken', base),
        usd,
        source: this.source,
        quote: 'USD',
        asOf: now,
      };
      const change = toFiniteNumber(item.change_pct);
      if (change !== undefined) tick.change24hPct = change;
      ticks.push(tick);
    }
    return { ticks };
  }
}
