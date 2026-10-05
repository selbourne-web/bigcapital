import { readFileSync } from 'fs';
import { join } from 'path';
import { KrakenTickerFeed } from './KrakenTickerFeed';
import { BinanceTickerFeed } from './BinanceTickerFeed';
import { CryptoComTickerFeed } from './CryptoComTickerFeed';
import { MAX_MESSAGE_BYTES, SourceTick, WebSocketLike } from './PriceFeed';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8').trim();

const NOW = 1_800_000_000_000;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: any[] = [];
  closed = false;
  terminated = false;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const setup = (Feed: any) => {
  const sockets: FakeSocket[] = [];
  const feed = new Feed({
    webSocketFactory: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: () => NOW,
  });
  const ticks: SourceTick[] = [];
  const onClose = jest.fn();
  return {
    feed,
    sockets,
    ticks,
    onClose,
    start: () => {
      feed.start((t: SourceTick) => ticks.push(t), onClose);
      return sockets[sockets.length - 1];
    },
  };
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('KrakenTickerFeed', () => {
  it('uses the public v2 endpoint and subscribes to USD pairs once open', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    expect(ws.url).toBe('wss://ws.kraken.com/v2');
    t.feed.subscribe(['BTC', 'ETH']);
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent).toEqual([
      {
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['BTC/USD', 'ETH/USD'] },
      },
    ]);
  });

  it('sends only the delta on later subscribe calls', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    ws.open();
    t.feed.subscribe(['BTC', 'ETH']);
    ws.sent.length = 0;
    t.feed.subscribe(['BTC', 'SOL']);
    expect(ws.sent).toEqual([
      {
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['SOL/USD'] },
      },
      {
        method: 'unsubscribe',
        params: { channel: 'ticker', symbol: ['ETH/USD'] },
      },
    ]);
  });

  it('never puts unsafe or fiat symbols into a subscribe message', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    t.feed.subscribe(['BTC', 'btc', 'A"B', 'X'.repeat(21), '', 'USD', 'EUR']);
    ws.open();
    expect(ws.sent).toEqual([
      {
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['BTC/USD'] },
      },
    ]);
  });

  it('parses a ticker snapshot into a normalized USD tick', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('kraken-ticker-snapshot.json'));
    expect(t.ticks).toEqual([
      {
        asset: 'BTC',
        usd: 65000.15,
        change24hPct: 0.23,
        source: 'kraken',
        quote: 'USD',
        asOf: NOW,
      },
    ]);
  });

  it('normalizes legacy Kraken codes (XBT -> BTC)', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(
      JSON.stringify({
        channel: 'ticker',
        type: 'update',
        data: [
          { symbol: 'XBT/USD', last: 1 },
          { symbol: 'XXBT/USD', last: 2 },
        ],
      }),
    );
    expect(t.ticks.map((x) => [x.asset, x.usd])).toEqual([
      ['BTC', 1],
      ['BTC', 2],
    ]);
  });

  it('ignores heartbeat, acks, non-USD pairs and bad prices', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('kraken-heartbeat.json'));
    ws.message(fixture('kraken-subscribe-ack.json'));
    ws.message(
      JSON.stringify({
        channel: 'ticker',
        type: 'update',
        data: [
          { symbol: 'BTC/EUR', last: 5 },
          { symbol: 'BTC/USD', last: 'abc' },
          { symbol: 'BTC/USD', last: -1 },
          { symbol: 'BTC/USD', last: 0 },
          null,
        ],
      }),
    );
    expect(t.ticks).toEqual([]);
  });

  it('ignores malformed JSON and oversize messages without throwing', () => {
    const t = setup(KrakenTickerFeed);
    const ws = t.start();
    ws.open();
    expect(() => ws.message('{not json')).not.toThrow();
    expect(() => ws.message('null')).not.toThrow();
    expect(() => ws.message('[1,2]')).not.toThrow();
    expect(() => ws.message(' '.repeat(MAX_MESSAGE_BYTES + 1))).not.toThrow();
    const big = JSON.stringify({
      channel: 'ticker',
      type: 'update',
      data: [{ symbol: 'BTC/USD', last: 1 }],
      pad: 'x'.repeat(MAX_MESSAGE_BYTES),
    });
    ws.message(big);
    expect(t.ticks).toEqual([]);
  });
});

describe('BinanceTickerFeed', () => {
  it('uses the raw stream endpoint and subscribes to lower-case <asset>usdt@ticker', () => {
    const t = setup(BinanceTickerFeed);
    const ws = t.start();
    expect(ws.url).toBe('wss://stream.binance.com:9443/ws');
    t.feed.subscribe(['BTC', 'ETH', 'USDT', 'EUR']);
    ws.open();
    expect(ws.sent).toEqual([
      {
        method: 'SUBSCRIBE',
        params: ['btcusdt@ticker', 'ethusdt@ticker'],
        id: expect.any(Number),
      },
    ]);
  });

  it('unsubscribes removed assets', () => {
    const t = setup(BinanceTickerFeed);
    const ws = t.start();
    ws.open();
    t.feed.subscribe(['BTC', 'ETH']);
    ws.sent.length = 0;
    t.feed.subscribe(['BTC']);
    expect(ws.sent).toEqual([
      {
        method: 'UNSUBSCRIBE',
        params: ['ethusdt@ticker'],
        id: expect.any(Number),
      },
    ]);
  });

  it('parses the 24hr ticker and marks the price as USDT-quoted', () => {
    const t = setup(BinanceTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('binance-ticker.json'));
    expect(t.ticks).toEqual([
      {
        asset: 'BTC',
        usd: 65000.15,
        change24hPct: 0.231,
        source: 'binance',
        quote: 'USDT',
        asOf: NOW,
      },
    ]);
  });

  it('ignores acks, non-USDT symbols, other events and malformed input', () => {
    const t = setup(BinanceTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('binance-subscribe-ack.json'));
    ws.message(JSON.stringify({ e: '24hrTicker', s: 'BTCEUR', c: '1' }));
    ws.message(JSON.stringify({ e: 'trade', s: 'BTCUSDT', c: '1' }));
    ws.message(JSON.stringify({ e: '24hrTicker', s: 'BTCUSDT', c: 'x' }));
    expect(() => ws.message('garbage')).not.toThrow();
    expect(() => ws.message('z'.repeat(MAX_MESSAGE_BYTES + 1))).not.toThrow();
    expect(t.ticks).toEqual([]);
  });
});

describe('CryptoComTickerFeed', () => {
  it('waits one second after connecting before subscribing', () => {
    const t = setup(CryptoComTickerFeed);
    const ws = t.start();
    expect(ws.url).toBe('wss://stream.crypto.com/exchange/v1/market');
    t.feed.subscribe(['BTC', 'ETH']);
    ws.open();
    jest.advanceTimersByTime(999);
    expect(ws.sent).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(ws.sent).toEqual([
      {
        id: expect.any(Number),
        method: 'subscribe',
        params: { channels: ['ticker.BTC_USD', 'ticker.ETH_USD'] },
        nonce: expect.any(Number),
      },
    ]);
  });

  it('sends deltas after the initial subscribe', () => {
    const t = setup(CryptoComTickerFeed);
    const ws = t.start();
    ws.open();
    jest.advanceTimersByTime(1000);
    t.feed.subscribe(['BTC', 'ETH']);
    ws.sent.length = 0;
    t.feed.subscribe(['ETH']);
    expect(ws.sent).toEqual([
      expect.objectContaining({
        method: 'unsubscribe',
        params: { channels: ['ticker.BTC_USD'] },
      }),
    ]);
  });

  it('parses a ticker message into a USD tick with 24h change in percent', () => {
    const t = setup(CryptoComTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('crypto-com-ticker.json'));
    expect(t.ticks).toHaveLength(1);
    expect(t.ticks[0]).toMatchObject({
      asset: 'BTC',
      usd: 65000.25,
      source: 'crypto_com',
      quote: 'USD',
      asOf: NOW,
    });
    expect(t.ticks[0].change24hPct).toBeCloseTo(0.23, 10);
  });

  it('answers the heartbeat immediately with the same id and emits no tick', () => {
    const t = setup(CryptoComTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('crypto-com-heartbeat.json'));
    expect(ws.sent).toEqual([
      { id: 1791104671000, method: 'public/respond-heartbeat' },
    ]);
    expect(t.ticks).toEqual([]);
  });

  it('ignores acks and malformed input', () => {
    const t = setup(CryptoComTickerFeed);
    const ws = t.start();
    ws.open();
    ws.message(fixture('crypto-com-subscribe-ack.json'));
    ws.message(JSON.stringify({ method: 'public/heartbeat', id: 'x' }));
    expect(() => ws.message('}{')).not.toThrow();
    expect(() => ws.message('q'.repeat(MAX_MESSAGE_BYTES + 1))).not.toThrow();
    expect(t.ticks).toEqual([]);
    expect(ws.sent).toEqual([]);
  });
});

describe.each([
  ['kraken', KrakenTickerFeed],
  ['binance', BinanceTickerFeed],
  ['crypto_com', CryptoComTickerFeed],
])('%s feed lifecycle', (source, Feed) => {
  it('exposes its source', () => {
    expect(setup(Feed).feed.source).toBe(source);
  });

  it('reports a server-side close once', () => {
    const t = setup(Feed);
    const ws = t.start();
    ws.open();
    ws.serverClose();
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('stop() closes the socket, does not report a close and ignores late events', () => {
    const t = setup(Feed);
    const ws = t.start();
    ws.open();
    t.feed.stop();
    expect(ws.terminated || ws.closed).toBe(true);
    ws.serverClose();
    ws.message(fixture('kraken-ticker-snapshot.json'));
    expect(t.onClose).not.toHaveBeenCalled();
    expect(t.ticks).toEqual([]);
  });

  it('stop() cancels a pending post-connect subscribe timer', () => {
    const t = setup(Feed);
    const ws = t.start();
    t.feed.subscribe(['BTC']);
    ws.open();
    t.feed.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('treats a throwing socket factory as a close instead of crashing', () => {
    const feed = new (Feed as any)({
      webSocketFactory: () => {
        throw new Error('boom');
      },
      now: () => NOW,
    });
    const onClose = jest.fn();
    expect(() => feed.start(() => undefined, onClose)).not.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['kraken', KrakenTickerFeed],
  ['binance', BinanceTickerFeed],
  ['crypto_com', CryptoComTickerFeed],
])('%s feed watchdogs', (_source, Feed) => {
  it('terminates and reports a close after 60 s of silence on an open socket', () => {
    const t = setup(Feed);
    const ws = t.start();
    ws.open();
    jest.advanceTimersByTime(59_999);
    expect(t.onClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    expect(ws.terminated).toBe(true);
    expect(ws.closed).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    ws.serverClose(); // late event from the old socket is ignored
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('is kept alive by inbound messages', () => {
    const t = setup(Feed);
    const ws = t.start();
    ws.open();
    jest.advanceTimersByTime(59_000);
    ws.message(fixture('kraken-heartbeat.json'));
    jest.advanceTimersByTime(59_000);
    expect(t.onClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('gives up when the socket never opens within 15 s', () => {
    const t = setup(Feed);
    const ws = t.start();
    jest.advanceTimersByTime(14_999);
    expect(t.onClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    expect(ws.terminated).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no timers after stop() and starts fresh ones on reconnect', () => {
    const t = setup(Feed);
    const ws = t.start();
    ws.open();
    t.feed.stop();
    expect(jest.getTimerCount()).toBe(0);
    const ws2 = t.start();
    expect(ws2).not.toBe(ws);
    ws2.open();
    jest.advanceTimersByTime(61_000);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    expect(ws2.terminated).toBe(true);
  });

  it('honours injected timeouts', () => {
    const sockets: FakeSocket[] = [];
    const feed = new (Feed as any)({
      webSocketFactory: (u: string) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      inactivityTimeoutMs: 1000,
      connectTimeoutMs: 500,
    });
    const onClose = jest.fn();
    feed.start(() => undefined, onClose);
    sockets[0].open();
    jest.advanceTimersByTime(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
