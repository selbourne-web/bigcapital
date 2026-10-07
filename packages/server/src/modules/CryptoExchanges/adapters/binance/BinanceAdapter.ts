import { CryptoExchangeId } from '../../CryptoExchanges.constants';
import { redactSecrets } from '../../utils/redact';
import {
  Credentials,
  ExchangeAdapter,
  HistoryCoverage,
  KeyInspection,
  RawBalance,
  RawRecordInput,
} from '../ExchangeAdapter';
import { normalizeAsset } from '../assets';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';
import { addDecimal, isDecimal, isZero, sanitizeText } from '../shared';
import { signBinance } from './binance.signing';

const HOST = 'https://api.binance.com';

/**
 * Read-only endpoints. This adapter must never reach a state-changing endpoint
 * (order, withdraw, transfer, convert, subscribe/redeem, ...), so any other path
 * is refused before a request is built.
 */
const READ_ENDPOINTS = new Set([
  '/sapi/v1/account/apiRestrictions',
  '/api/v3/account',
  '/api/v3/myTrades',
  '/sapi/v1/capital/deposit/hisrec',
  '/sapi/v1/capital/withdraw/history',
  '/api/v3/exchangeInfo', // public, sent unsigned and without the API key
]);

/** Public endpoints that need neither signature nor API key. */
const PUBLIC_ENDPOINTS = new Set(['/api/v3/exchangeInfo']);

/**
 * apiRestrictions allow-list. A key is read-only only when every field of the
 * response is one of these AND the value is what is listed. Anything else
 * (unknown field, missing field, wrong type) is treated as NOT read-only.
 */
/** Must be present and exactly `true`. */
const REQUIRED_TRUE = ['enableReading'];
/** Must be present and exactly `false`: each can trade, move or withdraw funds. */
const REQUIRED_FALSE = [
  'enableWithdrawals',
  'enableInternalTransfer',
  'enableMargin',
  'enableFutures',
  'permitsUniversalTransfer',
  'enableVanillaOptions',
  'enableSpotAndMarginTrading',
];
/** May be absent (newer/older keys); if present must be exactly `false`. */
const OPTIONAL_FALSE = ['enableFixApiTrade', 'enablePortfolioMarginTrading'];
/** Harmless booleans; any boolean value accepted. */
const NEUTRAL_BOOLEAN = ['ipRestrict', 'enableFixReadOnly'];
/** Harmless numbers (not permissions). */
const NEUTRAL_NUMBER = ['createTime'];

const RECV_WINDOW_MS = 10_000; // docs: default 5000, max 60000
const DAY_MS = 86_400_000;
/** Deposit/withdraw history: start..end span must not exceed 90 days. */
const WINDOW_MS = 90 * DAY_MS;
const PAGE_LIMIT = 1000; // deposit/withdraw/myTrades max page size
const EXCHANGE_INFO_TTL_MS = 3_600_000;
const SYMBOL_LIST_TTL_MS = 300_000;
/** Binance launch (2017-07-01 UTC): lower bound of an initial sync's deposit/withdraw scan. */
const BINANCE_LAUNCH_MS = Date.UTC(2017, 6, 1);
/**
 * Incremental syncs re-scan deposits/withdrawals from `since` minus this, because
 * those are windowed by insertTime/applyTime while we only record them once
 * completed: a withdrawal applied before `since` that completes after it must
 * still be picked up. Duplicates are absorbed by the stable record ids.
 */
const IN_FLIGHT_LOOKBACK_MS = 14 * DAY_MS;
const MAX_SEED_WINDOWS = 100;
const MAX_SEED_PAGES = 50;
const MAX_KNOWN_ASSETS = 5000;

type Json = Record<string, any>;
type Stage = 'dep' | 'wd';

type Cursor =
  | { stage: Stage; start: number; offset: number; origin: number }
  | { stage: 'trd'; symbol: string; after: boolean; fromId: number };

const isObject = (v: unknown): v is Json =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class BinanceAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'binance';
  readonly historyCoverage: HistoryCoverage = { level: 'full' };
  /**
   * Spot IP limit is request-weight based (per-IP, per minute; headers
   * X-MBX-USED-WEIGHT-1m). account and myTrades cost 20 each, deposit history 1.
   * Budget 2 calls/s sustained (about 40 weight/s), burst 10.
   */
  readonly rateLimit = {
    capacity: 10,
    refillPerSec: 2,
    historyPageCost: 3, // one fetchHistory page can make up to 3 HTTP calls
  };

  private readonly requestTimeoutMs: number;
  private readonly initialLookbackMs?: number;
  private symbolCache?: {
    at: number;
    list: { symbol: string; base: string; quote: string; status: string }[];
  };
  private tradeSymbolCache?: { key: string; at: number; symbols: string[] };

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    options: { requestTimeoutMs?: number; initialLookbackDays?: number } = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.initialLookbackMs =
      options.initialLookbackDays === undefined
        ? undefined
        : options.initialLookbackDays * DAY_MS;
  }

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    const body = await this.call(creds, '/sapi/v1/account/apiRestrictions', {});
    if (!isObject(body)) {
      return { readOnly: 'unverifiable', permissions: [] };
    }
    const permissions: string[] = [];
    let readOnly = true;
    const known = new Set([
      ...REQUIRED_TRUE,
      ...REQUIRED_FALSE,
      ...OPTIONAL_FALSE,
      ...NEUTRAL_BOOLEAN,
      ...NEUTRAL_NUMBER,
    ]);

    for (const [key, value] of Object.entries(body)) {
      if (!known.has(key)) {
        readOnly = false;
        permissions.push(`unrecognized:${key}`);
      } else if (value === true && key !== 'ipRestrict') {
        permissions.push(key);
      }
    }
    for (const key of REQUIRED_TRUE) {
      if (body[key] !== true) readOnly = false;
    }
    for (const key of REQUIRED_FALSE) {
      if (!(key in body)) {
        readOnly = false;
        permissions.push(`missing:${key}`);
      } else if (body[key] !== false) {
        readOnly = false;
      }
    }
    for (const key of OPTIONAL_FALSE) {
      if (key in body && body[key] !== false) readOnly = false;
    }
    for (const key of NEUTRAL_BOOLEAN) {
      if (key in body && typeof body[key] !== 'boolean') readOnly = false;
    }
    for (const key of NEUTRAL_NUMBER) {
      if (key in body && typeof body[key] !== 'number') readOnly = false;
    }
    return { readOnly, permissions };
  }

  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    return this.balances(this.trim(c));
  }

  /**
   * Cursor grammar (opaque to callers):
   *   dep:<windowStartMs>:<offset>:<originMs>   deposit history, 90-day window
   *   wd:<windowStartMs>:<offset>:<originMs>    withdraw history, 90-day window
   *   trd:<SYMBOL>:<fromId>                     myTrades for SYMBOL from trade id
   *   trd:><SYMBOL>:0                           myTrades for the first symbol after SYMBOL
   *                                             (`trd:>:0` = the first symbol)
   * `originMs` is the lower bound chosen on the first call so the withdraw stage
   * starts where the deposit stage did: with `since` it is `since` minus 14 days
   * (IN_FLIGHT_LOOKBACK_MS); without `since` (initial sync) it is the Binance launch,
   * 2017-07-01 UTC (or now minus `initialLookbackDays` when that override is set).
   * Order: deposits, withdrawals, trades; no cursor means start. A window moves
   * forward when a page is shorter than 1000; a full page continues by offset
   * (windows) or fromId (trades). Duplicates are absorbed by stable record ids.
   * Trade symbols are visited in lexicographic order and the cursor carries the
   * symbol itself, so a restart resumes at the same place even if the list changes.
   * Initial sync (no `since`): EVERY symbol with status TRADING from exchangeInfo,
   * any quote asset, so assets sold before the sync are still covered.
   * Incremental sync (`since`): only TRADING symbols whose base OR quote asset is in
   * the seed set = current balances + coins in deposit/withdraw history since
   * `since` minus 14 days + `q.knownAssets`. Limitation: an asset whose whole
   * lifecycle (buy and sell) falls between two syncs, with no balance, deposit or
   * withdrawal, and that the caller does not list in `knownAssets`, is not
   * discovered by an incremental sync. Delisted (non-TRADING) symbols are skipped.
   */
  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const creds = this.trim(c);
    let cursor: Cursor;
    if (q.cursor === undefined) {
      const origin = q.since
        ? Math.max(0, q.since.getTime() - IN_FLIGHT_LOOKBACK_MS)
        : this.initialLookbackMs !== undefined
          ? this.now() - this.initialLookbackMs
          : BINANCE_LAUNCH_MS;
      cursor = { stage: 'dep', start: origin, offset: 0, origin };
    } else {
      cursor = this.parseCursor(q.cursor);
    }
    if (cursor.stage === 'trd') {
      return this.tradesPage(creds, cursor, q.since, q.knownAssets);
    }
    return this.windowPage(creds, cursor);
  }

  private async windowPage(
    creds: Credentials,
    cur: Extract<Cursor, { stage: Stage }>,
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const { stage, start, offset, origin } = cur;
    const nowMs = this.now();
    const end = Math.min(start + WINDOW_MS - 1, nowMs);
    const path =
      stage === 'dep'
        ? '/sapi/v1/capital/deposit/hisrec'
        : '/sapi/v1/capital/withdraw/history';
    let rows: unknown[] = [];
    if (start <= nowMs) {
      const body = await this.call(creds, path, {
        startTime: String(start),
        endTime: String(end),
        offset: String(offset),
        limit: String(PAGE_LIMIT),
      });
      if (!Array.isArray(body)) {
        throw this.schemaError(`${path} response is not an array`, body);
      }
      rows = body;
    }

    const records: RawRecordInput[] = [];
    for (const row of rows) {
      records.push(
        ...(stage === 'dep'
          ? this.depositRecords(row, rows)
          : this.withdrawalRecords(row, rows)),
      );
    }

    let nextCursor: string;
    if (rows.length >= PAGE_LIMIT) {
      nextCursor = `${stage}:${start}:${offset + rows.length}:${origin}`;
    } else if (end >= nowMs) {
      nextCursor = stage === 'dep' ? `wd:${origin}:0:${origin}` : 'trd:>:0';
    } else {
      nextCursor = `${stage}:${end + 1}:0:${origin}`;
    }
    return { records, nextCursor };
  }

  private depositRecords(row: unknown, body: unknown): RawRecordInput[] {
    if (
      !isObject(row) ||
      typeof row.id !== 'string' ||
      typeof row.coin !== 'string' ||
      !isDecimal(row.amount) ||
      typeof row.status !== 'number' ||
      typeof row.insertTime !== 'number'
    ) {
      throw this.schemaError('Deposit entry has an unexpected shape', body);
    }
    // 1 = success, 6 = credited but cannot withdraw. Pending/rejected are not recorded.
    if (row.status !== 1 && row.status !== 6) return [];
    return [
      {
        type: 'deposit',
        exchangeRecordId: row.id,
        occurredAt: new Date(row.insertTime),
        payload: {
          ...row,
          normalizedAsset: normalizeAsset('binance', row.coin),
        },
      },
    ];
  }

  private withdrawalRecords(row: unknown, body: unknown): RawRecordInput[] {
    if (
      !isObject(row) ||
      typeof row.id !== 'string' ||
      typeof row.coin !== 'string' ||
      !isDecimal(row.amount) ||
      typeof row.status !== 'number' ||
      typeof row.applyTime !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.applyTime) ||
      (row.transactionFee !== undefined && !isDecimal(row.transactionFee))
    ) {
      throw this.schemaError('Withdrawal entry has an unexpected shape', body);
    }
    // 6 = completed. Email sent / approval / processing / rejected are not recorded.
    if (row.status !== 6) return [];
    const occurredAt = new Date(`${row.applyTime.replace(' ', 'T')}Z`); // docs times are UTC
    const normalizedAsset = normalizeAsset('binance', row.coin);
    const out: RawRecordInput[] = [
      {
        type: 'withdrawal',
        exchangeRecordId: row.id,
        occurredAt,
        payload: { ...row, normalizedAsset },
      },
    ];
    if (row.transactionFee !== undefined && !isZero(row.transactionFee)) {
      out.push({
        type: 'fee',
        exchangeRecordId: `${row.id}:fee`,
        occurredAt,
        payload: {
          withdrawalId: row.id,
          asset: row.coin,
          normalizedAsset,
          fee: row.transactionFee,
        },
      });
    }
    return out;
  }

  private async tradesPage(
    creds: Credentials,
    cur: Extract<Cursor, { stage: 'trd' }>,
    since?: Date,
    knownAssets?: string[],
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    let symbol = cur.symbol;
    if (cur.after) {
      const symbols = await this.tradeSymbols(creds, since, knownAssets);
      const next = symbols.find((s) => s > cur.symbol);
      if (!next) return { records: [], nextCursor: undefined };
      symbol = next;
    }

    const nowMs = this.now();
    const params: Record<string, string> = {
      symbol,
      limit: String(PAGE_LIMIT),
    };
    const sinceMs = since?.getTime();
    if (
      cur.fromId === 0 &&
      sinceMs !== undefined &&
      nowMs - sinceMs <= DAY_MS
    ) {
      // myTrades rejects start..end spans over 24h; use the time filter only when it fits.
      params.startTime = String(sinceMs);
      params.endTime = String(nowMs);
    } else {
      params.fromId = String(cur.after ? 0 : cur.fromId);
    }
    const body = await this.call(creds, '/api/v3/myTrades', params);
    if (!Array.isArray(body)) {
      throw this.schemaError('myTrades response is not an array', body);
    }

    const records: RawRecordInput[] = [];
    let maxId = -1;
    for (const row of body) {
      if (
        !isObject(row) ||
        typeof row.id !== 'number' ||
        typeof row.time !== 'number' ||
        typeof row.symbol !== 'string' ||
        typeof row.commissionAsset !== 'string' ||
        typeof row.isBuyer !== 'boolean' ||
        !isDecimal(row.price) ||
        !isDecimal(row.qty) ||
        !isDecimal(row.commission)
      ) {
        throw this.schemaError('Trade entry has an unexpected shape', body);
      }
      maxId = Math.max(maxId, row.id);
      if (sinceMs !== undefined && row.time < sinceMs) continue;
      const tradeId = `${row.symbol}:${row.id}`;
      const occurredAt = new Date(row.time);
      const normalizedAsset = normalizeAsset('binance', row.commissionAsset);
      records.push({
        type: 'trade',
        exchangeRecordId: tradeId,
        occurredAt,
        payload: { ...row, normalizedCommissionAsset: normalizedAsset },
      });
      if (!isZero(row.commission)) {
        records.push({
          type: 'fee',
          exchangeRecordId: `${tradeId}:fee`,
          occurredAt,
          payload: {
            tradeId,
            symbol: row.symbol,
            asset: row.commissionAsset,
            normalizedAsset,
            fee: row.commission,
          },
        });
      }
    }

    const nextCursor =
      body.length >= PAGE_LIMIT
        ? `trd:${symbol}:${maxId + 1}`
        : `trd:>${symbol}:0`;
    return { records, nextCursor };
  }

  /**
   * Symbols to pull trade history for, sorted for stable cursors (see fetchHistory
   * for the deep/incremental rules). Cached briefly so a symbol transition does not
   * repeat the account / history discovery calls.
   */
  private async tradeSymbols(
    creds: Credentials,
    since?: Date,
    knownAssets?: string[],
  ): Promise<string[]> {
    const known = this.cleanAssets(knownAssets);
    const sinceMs = since?.getTime();
    const key = JSON.stringify([creds.apiKey, sinceMs ?? null, known]);
    const t = this.now();
    if (
      this.tradeSymbolCache &&
      this.tradeSymbolCache.key === key &&
      t - this.tradeSymbolCache.at < SYMBOL_LIST_TTL_MS
    ) {
      return this.tradeSymbolCache.symbols;
    }
    const list = (await this.listedSymbols()).filter(
      (s) => s.status === 'TRADING',
    );
    let chosen = list;
    if (sinceMs !== undefined) {
      const seed = new Set<string>(known);
      for (const b of await this.balances(creds)) seed.add(b.asset);
      const seen = await this.seenCoins(
        creds,
        Math.max(0, sinceMs - IN_FLIGHT_LOOKBACK_MS),
      );
      for (const coin of seen) seed.add(coin);
      chosen = list.filter((s) => seed.has(s.base) || seed.has(s.quote));
    }
    const symbols = [...new Set(chosen.map((s) => s.symbol))].sort();
    this.tradeSymbolCache = { key, at: t, symbols };
    return symbols;
  }

  private cleanAssets(assets?: string[]): string[] {
    if (!Array.isArray(assets)) return [];
    const out = new Set<string>();
    for (const a of assets.slice(0, MAX_KNOWN_ASSETS)) {
      if (typeof a !== 'string') continue;
      const n = normalizeAsset('binance', a);
      if (/^[A-Z0-9]{1,20}$/.test(n)) out.add(n);
    }
    return [...out].sort();
  }

  /** Coins appearing in deposit/withdraw history (any status) from `fromMs` to now. */
  private async seenCoins(
    creds: Credentials,
    fromMs: number,
  ): Promise<Set<string>> {
    const nowMs = this.now();
    const coins = new Set<string>();
    for (const path of [
      '/sapi/v1/capital/deposit/hisrec',
      '/sapi/v1/capital/withdraw/history',
    ]) {
      for (
        let start = fromMs, w = 0;
        start <= nowMs && w < MAX_SEED_WINDOWS;
        start += WINDOW_MS, w++
      ) {
        const end = Math.min(start + WINDOW_MS - 1, nowMs);
        for (let offset = 0, p = 0; p < MAX_SEED_PAGES; p++) {
          const body = await this.call(creds, path, {
            startTime: String(start),
            endTime: String(end),
            offset: String(offset),
            limit: String(PAGE_LIMIT),
          });
          if (!Array.isArray(body)) {
            throw this.schemaError(`${path} response is not an array`, body);
          }
          for (const row of body) {
            if (isObject(row) && typeof row.coin === 'string') {
              coins.add(normalizeAsset('binance', row.coin));
            }
          }
          if (body.length < PAGE_LIMIT) break;
          offset += body.length;
        }
      }
    }
    return coins;
  }

  private async listedSymbols() {
    const t = this.now();
    if (this.symbolCache && t - this.symbolCache.at < EXCHANGE_INFO_TTL_MS) {
      return this.symbolCache.list;
    }
    const body = await this.call(
      { apiKey: '', apiSecret: '' },
      '/api/v3/exchangeInfo',
      {},
    );
    if (!isObject(body) || !Array.isArray(body.symbols)) {
      throw this.schemaError('exchangeInfo has no symbols array', body);
    }
    const list = body.symbols.map((s: unknown) => {
      if (
        !isObject(s) ||
        typeof s.symbol !== 'string' ||
        typeof s.baseAsset !== 'string' ||
        typeof s.quoteAsset !== 'string'
      ) {
        throw this.schemaError(
          'exchangeInfo symbol has an unexpected shape',
          body,
        );
      }
      return {
        symbol: s.symbol.toUpperCase(),
        base: normalizeAsset('binance', s.baseAsset),
        quote: normalizeAsset('binance', s.quoteAsset),
        status: typeof s.status === 'string' ? s.status : '',
      };
    });
    this.symbolCache = { at: t, list };
    return list;
  }

  private async balances(creds: Credentials): Promise<RawBalance[]> {
    const body = await this.call(creds, '/api/v3/account', {});
    if (!isObject(body) || !Array.isArray(body.balances)) {
      throw this.schemaError('Account response has no balances array', body);
    }
    const byAsset = new Map<string, { free: string; locked: string }>();
    for (const row of body.balances) {
      if (
        !isObject(row) ||
        typeof row.asset !== 'string' ||
        !isDecimal(row.free) ||
        !isDecimal(row.locked)
      ) {
        throw this.schemaError('Balance row has an unexpected shape', body);
      }
      // Earn wrapper tokens (LD-prefixed, e.g. LDBTC) are not unwrapped: the docs do
      // not describe them, so they are reported as their own asset (upper-cased only).
      const asset = normalizeAsset('binance', row.asset);
      const entry = byAsset.get(asset) ?? { free: '0', locked: '0' };
      entry.free = addDecimal(entry.free, row.free);
      entry.locked = addDecimal(entry.locked, row.locked);
      byAsset.set(asset, entry);
    }
    return [...byAsset.entries()]
      .filter(([, v]) => !isZero(v.free) || !isZero(v.locked))
      .map(([asset, v]) => ({ asset, free: v.free, locked: v.locked }));
  }

  private parseCursor(cursor: string): Cursor {
    const w = /^(dep|wd):(\d{1,15}):(\d{1,9}):(\d{1,15})$/.exec(cursor);
    if (w) {
      return {
        stage: w[1] as Stage,
        start: Number(w[2]),
        offset: Number(w[3]),
        origin: Number(w[4]),
      };
    }
    const t = /^trd:(>?)([A-Z0-9]{0,20}):(\d{1,15})$/.exec(cursor);
    if (t && (t[1] === '>' || t[2] !== '')) {
      return {
        stage: 'trd',
        after: t[1] === '>',
        symbol: t[2],
        fromId: Number(t[3]),
      };
    }
    throw new ExchangeSchemaError('Invalid Binance history cursor', cursor);
  }

  private trim(c: Credentials): Credentials {
    return {
      apiKey: c.apiKey.trim(),
      apiSecret: c.apiSecret.trim(),
      passphrase: c.passphrase?.trim(),
    };
  }

  /** Allow-listed GET (signed unless public); returns the parsed JSON body. */
  private async call(
    creds: Credentials,
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    if (!READ_ENDPOINTS.has(path)) {
      throw new Error(`Refusing to call non-read Binance endpoint ${path}`);
    }
    const isPublic = PUBLIC_ENDPOINTS.has(path);
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = {};
    let qs: string;
    if (isPublic) {
      qs = query.toString();
    } else {
      query.set('recvWindow', String(RECV_WINDOW_MS));
      query.set('timestamp', String(this.now()));
      const unsigned = query.toString();
      qs = `${unsigned}&signature=${signBinance(unsigned, creds.apiSecret)}`;
      headers['X-MBX-APIKEY'] = creds.apiKey;
    }

    // One deadline covers connect, headers and body so a hung socket cannot stall a sync.
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Binance request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${HOST}${path}${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers,
        redirect: 'error', // never re-send the API key to a redirect target
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Binance request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }

    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();

    if (res.status === 429 || res.status === 418) {
      throw new ExchangeRateLimitError(
        `Binance returned HTTP ${res.status}`,
        undefined,
        this.retryAfterMs(res),
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ExchangeNetworkError(
        `Binance returned a non-JSON response (HTTP ${res.status}): ${this.sanitize(text, creds)}`,
      );
    }

    if (!res.ok) {
      if (res.status >= 500) {
        throw new ExchangeNetworkError(`Binance returned HTTP ${res.status}`);
      }
      if (isObject(parsed) && typeof parsed.code === 'number') {
        throw this.mapApiError(parsed.code, parsed.msg, creds);
      }
      throw new ExchangeNetworkError(`Binance returned HTTP ${res.status}`);
    }
    return parsed;
  }

  private retryAfterMs(res: Response): number | undefined {
    const raw = res.headers?.get?.('retry-after');
    const seconds = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : undefined;
  }

  private mapApiError(code: number, msg: unknown, creds: Credentials) {
    const text = `Binance error ${code}: ${this.sanitize(msg, creds)}`;
    switch (code) {
      case -1003:
        return new ExchangeRateLimitError(text);
      case -2014: // malformed API key
      case -2015: // invalid key, IP or permissions
      case -1022: // invalid signature
      case -1002: // unauthorized
        return new ExchangeAuthError(text);
      case -1021: // timestamp outside recvWindow: clock skew, not a credential problem
        return new ExchangeNetworkError(
          text,
          "The server clock is out of sync with the exchange. The sync will retry; if it persists, check the server's clock.",
        );
      case -1000:
      case -1001:
      case -1006:
      case -1007:
        return new ExchangeNetworkError(text);
      default:
        return new ExchangeNetworkError(
          text,
          'The exchange reported an error. Check the connection and try again.',
          false,
        );
    }
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [
      creds.apiKey,
      creds.apiSecret,
      creds.passphrase,
    ]);
  }
}
