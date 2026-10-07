import { createHash } from 'crypto';
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
import { isDecimal, isZero, sanitizeText } from '../shared';
import { cryptoComSign } from './cryptocom.signing';

const DEFAULT_BASE_URL = 'https://api.crypto.com/exchange/v1';

/**
 * Read-only methods. The adapter must never reach a state-changing method
 * (create-order, create-withdrawal, ...), so anything else is refused.
 */
const READ_METHODS = new Set([
  'private/user-balance',
  'private/get-accounts',
  'private/get-trades',
  'private/get-order-history',
  'private/get-transactions',
  'private/get-deposit-history',
  'private/get-withdrawal-history',
  'private/get-deposit-address', // inspectKey probe only; addresses are discarded
]);

const WITHDRAWAL_WARNING =
  'This Crypto.com key appears to have withdrawal permission enabled. Crypto.com does not expose key permissions, so please confirm the key is read-only (Can Read only).';

/** API retention for trades/orders/transactions (docs: "recent 6 months"); 180 days, conservative. */
export const CRYPTOCOM_RETENTION_MS = 180 * 86_400_000;
const DAY_MS = 86_400_000;
/** Trades/orders/transactions: one-day windows, 100 rows max. */
const TIME_WINDOW_MS = DAY_MS;
const TIME_LIMIT = 100;
/** Deposits/withdrawals: the API default window is 90 days; page size max 200. */
const LIST_WINDOW_MS = 90 * DAY_MS;
const LIST_PAGE_SIZE = 200;
/**
 * Deposit/withdrawal lists are windowed by creation time but their status changes
 * later, so `since` is stepped back this far (ids dedupe the overlap).
 */
const LIST_OVERLAP_MS = 14 * DAY_MS;
/** At most this many API requests per fetchHistory call (empty windows are skipped quickly). */
const MAX_REQUESTS_PER_CALL = 8;
/** Gap between requests inside one call: get-trades/get-order-history allow 1 req/s. */
const SLOW_GAP_MS = 1_100;
const FAST_GAP_MS = 150;

const STREAMS = [
  'trades',
  'orders',
  'transactions',
  'deposits',
  'withdrawals',
] as const;
type Stream = (typeof STREAMS)[number];
type HistoryCursor = { stream: Stream; windowEnd: number; page?: number };

const STREAM_METHOD: Record<Stream, string> = {
  trades: 'private/get-trades',
  orders: 'private/get-order-history',
  transactions: 'private/get-transactions',
  deposits: 'private/get-deposit-history',
  withdrawals: 'private/get-withdrawal-history',
};

/** Journal types that duplicate other streams (trades, deposits, withdrawals): not recorded. */
const DUPLICATE_JOURNAL_TYPES = new Set([
  'TRADING',
  'ONCHAIN_DEPOSIT',
  'ONCHAIN_WITHDRAWAL',
]);
const FEE_JOURNAL_TYPES = new Set([
  'TRADE_FEE',
  'LIQUIDATION_FEE',
  'SETTLEMENT_FEE',
]);
/** No documented get-transactions journal type is a reward (staking rewards live on a separate endpoint). */
const REWARD_JOURNAL_TYPES = new Set<string>();

/**
 * Deposit/withdrawal `amount` and `fee` arrive as JSON numbers, and JSON.parse would
 * round long ones. Before parsing, this wraps those two number tokens in quotes in
 * the RAW text so the exact decimal text survives (trailing zeros included).
 * Quoted keys inside string values are escaped (`\"`), so they cannot match.
 */
export function quoteExactNumbers(text: string): string {
  return text.replace(
    /("(?:amount|fee)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g,
    '$1"$2"',
  );
}

/** Plain non-negative decimal text from `12`, `0.0005`, `1e-7`; undefined otherwise. */
function exactDecimal(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v);
  if (!m) return undefined;
  const [, int, frac = '', exp] = m;
  if (exp === undefined) return v;
  const e = Number(exp);
  if (!Number.isInteger(e) || Math.abs(e) > 60) return undefined;
  const digits = int + frac;
  const point = int.length + e;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length)
    out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return out.replace(/^0+(?=\d)/, '');
}

/** Epoch ms from a number or numeric string; undefined when not a plausible ms time. */
function toMs(v: unknown): number | undefined {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && /^\d+$/.test(v)
        ? Number(v)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function idText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0 && v.length <= 100) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  return undefined;
}

type Json = Record<string, any>;

/** Exact decimal arithmetic on non-negative decimal strings. */
function scaled(a: string, b: string) {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  return {
    scale,
    x: BigInt(ai + af.padEnd(scale, '0')),
    y: BigInt(bi + bf.padEnd(scale, '0')),
  };
}

function format(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** a - b, clamped at 0. */
function subDecimal(a: string, b: string): string {
  const { scale, x, y } = scaled(a, b);
  return x > y ? format(x - y, scale) : '0';
}

function addDecimal(a: string, b: string): string {
  const { scale, x, y } = scaled(a, b);
  return format(x + y, scale);
}

export class CryptoComAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'crypto_com';
  readonly historyCoverage: HistoryCoverage = {
    level: 'partial',
    note: 'Crypto.com Exchange API history is limited to the last 6 months.',
  };
  /** 3 private calls per 100 ms; trades/order history 1 req/s, so history pages cost 10. */
  readonly rateLimit = { capacity: 3, refillPerSec: 10, historyPageCost: 10 };

  /**
   * Per-api-key serialization state (keyed by a hash of the key). The adapter is a
   * shared singleton, so a global queue would let one tenant's slow call delay
   * another's. Entries are removed when the key has no calls in flight.
   */
  private readonly lanes = new Map<
    string,
    {
      tail: Promise<unknown>;
      pending: number;
      lastId: number;
      lastNonce: number;
    }
  >();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly requestTimeoutMs: number = 30_000,
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = DEFAULT_BASE_URL, // overridable for tests only
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    // Cheap auth check first so bad key/clock/IP errors are reported once, clearly.
    await this.call(creds, 'private/user-balance', {});
    const unverifiable = (warnings: string[]): KeyInspection => ({
      readOnly: 'unverifiable',
      permissions: ['read'],
      warnings,
    });
    try {
      // Heuristic: vendor docs say this needs the withdrawal setting. The returned
      // addresses are discarded and never stored or logged.
      await this.call(creds, 'private/get-deposit-address', {
        currency: 'BTC',
      });
      return unverifiable([WITHDRAWAL_WARNING]);
    } catch {
      // Ruling: no probe error propagates (not even auth errors). user-balance has
      // already authenticated the key, so any failure here just means we cannot tell.
      return unverifiable([]);
    }
  }

  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    const creds = this.trim(c);
    const body = await this.call(creds, 'private/user-balance', {});
    const data = body.result?.data;
    if (!Array.isArray(data)) {
      throw this.schemaError('user-balance result.data is not an array', body);
    }
    const out = new Map<string, { free: string; locked: string }>();
    for (const account of data) {
      const positions = account?.position_balances;
      if (!Array.isArray(positions)) {
        throw this.schemaError('user-balance has no position_balances', body);
      }
      for (const p of positions) {
        if (
          !p ||
          typeof p.instrument_name !== 'string' ||
          typeof p.quantity !== 'string' ||
          !/^-?\d+(\.\d+)?$/.test(p.quantity) ||
          !isDecimal(p.reserved_qty)
        ) {
          throw this.schemaError('user-balance position has bad shape', body);
        }
        // A negative quantity is a margin borrow: a liability, not a holding. It is
        // skipped (not an error) so one borrowed asset cannot fail the whole sync.
        if (p.quantity.startsWith('-')) continue;
        if (isZero(p.quantity) && isZero(p.reserved_qty)) continue;
        const asset = normalizeAsset('crypto_com', p.instrument_name);
        const free = subDecimal(p.quantity, p.reserved_qty);
        const locked = addDecimal(p.reserved_qty, '0');
        const prev = out.get(asset);
        if (prev) {
          prev.free = addDecimal(prev.free, free);
          prev.locked = addDecimal(prev.locked, locked);
        } else {
          out.set(asset, { free, locked });
        }
      }
    }
    return [...out.entries()].map(([asset, v]) => ({ asset, ...v }));
  }

  /**
   * Streams run in a fixed order (trades, orders, transactions, deposits,
   * withdrawals), each walked backwards from now in windows (1 day for the three
   * time-windowed endpoints, 90 days with page numbers for deposits/withdrawals)
   * down to a floor of `max(since, now - 180 days)`.
   *
   * Cursor: opaque JSON `{stream, windowEnd(ms, exclusive), page?}`. A call makes at
   * most 8 API requests: empty windows are skipped in-call, but a call returns as
   * soon as one request yields rows (one data page per call). A window returning
   * exactly 100 rows is re-requested with `end_time = oldest + 1` (never lossy;
   * duplicates dedupe by exchangeRecordId). The last page returns no `nextCursor`.
   */
  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const creds = this.trim(c);
    const now = this.now();
    const sinceMs = q.since ? q.since.getTime() : undefined;
    if (sinceMs !== undefined && !Number.isFinite(sinceMs)) {
      throw new ExchangeSchemaError('Invalid history since date', null);
    }
    let cur: HistoryCursor | undefined = q.cursor
      ? this.parseCursor(q.cursor)
      : { stream: 'trades', windowEnd: now };
    const records: RawRecordInput[] = [];
    let requests = 0;

    for (;;) {
      cur = this.settle(cur, now, sinceMs);
      if (!cur) return { records };
      if (requests >= MAX_REQUESTS_PER_CALL) {
        return { records, nextCursor: this.serializeCursor(cur) };
      }
      if (requests > 0) {
        await this.sleep(
          cur.stream === 'trades' || cur.stream === 'orders'
            ? SLOW_GAP_MS
            : FAST_GAP_MS,
        );
      }
      requests++;
      const floor = this.floorFor(cur.stream, now, sinceMs);
      const step =
        cur.stream === 'deposits' || cur.stream === 'withdrawals'
          ? await this.listWindow(creds, cur, floor)
          : await this.timeWindow(creds, cur, floor);
      records.push(...step.records);
      cur = step.next;
      if (step.records.length > 0) {
        cur = this.settle(cur, now, sinceMs);
        return cur
          ? { records, nextCursor: this.serializeCursor(cur) }
          : { records };
      }
    }
  }

  private floorFor(stream: Stream, now: number, sinceMs?: number): number {
    const retention = now - CRYPTOCOM_RETENTION_MS;
    if (sinceMs === undefined) return retention;
    const lower =
      stream === 'deposits' || stream === 'withdrawals'
        ? sinceMs - LIST_OVERLAP_MS
        : sinceMs;
    return Math.max(lower, retention);
  }

  /** Moves past streams whose window walk has reached the floor; undefined when all are done. */
  private settle(
    cur: HistoryCursor,
    now: number,
    sinceMs?: number,
  ): HistoryCursor | undefined {
    let c: HistoryCursor | undefined = cur;
    while (c && c.windowEnd <= this.floorFor(c.stream, now, sinceMs)) {
      const next: Stream | undefined = STREAMS[STREAMS.indexOf(c.stream) + 1];
      c = next ? { stream: next, windowEnd: now } : undefined;
    }
    return c;
  }

  private parseCursor(raw: string): HistoryCursor {
    const bad = () =>
      new ExchangeSchemaError('Invalid Crypto.com history cursor', raw);
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      throw bad();
    }
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      !STREAMS.includes(v.stream) ||
      !Number.isSafeInteger(v.windowEnd) ||
      v.windowEnd <= 0 ||
      (v.page !== undefined &&
        (!Number.isSafeInteger(v.page) || v.page < 0 || v.page > 1_000_000))
    ) {
      throw bad();
    }
    return {
      stream: v.stream,
      windowEnd: v.windowEnd,
      ...(v.page !== undefined ? { page: v.page } : {}),
    };
  }

  private serializeCursor(c: HistoryCursor): string {
    return JSON.stringify({
      stream: c.stream,
      windowEnd: c.windowEnd,
      ...(c.page ? { page: c.page } : {}),
    });
  }

  /** trades / orders / transactions: `start_time` inclusive, `end_time` exclusive, ms. */
  private async timeWindow(
    creds: Credentials,
    cur: HistoryCursor,
    floor: number,
  ): Promise<{ records: RawRecordInput[]; next: HistoryCursor }> {
    const start = Math.max(floor, cur.windowEnd - TIME_WINDOW_MS);
    const body = await this.call(creds, STREAM_METHOD[cur.stream], {
      start_time: start,
      end_time: cur.windowEnd,
      limit: TIME_LIMIT,
    });
    const rows = body.result?.data;
    if (!Array.isArray(rows)) {
      throw this.schemaError(`${cur.stream} result.data is not an array`, body);
    }
    const records: RawRecordInput[] = [];
    let oldest: number | undefined;
    for (const row of rows) {
      const mapped = this.mapTimeRow(cur.stream, row, start);
      if (mapped.at !== undefined) {
        oldest = oldest === undefined ? mapped.at : Math.min(oldest, mapped.at);
      }
      records.push(...mapped.records);
    }
    if (rows.length < TIME_LIMIT) {
      return { records, next: { stream: cur.stream, windowEnd: start } };
    }
    // Full page: more rows may remain in this window. Continue from the oldest row
    // (plus 1 ms because end_time is exclusive; it is the row itself that repeats).
    if (oldest === undefined) {
      throw this.schemaError(
        `${cur.stream} full page has no usable times`,
        body,
      );
    }
    const windowEnd = oldest + 1 < cur.windowEnd ? oldest + 1 : oldest;
    return { records, next: { stream: cur.stream, windowEnd } };
  }

  /** deposits / withdrawals: page-number lists over 90-day `start_ts`..`end_ts` windows. */
  private async listWindow(
    creds: Credentials,
    cur: HistoryCursor,
    floor: number,
  ): Promise<{ records: RawRecordInput[]; next: HistoryCursor }> {
    const start = Math.max(floor, cur.windowEnd - LIST_WINDOW_MS);
    const page = cur.page ?? 0;
    const key = cur.stream === 'deposits' ? 'deposit_list' : 'withdrawal_list';
    const body = await this.call(creds, STREAM_METHOD[cur.stream], {
      start_ts: start,
      end_ts: cur.windowEnd,
      page,
      page_size: LIST_PAGE_SIZE,
    });
    const rows = body.result?.[key];
    if (!Array.isArray(rows)) {
      throw this.schemaError(
        `${cur.stream} result.${key} is not an array`,
        body,
      );
    }
    const records: RawRecordInput[] = [];
    for (const row of rows) {
      records.push(this.mapListRow(cur.stream, row, start));
    }
    const next: HistoryCursor =
      rows.length >= LIST_PAGE_SIZE
        ? { stream: cur.stream, windowEnd: cur.windowEnd, page: page + 1 }
        : { stream: cur.stream, windowEnd: start };
    return { records, next };
  }

  private mapTimeRow(
    stream: Stream,
    row: any,
    windowStart: number,
  ): { records: RawRecordInput[]; at?: number } {
    const bad = (at?: number) => ({
      records: [this.unparsedRecord(stream, row, at ?? windowStart)],
      at,
    });
    if (!row || typeof row !== 'object' || Array.isArray(row)) return bad();
    if (stream === 'trades') {
      const at = toMs(row.create_time) ?? this.nsToMs(row.create_time_ns);
      const id = idText(row.trade_id);
      if (!id || at === undefined) return bad(at);
      return {
        at,
        records: [
          {
            type: 'trade',
            exchangeRecordId: `trade:${id}`,
            occurredAt: new Date(at),
            payload: row,
          },
        ],
      };
    }
    if (stream === 'orders') {
      const at = toMs(row.create_time) ?? toMs(row.update_time);
      const id = idText(row.order_id);
      if (!id || at === undefined) return bad(at);
      return {
        at,
        records: [
          {
            type: 'trade',
            exchangeRecordId: `order:${id}`,
            occurredAt: new Date(at),
            payload: row,
          },
        ],
      };
    }
    // transactions
    const at =
      toMs(row.event_timestamp_ms) ?? this.nsToMs(row.event_timestamp_ns);
    const id = idText(row.journal_id);
    if (!id || at === undefined || typeof row.journal_type !== 'string') {
      return bad(at);
    }
    if (DUPLICATE_JOURNAL_TYPES.has(row.journal_type)) {
      return { at, records: [] };
    }
    const type = FEE_JOURNAL_TYPES.has(row.journal_type)
      ? 'fee'
      : REWARD_JOURNAL_TYPES.has(row.journal_type)
        ? 'reward'
        : undefined;
    if (!type) return bad(at);
    return {
      at,
      records: [
        {
          type,
          exchangeRecordId: `tx:${id}`,
          occurredAt: new Date(at),
          payload: row,
        },
      ],
    };
  }

  private mapListRow(
    stream: Stream,
    row: any,
    windowStart: number,
  ): RawRecordInput {
    const deposit = stream === 'deposits';
    const id = row && typeof row === 'object' ? idText(row.id) : undefined;
    const amount = exactDecimal(row?.amount);
    const fee = exactDecimal(row?.fee);
    const at = toMs(row?.create_time);
    if (
      !id ||
      amount === undefined ||
      fee === undefined ||
      at === undefined ||
      typeof row.currency !== 'string' ||
      !row.currency
    ) {
      return this.unparsedRecord(stream, row, at ?? windowStart);
    }
    return {
      type: deposit ? 'deposit' : 'withdrawal',
      exchangeRecordId: `${deposit ? 'dep' : 'wd'}:${id}`,
      occurredAt: new Date(at),
      payload: {
        ...row,
        amount,
        fee,
        normalizedAsset: normalizeAsset('crypto_com', row.currency),
      },
    };
  }

  private nsToMs(v: unknown): number | undefined {
    if (typeof v !== 'string' || !/^\d{16,}$/.test(v)) return undefined;
    return toMs(Number(BigInt(v) / BigInt(1_000_000)));
  }

  /** Unknown shapes are kept (never dropped); the id is a content hash so re-fetches dedupe. */
  private unparsedRecord(
    stream: Stream,
    row: unknown,
    at: number,
  ): RawRecordInput {
    const hash = createHash('sha256')
      .update(JSON.stringify(row) ?? 'undefined')
      .digest('hex')
      .slice(0, 32);
    return {
      type: 'unparsed',
      exchangeRecordId: `unparsed:${stream}:${hash}`,
      occurredAt: new Date(at),
      payload: { stream, row: redactSecrets(row) },
    };
  }

  private trim(c: Credentials): Credentials {
    return { apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
  }

  /** Serialized so ids/nonces reach the exchange in order. */
  private call(
    creds: Credentials,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Json> {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = {
        tail: Promise.resolve(),
        pending: 0,
        lastId: 0,
        lastNonce: 0,
      };
      this.lanes.set(key, lane);
    }
    const l = lane;
    l.pending++;
    const run = l.tail.then(() =>
      this.send(creds, method, params, () => {
        l.lastId += 1;
        l.lastNonce = Math.max(this.now(), l.lastNonce + 1);
        return { id: l.lastId, nonce: l.lastNonce };
      }),
    );
    l.tail = run.catch(() => undefined);
    const done = () => {
      if (--l.pending === 0 && this.lanes.get(key) === l)
        this.lanes.delete(key);
    };
    run.then(done, done);
    return run;
  }

  private async send(
    creds: Credentials,
    method: string,
    params: Record<string, unknown>,
    next: () => { id: number; nonce: number },
  ): Promise<Json> {
    if (!READ_METHODS.has(method)) {
      throw new Error(`Refusing to call non-read Crypto.com method ${method}`);
    }
    const { id, nonce } = next();
    const sig = cryptoComSign({
      method,
      id,
      apiKey: creds.apiKey,
      params,
      nonce,
      secret: creds.apiSecret,
    });
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Crypto.com request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          method,
          api_key: creds.apiKey,
          params,
          nonce,
          sig,
        }),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Crypto.com request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }

    if (res.status === 429) throw new ExchangeRateLimitError();
    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();
    if (res.status >= 500) {
      throw new ExchangeNetworkError(`Crypto.com returned HTTP ${res.status}`);
    }
    // Parsed from text (never via res.json) so numeric strings stay exact.
    let parsed: any;
    try {
      parsed = JSON.parse(
        method === 'private/get-deposit-history' ||
          method === 'private/get-withdrawal-history'
          ? quoteExactNumbers(text)
          : text,
      );
    } catch {
      if (res.status === 401) throw this.mapCode(40101);
      throw new ExchangeSchemaError(
        'Crypto.com response was not valid JSON',
        this.sanitize(text, creds),
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.code !== 'number'
    ) {
      throw this.schemaError('Crypto.com response has no numeric code', parsed);
    }
    if (parsed.code !== 0) throw this.mapCode(parsed.code);
    if (!res.ok) {
      throw new ExchangeNetworkError(`Crypto.com returned HTTP ${res.status}`);
    }
    return parsed;
  }

  /** Codes: https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference */
  private mapCode(code: number) {
    switch (code) {
      case 40101:
        return new ExchangeAuthError(
          'Crypto.com: key or signature incorrect (40101)',
          'Crypto.com rejected the API key or signature. Check the key and secret.',
        );
      case 40102:
        return new ExchangeAuthError(
          'Crypto.com: nonce differs by more than 60 seconds (40102)',
          'Crypto.com rejected the request because the server clock is out of sync (more than 60 seconds). Check the server time and try again.',
        );
      case 40103:
        return new ExchangeAuthError(
          'Crypto.com: IP address not allow-listed (40103)',
          'This API key is IP-restricted and this server is not on its allow-list. Add the server IP in Crypto.com or remove the restriction.',
        );
      case 40801: // REQUEST_TIMEOUT (HTTP 408): retryable
        return new ExchangeNetworkError('Crypto.com: request timeout (40801)');
      case 42901:
        return new ExchangeRateLimitError(
          'Crypto.com: too many requests (42901)',
        );
      default:
        return new ExchangeNetworkError(
          `Crypto.com error code ${code}`,
          'The exchange reported an error. Check the connection and try again.',
          false,
        );
    }
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [creds.apiKey, creds.apiSecret]);
  }
}
