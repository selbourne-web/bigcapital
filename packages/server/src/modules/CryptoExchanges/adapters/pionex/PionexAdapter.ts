import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
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
import {
  addDecimal,
  isDecimal,
  isZero,
  sanitizeText,
  subDecimal,
} from '../shared';
import { pionexSign } from './pionex.signing';

const BASE_URL = 'https://api.pionex.com';

/**
 * Read-only endpoints (all GET). The adapter must never reach a state-changing
 * endpoint (orders, `/api/v1/assets/transfer`, ...), so anything else is refused.
 */
const READ_PATHS = new Set([
  '/api/v1/account/balances',
  '/api/v1/wallet/balancesFull',
  '/api/v1/common/symbols',
  '/api/v1/trade/fills',
  '/api/v1/trade/allOrders',
  '/api/v1/bot/orders',
]);

/** Pionex bans for 60 s after HTTP 429 and a retry inside the ban EXTENDS it. */
const COOL_DOWN_MS = 60_000;
/** Pionex rejects timestamps older than 20 s or in the future: send slightly in the past. */
const TIMESTAMP_SKEW_MS = 1_000;
/** fills/allOrders weigh 5 (2 per second); everything else 10 per second. */
const SLOW_GAP_MS = 600;
const FAST_GAP_MS = 120;
const METHOD_GAP_MS: Record<string, number> = {
  '/api/v1/trade/fills': SLOW_GAP_MS,
  '/api/v1/trade/allOrders': SLOW_GAP_MS,
};

/** Segments of `wallet/balancesFull` botAccount that hold funds NOT in account/balances. */
const BOT_FUND_SEGMENTS = new Set(['trading_bot', 'lending']);

const BOT_PERMISSION_WARNING =
  'Bot and lending balances need the Bot reading permission; without it only spot balances are imported.';

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Amount-like fields are decimal strings in the documented API, but if one ever
 * arrives as a JSON number, JSON.parse would round it. Before parsing, wrap those
 * number tokens in quotes in the RAW text so the exact decimal text survives.
 */
export function quoteExactNumbers(text: string): string {
  return text.replace(
    /("(?:free|frozen|price|size|amount|fee|filledSize|filledAmount|investmentAmount|profit)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g,
    '$1"$2"',
  );
}

type Json = Record<string, any>;

const isObject = (v: unknown): v is Json =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class PionexAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'pionex';
  readonly historyCoverage: HistoryCoverage = {
    level: 'partial',
    note: 'Pionex API history is limited to the latest 100 fills per market and excludes deposits, withdrawals and bot activity; import the CSV exports for complete history.',
  };
  /** 10 req/s per account and IP; fills/allOrders weigh 5. A history page costs 10 tokens (capacity must be >= cost). */
  readonly rateLimit = { capacity: 10, refillPerSec: 10, historyPageCost: 10 };

  private readonly logger = new Logger('PionexAdapter');
  /** api-key hashes already warned about skipped bot/lending balances (bounded). */
  private readonly botSkipWarned = new Set<string>();
  /** Last send time per "<key hash>:<path>" (bounded; see markSent). */
  private readonly sentAt = new Map<string, number>();
  /** Per api-key hash: epoch ms until which no request may be sent (HTTP 429 ban). */
  private readonly coolUntil = new Map<string, number>();
  /** Per-api-key serialization lanes; removed when a key has no calls in flight. */
  private readonly lanes = new Map<
    string,
    { tail: Promise<unknown>; pending: number }
  >();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly requestTimeoutMs: number = 30_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    // The first authenticated call: auth/clock/IP errors propagate with clear messages.
    await this.call(creds, '/api/v1/account/balances', {});
    const permissions = ['read'];
    const warnings: string[] = [];
    try {
      // Pionex has no permission introspection; a working bot listing means the key
      // also has Bot reading. No probe error propagates (auth, 429, 5xx, network).
      await this.call(creds, '/api/v1/bot/orders', { status: 'running' });
      permissions.push('bot-read');
    } catch (e) {
      // cannot tell: leave as plain 'read'; a permission error is worth a warning
      if (this.isPermissionDenied(e)) warnings.push(BOT_PERMISSION_WARNING);
    }
    return { readOnly: 'unverifiable', permissions, warnings };
  }

  /**
   * Trading balances (`account/balances`) plus funds locked in bots and earn
   * products from `wallet/balancesFull`. The `spot` segment of balancesFull repeats
   * the trading account (adding it would double count), `arbitrage`, `traderAccount`
   * and `extractBalances` are out of scope, so only `trading_bot` and `lending`
   * entries (`investmentAmount + profit` in `investmentToken`) are added, as locked.
   * A failing balancesFull call propagates: bot funds are never silently omitted.
   */
  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    const creds = this.trim(c);
    const out = new Map<string, { free: string; locked: string }>();
    const add = (coin: string, free: string, locked: string) => {
      const asset = normalizeAsset('pionex', coin);
      const prev = out.get(asset);
      if (prev) {
        prev.free = addDecimal(prev.free, free);
        prev.locked = addDecimal(prev.locked, locked);
      } else {
        out.set(asset, { free, locked });
      }
    };

    const trading = await this.call(creds, '/api/v1/account/balances', {});
    const rows = trading.data?.balances;
    if (!Array.isArray(rows)) {
      throw this.schemaError(
        'account/balances data.balances is not an array',
        trading,
      );
    }
    for (const row of rows) {
      if (
        !isObject(row) ||
        typeof row.coin !== 'string' ||
        row.coin.trim() === '' ||
        !isDecimal(row.free) ||
        !isDecimal(row.frozen)
      ) {
        continue; // zero/negative/malformed entries never fail the sync
      }
      if (isZero(row.free) && isZero(row.frozen)) continue;
      add(row.coin, addDecimal(row.free, '0'), addDecimal(row.frozen, '0'));
    }

    let full: Json;
    try {
      full = await this.call(creds, '/api/v1/wallet/balancesFull', {});
    } catch (e) {
      // Only a missing Bot reading permission degrades to spot-only balances.
      if (!this.isPermissionDenied(e)) throw e;
      this.warnBotSkipped(creds);
      return this.toBalances(out);
    }
    const data = full.data;
    if (!isObject(data)) {
      throw this.schemaError('wallet/balancesFull data is not an object', full);
    }
    const bot = data.botAccount;
    if (bot !== undefined && bot !== null) {
      if (!isObject(bot) || !Array.isArray(bot.detail)) {
        throw this.schemaError(
          'wallet/balancesFull botAccount.detail is not an array',
          full,
        );
      }
      for (const segment of bot.detail) {
        if (
          !isObject(segment) ||
          typeof segment.type !== 'string' ||
          !BOT_FUND_SEGMENTS.has(segment.type) ||
          !Array.isArray(segment.list)
        ) {
          continue; // spot (duplicate), arbitrage (null list), unknown segments
        }
        for (const entry of segment.list) {
          const funds = this.botFunds(entry);
          if (funds) add(funds.coin, '0', funds.amount);
        }
      }
    }
    return this.toBalances(out);
  }

  private toBalances(
    out: Map<string, { free: string; locked: string }>,
  ): RawBalance[] {
    return [...out.entries()].map(([asset, v]) => ({ asset, ...v }));
  }

  private isPermissionDenied(e: unknown): boolean {
    return (
      e instanceof ExchangeAuthError && e.message.includes('PERMISSION_DENIED')
    );
  }

  private warnBotSkipped(creds: Credentials) {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    if (this.botSkipWarned.has(key)) return;
    if (this.botSkipWarned.size >= 256) this.botSkipWarned.clear();
    this.botSkipWarned.add(key);
    this.logger.warn(
      'Pionex bot/lending balances skipped: key lacks Bot reading permission',
    );
  }

  /** `investmentAmount + profit` (profit may be negative); undefined for unusable entries. */
  private botFunds(
    entry: unknown,
  ): { coin: string; amount: string } | undefined {
    if (
      !isObject(entry) ||
      typeof entry.investmentToken !== 'string' ||
      entry.investmentToken.trim() === '' ||
      !isDecimal(entry.investmentAmount)
    ) {
      return undefined;
    }
    const profit = entry.profit === undefined ? '0' : entry.profit;
    let amount: string;
    if (isDecimal(profit)) {
      amount = addDecimal(entry.investmentAmount, profit);
    } else if (typeof profit === 'string' && /^-\d+(\.\d+)?$/.test(profit)) {
      amount = subDecimal(entry.investmentAmount, profit.slice(1)); // clamps at 0
    } else {
      return undefined;
    }
    if (isZero(amount)) return undefined;
    return { coin: entry.investmentToken, amount };
  }

  /** TODO(Task 3): fills/allOrders history. Until then the adapter returns no history. */
  async fetchHistory(): Promise<{
    records: RawRecordInput[];
    nextCursor?: string;
  }> {
    return { records: [] };
  }

  private trim(c: Credentials): Credentials {
    return { apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
  }

  /** Serialized per api key; paced per key and path; honours the per-key 429 cool-down. */
  private call(
    creds: Credentials,
    path: string,
    query: Record<string, string | number>,
  ): Promise<Json> {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0 };
      this.lanes.set(key, lane);
    }
    const l = lane;
    l.pending++;
    const run = l.tail.then(async () => {
      // Cool-down first: a request inside Pionex's ban window would extend the ban.
      const until = this.coolUntil.get(key);
      if (until !== undefined) {
        const remaining = until - this.now();
        if (remaining > 0) {
          throw this.rateLimited(remaining);
        }
        this.coolUntil.delete(key);
      }
      const gap = METHOD_GAP_MS[path] ?? FAST_GAP_MS;
      const sentKey = `${key}:${path}`;
      const last = this.sentAt.get(sentKey);
      if (last !== undefined) {
        const wait = last + gap - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.markSent(sentKey);
      return this.send(creds, key, path, query);
    });
    l.tail = run.catch(() => undefined);
    const done = () => {
      if (--l.pending === 0 && this.lanes.get(key) === l) {
        this.lanes.delete(key);
      }
    };
    run.then(done, done);
    return run;
  }

  private markSent(sentKey: string) {
    const t = this.now();
    this.sentAt.set(sentKey, t);
    if (this.sentAt.size > 256) {
      for (const [k, v] of this.sentAt) {
        if (t - v > SLOW_GAP_MS) this.sentAt.delete(k);
      }
    }
  }

  private rateLimited(retryAfterMs: number) {
    return new ExchangeRateLimitError(
      'Pionex: rate limited (HTTP 429), cooling down',
      'Pionex is rate limiting this API key. The sync will retry after the cool-down.',
      retryAfterMs,
    );
  }

  private async send(
    creds: Credentials,
    keyHash: string,
    path: string,
    query: Record<string, string | number>,
  ): Promise<Json> {
    if (!READ_PATHS.has(path)) {
      throw new Error(`Refusing to call non-read Pionex endpoint ${path}`);
    }
    const full: Record<string, string | number> = {
      ...query,
      timestamp: this.now() - TIMESTAMP_SKEW_MS,
    };
    for (const [k, v] of Object.entries(full)) {
      if (!/^[A-Za-z0-9_]+$/.test(k) || !/^[A-Za-z0-9_.\-]+$/.test(String(v))) {
        throw new ExchangeNetworkError(
          `Refusing unsafe Pionex query parameter ${k}`,
          'The request contained an unsupported character.',
          false,
        );
      }
    }
    const signature = pionexSign({
      method: 'GET',
      path,
      query: full,
      secret: creds.apiSecret,
    });
    const qs = Object.keys(full)
      .sort()
      .map((k) => `${k}=${full[k]}`)
      .join('&');
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Pionex request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, {
        method: 'GET',
        headers: {
          'PIONEX-KEY': creds.apiKey,
          'PIONEX-SIGNATURE': signature,
        },
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Pionex request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }

    // Always drain the body (also on 429) so the connection is released.
    const text = await res.text().catch(() => '');
    if (res.status === 429) {
      this.coolUntil.set(keyHash, this.now() + COOL_DOWN_MS);
      if (this.coolUntil.size > 256) this.pruneCoolDowns();
      throw this.rateLimited(COOL_DOWN_MS);
    }
    if (signal.aborted) throw timedOut();
    if (res.status >= 500) {
      throw new ExchangeNetworkError(`Pionex returned HTTP ${res.status}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(quoteExactNumbers(text));
    } catch {
      if (res.status === 401) throw this.mapCode('INVALID_APIKEY');
      throw new ExchangeSchemaError(
        'Pionex response was not valid JSON',
        this.sanitize(text, creds),
      );
    }
    // Pionex answers parameter errors with HTTP 200 + result:false: check it on any status.
    if (!isObject(parsed) || typeof parsed.result !== 'boolean') {
      if (res.status === 401) throw this.mapCode('INVALID_APIKEY');
      throw this.schemaError(
        'Pionex response is not the documented envelope',
        parsed,
      );
    }
    if (parsed.result === false) {
      const err = this.mapCode(
        typeof parsed.code === 'string' ? parsed.code : '',
      );
      // HTTP 401 is always an authentication problem, whatever the code says.
      if (res.status === 401 && !(err instanceof ExchangeAuthError)) {
        throw this.mapCode('INVALID_APIKEY');
      }
      throw err;
    }
    if (!res.ok) {
      throw new ExchangeNetworkError(`Pionex returned HTTP ${res.status}`);
    }
    return parsed;
  }

  private pruneCoolDowns() {
    const t = this.now();
    for (const [k, v] of this.coolUntil) {
      if (v <= t) this.coolUntil.delete(k);
    }
  }

  private mapCode(code: string) {
    switch (code) {
      case 'INVALID_APIKEY':
        return new ExchangeAuthError(
          'Pionex: invalid API key (INVALID_APIKEY)',
          'Pionex does not recognise this API key. Check that the key was copied correctly.',
        );
      case 'APIKEY_LOST':
        return new ExchangeAuthError(
          'Pionex: API key header missing (APIKEY_LOST)',
          'Pionex did not receive the API key. Check that the key is entered.',
        );
      case 'APIKEY_EXPIRED':
        return new ExchangeAuthError(
          'Pionex: API key expired (APIKEY_EXPIRED)',
          'This Pionex API key has expired. Create a new read-only key in Pionex and reconnect.',
        );
      case 'INVALID_SIGNATURE':
        return new ExchangeAuthError(
          'Pionex: signature incorrect (INVALID_SIGNATURE)',
          'Pionex rejected the request signature. Check the API secret.',
        );
      case 'SIGNATURE_LOST':
        return new ExchangeAuthError(
          'Pionex: signature missing (SIGNATURE_LOST)',
          'Pionex did not receive the request signature. Check the API secret is entered.',
        );
      case 'PERMISSION_DENIED':
        return new ExchangeAuthError(
          'Pionex: permission denied (PERMISSION_DENIED)',
          'This Pionex API key lacks the permission needed to read this data. Enable reading on the key.',
        );
      case 'IP_NOT_WHITELISTED':
        return new ExchangeAuthError(
          'Pionex: IP address not allow-listed (IP_NOT_WHITELISTED)',
          'This API key is IP-restricted and this server is not on its allow-list. Add the server IP in Pionex or remove the restriction.',
        );
      case 'INVALID_TIMESTAMP':
        return new ExchangeAuthError(
          'Pionex: timestamp rejected (INVALID_TIMESTAMP)',
          'Pionex rejected the request because the server clock is out of sync (older than 20 seconds or in the future). Check the server time and try again.',
        );
      case 'TRADE_PARAMETER_ERROR':
      case 'TRADE_INVALID_SYMBOL':
        // Non-auth, non-retryable; a history caller skips the offending market.
        return new ExchangeNetworkError(
          `Pionex error code ${code}`,
          'Pionex rejected a request parameter.',
          false,
        );
      default:
        return new ExchangeNetworkError(
          `Pionex error code ${this.sanitizeCode(code)}`,
          'The exchange reported an error. Check the connection and try again.',
          false,
        );
    }
  }

  private sanitizeCode(code: string): string {
    return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'unknown';
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [creds.apiKey, creds.apiSecret]);
  }
}
