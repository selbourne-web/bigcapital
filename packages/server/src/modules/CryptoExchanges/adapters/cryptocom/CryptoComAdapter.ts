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
import { cryptoComSign } from './cryptocom.signing';

const DEFAULT_BASE_URL = 'https://api.crypto.com/exchange/v1';

/**
 * Read-only methods. The adapter must never reach a state-changing method
 * (create-order, create-withdrawal, ...), so anything else is refused.
 */
const READ_METHODS = new Set([
  'private/user-balance',
  'private/get-trades',
  'private/get-order-history',
  'private/get-transactions',
  'private/get-deposit-history',
  'private/get-withdrawal-history',
  'private/staking/get-reward-history',
  'private/get-deposit-address', // inspectKey probe only; addresses are discarded
]);

const WITHDRAWAL_WARNING =
  'This Crypto.com key appears to have withdrawal permission enabled. Crypto.com does not expose key permissions, so please confirm the key is read-only (Can Read only).';

/** API retention for trades/orders/transactions (docs: "recent 6 months"); 180 days, conservative. */
export const CRYPTOCOM_RETENTION_MS = 180 * 86_400_000;
const DAY_MS = 86_400_000;
/**
 * Deposit/withdrawal lists have no documented retention, so their lower bound is
 * this fixed date (Crypto.com Exchange launched in 2018), not the 180-day clamp.
 */
const LIST_EPOCH_MS = Date.UTC(2018, 0, 1);
/**
 * Deposit/withdrawal lists are windowed by creation time but their status changes
 * later, so `since` is stepped back this far (status is part of the record id, so
 * each transition becomes a new raw row).
 */
const LIST_OVERLAP_MS = 14 * DAY_MS;
/** At most this many API requests per fetchHistory call (empty windows are skipped quickly). */
const MAX_REQUESTS_PER_CALL = 8;
/** Cap on queued unseen sub-ranges in a cursor. */
const MAX_PENDING = 64;
/** Gap between requests inside one call: get-trades/get-order-history allow 1 req/s. */
const SLOW_GAP_MS = 1_100;
const FAST_GAP_MS = 150;
/** Per-method minimum gap between requests of one api key (filled from STREAM_CONF below). */
const METHOD_GAP_MS: Record<string, number> = {};

const STREAMS = [
  'trades',
  'orders',
  'transactions',
  'deposits',
  'withdrawals',
  'rewards',
] as const;
type Stream = (typeof STREAMS)[number];
type Range = [number, number];
type HistoryCursor = {
  stream: Stream;
  windowEnd: number;
  page?: number;
  pending?: Range[];
};

/**
 * Per-stream endpoint config. `time`: start_time/end_time windows, `limit` rows max.
 * `list`: start_ts/end_ts windows with page numbers, `limit` is the page size.
 * Docs (see CryptoComAdapter.history.spec.ts for URLs): trades/orders/transactions
 * 100 rows, deposits/withdrawals page_size 200 (90-day default window), staking
 * rewards limit 500 with start_time >= end_time - 180 days.
 */
const STREAM_CONF: Record<
  Stream,
  {
    method: string;
    kind: 'time' | 'list';
    windowMs: number;
    limit: number;
    gapMs: number;
  }
> = {
  trades: {
    method: 'private/get-trades',
    kind: 'time',
    windowMs: DAY_MS,
    limit: 100,
    gapMs: SLOW_GAP_MS,
  },
  orders: {
    method: 'private/get-order-history',
    kind: 'time',
    windowMs: DAY_MS,
    limit: 100,
    gapMs: SLOW_GAP_MS,
  },
  transactions: {
    method: 'private/get-transactions',
    kind: 'time',
    windowMs: DAY_MS,
    limit: 100,
    gapMs: FAST_GAP_MS,
  },
  deposits: {
    method: 'private/get-deposit-history',
    kind: 'list',
    windowMs: 90 * DAY_MS,
    limit: 200,
    gapMs: FAST_GAP_MS,
  },
  withdrawals: {
    method: 'private/get-withdrawal-history',
    kind: 'list',
    windowMs: 90 * DAY_MS,
    limit: 200,
    gapMs: FAST_GAP_MS,
  },
  rewards: {
    method: 'private/staking/get-reward-history',
    kind: 'time',
    windowMs: 30 * DAY_MS,
    limit: 500,
    gapMs: FAST_GAP_MS,
  },
};

for (const conf of Object.values(STREAM_CONF)) {
  METHOD_GAP_MS[conf.method] = conf.gapMs;
}

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
/** No documented get-transactions journal type is a reward (staking rewards have their own stream). */
const REWARD_JOURNAL_TYPES = new Set<string>();

/**
 * Deposit/withdrawal `amount` and `fee` arrive as JSON numbers, and JSON.parse would
 * round long ones. Before parsing, this wraps those two number tokens in quotes in
 * the RAW text so the exact decimal text survives (trailing zeros included).
 * Quoted keys inside string values are escaped (`\"`), so they cannot match.
 */
export function quoteExactNumbers(text: string): string {
  return text.replace(
    /("(?:amount|fee|reward_quantity|staked_balance)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g,
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

/** Longest id fragment used raw; longer ones are shortened with a hash so composed ids stay well under varchar(191). */
const MAX_ID_FRAGMENT = 64;

function idText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0 && v.length <= 1000) {
    if (v.length <= MAX_ID_FRAGMENT) return v;
    const hash = createHash('sha256').update(v).digest('hex').slice(0, 16);
    return `${v.slice(0, 40)}~${hash}`; // 57 chars
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  return undefined;
}

type Json = Record<string, any>;

export class CryptoComAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'crypto_com';
  readonly historyCoverage: HistoryCoverage = {
    level: 'partial',
    note: 'Crypto.com Exchange API trade, order and ledger history is limited to the last 6 months; import a CSV for older records.',
  };
  /** Most private calls 3 per 100 ms; trades/order history 1 req/s. A history page costs 10 tokens (capacity must be >= cost) and the adapter paces its own 1 req/s calls. */
  readonly rateLimit = { capacity: 10, refillPerSec: 10, historyPageCost: 10 };

  /**
   * Per-api-key serialization state (keyed by a hash of the key). The adapter is a
   * shared singleton, so a global queue would let one tenant's slow call delay
   * another's. Entries are removed when the key has no calls in flight.
   */
  private readonly logger = new Logger('CryptoComAdapter');
  /** api-key hashes already warned about a skipped rewards stream (bounded, process lifetime). */
  /** Last send time per "<key hash>:<method>" (bounded; see markSent). */
  private readonly sentAt = new Map<string, number>();
  private readonly rewardsWarned = new Set<string>();

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
   * withdrawals, rewards), each walked backwards from now in windows (1 day for
   * trades/orders/transactions, 30 days for staking rewards, 90 days with page
   * numbers for deposits/withdrawals). Time-windowed streams stop at
   * `max(since, now - 180 days)` (documented retention); deposit/withdrawal lists
   * have no documented retention and stop at `max(since - 14d, 2018-01-01)`.
   *
   * Cursor: opaque JSON `{stream, windowEnd(ms, exclusive), page?, pending?}`. A call
   * makes at most 8 API requests: empty windows are skipped in-call, but a call
   * returns as soon as one request yields rows (one data page per call).
   *
   * Row order within a response is not documented, so a FULL page (limit rows) is
   * handled order-independently: with min/max row times m/M of a requested range
   * [s,e), the unseen remainder is [s, m+1) (rows older than the page, ties at m
   * included) and [M, e) (rows newer than the page, ties at M included). Both are
   * queued in `pending` and re-requested (and split again if full) before the main
   * walk continues. Duplicates dedupe by exchangeRecordId.
   * Known limit: when a range still returns >= limit rows that all share one
   * millisecond, no sub-range can be smaller than the range itself; the walk
   * terminates and the rows beyond the first `limit` at that millisecond cannot be
   * fetched (the API offers no other cursor).
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
      requests++;
      const floor = this.floorFor(cur.stream, now, sinceMs);
      const step =
        STREAM_CONF[cur.stream].kind === 'list'
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
    if (STREAM_CONF[stream].kind === 'list') {
      // No documented retention for deposit/withdrawal lists: never clamp to 180 days.
      return Math.max((sinceMs ?? 0) - LIST_OVERLAP_MS, LIST_EPOCH_MS);
    }
    const retention = now - CRYPTOCOM_RETENTION_MS;
    return sinceMs === undefined ? retention : Math.max(sinceMs, retention);
  }

  /** Moves past streams whose walk is finished; undefined when all are done. */
  private settle(
    cur: HistoryCursor,
    now: number,
    sinceMs?: number,
  ): HistoryCursor | undefined {
    let c: HistoryCursor | undefined = cur;
    while (
      c &&
      !c.pending?.length &&
      c.windowEnd <= this.floorFor(c.stream, now, sinceMs)
    ) {
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
    let pending: Range[] | undefined;
    if (v.pending !== undefined) {
      if (
        STREAM_CONF[v.stream as Stream].kind !== 'time' ||
        !Array.isArray(v.pending) ||
        v.pending.length > MAX_PENDING ||
        !v.pending.every(
          (r: any) =>
            Array.isArray(r) &&
            r.length === 2 &&
            Number.isSafeInteger(r[0]) &&
            Number.isSafeInteger(r[1]) &&
            r[0] > 0 &&
            r[0] < r[1],
        )
      ) {
        throw bad();
      }
      pending = v.pending.map((r: Range) => [r[0], r[1]] as Range);
    }
    return {
      stream: v.stream,
      windowEnd: v.windowEnd,
      ...(v.page !== undefined ? { page: v.page } : {}),
      ...(pending?.length ? { pending } : {}),
    };
  }

  private serializeCursor(c: HistoryCursor): string {
    return JSON.stringify({
      stream: c.stream,
      windowEnd: c.windowEnd,
      ...(c.page ? { page: c.page } : {}),
      ...(c.pending?.length ? { pending: c.pending } : {}),
    });
  }

  /** `start_time` inclusive, `end_time` exclusive, ms. */
  private async timeWindow(
    creds: Credentials,
    cur: HistoryCursor,
    floor: number,
  ): Promise<{ records: RawRecordInput[]; next: HistoryCursor }> {
    const conf = STREAM_CONF[cur.stream];
    let range: Range;
    let rest: Range[];
    let windowEnd = cur.windowEnd;
    if (cur.pending?.length) {
      range = cur.pending[0];
      rest = cur.pending.slice(1);
    } else {
      const start = Math.max(floor, cur.windowEnd - conf.windowMs);
      range = [start, cur.windowEnd];
      rest = [];
      windowEnd = start;
    }
    const done = (r: RawRecordInput[], nextRest: Range[], end = windowEnd) => ({
      records: r,
      next: {
        stream: cur.stream,
        windowEnd: end,
        ...(nextRest.length ? { pending: nextRest } : {}),
      } as HistoryCursor,
    });

    let body: Json;
    try {
      body = await this.call(creds, conf.method, {
        start_time: range[0],
        end_time: range[1],
        limit: conf.limit,
      });
    } catch (err) {
      // The staking reward endpoint documents `instrument_name` as required, but
      // the adapter does not know the staking instruments. If the exchange rejects
      // the call as a bad request (a non-retryable, non-auth error), the optional
      // rewards stream is treated as unavailable rather than failing the sync.
      if (
        cur.stream === 'rewards' &&
        err instanceof ExchangeNetworkError &&
        !err.retryable
      ) {
        this.warnRewardsSkipped(creds, err);
        return done([], [], floor);
      }
      throw err;
    }
    const rows = this.timeRows(cur.stream, body);
    const records: RawRecordInput[] = [];
    let min: number | undefined;
    let max: number | undefined;
    for (const row of rows) {
      const mapped = this.mapTimeRow(cur.stream, row, range[0]);
      if (mapped.at !== undefined) {
        min = min === undefined ? mapped.at : Math.min(min, mapped.at);
        max = max === undefined ? mapped.at : Math.max(max, mapped.at);
      }
      records.push(...mapped.records);
    }
    if (rows.length >= conf.limit) {
      if (min === undefined || max === undefined) {
        throw this.schemaError(
          `${cur.stream} full page has no usable times`,
          body,
        );
      }
      const unseen: Range[] = (
        [
          [range[0], min + 1], // older than the page, ties at min included
          [max, range[1]], // newer than the page, ties at max included
        ] as Range[]
      ).filter(([lo, hi]) => lo < hi && !(lo === range[0] && hi === range[1]));
      rest = [...unseen, ...rest];
      if (rest.length > MAX_PENDING) {
        throw this.schemaError(
          `${cur.stream} history is too dense to page`,
          body,
        );
      }
    }
    return done(records, rest);
  }

  /**
   * One redacted warning per api key per process when the optional rewards stream is
   * skipped, so a never-working stream is visible without logging on every sync.
   * Only the stream name and the error text built from the exchange code or HTTP
   * status are logged: no keys, addresses or payloads.
   */
  private warnRewardsSkipped(creds: Credentials, err: ExchangeNetworkError) {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    if (this.rewardsWarned.has(key)) return;
    if (this.rewardsWarned.size >= 1000) this.rewardsWarned.clear();
    this.rewardsWarned.add(key);
    this.logger.warn(
      `Crypto.com staking rewards stream skipped: ${err.message}`,
    );
  }

  private timeRows(stream: Stream, body: Json): any[] {
    const result = body.result;
    if (stream === 'rewards') {
      // The docs describe the response only as "an array of reward objects"; accept
      // the usual containers (not verified live).
      for (const rows of [
        result?.data,
        result?.reward_list,
        result?.reward_history_list,
        Array.isArray(result) ? result : undefined,
      ]) {
        if (Array.isArray(rows)) return rows;
      }
      throw this.schemaError('rewards result has no reward array', body);
    }
    if (!Array.isArray(result?.data)) {
      throw this.schemaError(`${stream} result.data is not an array`, body);
    }
    return result.data;
  }

  /** deposits / withdrawals: page-number lists over 90-day `start_ts`..`end_ts` windows. */
  private async listWindow(
    creds: Credentials,
    cur: HistoryCursor,
    floor: number,
  ): Promise<{ records: RawRecordInput[]; next: HistoryCursor }> {
    const conf = STREAM_CONF[cur.stream];
    const start = Math.max(floor, cur.windowEnd - conf.windowMs);
    const page = cur.page ?? 0;
    const key = cur.stream === 'deposits' ? 'deposit_list' : 'withdrawal_list';
    const body = await this.call(creds, conf.method, {
      start_ts: start,
      end_ts: cur.windowEnd,
      page,
      page_size: conf.limit,
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
      rows.length >= conf.limit
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
            payload: { ...row, _source: 'trades' },
          },
        ],
      };
    }
    if (stream === 'orders') {
      const at = toMs(row.create_time) ?? toMs(row.update_time);
      const id = idText(row.order_id);
      const status = idText(row.status);
      if (!id || !status || at === undefined) return bad(at);
      // The id carries the status so each status transition is its own immutable
      // raw row (inserts dedupe by id). `_source` lets consumers tell orders from fills.
      return {
        at,
        records: [
          {
            type: 'trade',
            exchangeRecordId: `order:${id}:s${status}`,
            occurredAt: new Date(at),
            payload: { ...row, _source: 'order-history' },
          },
        ],
      };
    }
    if (stream === 'rewards') {
      const at = toMs(row.event_timestamp_ms);
      const inst =
        idText(row.staking_inst_name) ?? idText(row.reward_inst_name);
      const qty = exactDecimal(row.reward_quantity);
      const rewardInst = idText(row.reward_inst_name);
      if (!inst || qty === undefined || at === undefined || !rewardInst) {
        return bad(at);
      }
      return {
        at,
        records: [
          {
            type: 'reward',
            exchangeRecordId: this.rewardId(inst, at, qty),
            occurredAt: new Date(at),
            payload: {
              ...row,
              reward_quantity: qty,
              normalizedAsset: normalizeAsset('crypto_com', rewardInst),
            },
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
    const isRow = row && typeof row === 'object' && !Array.isArray(row);
    const id = isRow ? idText(row.id) : undefined;
    const status = isRow ? idText(row.status) : undefined;
    const amount = exactDecimal(row?.amount);
    // A missing fee is not schema drift: treat it as zero.
    const fee =
      row?.fee === undefined || row?.fee === null ? '0' : exactDecimal(row.fee);
    const at = toMs(row?.create_time);
    if (
      !id ||
      status === undefined ||
      amount === undefined ||
      fee === undefined ||
      at === undefined ||
      typeof row.currency !== 'string' ||
      !row.currency
    ) {
      return this.unparsedRecord(stream, row, at ?? windowStart);
    }
    // The status is part of the id: each status transition is a new immutable raw row.
    return {
      type: deposit ? 'deposit' : 'withdrawal',
      exchangeRecordId: `${deposit ? 'dep' : 'wd'}:${id}:s${status}`,
      occurredAt: new Date(at),
      payload: {
        ...row,
        amount,
        fee,
        normalizedAsset: normalizeAsset('crypto_com', row.currency),
      },
    };
  }

  /** Stable reward id; hashed if it would be unreasonably long. */
  private rewardId(inst: string, at: number, qty: string): string {
    const id = `reward:${inst}:${at}:${qty}`;
    return id.length <= 150
      ? id
      : `reward:${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
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
    const run = l.tail.then(async () => {
      // Per key AND method pacing across fetchHistory calls too: the exchange allows
      // 1 request/s on get-trades/get-order-history. `sentAt` outlives the lane (which
      // is deleted when idle) for a short TTL, so back-to-back calls stay paced.
      const gap = METHOD_GAP_MS[method] ?? FAST_GAP_MS;
      const sentKey = `${key}:${method}`;
      const last = this.sentAt.get(sentKey);
      if (last !== undefined) {
        const wait = last + gap - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.markSent(sentKey);
      return this.send(creds, method, params, () => {
        l.lastId += 1;
        l.lastNonce = Math.max(this.now(), l.lastNonce + 1);
        return { id: l.lastId, nonce: l.lastNonce };
      });
    });
    l.tail = run.catch(() => undefined);
    const done = () => {
      if (--l.pending === 0 && this.lanes.get(key) === l)
        this.lanes.delete(key);
    };
    run.then(done, done);
    return run;
  }

  /** Records a send time; entries older than the longest gap are pruned (bounded map). */
  private markSent(sentKey: string) {
    const t = this.now();
    this.sentAt.set(sentKey, t);
    if (this.sentAt.size > 256) {
      for (const [k, v] of this.sentAt) {
        if (t - v > SLOW_GAP_MS) this.sentAt.delete(k);
      }
    }
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

    // Always drain the body (also on 429) so the connection is released.
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new ExchangeRateLimitError();
    if (signal.aborted) throw timedOut();
    if (res.status >= 500) {
      throw new ExchangeNetworkError(`Crypto.com returned HTTP ${res.status}`);
    }
    // Parsed from text (never via res.json) so numeric strings stay exact.
    let parsed: any;
    try {
      parsed = JSON.parse(
        method === 'private/get-deposit-history' ||
          method === 'private/get-withdrawal-history' ||
          method === 'private/staking/get-reward-history'
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
      if (res.status === 401) throw this.mapCode(40101);
      throw this.schemaError('Crypto.com response has no numeric code', parsed);
    }
    if (parsed.code !== 0) {
      const err = this.mapCode(parsed.code);
      // HTTP 401 is always an authentication problem, whatever the code says.
      if (res.status === 401 && !(err instanceof ExchangeAuthError)) {
        throw this.mapCode(40101);
      }
      throw err;
    }
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
      case 40104: // USER_TIER_INVALID (HTTP 401): the account tier disallows this call
        return new ExchangeAuthError(
          'Crypto.com: disallowed based on user tier (40104)',
          'Crypto.com says this account tier is not allowed to use this API. Check the account tier and key.',
        );
      case 50001: // ERR_INTERNAL (HTTP 500): retryable
        return new ExchangeNetworkError('Crypto.com: internal error (50001)');
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
