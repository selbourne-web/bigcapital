import { WebSocket as WsWebSocket } from 'ws';

export type PriceSource = 'kraken' | 'binance' | 'crypto_com';

/** Currency a price was actually quoted in. USDT is never silently equated to USD. */
export type QuoteCurrency = 'USD' | 'USDT';

export type SourceTick = {
  /** Canonical upper-case asset symbol (`normalizeAsset`), e.g. `BTC`. */
  asset: string;
  usd: number;
  change24hPct?: number;
  source: PriceSource;
  /** Receive time (epoch ms) used for staleness decisions. */
  asOf: number;
  /** Quote currency of the pair the price came from. Feeds always set it. */
  quote?: QuoteCurrency;
};

export type PriceQuote = {
  asset: string;
  usd: number;
  change24hPct?: number;
  source: PriceSource;
  asOf: number;
  /** True when every source has been silent past the limit; `usd` is the last known value. */
  stale: boolean;
  /** `USDT` when the price came from a USDT-quoted pair (approximately USD, not exactly). */
  quote: QuoteCurrency;
};

export interface PriceFeed {
  readonly source: PriceSource;
  /**
   * Opens the connection. `onClose` fires when the connection ends for any reason other
   * than `stop()`; the caller (PriceFeedManager) owns the reconnect policy.
   */
  start(onTick: (t: SourceTick) => void, onClose?: () => void): void;
  /** Declarative: the feed ends up subscribed to exactly these assets (delta is sent). */
  subscribe(assets: string[]): void;
  stop(): void;
}

/** The subset of the WHATWG WebSocket API the feeds use (also implemented by `ws`). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  /** Present on `ws`: drops a dead peer immediately instead of waiting for the close handshake. */
  terminate?(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

/** Inbound messages larger than this are dropped unparsed. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Only symbols matching this ever reach a subscribe message. */
export const ASSET_SYMBOL = /^[A-Z0-9]{1,20}$/;

/** Fiat codes are not priced through crypto tickers (USD is exactly 1 and handled by consumers). */
const FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'JPY', 'AUD', 'CHF', 'BBD']);

export const isPriceableAsset = (asset: string): boolean =>
  ASSET_SYMBOL.test(asset) && !FIAT.has(asset);

/**
 * Prefers the platform `WebSocket` when it exists (Node >= 22) and falls back to `ws`
 * (the API may still run on Node 18, which has no global WebSocket).
 */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Native = (globalThis as { WebSocket?: new (u: string) => unknown })
    .WebSocket;
  if (typeof Native === 'function') {
    return new Native(url) as WebSocketLike;
  }
  return new WsWebSocket(url, {
    maxPayload: MAX_MESSAGE_BYTES,
    handshakeTimeout: 15_000,
  }) as unknown as WebSocketLike;
};

export type FeedOptions = {
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  /** Socket must deliver something within this long once open. Default 60 s. */
  inactivityTimeoutMs?: number;
  /** Socket must reach `open` within this long of creation. Default 15 s. */
  connectTimeoutMs?: number;
};

export type ParseResult = { ticks: SourceTick[]; reply?: unknown };

/** Parses a finite positive price; anything else is rejected. */
export const toPrice = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export const toFiniteNumber = (v: unknown): number | undefined => {
  if (v === null || v === '' || typeof v === 'boolean') return undefined;
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Shared connection lifecycle. A subclass supplies the host (constant, never user input),
 * the one-place asset -> pair mapping (`pairFor`), the subscribe/unsubscribe message
 * shapes and the message parser. No credentials are involved: public streams only.
 * Payloads are never logged.
 */
export abstract class WsTickerFeed implements PriceFeed {
  abstract readonly source: PriceSource;
  protected abstract readonly url: string;
  /** Delay between the socket opening and the first outbound message. */
  protected readonly openDelayMs: number = 0;

  /** Exchange pair naming for a held asset, or undefined when it is not offered. */
  protected abstract pairFor(asset: string): string | undefined;
  protected abstract subscribeMessages(pairs: string[]): unknown[];
  protected abstract unsubscribeMessages(pairs: string[]): unknown[];
  protected abstract parse(msg: unknown, now: number): ParseResult;

  protected readonly now: () => number;
  private readonly factory: WebSocketFactory;
  private ws: WebSocketLike | undefined;
  private ready = false;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private onTick: (t: SourceTick) => void = () => undefined;
  private onClose: (() => void) | undefined;
  private desired = new Map<string, string>(); // asset -> pair
  private sent = new Set<string>(); // pairs already subscribed on this connection
  protected messageId = 0;
  private readonly inactivityMs: number;
  private readonly connectMs: number;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FeedOptions = {}) {
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.now = options.now ?? Date.now;
    this.inactivityMs = options.inactivityTimeoutMs ?? 60_000;
    this.connectMs = options.connectTimeoutMs ?? 15_000;
  }

  start(onTick: (t: SourceTick) => void, onClose?: () => void): void {
    this.teardown();
    this.onTick = onTick;
    this.onClose = onClose;
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.onClose?.();
      return;
    }
    this.ws = ws;
    // A half-open or never-opening socket never fires `close`, so watch it ourselves.
    this.connectTimer = setTimeout(() => this.fail(ws), this.connectMs);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearTimer('connectTimer');
      this.armInactivity(ws);
      if (this.openDelayMs > 0) {
        this.openTimer = setTimeout(
          () => this.becomeReady(ws),
          this.openDelayMs,
        );
      } else {
        this.becomeReady(ws);
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.armInactivity(ws);
      this.handleMessage(ev.data);
    };
    // `ws` also surfaces protocol pings (Binance pings every 20 s); count them as activity.
    (ws as { on?: (e: string, cb: () => void) => void }).on?.('ping', () => {
      if (this.ws === ws) this.armInactivity(ws);
    });
    // `error` is always followed by `close`; handling it only prevents an unhandled event.
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardown();
      this.onClose?.();
    };
  }

  subscribe(assets: string[]): void {
    const next = new Map<string, string>();
    for (const asset of assets) {
      if (!isPriceableAsset(asset)) continue;
      const pair = this.pairFor(asset);
      if (pair) next.set(asset, pair);
    }
    this.desired = next;
    if (this.ready) this.syncSubscriptions();
  }

  stop(): void {
    this.teardown();
    this.onClose = undefined;
  }

  private becomeReady(ws: WebSocketLike) {
    this.openTimer = undefined;
    if (this.ws !== ws) return;
    this.ready = true;
    this.sent.clear();
    this.syncSubscriptions();
  }

  private syncSubscriptions() {
    const want = new Set(this.desired.values());
    const add = [...want].filter((p) => !this.sent.has(p));
    const remove = [...this.sent].filter((p) => !want.has(p));
    if (add.length) {
      this.subscribeMessages(add).forEach((m) => this.send(m));
    }
    if (remove.length) {
      this.unsubscribeMessages(remove).forEach((m) => this.send(m));
    }
    add.forEach((p) => this.sent.add(p));
    remove.forEach((p) => this.sent.delete(p));
  }

  protected send(message: unknown) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A failed send surfaces as a close; nothing to log (no payloads).
    }
  }

  private handleMessage(data: unknown) {
    const raw = this.toText(data);
    if (raw === undefined || raw.length > MAX_MESSAGE_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    let result: ParseResult;
    try {
      result = this.parse(parsed, this.now());
    } catch {
      return;
    }
    if (result.reply !== undefined) this.send(result.reply);
    for (const tick of result.ticks) this.onTick(tick);
  }

  private toText(data: unknown): string | undefined {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) {
      if (data.byteLength > MAX_MESSAGE_BYTES) return undefined;
      return Buffer.from(data).toString('utf8');
    }
    return undefined;
  }

  private armInactivity(ws: WebSocketLike) {
    this.clearTimer('activityTimer');
    this.activityTimer = setTimeout(() => this.fail(ws), this.inactivityMs);
  }

  /** Watchdog expiry: drop the socket and let the owner's backoff reconnect. */
  private fail(ws: WebSocketLike) {
    if (this.ws !== ws) return;
    this.teardown();
    this.onClose?.();
  }

  private clearTimer(name: 'openTimer' | 'connectTimer' | 'activityTimer') {
    if (this[name]) clearTimeout(this[name]);
    this[name] = undefined;
  }

  private teardown() {
    this.clearTimer('openTimer');
    this.clearTimer('connectTimer');
    this.clearTimer('activityTimer');
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    this.sent.clear();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => undefined;
      try {
        if (typeof ws.terminate === 'function') ws.terminate();
        else ws.close();
      } catch {
        // already closed
      }
    }
  }
}
