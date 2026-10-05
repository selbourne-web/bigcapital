import { normalizeAsset } from '../../CryptoExchanges/adapters/assets';
import {
  ParseResult,
  WsTickerFeed,
  toFiniteNumber,
  toPrice,
} from './PriceFeed';

/**
 * Binance spot public market streams (no credentials).
 * Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 *
 * Raw stream endpoint `/ws`; streams are added with
 * {"method":"SUBSCRIBE","params":["btcusdt@ticker"],"id":1}. Stream names are lower-case.
 * Payload: {"e":"24hrTicker","s":"BTCUSDT","c":"<last price>","P":"<24h change %>",...}.
 * Server pings every 20 s; the platform WebSocket / `ws` answer pongs automatically.
 * A connection lives at most 24 h (the manager reconnects) and accepts 5 incoming
 * messages per second, so subscribe/unsubscribe go out as one message each per sync.
 *
 * Binance has USDT pairs only, so every tick is marked quote 'USDT': the value is
 * approximately, not exactly, USD. USDT itself has no pair here and is skipped.
 */
export class BinanceTickerFeed extends WsTickerFeed {
  readonly source = 'binance' as const;
  protected readonly url = 'wss://stream.binance.com:9443/ws';

  /** The single place that maps a held asset to a Binance stream name. */
  protected pairFor(asset: string): string | undefined {
    if (asset === 'USDT') return undefined;
    return `${asset.toLowerCase()}usdt@ticker`;
  }

  protected subscribeMessages(pairs: string[]): unknown[] {
    return [{ method: 'SUBSCRIBE', params: pairs, id: this.nextId() }];
  }

  protected unsubscribeMessages(pairs: string[]): unknown[] {
    return [{ method: 'UNSUBSCRIBE', params: pairs, id: this.nextId() }];
  }

  private nextId(): number {
    this.messageId += 1;
    return this.messageId;
  }

  protected parse(msg: any, now: number): ParseResult {
    if (msg.e !== '24hrTicker' || typeof msg.s !== 'string') {
      return { ticks: [] };
    }
    const m = /^([A-Z0-9]+)USDT$/.exec(msg.s);
    if (!m) return { ticks: [] };
    const usd = toPrice(msg.c);
    if (usd === undefined) return { ticks: [] };
    const tick: ParseResult['ticks'][number] = {
      asset: normalizeAsset('binance', m[1]),
      usd,
      source: this.source,
      quote: 'USDT',
      asOf: now,
    };
    const change = toFiniteNumber(msg.P);
    if (change !== undefined) tick.change24hPct = change;
    return { ticks: [tick] };
  }
}
