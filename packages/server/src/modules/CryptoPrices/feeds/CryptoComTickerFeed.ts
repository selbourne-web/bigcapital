import { normalizeAsset } from '../../CryptoExchanges/adapters/assets';
import {
  ParseResult,
  WsTickerFeed,
  toFiniteNumber,
  toPrice,
} from './PriceFeed';

/**
 * VERIFICATION STATUS (recorded 2026-10-05): the official Crypto.com docs page is
 * JS-rendered and could not be read. The ticker field names (`i`, `a`, `c`, `t`), the
 * `result.channel` / `result.data[]` envelope and the ~1 s post-connect wait are
 * UNVERIFIED against the official docs. Only the endpoint, the `ticker.<INSTRUMENT>`
 * channel naming and the `public/heartbeat` -> `public/respond-heartbeat` reply with the
 * same id were cross-checked, via the ccxt source (ts/src/pro/cryptocom.ts).
 * A one-time live check is required before relying on this source.
 *
 * Crypto.com Exchange v1 public market-data WebSocket (no credentials).
 * Docs: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html (market data section).
 *
 * Subscribe: {"id":1,"method":"subscribe","params":{"channels":["ticker.BTC_USD"]},"nonce":<ms>}
 * Data: {"result":{"channel":"ticker","data":[{"i":"BTC_USD","a":"<last trade>","c":"<24h change, fraction>","t":<ms>}]}}
 * Heartbeat: the server sends {"id":N,"method":"public/heartbeat"} and expects
 * {"id":N,"method":"public/respond-heartbeat"} back or it closes the connection.
 * The docs advise waiting about one second after connecting before sending requests.
 */
export class CryptoComTickerFeed extends WsTickerFeed {
  readonly source = 'crypto_com' as const;
  protected readonly url = 'wss://stream.crypto.com/exchange/v1/market';
  protected readonly openDelayMs = 1000;

  /** The single place that maps a held asset to a Crypto.com channel (USD instrument). */
  protected pairFor(asset: string): string {
    return `ticker.${asset}_USD`;
  }

  protected subscribeMessages(channels: string[]): unknown[] {
    return [this.request('subscribe', channels)];
  }

  protected unsubscribeMessages(channels: string[]): unknown[] {
    return [this.request('unsubscribe', channels)];
  }

  private request(method: string, channels: string[]) {
    this.messageId += 1;
    return {
      id: this.messageId,
      method,
      params: { channels },
      nonce: this.now(),
    };
  }

  protected parse(msg: any, now: number): ParseResult {
    if (msg.method === 'public/heartbeat') {
      return typeof msg.id === 'number' && Number.isSafeInteger(msg.id)
        ? {
            ticks: [],
            reply: { id: msg.id, method: 'public/respond-heartbeat' },
          }
        : { ticks: [] };
    }
    const result = msg.result;
    if (!result || result.channel !== 'ticker' || !Array.isArray(result.data)) {
      return { ticks: [] };
    }
    const ticks: ParseResult['ticks'] = [];
    for (const item of result.data) {
      if (!item || typeof item.i !== 'string') continue;
      const m = /^([A-Z0-9]+)_(USDT|USD)$/.exec(item.i);
      if (!m) continue;
      const usd = toPrice(item.a);
      if (usd === undefined) continue;
      const tick: ParseResult['ticks'][number] = {
        asset: normalizeAsset('binance', m[1]),
        usd,
        source: this.source,
        quote: m[2] as 'USD' | 'USDT',
        asOf: now,
      };
      const change = toFiniteNumber(item.c);
      if (change !== undefined) tick.change24hPct = change * 100;
      ticks.push(tick);
    }
    return { ticks };
  }
}
