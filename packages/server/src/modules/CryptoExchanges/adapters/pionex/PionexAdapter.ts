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
/**
 * fills, allOrders and common/symbols weigh 5 (official openapi.yaml): at most 2 per
 * second, shared across those paths per key (see `call`); everything else 10 per second.
 */
const SLOW_GAP_MS = 600;
const FAST_GAP_MS = 120;
const HEAVY_PATHS = new Set([
  '/api/v1/trade/fills',
  '/api/v1/trade/allOrders',
  '/api/v1/common/symbols',
]);

/** Lower bound of any history walk (Pionex launched its API in 2018). */
const HISTORY_FLOOR_MS = Date.UTC(2018, 0, 1);
/** `since` is moved back by this much so a late-arriving row is never missed. */
const SINCE_OVERLAP_MS = 86_400_000;
/** HTTP requests (one data page each) a single `fetchHistory` call may make. */
const MAX_REQUESTS_PER_CALL = 8;
/** Official page sizes: `fills` returns the latest 100, `allOrders` takes limit 1..200. */
const FILLS_PAGE = 100;
const ORDERS_PAGE = 200;
/**
 * Markets walked per history run (fills then orders for each). Markets are the
 * enabled SPOT markets whose base coin is held or previously seen, USDT/USDC quoted
 * first; any beyond the cap are skipped with a (once per key) log warning stating how
 * many were not covered. The list lives in the cursor, so the cap also bounds the
 * cursor size: 300 symbols of at most 40 characters serialize to under 13 KB.
 */
export const MAX_PIONEX_MARKETS = 300;
/** Consecutive no-progress steps before the createTime fallback is trusted (orders). */
const STUCK_LIMIT = 4;
const MAX_SYMBOL_LENGTH = 40;
const SYMBOL_RE = /^[A-Za-z0-9_.\-]+$/;
const MAX_CURSOR_LENGTH = 16_384;
/** Ids longer than this are shortened with a hash so composed ids stay under varchar(191). */
const MAX_ID_FRAGMENT = 64;
const SIDES = new Set(['BUY', 'SELL']);
const ROLES = new Set(['TAKER', 'MAKER']);
const ORDER_TYPES = new Set(['LIMIT', 'MARKET']);
const ORDER_STATUSES = new Set(['OPEN', 'CLOSED']);

type HistoryCursor = {
  phase: 'fills' | 'orders';
  /** Index into `symbols` of the market being walked. */
  symbolIndex: number;
  /** Upper bound (ms) of the window still to fetch for this market and phase. */
  endTime: number;
  /** Lower bound (ms) of every window in this run. */
  start: number;
  symbols: string[];
  /** Consecutive steps that made no progress (omitted when 0). */
  stuck?: number;
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
    /("(?:free|frozen|price|size|amount|fee|filledSize|filledAmount|investmentAmount|profit|id|orderId)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g,
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
  /** key-hash warnings already logged: truncated market list, ms-tie, rejected markets (bounded). */
  private readonly historyWarned = new Set<string>();
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

  /**
   * Spot fills and orders, per market (the API has no account-wide listing).
   *
   * Markets: enabled SPOT markets from `common/symbols` whose base coin is in
   * `knownAssets`, or, when the caller has none (first sync), in the current
   * non-zero `account/balances`. The list is built on the first call of a run and
   * carried in the cursor, so later calls make no discovery requests.
   *
   * Cursor (opaque, bounded, validated): `{phase, symbolIndex, endTime, start,
   * symbols}`. Each market is walked fills first, then orders, backwards from now to
   * `start = max(since - 1 day, 2018-01-01)`. Both endpoints return the LATEST rows in
   * the window (fills: 100, allOrders: `limit`), so a full page re-requests with
   * `endTime` moved to the oldest timestamp on it, computed from the rows themselves
   * (response order is never relied on). The docs do not say whether `endTime` is
   * inclusive, so the next window ends at oldest + 1 ms: with an inclusive end the
   * rows at the oldest millisecond come back (deduplicated), with an exclusive end
   * they are included too, so a same-millisecond group straddling the page edge is
   * never lost. For orders the docs do not say whether the window uses createTime or
   * updateTime: the first candidate is minimum updateTime + 1 (exact for updateTime
   * windows, safe for createTime windows since update >= create). When it makes no
   * progress the window steps back 1 ms (`endTime - 1`, logged once per key) and a
   * `stuck` counter in the cursor counts such steps. Minimum createTime + 1 is used
   * only when the page proves createTime windowing (a row updated after `endTime`),
   * or, as a bounded last resort, after STUCK_LIMIT consecutive stuck steps (a
   * createTime-windowed API whose orders were all updated recently would otherwise
   * crawl 1 ms at a time; this can skip rows if the API windows by updateTime and
   * more than STUCK_LIMIT ms are each full pages, and is logged). So a walk always
   * terminates; rows beyond a page sharing one millisecond are the expected loss.
   * A call makes at most MAX_REQUESTS_PER_CALL HTTP requests (discovery included);
   * no `nextCursor` once the last market and phase are done.
   *
   * A market the API rejects (TRADE_INVALID_SYMBOL / TRADE_PARAMETER_ERROR) is skipped.
   */
  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] } = {},
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const creds = this.trim(c);
    const budget = { used: 0 };
    const records: RawRecordInput[] = [];
    const seen = new Set<string>();

    let cur: HistoryCursor | undefined;
    if (q.cursor) {
      cur = this.parseHistoryCursor(q.cursor);
    } else {
      const symbols = await this.discoverMarkets(
        creds,
        q.knownAssets ?? [],
        budget,
      );
      if (symbols.length === 0) return { records };
      const sinceMs = q.since?.getTime();
      const start = Math.max(
        HISTORY_FLOOR_MS,
        Number.isSafeInteger(sinceMs) ? sinceMs! - SINCE_OVERLAP_MS : 0,
      );
      cur = {
        phase: 'fills',
        symbolIndex: 0,
        endTime: Math.max(this.now(), start),
        start,
        symbols,
      };
    }

    while (cur) {
      if (budget.used >= MAX_REQUESTS_PER_CALL) {
        return { records, nextCursor: this.serializeHistoryCursor(cur) };
      }
      cur = await this.historyStep(creds, cur, records, seen, budget);
    }
    return { records };
  }

  /** Builds the bounded, ordered market list for a run (1 to 2 requests). */
  private async discoverMarkets(
    creds: Credentials,
    knownAssets: string[],
    budget: { used: number },
  ): Promise<string[]> {
    const coins = new Set<string>();
    for (const a of knownAssets) {
      if (typeof a === 'string' && a.trim()) {
        coins.add(normalizeAsset('pionex', a));
      }
    }
    if (coins.size === 0) {
      budget.used++;
      const res = await this.call(creds, '/api/v1/account/balances', {});
      const rows = res.data?.balances;
      if (!Array.isArray(rows)) {
        throw this.schemaError(
          'account/balances data.balances is not an array',
          res,
        );
      }
      for (const row of rows) {
        if (
          isObject(row) &&
          typeof row.coin === 'string' &&
          row.coin.trim() !== '' &&
          isDecimal(row.free) &&
          isDecimal(row.frozen) &&
          !(isZero(row.free) && isZero(row.frozen))
        ) {
          coins.add(normalizeAsset('pionex', row.coin));
        }
      }
    }
    if (coins.size === 0) return [];

    budget.used++;
    const res = await this.call(creds, '/api/v1/common/symbols', {});
    const list = res.data?.symbols;
    if (!Array.isArray(list)) {
      throw this.schemaError(
        'common/symbols data.symbols is not an array',
        res,
      );
    }
    const picked = new Map<string, number>(); // symbol -> quote rank
    for (const s of list) {
      if (
        !isObject(s) ||
        s.type !== 'SPOT' ||
        s.enable !== true ||
        typeof s.symbol !== 'string' ||
        s.symbol.length > MAX_SYMBOL_LENGTH ||
        !SYMBOL_RE.test(s.symbol) ||
        typeof s.baseCurrency !== 'string' ||
        !coins.has(normalizeAsset('pionex', s.baseCurrency))
      ) {
        continue; // disabled, non-spot, malformed or not an asset we hold or saw
      }
      const quote =
        typeof s.quoteCurrency === 'string'
          ? normalizeAsset('pionex', s.quoteCurrency)
          : '';
      picked.set(s.symbol, quote === 'USDT' ? 0 : quote === 'USDC' ? 1 : 2);
    }
    const ordered = [...picked.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([symbol]) => symbol);
    if (ordered.length > MAX_PIONEX_MARKETS) {
      this.warnOnce(
        creds,
        'truncated',
        `Pionex history: ${ordered.length - MAX_PIONEX_MARKETS} of ${ordered.length} markets are not covered (limit ${MAX_PIONEX_MARKETS} per run)`,
      );
    }
    return ordered.slice(0, MAX_PIONEX_MARKETS);
  }

  /** One request (or a free transition) of the walk; returns the next cursor, or undefined at the end. */
  private async historyStep(
    creds: Credentials,
    cur: HistoryCursor,
    records: RawRecordInput[],
    seen: Set<string>,
    budget: { used: number },
  ): Promise<HistoryCursor | undefined> {
    if (cur.endTime < cur.start) return this.afterPhase(cur);
    const fills = cur.phase === 'fills';
    const symbol = cur.symbols[cur.symbolIndex];
    const query: Record<string, string | number> = {
      symbol,
      startTime: cur.start,
      endTime: cur.endTime,
      ...(fills ? {} : { limit: ORDERS_PAGE }),
    };
    let res: Json;
    budget.used++;
    try {
      res = await this.call(
        creds,
        fills ? '/api/v1/trade/fills' : '/api/v1/trade/allOrders',
        query,
      );
    } catch (e) {
      // A delisted/rejected market never fails the sync (nor trips the cool-down).
      if (this.isRejectedMarket(e)) {
        this.warnOnce(
          creds,
          `skip:${symbol}`,
          `Pionex history: market ${symbol} skipped (${(e as Error).message.match(/TRADE_(?:INVALID_SYMBOL|PARAMETER_ERROR)/)![0]})`,
        );
        return this.nextMarket(cur);
      }
      throw e;
    }
    const rows = fills ? res.data?.fills : res.data?.orders;
    if (!Array.isArray(rows)) {
      throw this.schemaError(
        `trade/${fills ? 'fills' : 'allOrders'} data.${fills ? 'fills' : 'orders'} is not an array`,
        res,
      );
    }

    let oldest: number | undefined;
    let oldestAlt: number | undefined;
    let newest: number | undefined;
    for (const row of rows) {
      const mapped = fills
        ? this.mapFill(row, cur.endTime)
        : this.mapOrder(row, cur.endTime);
      if (!seen.has(mapped.record.exchangeRecordId)) {
        seen.add(mapped.record.exchangeRecordId);
        records.push(mapped.record);
      }
      if (
        mapped.walkMs !== undefined &&
        (oldest === undefined || mapped.walkMs < oldest)
      ) {
        oldest = mapped.walkMs;
      }
      if (
        mapped.walkMs !== undefined &&
        (newest === undefined || mapped.walkMs > newest)
      ) {
        newest = mapped.walkMs;
      }
      if (
        mapped.altMs !== undefined &&
        (oldestAlt === undefined || mapped.altMs < oldestAlt)
      ) {
        oldestAlt = mapped.altMs;
      }
    }

    const cap = fills ? FILLS_PAGE : ORDERS_PAGE;
    if (rows.length >= cap && oldest !== undefined) {
      const stuck = cur.stuck ?? 0;
      let next: number | undefined =
        oldest + 1 < cur.endTime ? oldest + 1 : undefined;
      let nextStuck = 0;
      if (next === undefined) {
        const alt = (oldestAlt ?? oldest) + 1;
        // A row updated after endTime proves the window is not on updateTime.
        const proven = newest !== undefined && newest > cur.endTime;
        if (alt < cur.endTime && (proven || stuck >= STUCK_LIMIT)) {
          next = alt;
          if (!proven) {
            this.warnOnce(
              creds,
              'alt',
              'Pionex history: allOrders made no progress for several steps; continued from the earliest createTime and rows updated in between may be missed',
            );
          }
        } else {
          this.warnOnce(
            creds,
            'tie',
            'Pionex history: a full page made no progress; more than a page of rows may share one millisecond and the excess can be missed',
          );
          nextStuck = Math.min(stuck + 1, STUCK_LIMIT);
        }
      }
      const out: HistoryCursor = { ...cur, endTime: next ?? cur.endTime - 1 };
      if (nextStuck > 0) out.stuck = nextStuck;
      else delete out.stuck;
      return out;
    }
    return this.afterPhase(cur);
  }

  private afterPhase(cur: HistoryCursor): HistoryCursor | undefined {
    if (cur.phase === 'fills') {
      const { stuck: _stuck, ...rest } = cur;
      return { ...rest, phase: 'orders', endTime: this.freshEnd(cur) };
    }
    return this.nextMarket(cur);
  }

  private nextMarket(cur: HistoryCursor): HistoryCursor | undefined {
    if (cur.symbolIndex + 1 >= cur.symbols.length) return undefined;
    const { stuck: _stuck, ...rest } = cur;
    return {
      ...rest,
      phase: 'fills',
      symbolIndex: cur.symbolIndex + 1,
      endTime: this.freshEnd(cur),
    };
  }

  private freshEnd(cur: HistoryCursor): number {
    return Math.max(this.now(), cur.start);
  }

  private warnOnce(creds: Credentials, what: string, message: string) {
    const id = `${this.hashKey(creds)}:${what}`;
    if (this.historyWarned.has(id)) return;
    if (this.historyWarned.size >= 1024) this.historyWarned.clear();
    this.historyWarned.add(id);
    this.logger.warn(message); // market symbols and counts only; never keys
  }

  private hashKey(creds: Credentials): string {
    return createHash('sha256').update(creds.apiKey).digest('hex');
  }

  private isRejectedMarket(e: unknown): boolean {
    return (
      e instanceof ExchangeNetworkError &&
      /TRADE_(INVALID_SYMBOL|PARAMETER_ERROR)/.test(e.message)
    );
  }

  private msOf(v: unknown): number | undefined {
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string' && /^\d{1,16}$/.test(v)
          ? Number(v)
          : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }

  private idText(v: unknown): string | undefined {
    if (typeof v === 'string' && v.length > 0 && v.length <= 1000) {
      if (v.length <= MAX_ID_FRAGMENT) return v;
      const hash = createHash('sha256').update(v).digest('hex').slice(0, 16);
      return `${v.slice(0, 40)}~${hash}`;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
    return undefined;
  }

  /** Decimal text, optionally signed (a fee can be a rebate). */
  private isSignedDecimal(v: unknown): v is string {
    return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
  }

  private mapFill(
    row: unknown,
    at: number,
  ): { record: RawRecordInput; walkMs?: number; altMs?: number } {
    const ms = isObject(row) ? this.msOf(row.timestamp) : undefined;
    const id = isObject(row) ? this.idText(row.id) : undefined;
    if (
      !isObject(row) ||
      !id ||
      ms === undefined ||
      typeof row.symbol !== 'string' ||
      !SIDES.has(row.side) ||
      !ROLES.has(row.role) ||
      !isDecimal(row.price) ||
      !isDecimal(row.size) ||
      !this.isSignedDecimal(row.fee) ||
      typeof row.feeCoin !== 'string'
    ) {
      return {
        record: this.unparsedRecord('fills', row, ms ?? at),
        walkMs: ms,
      };
    }
    return {
      walkMs: ms,
      record: {
        type: 'trade',
        exchangeRecordId: `fill:${id}`,
        occurredAt: new Date(ms),
        payload: { ...row, _source: 'fills' },
      },
    };
  }

  private mapOrder(
    row: unknown,
    at: number,
  ): { record: RawRecordInput; walkMs?: number; altMs?: number } {
    const obj = isObject(row) ? row : undefined;
    const created = obj ? this.msOf(obj.createTime) : undefined;
    const updated = obj ? this.msOf(obj.updateTime) : undefined;
    // The window may use either time: walk by updateTime (>= createTime), with
    // createTime as the progress fallback (see fetchHistory).
    const walkMs = updated ?? created;
    const altMs = created ?? updated;
    const occurred = updated ?? created;
    const id = obj ? this.idText(obj.orderId) : undefined;
    const numeric = ['price', 'size', 'amount', 'filledSize', 'filledAmount']
      .map((k) => obj?.[k])
      .every((v) => v === undefined || v === '' || isDecimal(v));
    if (
      !obj ||
      !id ||
      occurred === undefined ||
      typeof obj.symbol !== 'string' ||
      !ORDER_STATUSES.has(obj.status) ||
      (obj.side !== undefined && !SIDES.has(obj.side)) ||
      (obj.type !== undefined && !ORDER_TYPES.has(obj.type)) ||
      !numeric ||
      (obj.fee !== undefined &&
        obj.fee !== '' &&
        !this.isSignedDecimal(obj.fee))
    ) {
      return {
        record: this.unparsedRecord('order-history', row, occurred ?? at),
        walkMs,
        altMs,
      };
    }
    // One immutable raw row per status transition: the status is part of the id.
    return {
      walkMs,
      altMs,
      record: {
        type: 'trade',
        exchangeRecordId: `order:${id}:s${obj.status}`,
        occurredAt: new Date(occurred),
        payload: { ...obj, _source: 'order-history' },
      },
    };
  }

  /** Unknown shapes are kept (never dropped); the id is a content hash so re-fetches dedupe. */
  private unparsedRecord(
    source: 'fills' | 'order-history',
    row: unknown,
    at: number,
  ): RawRecordInput {
    const hash = createHash('sha256')
      .update(JSON.stringify(row) ?? 'undefined')
      .digest('hex')
      .slice(0, 32);
    return {
      type: 'unparsed',
      exchangeRecordId: `unparsed:pionex-${source}:${hash}`,
      occurredAt: new Date(at),
      payload: { stream: source, row: redactSecrets(row) },
    };
  }

  private parseHistoryCursor(raw: string): HistoryCursor {
    const bad = () =>
      new ExchangeSchemaError(
        'Invalid Pionex history cursor',
        raw.slice(0, 200),
      );
    if (typeof raw !== 'string' || raw.length > MAX_CURSOR_LENGTH) throw bad();
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      throw bad();
    }
    if (
      !isObject(v) ||
      (v.phase !== 'fills' && v.phase !== 'orders') ||
      !Array.isArray(v.symbols) ||
      v.symbols.length < 1 ||
      v.symbols.length > MAX_PIONEX_MARKETS ||
      !v.symbols.every(
        (s: unknown) =>
          typeof s === 'string' &&
          s.length <= MAX_SYMBOL_LENGTH &&
          SYMBOL_RE.test(s),
      ) ||
      !Number.isSafeInteger(v.symbolIndex) ||
      v.symbolIndex < 0 ||
      v.symbolIndex >= v.symbols.length ||
      !Number.isSafeInteger(v.endTime) ||
      v.endTime <= 0 ||
      !Number.isSafeInteger(v.start) ||
      v.start < HISTORY_FLOOR_MS ||
      (v.stuck !== undefined &&
        (!Number.isSafeInteger(v.stuck) ||
          v.stuck < 1 ||
          v.stuck > STUCK_LIMIT))
    ) {
      throw bad();
    }
    return {
      phase: v.phase,
      symbolIndex: v.symbolIndex,
      endTime: v.endTime,
      start: v.start,
      symbols: [...v.symbols],
      ...(v.stuck ? { stuck: v.stuck } : {}),
    };
  }

  private serializeHistoryCursor(c: HistoryCursor): string {
    return JSON.stringify({
      phase: c.phase,
      symbolIndex: c.symbolIndex,
      endTime: c.endTime,
      start: c.start,
      symbols: c.symbols,
      ...(c.stuck ? { stuck: c.stuck } : {}),
    });
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
      // Weight-5 paths share one budget per key, so alternating fills/allOrders/
      // symbols calls never exceed 2 per second.
      const heavy = HEAVY_PATHS.has(path);
      const gap = heavy ? SLOW_GAP_MS : FAST_GAP_MS;
      const sentKey = `${key}:${heavy ? 'heavy' : path}`;
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
